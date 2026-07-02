/**
 * Extractor del PDF de ORDEN DE COMPRA de Casa Ley (SEC/SAP).
 * Renglón: <Fam> <Cant(=cajas)> <Cont(=emb)/x> PZ <Descripción> <Modelo> <UPC13> <PreLista>
 * Cant = número de cajas (= etiquetas). Cont "12/1" = 12 piezas por caja.
 */
const { PDFParse } = require("pdf-parse");

const NUM_PROVEEDOR_SAP = "1018566";
const RE_LINEA = /^(\d{2}-\d{3})\s+(\d+)\s+(\d+)\/\d+\s+\S+\s+(.+?)\s+(\S+)\s+(\d{13})\s+([\d.,]+)$/;

/** GTIN-14 (DUN-14) a partir del EAN-13: "1" + 12 dígitos + dígito control. */
function gtin14(ean13) {
  const base = "1" + String(ean13).replace(/\D/g, "").slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += (+base[12 - i]) * (i % 2 === 0 ? 3 : 1);
  return base + ((10 - (sum % 10)) % 10);
}

async function extraerCasaLey(buffer) {
  const text = (await new PDFParse({ data: buffer }).getText()).text || "";
  const oc = (text.match(/Orden de Compra No\.?:?\s*(\d+)/i) || [])[1] || null;

  const lineas = [];
  text.split(/\n/).forEach((L) => {
    const m = L.replace(/\t/g, " ").trim().match(RE_LINEA);
    if (m) {
      // a veces la marca se pega al SKU sin espacio: "REDSTONECAPM75G" -> "CAPM75G"
      const modelo = m[5].replace(/^RED\s*STONE_?/i, "").replace(/^REDSTONE/i, "");
      lineas.push({
        fam: m[1],
        cajas: parseInt(m[2], 10),        // Cant = cajas
        embalaje: parseInt(m[3], 10),     // Cont "12/1" -> 12
        descripcion: m[4].trim(),
        modelo,                           // nuestro SKU (SIC24G, CAPM75B...)
        gtin: m[6],
      });
    }
  });

  return {
    cliente: "CASALEY",
    encabezado: { num_orden_compra: oc, proveedor_sap: NUM_PROVEEDOR_SAP,
      proveedor_nombre: "FUTUREENTS TECH SA DE CV" },
    lineas,
    totales: {
      productos: lineas.length,
      etiquetas: lineas.reduce((a, l) => a + (l.cajas || 0), 0),
    },
  };
}

/** ZPL de una etiqueta Casa Ley (texto + UPC EAN13 + DUN-14 ITF-14). */
function zplCasaLey(oc, embalaje, descripcion, sku, gtin) {
  const A = 812, L = 671, XL = 30, FS = 27;
  const ean = String(gtin).replace(/\D/g, ""); const dun = gtin14(ean);
  const words = (descripcion + " RED STONE").split(" ");
  const lines = []; let cur = "";
  words.forEach((w) => { if ((cur + " " + w).trim().length > 34) { lines.push(cur.trim()); cur = w; } else cur = (cur + " " + w).trim(); });
  if (cur) lines.push(cur);
  let y = 34; const line = (t) => { const s = `^FO${XL},${y}^A0N,${FS},${FS}^FD${t}^FS\n`; y += 40; return s; };
  let z = `^XA\n^CI28\n^PW${A}\n^LL${L}\n^LH0,0\n`;
  z += line("PROVEEDOR: FUTUREENTS TECH SA DE CV");
  z += line("NUMERO DE PROVEEDOR SAP: " + NUM_PROVEEDOR_SAP);
  z += line("ORDEN DE COMPRA: " + (oc || ""));
  z += line("EMBALAJE: " + embalaje + " PIEZAS");
  z += line("DESCRIPCION: " + (lines[0] || ""));
  for (let i = 1; i < lines.length; i++) z += line(lines[i]);
  z += line("SKU: " + sku);
  z += `^FO250,${y + 6}^BY2^BEN,70,Y,N^FD${ean}^FS\n`; y += 120;
  z += `^FO120,${y}^BY2^B2N,70,N,N,N^FD${dun}^FS\n`;
  z += `^FO120,${y + 82}^A0N,24,24^FDDUN 14  ${dun}^FS\n`;
  z += "^XZ";
  return z;
}

function generarEtiquetasCasaLey(pedido) {
  const et = [];
  pedido.lineas.forEach((l) => {
    const zpl = zplCasaLey(pedido.encabezado.num_orden_compra, l.embalaje, l.descripcion, l.modelo, l.gtin);
    for (let c = 1; c <= (l.cajas || 0); c++) et.push({ zpl, sku_interno: l.modelo, descripcion: l.descripcion });
  });
  return et;
}

module.exports = { extraerCasaLey, generarEtiquetasCasaLey, zplCasaLey, gtin14 };
