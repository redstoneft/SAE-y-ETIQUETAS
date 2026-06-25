"""
ESTACION DE IMPRESION ZEBRA  (modelo: jala trabajos del backend)
================================================================
Corre en la PC que tiene la GK420T conectada por USB.
NO recibe conexiones: le PREGUNTA al backend cada pocos segundos si hay
etiquetas que imprimir, las jala, las manda a la Zebra por USB, y reporta.

Asi no hay que abrir puertos en tu red ni exponer nada.

INSTALACION (en la PC con la Zebra):
  1. Instalar Python 3.10+  (python.org)  -- o usar el .exe (ver abajo)
  2. pip install pywin32 requests
  3. Editar CONFIG abajo (BACKEND_URL, PRINTER_NAME, ESTACION)
  4. python print_station.py

CONVERTIR EN .EXE (un solo archivo, sin instalar Python en cada PC):
  pip install pyinstaller
  pyinstaller --onefile --name EstacionZebra print_station.py
  -> queda dist/EstacionZebra.exe : doble clic y corre.
  Para que arranque solo al prender la PC: poner un acceso directo del .exe
  en la carpeta de Inicio de Windows (shell:startup).
"""

import time
import sys
import json

# ====== CONFIG ======
BACKEND_URL  = "https://sae-y-etiquetas-production.up.railway.app"  # backend en Railway
ESTACION     = "zebra-01"                  # id de esta PC/impresora
PRINTER_NAME = ""                          # vacio = auto-detecta la Zebra (GK420/ZDesigner)
POLL_SEGUNDOS = 5                          # cada cuanto pregunta por trabajo
MAX_INTENTOS = 3                           # reintentos por etiqueta

# ====== Dependencias opcionales ======
try:
    import requests
except ImportError:
    print("Falta 'requests'. Ejecuta: pip install requests")
    sys.exit(1)


# ====== Impresion por USB (Windows RAW) ======
def listar_impresoras():
    try:
        import win32print
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        return [p[2] for p in win32print.EnumPrinters(flags)]
    except ImportError:
        return ["[pywin32 no instalado: pip install pywin32]"]
    except Exception as e:
        return [f"[error: {e}]"]


def autodetectar_zebra():
    """Devuelve el nombre de la primera impresora Zebra/GK420 encontrada, o ''."""
    for p in listar_impresoras():
        pl = p.lower()
        if "gk420" in pl or "zebra" in pl or "zdesigner" in pl:
            return p
    return ""


def imprimir_raw(zpl, printer_name):
    """Manda ZPL crudo a la Zebra por la cola RAW de Windows."""
    import win32print
    data = zpl.encode("utf-8")
    # PRINTER_ACCESS_USE basta para imprimir y NO requiere admin.
    # Sin esto, OpenPrinter pide PRINTER_ALL_ACCESS y Windows responde
    # "Acceso denegado" (error 5) salvo que se corra como administrador.
    h = win32print.OpenPrinter(printer_name,
                               {"DesiredAccess": win32print.PRINTER_ACCESS_USE})
    try:
        win32print.StartDocPrinter(h, 1, ("Etiqueta ZPL", None, "RAW"))
        win32print.StartPagePrinter(h)
        win32print.WritePrinter(h, data)
        win32print.EndPagePrinter(h)
        win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)


# ====== Comunicacion con el backend ======
def tomar_trabajo():
    try:
        r = requests.get(f"{BACKEND_URL}/api/print-station/siguiente",
                         params={"estacion": ESTACION}, timeout=15)
        if r.status_code == 204:
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  (sin conexion al backend: {e})")
        return None


def reportar(job_id, impresas, fallidas, estatus, error_msg=None):
    try:
        requests.post(f"{BACKEND_URL}/api/print-station/{job_id}/resultado",
                      json={"impresas": impresas, "fallidas": fallidas,
                            "estatus": estatus, "error_msg": error_msg}, timeout=15)
    except Exception as e:
        print(f"  (no se pudo reportar: {e})")


# ====== Procesar un trabajo ======
def procesar(job):
    etiquetas = job.get("etiquetas", [])
    total = len(etiquetas)
    print(f"  Trabajo {job['id']}: {total} etiquetas")
    impresas = fallidas = 0

    for i, et in enumerate(etiquetas, 1):
        zpl = et.get("zpl", "")
        ok = False
        for intento in range(1, MAX_INTENTOS + 1):
            try:
                imprimir_raw(zpl, PRINTER_NAME)
                ok = True
                break
            except Exception as e:
                ultimo = str(e)
                time.sleep(0.4 * intento)
        if ok:
            impresas += 1
        else:
            fallidas += 1
            print(f"    fallo etiqueta {i}: {ultimo}")
            # si fallan 3 seguidas desde el inicio, la impresora murio
            if fallidas >= 3 and impresas == 0:
                reportar(job["id"], impresas, fallidas, "error",
                         "La impresora no responde; trabajo detenido")
                print("    impresora no responde, deteniendo trabajo")
                return
        # reporte de avance cada 10 etiquetas
        if i % 10 == 0 or i == total:
            reportar(job["id"], impresas, fallidas, "imprimiendo")
            print(f"    avance: {i}/{total}")

    estatus = "completo" if fallidas == 0 else "error"
    reportar(job["id"], impresas, fallidas, estatus)
    print(f"  Trabajo terminado: {impresas} impresas, {fallidas} fallidas")


# ====== Loop principal ======
def main():
    global PRINTER_NAME
    print("=" * 55)
    print(" ESTACION DE IMPRESION ZEBRA -- jala trabajos del backend")
    print("=" * 55)
    print("\nImpresoras detectadas:")
    for p in listar_impresoras():
        print("   -", p)
    if not PRINTER_NAME:
        PRINTER_NAME = autodetectar_zebra()
        if PRINTER_NAME:
            print(f"\n>> Zebra detectada automaticamente: {PRINTER_NAME}")
        else:
            print("\n>> No encontre una Zebra. Edita PRINTER_NAME con el nombre exacto.")
    else:
        print(f"\n>> Usando impresora: {PRINTER_NAME}")
    print(f"\nBackend: {BACKEND_URL}")
    print(f"Estacion: {ESTACION} | Revisando cada {POLL_SEGUNDOS}s")
    print("Ctrl+C para detener.\n")

    while True:
        try:
            job = tomar_trabajo()
            if job:
                procesar(job)
            else:
                time.sleep(POLL_SEGUNDOS)
        except KeyboardInterrupt:
            print("\nDetenido.")
            break
        except Exception as e:
            print(f"Error en loop (continua): {e}")
            time.sleep(POLL_SEGUNDOS)


if __name__ == "__main__":
    main()
