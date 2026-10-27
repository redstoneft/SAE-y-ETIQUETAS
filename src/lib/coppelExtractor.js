/**
 * Extractor del REPORTE DE PEDIDOS de COPPEL (Excel, RetailLink/portal COPPEL).
 *
 * A diferencia de Walmart/HEB/Alsuper/Casa Ley (PDF), COPPEL llega en Excel y el
 * reporte NO trae código de barras, color ni descripción formal: solo Código,
 * CEDIS (Número Bodega), Pedido y Cantidad. Esos 3 campos faltantes se completan
 * con un CATALOGO por código (se recuerda entre pedidos) y, lo que falte, lo llena
 * el operador antes de generar etiquetas.
 *
 * Columnas del reporte (por nombre, tolerante a acentos/espacios):
 *   Número Pedido | Fecha Pedido | Fecha Surtir | Departamento | Código |
 *   Artículo | Modelo | Número Bodega | Iniciales Bodega | Bodega Destino | Cantidad de Piezas
 *
 * Una etiqueta = una caja. Si el catálogo trae piezas_caja, el total por CEDIS se
 * parte en varias etiquetas (ej. 36 pz con 18/caja = 2 etiquetas de 18).
 */
const XLSX = require("xlsx");

const NUM_PROVEEDOR = "33456";
const PROVEEDOR_NOMBRE = "FUTUREENTS TECH, S.A DE C.V";

const norm = (s) =>
  String(s == null ? "" : s).toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** Ubica los índices de columna del reporte por nombre de encabezado. */
function mapearColumnas(headers) {
  const h = headers.map(norm);
  const find = (...keys) => h.findIndex((x) => keys.some((k) => x.includes(k)));
  const codigo = h.indexOf("codigo") >= 0 ? h.indexOf("codigo") : find("codigo art", "codigo");
  return {
    pedido: find("numero pedido", "no pedido", "pedido"),
    codigo,
    bod: find("numero bodega", "cedis", "bodega destino", "bodega"),
    bodnom: find("bodega destino", "destino"),
    cant: find("cantidad de piezas", "cantidad", "piezas"),
    articulo: find("articulo"),
    modelo: find("modelo"),
  };
}

/** Parte un total en cajas de `porCaja` piezas (full boxes + remanente). */
function partirEnCajas(total, porCaja) {
  if (!porCaja || porCaja <= 0) return [total];
  const out = [];
  let r = total;
  while (r > porCaja) { out.push(porCaja); r -= porCaja; }
  if (r > 0) out.push(r);
  return out.length ? out : [total];
}

/**
 * Lee el Excel del pedido COPPEL.
 * @param {Buffer} buffer  archivo .xlsx
 * @param {Object} opts.catalogo  { [codigo]: { gtin, descripcion, color, piezas_caja } }
 */
function extraerCoppel(buffer, opts = {}) {
  const catalogo = opts.catalogo || {};
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  // localizar fila de encabezados (la que tenga 'pedido' y 'bodega')
  let hi = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const line = (rows[i] || []).map(norm).join("|");
    if (line.includes("pedido") && line.includes("bodega")) { hi = i; break; }
  }
  const ix = mapearColumnas(rows[hi] || []);
  if (ix.codigo < 0 || ix.bod < 0 || ix.cant < 0) {
    throw new Error("No reconocí las columnas del reporte COPPEL (Código / Número Bodega / Cantidad de Piezas).");
  }

  const lineas = [];
  const faltantes = new Set();
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const codigo = String(r[ix.codigo] == null ? "" : r[ix.codigo]).trim();
    const cedisNum = String(r[ix.bod] == null ? "" : r[ix.bod]).trim();
    if (!codigo || !cedisNum) continue;
    const cat = catalogo[codigo] || {};
    const cantTotal = Number(r[ix.cant]) || 0;
    const cedisNom = ix.bodnom >= 0 ? String(r[ix.bodnom] || "").trim() : "";
    const pedido = ix.pedido >= 0 ? String(r[ix.pedido] || "").trim() : "";
    const descrPedido = [ix.articulo >= 0 ? r[ix.articulo] : "", ix.modelo >= 0 ? r[ix.modelo] : ""]
      .map((x) => String(x || "").trim()).filter(Boolean).join(" ");

    for (const pz of partirEnCajas(cantTotal, Number(cat.piezas_caja) || 0)) {
      lineas.push({
        codigo,
        cedis: cedisNum,
        cedis_nombre: cedisNom,
        pedido,
        piezas: pz,
        // campos del catálogo (pueden venir vacíos → faltantes)
        gtin: cat.gtin || "",
        descripcion: cat.descripcion || "",
        color: cat.color || "",
        descr_pedido: descrPedido,
      });
    }
    if (!cat.gtin || !cat.descripcion || !cat.color) faltantes.add(codigo);
  }

  return {
    cliente: "COPPEL",
    encabezado: { num_proveedor: NUM_PROVEEDOR, proveedor_nombre: PROVEEDOR_NOMBRE },
    lineas,
    faltantes: [...faltantes],
    totales: {
      productos: new Set(lineas.map((l) => l.codigo)).size,
      cedis: new Set(lineas.map((l) => l.cedis)).size,
      pedidos: new Set(lineas.map((l) => l.pedido)).size,
      etiquetas: lineas.length,
    },
  };
}

/**
 * ZPL de una etiqueta de embarque COPPEL (203 dpi, 4"x3").
 * Reproduce la etiqueta física: CEDIS, proveedor, no. proveedor, pedido,
 * código de barras (EAN/GTIN), código de artículo, descripción, color y piezas.
 */
function zplCoppel(l, encabezado) {
  const A = 812, LL = 609, X = 28, FS = 26;
  const ean = String(l.gtin || "").replace(/\D/g, "");
  // descripción envuelta a ~36 chars
  const words = String(l.descripcion || l.descr_pedido || "").split(/\s+/);
  const dl = []; let cur = "";
  words.forEach((w) => { if ((cur + " " + w).trim().length > 36) { dl.push(cur.trim()); cur = w; } else cur = (cur + " " + w).trim(); });
  if (cur) dl.push(cur);

  let y = 26;
  const line = (t, big) => { const fs = big ? 46 : FS; const s = `^FO${X},${y}^A0N,${fs},${fs}^FD${t}^FS\n`; y += (big ? 56 : 36); return s; };
  let z = `^XA\n^CI28\n^PW${A}\n^LL${LL}\n^LH0,0\n`;
  z += line(`${l.cedis} ${l.cedis_nombre}`.trim(), true);   // encabezado grande (CEDIS)
  z += line("PROVEEDOR: " + encabezado.proveedor_nombre);
  z += line("NO. PROVEEDOR: " + encabezado.num_proveedor);
  z += line("NO. DE PEDIDO: " + (l.pedido || ""));
  if (ean) {
    z += `^FO${X},${y}^BY2^BEN,70,Y,N^FD${ean}^FS\n`;
    y += 120;
  }
  z += line("CODIGO ART: " + l.codigo + "        PIEZAS: " + l.piezas);
  if (l.color) z += line("COLOR: " + l.color);
  (dl.length ? dl : [""]).forEach((t) => { z += line(t); });
  z += "^XZ";
  return z;
}

/** Una etiqueta por caja (cada línea ya viene partida por caja en extraerCoppel). */
function generarEtiquetasCoppel(pedido) {
  return pedido.lineas.map((l) => ({
    zpl: zplCoppel(l, pedido.encabezado),
    sku_interno: l.codigo,
    descripcion: l.descripcion || l.descr_pedido,
    cedis: l.cedis,
    piezas: l.piezas,
  }));
}

module.exports = { extraerCoppel, generarEtiquetasCoppel, zplCoppel, NUM_PROVEEDOR, PROVEEDOR_NOMBRE };
