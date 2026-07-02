/**
 * Extractor del PDF de ORDEN DE COMPRA de Alsuper.
 * Devuelve OC (Número de Orden) y líneas con artículo, descripción, marca,
 * GTIN (C.Barras), código de proveedor, embalaje (piezas por caja) y cajas
 * (Cant.Ord).
 *
 * Formato de renglón:
 *   <art> <descripcion> <F.Empaque> <marca> <GTIN13> <CodProv> <embalaje> <d1>% <d2>% <cajas> ...
 */
const { PDFParse } = require("pdf-parse");

const RE_LINEA = /^(\d{5,7})\s+(.+?)\s+\d+\s+PIEZAS?\s+([A-Z][A-Z ]+?)\s+(\d{13})\s+(\S+)\s+([\d.,]+)\s+\d+%\s+\d+%\s+(\d+)\b/;

async function extraerAlsuper(buffer) {
  const text = (await new PDFParse({ data: buffer }).getText()).text || "";
  const oc = (text.match(/(\d{5,8})\s+Número de Orden/) || [])[1] || null;

  const lineas = [];
  text.split(/\n/).forEach((L) => {
    const m = L.replace(/\t/g, " ").match(RE_LINEA);
    if (m) {
      const desc = m[2].trim();
      const marca = m[3].trim();
      lineas.push({
        articulo: m[1],
        descripcion: /RED STONE/i.test(desc) ? desc : `${desc} ${marca}`.trim(),
        marca,
        gtin: m[4],
        cod_proveedor: m[5],
        embalaje: Math.round(parseFloat(m[6].replace(/,/g, ""))),
        cajas: parseInt(m[7], 10),
      });
    }
  });

  return {
    cliente: "ALSUPER",
    encabezado: { num_orden_compra: oc, proveedor: "207850",
      proveedor_nombre: "FUTUREENTS TECH SA DE CV" },
    lineas,
    totales: {
      productos: lineas.length,
      etiquetas: lineas.reduce((a, l) => a + (l.cajas || 0), 0),
    },
  };
}

/** ZPL de una etiqueta Alsuper (PROVEEDOR, EMBALAJE, DESCRIPCION, EAN13). */
function zplAlsuper(embalaje, descripcion, gtin) {
  const A = 812, L = 671, XL = 30, FS = 32;
  const ean = String(gtin).replace(/\D/g, "");
  let d1 = descripcion, d2 = "";
  if (descripcion.length > 30) {
    const cut = descripcion.lastIndexOf(" ", 30);
    d1 = descripcion.slice(0, cut > 0 ? cut : 30);
    d2 = descripcion.slice((cut > 0 ? cut : 30) + 1);
  }
  let y = 70;
  const line = (t) => { const s = `^FO${XL},${y}^A0N,${FS},${FS}^FD${t}^FS\n`; y += 54; return s; };
  let z = `^XA\n^CI28\n^PW${A}\n^LL${L}\n^LH0,0\n`;
  z += line("PROVEEDOR: FUTUREENTS TECH SA DE CV");
  z += line("EMBALAJE: " + embalaje + " PIEZAS");
  z += line("DESCRIPCION: " + d1);
  if (d2) z += line(d2);
  z += `^FO150,${Math.max(y + 30, 430)}^BY3^BEN,130,Y,N^FD${ean}^FS\n^XZ`;
  return z;
}

function generarEtiquetasAlsuper(pedido) {
  const et = [];
  pedido.lineas.forEach((l) => {
    const zpl = zplAlsuper(l.embalaje, l.descripcion, l.gtin);
    for (let c = 1; c <= (l.cajas || 0); c++) et.push({ zpl, sku_interno: l.articulo, descripcion: l.descripcion });
  });
  return et;
}

module.exports = { extraerAlsuper, generarEtiquetasAlsuper, zplAlsuper };
