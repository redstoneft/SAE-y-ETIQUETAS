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

// Renglón de la OC. Tolerante: "PIEZA/PIEZAS/PZA/PZAS/PZ", marca con dígitos o "&",
// código de barras de 12 a 14 dígitos (se normaliza a 13), y renglones partidos en dos
// líneas por el PDF (descripción larga, p.ej. el wok) se vuelven a unir antes de leerlos.
const RE_LINEA = /^(\d{5,7})\s+(.+?)\s+\d+\s+(?:PIEZAS?|PZAS?|PZS?)\s+([A-Z0-9&][A-Z0-9& .-]*?)\s+(\d{12,14})\s+(\S+)\s+([\d.,]+)\s+\d+(?:[.,]\d+)?%\s+\d+(?:[.,]\d+)?%\s+(\d+)\b/i;
const RE_INICIO = /^\d{5,7}\s+\S/;             // empieza como renglón de artículo
const RE_COMPLETO = /\d{12,14}\s+\S+\s+[\d.,]+\s+\d+(?:[.,]\d+)?%\s+\d+(?:[.,]\d+)?%\s+\d+\b/;  // ya trae barras, embalaje, descuentos y cajas

/** "12.00", "4,00" (coma decimal) o "1,200" (miles) → entero. */
function numeroAlsuper(t) {
  t = String(t).trim();
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  return Math.round(parseFloat(t)) || 0;
}

function normalizarGtin(g) {
  g = String(g).replace(/\D/g, "");
  if (g.length === 14 && g[0] === "0") g = g.slice(1);
  if (g.length === 12) g = "0" + g;            // UPC-A → EAN-13
  return g;
}

/** Une los renglones que el PDF partió: un inicio de artículo sin barras/cajas absorbe las líneas siguientes hasta completarse. */
function unirRenglones(lineas) {
  const out = [];
  for (let i = 0; i < lineas.length; i++) {
    let L = lineas[i];
    if (RE_INICIO.test(L) && !RE_COMPLETO.test(L)) {
      let j = i + 1;
      while (j < lineas.length && j <= i + 3 && !RE_INICIO.test(lineas[j])) {
        L = L + " " + lineas[j];
        j++;
        if (RE_COMPLETO.test(L)) break;
      }
      if (RE_COMPLETO.test(L)) i = j - 1;
      else L = lineas[i];
    }
    out.push(L);
  }
  return out;
}

function parsearLineas(text) {
  const crudas = text.split(/\n/).map((L) => L.replace(/\t/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const lineas = [], no_reconocidas = [];
  unirRenglones(crudas).forEach((L) => {
    const m = L.match(RE_LINEA);
    if (m) {
      const desc = m[2].trim();
      const marca = m[3].trim();
      lineas.push({
        articulo: m[1],
        descripcion: /RED STONE/i.test(desc) ? desc : `${desc} ${marca}`.trim(),
        marca,
        gtin: normalizarGtin(m[4]),
        cod_proveedor: m[5],
        embalaje: numeroAlsuper(m[6]),
        cajas: parseInt(m[7], 10),
      });
    } else if (RE_INICIO.test(L) && /\d{12,14}/.test(L)) {
      // parece un artículo (número + código de barras) pero no se pudo leer: se reporta, nunca se calla
      no_reconocidas.push(L.slice(0, 160));
    }
  });
  return { lineas, no_reconocidas };
}

async function extraerAlsuper(buffer) {
  const text = (await new PDFParse({ data: buffer }).getText()).text || "";
  const oc = (text.match(/(\d{5,8})\s+Número de Orden/) || [])[1] || null;
  const { lineas, no_reconocidas } = parsearLineas(text);

  return {
    cliente: "ALSUPER",
    encabezado: { num_orden_compra: oc, proveedor: "207850",
      proveedor_nombre: "FUTUREENTS TECH SA DE CV" },
    lineas,
    no_reconocidas,
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

module.exports = { extraerAlsuper, generarEtiquetasAlsuper, zplAlsuper, parsearLineas };
