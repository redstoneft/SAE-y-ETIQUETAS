# Automatización Pedidos Walmart → SAE → Zebra (MVP)

Sistema que toma el PDF de pedido de Walmart (RetailLink), lo valida,
prepara la factura para Aspel SAE (sin timbrar) y genera las etiquetas
Zebra (una por caja).

## Arquitectura

```
PDF Walmart ─► Backend (Node) ─► Supabase (BD + cola)
                  │                    │
                  ├─► Etiquetas ZPL    └─► Agente SAE (.NET, pendiente)
                  │        │                    │
                  │        ▼                    ▼
                  └─► print_station.py ─► Aspel SAE (factura sin timbrar)
                           │
                           ▼
                      Zebra GK420T (USB)
```

## Componentes incluidos

| Archivo | Qué hace | Dónde corre |
|---|---|---|
| `schema_mvp.sql` | Base de datos completa | Supabase (SQL Editor) |
| `backend/` | API que orquesta todo el flujo | Cloud / servidor |
| `printerNetwork.js: imprime directo a la Zebra de red (TCP 9100) |

El backend incluye (en `backend/src/lib/`):
- `walmartExtractor.js` — lee el PDF y saca el JSON (validado con datos reales)
- `validaciones.js` — 11 reglas pre-SAE; si falla, NO avanza a SAE
- `zplEngine.js` — genera el ZPL de la etiqueta Walmart
- `db.js` — persistencia en Supabase (o modo "dry" sin BD para probar)

## Instalación

### 1. Base de datos (Supabase)
Abre el SQL Editor de tu proyecto y corre `schema_mvp.sql`.

### 2. Backend
```bash
cd backend
npm install
# configura credenciales (opcional para probar):
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_SERVICE_KEY="tu-service-key"
export PRINT_STATION_URL="http://127.0.0.1:9100"   # PC con la Zebra
node src/server.js
```
Sin credenciales corre en **modo dry** (no escribe en BD, sirve para probar).

### 3. Estación de impresión (PC con la Zebra)
```bash
# En la PC Windows con la GK420T:
pip install pywin32
python print_station.py
# anota el nombre exacto de la impresora que lista
```

## Flujo de uso (API)

```bash
# 1. Subir PDF -> extrae, valida, guarda
curl -X POST http://localhost:3000/api/pedidos/upload -F "file=@pedido.pdf"
#   -> devuelve pedido_id, estatus (validado|con_errores), validacion, resumen

# 2. Si quedo validado, encolar la factura SAE (sin timbrar)
curl -X POST http://localhost:3000/api/pedidos/{id}/sae
#   -> encola job para el agente; la OC va en referencia_oc

# 3. Generar etiquetas (una por caja)
curl -X POST http://localhost:3000/api/pedidos/{id}/etiquetas
#   -> devuelve el ZPL de cada caja

# 4. Imprimir en la Zebra
curl -X POST http://localhost:3000/api/imprimir \
  -H "Content-Type: application/json" \
  -d '{"etiquetas":[...], "printer":"Zebra GK420T"}'
```

## Reglas de negocio implementadas

- **1 OC = 1 factura** (forzado por índice único en la BD).
- **Anti-duplicado**: un pedido con OC repetida se rechaza (HTTP 409).
- La factura se crea **SIN TIMBRAR**; el agente nunca timbra. El usuario
  revisa y timbra manualmente en SAE.
- La **OC de Walmart va escrita en la factura** (campo referencia_oc).
- El **SKU interno viene en el pedido** (col "Nro Stock de Prov" = SIC24G…),
  igual al de SAE; la descripción la pone SAE de su catálogo.
- Si la validación falla (precio distinto, existencia insuficiente, SKU
  inexistente, etc.), el pedido **no avanza a SAE**.

## Pendiente (siguiente fase)

- **Agente SAE (.NET)**: servicio Windows que toma los jobs de la cola,
  lee Firebird (existencias/clientes) y crea la factura vía SDK de Aspel.
  Requiere confirmar con distribuidor Aspel la vía de escritura para SAE 10.
- **Dashboard** (React) sobre esta API.
- **Calibración fina del ZPL** contra impresión real (usar el calibrador visual).
```
