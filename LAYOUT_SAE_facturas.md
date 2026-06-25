# Layout de importación de facturas — Aspel SAE 10

Archivo .xlsx, hoja "DocFacturas", 32 columnas. Cada renglón = una partida.
Las partidas de una misma factura comparten la columna "Clave" (folio).

## Campos obligatorios
- **Clave**: folio del documento (consecutivo SAE). Mismo para todas las partidas de una factura.
- **Cliente**: clave del cliente en SAE (debe existir en el catálogo).
- **Fecha de elaboración**: DD/MM/AAAA.
- **Clave del artículo**: tu SKU interno (SIC24G…), como está en el catálogo.
- **Cantidad** y **Precio**.

## Campos clave para Walmart
- **Su pedido**: AQUÍ va la OC de Walmart (8834970382). Es el campo de referencia.
- **Método de pago**: PUE (una exhibición) o PPD (diferido). NET 90 = PPD.
- **Forma de Pago SAT**: si es PPD usar 99.
- **Uso CFDI**: ej. G01.

## Lo que SAE toma solo (dejar vacío)
- Impuestos (los toma del catálogo del producto)
- Descripción del producto
- Clave SAT / Unidad SAT (si están en el catálogo)

## Datos de configuración que faltan confirmar
- El folio/serie que usas para facturas de Walmart
- La clave exacta del cliente Walmart en tu SAE
- Tu Uso CFDI y método de pago habituales para Walmart
- El número de almacén (default 1)
