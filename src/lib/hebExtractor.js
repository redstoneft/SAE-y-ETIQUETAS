/**
 * Extractor del PDF de ORDEN DE COMPRA de HEB (Orden Consolidada en México).
 * Devuelve encabezado (OC, proveedor) y líneas con SKU, GTIN, descripción,
 * embalaje (U. por CasePack) y número de cajas (Tot. Pedido Casepack).
 *
 * Los renglones de producto vienen ANTES del encabezado en el texto extraído.
 * La descripción puede partirse en varias líneas.
 */
const { PDFParse } = require("pdf-parse");

function limpiar(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function extraerHEB(buffer) {
  const parsed = await new PDFParse({ data: buffer }).getText();
  const text = parsed.text || "";

  // OC = número de 8-10 dígitos que sigue a "Orden No"
  let oc = null;
  const mOc = text.match(/Orden No[\s\S]*?\b(\d{7,10})\b/);
  if (mOc) oc = mOc[1];
  if (!oc) { const m2 = text.match(/(^|\s)(\d{9})(\s|$)/m); if (m2) oc = m2[2]; }

  // El PDF puede tener varias páginas (productos + encabezado por página).
  // El patrón de renglón es específico, así que corremos el regex sobre TODO
  // el texto para capturar los productos de todas las páginas.
  const blob = text.replace(/\n/g, " ");
  const re = /(\d{5,7})\s+(\d{12,13})\s+(\S+)\s+(.+?)\s+([\d.]+)\s+\S+\s+\S+\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d{2}\/\d{2}\/\d{4})/g;
  const lineas = [];
  let m;
  while ((m = re.exec(blob)) !== null) {
    lineas.push({
      sku: m[1],
      gtin: m[2],
      clave_prov: m[3],
      descripcion: limpiar(m[4]),
      embalaje: Math.round(parseFloat(m[6])),      // U. por CasePack
      cajas: parseInt(m[7], 10),                    // Tot. Pedido Casepack
      total_unidades: Math.round(parseFloat(m[8])),
    });
  }

  return {
    cliente: "HEB",
    encabezado: {
      num_orden_compra: oc,
      proveedor: "13217",
      proveedor_nombre: "FUTUREENTS TECH SA DE CV",
    },
    lineas,
    totales: {
      productos: lineas.length,
      etiquetas: lineas.reduce((a, l) => a + (l.cajas || 0), 0),
      unidades: lineas.reduce((a, l) => a + (l.total_unidades || 0), 0),
    },
  };
}

/** Plantilla ZPL de la etiqueta de caja HEB (texto + EAN13). */
function zplHEB(oc, embalaje, descripcion, sku, gtin) {
  const A = 812, L = 671, XL = 30, FS = 30;
  const ean = String(gtin).replace(/\D/g, "");
  let d1 = descripcion, d2 = "";
  if (descripcion.length > 34) {
    const cut = descripcion.lastIndexOf(" ", 34);
    d1 = descripcion.slice(0, cut > 0 ? cut : 34);
    d2 = descripcion.slice((cut > 0 ? cut : 34) + 1);
  }
  let y = 45;
  const line = (t) => { const s = `^FO${XL},${y}^A0N,${FS},${FS}^FD${t}^FS\n`; y += 48; return s; };
  let z = `^XA\n^CI28\n^PW${A}\n^LL${L}\n^LH0,0\n`;
  z += line("PROVEEDOR: FUTUREENTS TECH SA DE CV");
  z += line("NUMERO DE PROVEEDOR: 13217");
  z += line("ORDEN DE COMPRA: " + (oc || ""));
  z += line("EMBALAJE: " + embalaje + " PIEZAS");
  z += line("DESCRIPCION: " + d1);
  if (d2) z += line(d2);
  z += line("SKU: " + sku);
  z += `^FO210,${Math.max(y + 10, 470)}^BY3^BEN,120,Y,N^FD${ean}^FS\n^XZ`;
  return z;
}

/** Genera todas las etiquetas HEB (una por caja de cada producto). */
function generarEtiquetasHEB(pedido) {
  const oc = pedido.encabezado.num_orden_compra;
  const etiquetas = [];
  pedido.lineas.forEach((l) => {
    const zpl = zplHEB(oc, l.embalaje, l.descripcion, l.sku, l.gtin);
    for (let c = 1; c <= (l.cajas || 0); c++) {
      etiquetas.push({ zpl, sku_interno: l.sku, descripcion: l.descripcion,
        caja_x: c, caja_y: l.cajas });
    }
  });
  return etiquetas;
}

module.exports = { extraerHEB, generarEtiquetasHEB, zplHEB };
