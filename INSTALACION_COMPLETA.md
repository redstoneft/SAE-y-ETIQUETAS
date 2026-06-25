# Instalación completa — Sistema Embarque

Guía para instalar todo de una vez. Asume que manejas GitHub, Netlify y Supabase.
Tiempo estimado: 1-2 horas la primera vez.

Orden: Supabase (base) → Backend (nube) → Dashboard (Netlify) → Estación de
impresión (PC con Zebra). Cada paso se prueba antes de seguir.

---

## PASO 1 · Base de datos (Supabase)  ~15 min

1. Crea un proyecto nuevo en supabase.com (o usa uno existente).
2. Ve a **SQL Editor** → New query.
3. Pega y corre `schema_mvp.sql` completo. (Crea tablas + cliente Walmart.)
4. Pega y corre `schema_v2.sql` completo. (Mejoras: alertas, cola impresión, etc.)
5. Ve a **Settings → API** y copia:
   - **Project URL** (ej. https://abcd.supabase.co)
   - **service_role key** (la secreta, no la anon)
6. **Carga tus catálogos** (Table Editor → import CSV), aunque sea mínimo:
   - `productos`: tus SKU (SIC24G…) con su gtin
   - `precios_autorizados`: cliente_id de Walmart + sku_interno + precio
   - (el cliente Walmart ya quedó sembrado con codigo_interno = WMT)

**Prueba:** en Table Editor debes ver las tablas creadas y el cliente WALMART.

---

## PASO 2 · Backend (nube)  ~20 min

El backend es Node. Recomiendo **Railway** o **Render** (despliegan desde GitHub).

1. Sube la carpeta `backend/` a un repo de GitHub (sin `node_modules`).
2. En Railway/Render, crea un servicio nuevo desde ese repo.
3. Build command: `npm install`  ·  Start command: `node src/server.js`
4. Configura las **variables de entorno**:
   ```
   SUPABASE_URL=https://abcd.supabase.co
   SUPABASE_SERVICE_KEY=tu-service-role-key
   ```
5. Despliega. Anota la URL pública que te dan (ej. https://embarque.up.railway.app).

**Prueba:** abre `https://tu-backend/api/health` en el navegador.
Debe responder: `{"ok":true,"modo":"supabase",...}`
(Si dice "dry", las variables de Supabase no quedaron bien.)

---

## PASO 3 · Dashboard (Netlify)  ~10 min

1. Abre `dashboard.html` y cambia arriba la línea:
   ```
   const API_BASE = "https://tu-backend.up.railway.app";
   ```
   (déjalo SIN slash al final)
2. Sube `dashboard.html` a Netlify (arrastrar y soltar, o desde GitHub).
3. Netlify te da una URL (ej. https://embarque.netlify.app).

**Prueba:** abre esa URL. Arrastra un PDF de Walmart. Debe extraer el pedido.
Arriba debe decir "conectado a https://tu-backend…" (no "modo demo").

---

## PASO 4 · Estación de impresión (PC con la Zebra USB)  ~15 min

Esta es la única pieza local. Corre en la PC que tiene la GK420T por USB.

### Opción rápida (genera el .exe una vez):
En cualquier PC con Python:
```
pip install pyinstaller pywin32 requests
```
Edita `print_station.py` y cambia arriba:
```
BACKEND_URL  = "https://tu-backend.up.railway.app"
PRINTER_NAME = "ZDesigner GK420t"   # nombre EXACTO (ver abajo cómo sacarlo)
ESTACION     = "zebra-01"
```
Genera el ejecutable:
```
pyinstaller --onefile --name EstacionZebra print_station.py
```
Queda `dist/EstacionZebra.exe`. Cópialo a la PC de la Zebra.

### En la PC de la Zebra:
1. Para saber el nombre EXACTO de la impresora: Panel de Control →
   Dispositivos e impresoras → ahí está el nombre. Ponlo en PRINTER_NAME.
2. Doble clic en `EstacionZebra.exe`. Queda corriendo, jalando trabajos.
3. Para que arranque sola al prender la PC: Win+R → escribe `shell:startup`
   → pega ahí un acceso directo del .exe.

**Prueba:** desde el dashboard, carga un pedido, genera etiquetas, e imprime.
En segundos deben salir en la Zebra. La ventana del .exe muestra el avance.

---

## PASO 5 · Probar el archivo de SAE  ~10 min

1. En el dashboard, carga un pedido y dale a generar factura SAE.
   Descarga el archivo `factura_SAE_OC…xlsx`.
2. En SAE (mejor en una **empresa de PRUEBA**), importa ese archivo:
   menú de importación de documentos → selecciona el archivo.
3. Verifica que SAE cree la factura sin timbrar, con folio W-M y la OC.

**Si funciona:** ya tienes el ciclo completo.
**Si SAE marca error:** anota el mensaje exacto y ajustamos el generador.

---

## Resumen de lo que queda corriendo

```
Supabase (base de datos)        ← siempre, en la nube
Backend en Railway/Render       ← siempre, en la nube
Dashboard en Netlify            ← siempre, en la nube
EstacionZebra.exe               ← en la PC de la Zebra (arranca sola)
```

Tu equipo solo abre la URL de Netlify. Nada más.

---

## Variables y datos que ya quedaron fijos

- Cliente Walmart en SAE: clave **3**
- Folio: serie **W-M** (SAE pega el consecutivo)
- Almacén: **11**
- Método pago **PPD** · Forma SAT **99** · Uso CFDI **G01**

Si alguno cambia, se ajusta en `src/lib/saeExport.js` (CONFIG_WALMART).

---

## Pendiente
- Confirmar que SAE acepta el archivo de importación (Paso 5).
- Agregar los otros 7 clientes (pedido + factura + etiqueta de cada uno).
