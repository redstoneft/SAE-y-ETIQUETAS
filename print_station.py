"""
ESTACION DE IMPRESION ZEBRA  (modelo: jala trabajos del backend)
================================================================
Corre en la PC que tiene la GK420T conectada por USB.
NO recibe conexiones: le PREGUNTA al backend cada pocos segundos si hay
etiquetas que imprimir, las jala, las manda a la Zebra por USB, y reporta.

Asi no hay que abrir puertos en tu red ni exponer nada.

ADEMAS expone un servicio LOCAL (solo en esta PC, http://127.0.0.1:9101) para
que la pagina web imprima DIRECTO a traves del driver de Windows de la Zebra
(ZDesigner o el que tenga instalado). Con esto ya no hace falta cambiar el
driver a WinUSB ni tocar el puerto USB000: la impresora se queda tal cual la
instalo Windows. La pagina detecta sola la estacion y manda las etiquetas aqui.

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
LOCAL_PUERTO = 9101                        # servicio local para la pagina web (solo 127.0.0.1)
VERSION = "1.1"

import os
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "estacion.json")

def cargar_config():
    """Lee estacion.json (junto al .exe) si existe: {"printer": "...", "estacion": "..."}."""
    global PRINTER_NAME, ESTACION
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            c = json.load(f)
        if c.get("printer"):
            PRINTER_NAME = c["printer"]
        if c.get("estacion"):
            ESTACION = c["estacion"]
    except Exception:
        pass

def guardar_config():
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump({"printer": PRINTER_NAME, "estacion": ESTACION}, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"  (no se pudo guardar estacion.json: {e})")

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
    """Reporta avance/resultado. Devuelve True si el backend pide CANCELAR."""
    try:
        r = requests.post(f"{BACKEND_URL}/api/print-station/{job_id}/resultado",
                          json={"impresas": impresas, "fallidas": fallidas,
                                "estatus": estatus, "error_msg": error_msg}, timeout=15)
        try:
            return bool(r.json().get("cancelar"))
        except Exception:
            return False
    except Exception as e:
        print(f"  (no se pudo reportar: {e})")
        return False


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
        # reporte de avance cada 5 etiquetas; si el usuario canceló, detener
        if i % 5 == 0 or i == total:
            cancelar = reportar(job["id"], impresas, fallidas, "imprimiendo")
            print(f"    avance: {i}/{total}")
            if cancelar:
                print("    >> CANCELADO por el usuario, deteniendo trabajo")
                return

    estatus = "completo" if fallidas == 0 else "error"
    reportar(job["id"], impresas, fallidas, estatus)
    print(f"  Trabajo terminado: {impresas} impresas, {fallidas} fallidas")


# ====== Servicio local para la pagina web (driver de Windows, sin WinUSB) ======
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_lock_impresion = threading.Lock()

class _Local(BaseHTTPRequestHandler):
    server_version = "EstacionZebra/" + VERSION

    def log_message(self, fmt, *args):   # silencio: no llenar la consola con cada request
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome exige esto para que una pagina https hable con 127.0.0.1 (Private Network Access)
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/estado"):
            return self._json(200, {"ok": True, "version": VERSION, "estacion": ESTACION,
                                    "impresora": PRINTER_NAME, "impresoras": listar_impresoras()})
        self._json(404, {"error": "no existe"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            datos = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception as e:
            return self._json(400, {"error": f"JSON invalido: {e}"})

        if self.path.startswith("/impresora"):
            global PRINTER_NAME
            nombre = (datos.get("nombre") or "").strip()
            if nombre and nombre not in listar_impresoras():
                return self._json(400, {"error": f"No existe la impresora '{nombre}' en Windows"})
            PRINTER_NAME = nombre or autodetectar_zebra()
            guardar_config()
            print(f">> Impresora cambiada desde la pagina: {PRINTER_NAME}")
            return self._json(200, {"ok": True, "impresora": PRINTER_NAME})

        if self.path.startswith("/imprimir"):
            etiquetas = datos.get("etiquetas") or []
            printer = (datos.get("impresora") or PRINTER_NAME or "").strip()
            if not printer:
                return self._json(400, {"error": "No hay impresora Zebra configurada en la estacion"})
            impresas, fallidas, errores = 0, 0, []
            with _lock_impresion:
                for i, et in enumerate(etiquetas, 1):
                    zpl = et.get("zpl") if isinstance(et, dict) else str(et)
                    if not zpl:
                        fallidas += 1; errores.append(f"etiqueta {i}: sin ZPL"); continue
                    ultimo = ""
                    for intento in range(1, MAX_INTENTOS + 1):
                        try:
                            imprimir_raw(zpl, printer); impresas += 1; break
                        except Exception as e:
                            ultimo = str(e); time.sleep(0.3 * intento)
                    else:
                        fallidas += 1; errores.append(f"etiqueta {i}: {ultimo}")
                        if fallidas >= 3 and impresas == 0:
                            errores.append("La impresora no responde; se detuvo el lote")
                            break
            if impresas:
                print(f"  Pagina web -> {printer}: {impresas} etiquetas" + (f", {fallidas} fallidas" if fallidas else ""))
            return self._json(200, {"ok": fallidas == 0, "impresas": impresas, "fallidas": fallidas,
                                    "errores": errores[:10], "impresora": printer})
        self._json(404, {"error": "no existe"})


def iniciar_servicio_local():
    """Arranca el servicio en 127.0.0.1 (nunca en la red) en un hilo aparte."""
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", LOCAL_PUERTO), _Local)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        print(f"Servicio local para la pagina web: http://127.0.0.1:{LOCAL_PUERTO}  (imprime por el driver de Windows)")
        return True
    except OSError as e:
        print(f"!! No se pudo abrir el puerto local {LOCAL_PUERTO}: {e}")
        print("   (probablemente ya hay otra EstacionZebra abierta; cierra la otra ventana)")
        return False


# ====== Loop principal ======
def main():
    global PRINTER_NAME
    print("=" * 55)
    print(f" ESTACION DE IMPRESION ZEBRA v{VERSION} -- driver de Windows, sin WinUSB")
    print("=" * 55)
    cargar_config()
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
    iniciar_servicio_local()
    print("Deja esta ventana abierta. La pagina web imprimira directo aqui. Ctrl+C para detener.\n")

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
