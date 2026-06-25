/**
 * Impresión avanzada: reintentos, avance por caja, reimpresión de rango.
 * Usa printerNetwork para el envío TCP a la Zebra de red.
 */

const { imprimirEnRed, probarImpresora } = require("./printerNetwork");

/**
 * Imprime una lista de etiquetas una por una, con:
 *  - reintentos por etiqueta (hasta maxIntentos)
 *  - callback de avance ("caja X de Y")
 *  - detención si la impresora deja de responder
 *
 * @param {Array} etiquetas  [{caja_x, caja_y, zpl, sku_interno}]
 * @param {string} ip        IP de la impresora
 * @param {object} opts      { maxIntentos, onAvance(progreso), desde, hasta }
 * @returns {object} resumen { total, impresas, fallidas, errores }
 */
async function imprimirConAvance(etiquetas, ip, opts = {}) {
  const maxIntentos = opts.maxIntentos || 3;
  const onAvance = opts.onAvance || (() => {});
  // rango opcional: reimprimir solo de la caja 'desde' a 'hasta'
  let lista = etiquetas;
  if (opts.desde || opts.hasta) {
    const d = opts.desde || 1;
    const h = opts.hasta || etiquetas.length;
    lista = etiquetas.filter((e, i) => (i + 1) >= d && (i + 1) <= h);
  }

  // Verificar impresora antes de empezar un lote grande
  const estado = await probarImpresora(ip);
  if (!estado.ok) {
    return {
      total: lista.length, impresas: 0, fallidas: lista.length,
      detenido: true,
      errores: [`La impresora ${ip} no responde: ${estado.error}. No se imprimió nada.`],
    };
  }

  let impresas = 0, fallidas = 0;
  const errores = [];

  for (let i = 0; i < lista.length; i++) {
    const et = lista[i];
    let ok = false, ultimoError = null;

    for (let intento = 1; intento <= maxIntentos && !ok; intento++) {
      try {
        await imprimirEnRed(et.zpl, ip);
        ok = true;
      } catch (e) {
        ultimoError = e.message;
        // si falla, esperar un poco antes de reintentar
        await new Promise((r) => setTimeout(r, 500 * intento));
      }
    }

    if (ok) {
      impresas++;
    } else {
      fallidas++;
      errores.push(`Etiqueta ${et.sku_interno} caja ${et.caja_x}: ${ultimoError}`);
      // Si fallan 3 seguidas, probablemente la impresora murió: detener
      if (fallidas >= 3 && impresas === 0) {
        errores.push("Demasiadas fallas seguidas; se detiene el lote. Revisa la impresora.");
        onAvance({ actual: i + 1, total: lista.length, impresas, fallidas, detenido: true });
        return { total: lista.length, impresas, fallidas, detenido: true, errores };
      }
    }

    onAvance({ actual: i + 1, total: lista.length, impresas, fallidas, detenido: false,
      sku: et.sku_interno, caja: `${et.caja_x} de ${et.caja_y}` });
  }

  return { total: lista.length, impresas, fallidas, detenido: false, errores };
}

module.exports = { imprimirConAvance };
