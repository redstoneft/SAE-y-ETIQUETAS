/**
 * Extractor de pedidos Walmart (RetailLink PDF) -> objeto estructurado.
 * Validado contra PDF real. Texto nativo, sin OCR.
 * Usa la libreria 'pdf-parse' (clase PDFParse).
 */

const { PDFParse } = require("pdf-parse");

function fixEncoding(text) {
  if (text == null) return null;
  return text.replace(/\uFFFD/g, "").replace(/\s+/g, " ").trim();
}

function grab(re, text, group = 1) {
  const m = text.match(re);
  return m ? m[group].trim() : null;
}

function parseDate(d) {
  if (!d) return null;
  const m = d.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return d;
  const [, mo, da, yr] = m;
  return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
}

function extractHeader(text) {
  const h = {};
  h.num_orden_compra = grab(/Purchase Order Number\s+(\d+)/, text);
  h.fecha_pedido = parseDate(grab(/Purchase Order Date\s+([\d/]+)/, text));
  h.fecha_envio = parseDate(grab(/Fecha De Envio\s+([\d/]+)/, text));
  h.fecha_cancelacion = parseDate(grab(/Fecha De Cancelacion\s+([\d/]+)/, text));
  h.tipo_orden = grab(/Tipo De Orden\s+(\d+)/, text);
  h.moneda = grab(/Moneda\s+([A-Z]{3})/, text);
  h.departamento = grab(/Department\s+(\d+)/, text);
  h.evento_promocional = grab(/Promotional Event\s+(.+)/, text);
  h.condicion_pago = grab(/Payment Terms\s+(.+)/, text);
  h.num_proveedor_walmart = grab(/Supplier Number\s+(\d+)/, text);
  h.nombre_proveedor = grab(/Proveedor\s*\n([A-Z][^\n]+)/, text);
  h.formato_tienda = grab(/Formato De Tienda\s*\n(BODEGA|TIENDA)/, text);
  // El destino puede venir como "CD NAVE 1 SECOS 7494" o "SECOS CD GUADALAJARA 7493".
  // Tomamos la línea completa tras "Enviar a:" y de ahí el código de 4-5 dígitos,
  // sin asumir que empiece con "CD".
  h.cedis_nombre = grab(/Enviar a:\s*\n([^\n]+)/, text);
  h.cedis_destino = grab(/Enviar a:\s*\n[^\n]*?(\d{4,5})(?=\s|$)/m, text);
  h.gln_destino = grab(/GLN\s+(\d+)/, text);
  h.instrucciones = grab(/Instrucciones de orden\s*\n([^\n]+)/, text);
  for (const k of Object.keys(h)) {
    if (typeof h[k] === "string") h[k] = fixEncoding(h[k]);
  }
  return h;
}

function extractLines(text) {
  let t = text.replace(/\(GTIN-\s*\n?\s*13\)\s*\n/g, "| ");
  const lines = [];
  const pat = new RegExp(
    "(\\d{3})\\s+" +
    "(\\d+)\\s+" +
    "(\\d+)\\s*\\|\\s*" +
    "(\\S+)\\s+" +
    "(\\S+)\\s+" +
    "(\\d+)\\s+" +
    "(\\w+)\\s+" +
    "(\\d+)\\s*/\\s*(\\d+)\\s+" +
    "([\\d.]+)\\s+" +
    "([\\d.]+)",
    "g"
  );
  let m;
  while ((m = pat.exec(t)) !== null) {
    const cantidad = parseInt(m[6], 10);
    const porCaja = parseInt(m[8], 10);
    const cajas = porCaja ? Math.ceil(cantidad / porCaja) : 0;
    lines.push({
      num_linea: m[1],
      sku_walmart: m[2],
      sku_interno: m[4],
      gtin: m[3],
      color: m[5],
      cantidad,
      uom: m[7],
      piezas_por_caja: porCaja,
      cajas,
      precio_unitario: parseFloat(m[10]),
      total_linea: Math.round(parseFloat(m[11]) * 100) / 100,
    });
  }
  return lines;
}

function extractTotals(text) {
  return {
    total: parseFloat(grab(/Cantidad total ordenada.*?([\d.]+)/, text) || "0"),
    total_lineas: parseInt(grab(/Total artic l\S+\s+(\d+)/, text) || "0", 10),
    total_unidades: parseInt(grab(/Total Unidades Pedidas\s+(\d+)/, text) || "0", 10),
  };
}

async function extractFromBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });
  const res = await parser.getText();
  const full = res.text;

  const header = extractHeader(full);
  const lines = extractLines(full);
  const totals = extractTotals(full);

  const sumaExtendido = Math.round(lines.reduce((a, l) => a + l.total_linea, 0) * 100) / 100;
  const sumaUnidades = lines.reduce((a, l) => a + l.cantidad, 0);
  const totalCajas = lines.reduce((a, l) => a + l.cajas, 0);

  // === DETECCION DE PROBLEMAS DE EXTRACCION ===
  // Si algo no cuadra, marcamos "revisar a mano" en vez de pasar datos malos.
  const problemas = [];

  if (!header.num_orden_compra)
    problemas.push("No se encontró el número de orden de compra");
  if (lines.length === 0)
    problemas.push("No se extrajo ninguna línea de producto");
  if (totals.total_lineas > 0 && lines.length !== totals.total_lineas)
    problemas.push(`Se esperaban ${totals.total_lineas} líneas pero se extrajeron ${lines.length}`);
  if (totals.total > 0 && Math.abs(sumaExtendido - totals.total) >= 0.01)
    problemas.push(`El total calculado (${sumaExtendido}) no coincide con el del PDF (${totals.total})`);
  if (totals.total_unidades > 0 && sumaUnidades !== totals.total_unidades)
    problemas.push(`Las unidades calculadas (${sumaUnidades}) no coinciden con el PDF (${totals.total_unidades})`);

  // Lineas con datos sospechosos (campos vacios o numeros invalidos)
  lines.forEach((l) => {
    if (!l.sku_interno) problemas.push(`Línea ${l.num_linea}: sin SKU interno`);
    if (!l.gtin || l.gtin.length < 8) problemas.push(`Línea ${l.num_linea}: GTIN inválido (${l.gtin})`);
    if (!Number.isInteger(l.cantidad) || l.cantidad <= 0) problemas.push(`Línea ${l.num_linea}: cantidad inválida`);
    if (!l.piezas_por_caja || l.piezas_por_caja <= 0) problemas.push(`Línea ${l.num_linea}: empaque inválido`);
    if (l.precio_unitario == null || isNaN(l.precio_unitario)) problemas.push(`Línea ${l.num_linea}: precio inválido`);
  });

  // Texto del PDF con caracteres de reemplazo en zona de datos = posible PDF raro
  const reemplazos = (full.match(/\uFFFD/g) || []).length;
  if (reemplazos > 10)
    problemas.push(`El PDF tiene muchos caracteres ilegibles (${reemplazos}); revisar codificación`);

  const requiereRevision = problemas.length > 0;

  return {
    cliente: "WALMART",
    encabezado: header,
    lineas: lines,
    totales_pdf: totals,
    control: {
      suma_extendido_calculado: sumaExtendido,
      coincide_total: Math.abs(sumaExtendido - totals.total) < 0.01,
      suma_unidades_calculado: sumaUnidades,
      coincide_unidades: sumaUnidades === totals.total_unidades,
      num_lineas_calculado: lines.length,
      coincide_num_lineas: lines.length === totals.total_lineas,
      total_cajas_etiquetas: totalCajas,
    },
    // NUEVO: bandera y lista de problemas para "revisar a mano"
    extraccion: {
      requiere_revision: requiereRevision,
      problemas,
      confiable: !requiereRevision,
    },
  };
}

module.exports = { extractFromBuffer };
