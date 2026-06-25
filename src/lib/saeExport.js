/**
 * Generador del archivo de importación de FACTURAS para Aspel SAE 10.
 * Produce un .xlsx con el layout EXACTO que SAE espera (hoja DocFacturas,
 * 32 columnas). El usuario lo importa en SAE -> SAE crea la factura SIN
 * timbrar, respetando folios e impuestos con su propia lógica.
 *
 * Cada partida (línea de producto) es un renglón con la MISMA Clave de
 * documento, para que SAE las agrupe en una sola factura.
 *
 * El campo "Su pedido" lleva la OC de Walmart (requisito del retailer).
 */

const XLSX = require("xlsx");

// Configuración por defecto para WALMART (datos reales confirmados).
// El folio "W-M" es la serie; SAE asigna el consecutivo al importar
// (confirmar al primer import; si SAE pide número completo, ver README).
const CONFIG_WALMART = {
  folio: "W-M",          // serie de facturas Walmart
  clienteSae: "3",       // clave del cliente Walmart en SAE
  metodoPago: "PPD",     // pago diferido (NET 90)
  formaPagoSat: "99",    // por definir (corresponde a PPD)
  usoCfdi: "G01",        // adquisición de mercancías
  almacen: 11,           // almacén 11
  usarCantidadSurtir: true,
};

// Las 32 columnas en el orden EXACTO del layout de SAE.
const COLUMNAS = [
  "Clave", "Cliente", "Fecha de elaboración", "Su pedido", "Clave del artículo",
  "Cantidad", "Precio", "Desc. 1", "Desc. 2", "Desc. 3", "Clave de vendedor",
  "Comisión", "Clave de esquema de impuestos", "Impuesto 1", "Impuesto 2",
  "Impuesto 3", "Impuesto 4", "Impuesto 5", "Impuesto 6", "Impuesto 7",
  "Impuesto 8", "Método de pago", "Forma de Pago SAT", "Uso CFDI", "Clave SAT",
  "Unidad SAT", "Observaciones", "Observaciones de partida", "Fecha de entrega",
  "Fecha de vencimiento", "Número de almacén cabecera", "Número de almacén partidas",
];

function fechaSAE(d) {
  // SAE espera DD/MM/AAAA
  const dt = d ? new Date(d) : new Date();
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

/**
 * Construye los renglones de la factura.
 * @param {object} pedido   pedido extraído (con encabezado y lineas)
 * @param {object} cfg      configuración fija del cliente en SAE:
 *   {
 *     folio,                 // Clave del documento (consecutivo SAE), ej "FACT-1025"
 *     clienteSae,            // clave del cliente Walmart en SAE
 *     metodoPago,            // "PUE" o "PPD"
 *     formaPagoSat,          // "01", "99", etc.
 *     usoCfdi,               // "G01", etc.
 *     almacen,               // número de almacén (default 1)
 *     fechaElaboracion,      // opcional, default hoy
 *     usarCantidadSurtir,    // true = usa cantidad_surtir; false = cantidad pedida
 *   }
 */
function construirRenglones(pedido, cfg) {
  const fecha = fechaSAE(cfg.fechaElaboracion);
  const oc = pedido.encabezado.num_orden_compra;

  return pedido.lineas.map((l) => {
    const cantidad = cfg.usarCantidadSurtir && l.cantidad_surtir != null
      ? l.cantidad_surtir : l.cantidad;

    // un objeto por las 32 columnas (vacío donde no aplica)
    const row = {};
    COLUMNAS.forEach((c) => { row[c] = ""; });

    row["Clave"] = cfg.folio;                 // misma para todas las partidas
    row["Cliente"] = cfg.clienteSae;
    row["Fecha de elaboración"] = fecha;
    row["Su pedido"] = oc;                     // OC de Walmart
    row["Clave del artículo"] = l.sku_interno; // SIC24G...
    row["Cantidad"] = cantidad;
    row["Precio"] = l.precio_unitario;
    row["Método de pago"] = cfg.metodoPago || "PUE";
    row["Forma de Pago SAT"] = cfg.formaPagoSat || "01";
    row["Uso CFDI"] = cfg.usoCfdi || "G01";
    row["Número de almacén cabecera"] = cfg.almacen || 1;
    row["Número de almacén partidas"] = cfg.almacen || 1;
    // impuestos y descripción los toma SAE del catálogo del producto (vacío)
    return row;
  });
}

/**
 * Genera el archivo .xlsx listo para importar en SAE.
 * Devuelve un Buffer (para descargar o guardar).
 */
function generarArchivoSAE(pedido, cfg) {
  if (!cfg.folio) throw new Error("Falta el folio (Clave del documento) para SAE");
  if (!cfg.clienteSae) throw new Error("Falta la clave del cliente en SAE");

  const renglones = construirRenglones(pedido, cfg);

  // hoja con encabezados exactos
  const ws = XLSX.utils.json_to_sheet(renglones, { header: COLUMNAS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "DocFacturas");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = { generarArchivoSAE, construirRenglones, COLUMNAS, CONFIG_WALMART };
