# Guía de instalación — Sistema Embarque (nube + Zebra USB)

Arquitectura: backend y dashboard en la nube; la Zebra va por USB en una PC
que corre un programa pequeño (EstacionZebra) que JALA los trabajos de
impresion del backend. No se abren puertos en tu red.

```
        NUBE                                 TU OFICINA
  +------------------+                 +------------------------+
  | Backend + BD     |  <--- jala ---  | PC con EstacionZebra   |
  | Dashboard (web)  |   trabajos      |        |  USB          |
  +------------------+                 |   GK420T (USB)         |
         ^                             +------------------------+
         | abren URL
    Tus 3 personas (navegador, sin instalar nada)
```

Tu equipo NO instala nada: abren una URL. Solo la PC de la Zebra corre el
programa de impresion (una vez configurado, arranca solo).

---

## Instalacion unica (la haces tu una vez)

### Paso 1 - Base de datos (Supabase)
- Crea proyecto en supabase.com
- En SQL Editor corre schema_mvp.sql y luego schema_v2.sql
- Anota URL del proyecto y service key (Settings -> API)

### Paso 2 - Desplegar el backend (nube)
- Subelo a Railway / Render / similar (aceptan Node)
- Variables de entorno:
    SUPABASE_URL=https://tu-proyecto.supabase.co
    SUPABASE_SERVICE_KEY=tu-service-key

### Paso 3 - Publicar el dashboard
- En dashboard.html cambia arriba:
    const API_BASE = "https://tu-backend.com";
- Subelo a Netlify (arrastrar y soltar). Tu equipo entra a esa URL.

### Paso 4 - Estacion de impresion (PC con la Zebra USB)
Opcion facil (recomendada): usar el .exe.
- Te paso EstacionZebra.exe (o lo generas, ver abajo)
- Editas su config: BACKEND_URL, PRINTER_NAME (nombre exacto de la Zebra),
  ESTACION (ej. zebra-01)
- Doble clic. Queda corriendo y jala trabajos cada 5 segundos.
- Para que arranque solo al prender la PC: pon un acceso directo del .exe
  en la carpeta de Inicio (tecla Win+R, escribe  shell:startup , pega el
  acceso directo ahi).

Generar el .exe tu mismo (si no te lo paso hecho):
    pip install pyinstaller pywin32 requests
    pyinstaller --onefile --name EstacionZebra print_station.py
    -> queda en dist/EstacionZebra.exe

---

## El dia a dia de tu equipo (cero instalacion)

1. Abren la URL del dashboard
2. Arrastran el PDF del pedido de Walmart
3. Revisan la extraccion y validacion
4. Capturan la factura en SAE con los datos del panel
   (o importan el archivo cuando esa parte este lista)
5. Generan etiquetas -> se encolan -> la EstacionZebra las imprime sola
   El dashboard muestra el avance (caja X de Y).

---

## Como funciona la impresion (modelo seguro)

- El dashboard manda las etiquetas al backend (quedan "en cola").
- La PC con la Zebra le pregunta al backend cada 5s "hay algo?".
- Cuando hay, jala el trabajo, imprime por USB, y reporta el avance.
- Si una etiqueta falla, reintenta 3 veces. Si la impresora no responde,
  detiene el trabajo y genera una alerta.
- Reimpresion por rango: puedes reimprimir solo las cajas X a Y.

No se abren puertos en tu red: la PC siempre inicia la conexion saliente.

---

## Pendiente (decision futura)
- Factura automatica a SAE: elegiste importar archivo. Falta el layout de
  importacion de tu SAE 10 (lo sacas exportando una factura desde SAE).
- Los otros 7 clientes: junta pedido + factura + etiqueta de cada uno.
