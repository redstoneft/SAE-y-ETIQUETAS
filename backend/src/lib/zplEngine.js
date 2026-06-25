/**
 * Motor de etiquetas ZPL - Walmart (Node).
 * Etiqueta 84 x 101.6 mm @ 203 dpi (GK420T) = 671 x 812 dots.
 * 5 secciones: CEDIS, OC, UPC(EAN13), TOTAL PIEZAS, CONSECUTIVO.
 * Una etiqueta por caja.
 *
 * CALIBRACION: ajusta CFG con los valores del calibrador visual.
 */

const CFG = {
  ancho: 671,
  alto: 812,
  xLabel: 40,
  xBarcode: 250,
  y0: 70,
  dy: 150,
  barcodeH: 90,
  fontSize: 28,
};

function ean13(gtin) {
  const g = String(gtin).replace(/\D/g, "");
  return g.length === 13 ? g : null;
}

function seccion(y, titulo, dato, simbologia, cfg) {
  const out = [];
  out.push(`^FO${cfg.xLabel},${y + 30}^A0N,${cfg.fontSize},${cfg.fontSize}^FD${titulo}^FS`);
  if (simbologia === "EAN13" && ean13(dato)) {
    out.push(`^FO${cfg.xBarcode},${y}^BY2`);
    out.push(`^BEN,${cfg.barcodeH},Y,N^FD${ean13(dato)}^FS`);
  } else {
    out.push(`^FO${cfg.xBarcode},${y}^BY2`);
    out.push(`^BCN,${cfg.barcodeH},Y,N,N^FD${dato}^FS`);
  }
  return out.join("\n");
}

function generarZplEtiqueta({ cedis, oc, gtin, piezasPorCaja, cajaX, cajaY }, cfg = CFG) {
  const p = ["^XA", "^CI28", `^PW${cfg.ancho}`, `^LL${cfg.alto}`, "^LH0,0"];
  p.push(seccion(cfg.y0 + 0 * cfg.dy, "CEDIS", cedis, "C128", cfg));
  p.push(seccion(cfg.y0 + 1 * cfg.dy, "OC", oc, "C128", cfg));
  p.push(seccion(cfg.y0 + 2 * cfg.dy, "UPC", gtin, "EAN13", cfg));
  p.push(seccion(cfg.y0 + 3 * cfg.dy, "TOTAL DE PIEZAS POR CAJA", piezasPorCaja, "C128", cfg));
  p.push(seccion(cfg.y0 + 4 * cfg.dy, "CONSECUTIVO DE CAJA", `${cajaX} DE ${cajaY}`, "C128", cfg));
  p.push("^XZ");
  return p.join("\n");
}

/** Todas las etiquetas de una linea (una por caja). */
function generarEtiquetasLinea(linea, cedis, oc, cfg = CFG) {
  const total = linea.cajas;
  const etiquetas = [];
  for (let i = 1; i <= total; i++) {
    etiquetas.push({
      sku_interno: linea.sku_interno,
      caja_x: i,
      caja_y: total,
      zpl: generarZplEtiqueta({
        cedis, oc, gtin: linea.gtin,
        piezasPorCaja: linea.piezas_por_caja,
        cajaX: i, cajaY: total,
      }, cfg),
    });
  }
  return etiquetas;
}

/** Todas las etiquetas del pedido completo. */
function generarEtiquetasPedido(pedido, cfg = CFG) {
  const cedis = pedido.encabezado.cedis_destino;
  const oc = pedido.encabezado.num_orden_compra;
  const todas = [];
  for (const linea of pedido.lineas) {
    todas.push(...generarEtiquetasLinea(linea, cedis, oc, cfg));
  }
  return todas;
}

module.exports = {
  CFG,
  generarZplEtiqueta,
  generarEtiquetasLinea,
  generarEtiquetasPedido,
};
