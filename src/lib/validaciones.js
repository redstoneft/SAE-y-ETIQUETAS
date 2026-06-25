/**
 * Validaciones pre-SAE.
 * Recibe el pedido extraido + catalogos (de Supabase) y devuelve
 * la lista de errores. Si hay errores, el pedido NO avanza a SAE.
 *
 * Catalogos esperados:
 *   productos: { sku_interno: {...} }           (existencia se lee de SAE via agente)
 *   precios:   { sku_interno: precio_autorizado }
 *   existencias: { sku_interno: cantidad }       (opcional; viene del agente SAE)
 */

function validarPedido(pedido, catalogos = {}) {
  const { productos = {}, precios = {}, existencias = {} } = catalogos;
  const errores = [];

  function err(tipo, descripcion, linea = null, severidad = "error") {
    errores.push({ tipo, descripcion, num_linea: linea, severidad });
  }

  // Encabezado
  if (!pedido.encabezado.num_orden_compra) {
    err("formato", "El pedido no tiene numero de orden de compra");
  }
  if (!pedido.encabezado.cedis_destino) {
    err("formato", "El pedido no tiene CEDIS destino", null, "advertencia");
  }

  // Control de extraccion (totales que no cuadran = extraccion sospechosa)
  if (!pedido.control.coincide_total) {
    err("formato", `El total calculado (${pedido.control.suma_extendido_calculado}) no coincide con el del PDF (${pedido.totales_pdf.total})`);
  }
  if (!pedido.control.coincide_num_lineas) {
    err("formato", "El numero de lineas extraidas no coincide con el del PDF");
  }

  // Lineas
  for (const l of pedido.lineas) {
    const sku = l.sku_interno;

    if (!sku) {
      err("sin_mapeo", `Linea ${l.num_linea}: no se pudo determinar el SKU interno`, l.num_linea);
      continue;
    }

    // SKU existe en catalogo de productos
    if (Object.keys(productos).length && !productos[sku]) {
      err("sku_inexistente", `Linea ${l.num_linea}: SKU ${sku} no existe en el catalogo`, l.num_linea);
    }

    // Precio vs autorizado
    if (precios[sku] != null) {
      const autorizado = Number(precios[sku]);
      const pedido_precio = Number(l.precio_unitario);
      if (Math.abs(autorizado - pedido_precio) > 0.01) {
        err("precio_distinto",
          `Linea ${l.num_linea} (${sku}): precio del pedido ${pedido_precio} difiere del autorizado ${autorizado}`,
          l.num_linea);
      }
    }

    // Existencia (si el agente SAE ya nos paso inventario)
    if (existencias[sku] != null) {
      const disp = Number(existencias[sku]);
      if (disp < l.cantidad) {
        err("existencia_insuficiente",
          `Linea ${l.num_linea} (${sku}): se piden ${l.cantidad} pero hay ${disp} disponibles`,
          l.num_linea);
      }
    }

    // Cantidad valida
    if (!Number.isInteger(l.cantidad) || l.cantidad <= 0) {
      err("formato", `Linea ${l.num_linea}: cantidad invalida (${l.cantidad})`, l.num_linea);
    }
  }

  const soloErrores = errores.filter((e) => e.severidad === "error");
  return {
    valido: soloErrores.length === 0,
    errores,
    num_errores: soloErrores.length,
    num_advertencias: errores.length - soloErrores.length,
  };
}

module.exports = { validarPedido };
