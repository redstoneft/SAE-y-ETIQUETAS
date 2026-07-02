/**
 * Capa de persistencia (Supabase).
 * Guarda pedidos, lineas, validaciones, encola etiquetas y jobs SAE.
 *
 * Configura SUPABASE_URL y SUPABASE_SERVICE_KEY como variables de entorno.
 * Si no estan, exporta funciones en modo "dry" (no escribe, solo loguea)
 * para poder probar el flujo sin credenciales.
 */

const crypto = require("crypto");

let supabase = null;
const HAS_CREDS = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

if (HAS_CREDS) {
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function hashPedido(clienteId, oc) {
  return crypto.createHash("sha256").update(`${clienteId}:${oc}`).digest("hex");
}

/** Busca el cliente WALMART (o lo que se pida) y devuelve su id. */
async function getClienteId(codigoInterno = "WMT") {
  if (!supabase) return "dry-cliente-id";
  const { data, error } = await supabase
    .from("clientes").select("id").eq("codigo_interno", codigoInterno).single();
  if (error) throw new Error(`No se encontro cliente ${codigoInterno}: ${error.message}`);
  return data.id;
}

/** ¿Ya existe este pedido? (anti-duplicado) */
async function pedidoExiste(clienteId, oc) {
  if (!supabase) return false;
  const { data } = await supabase
    .from("pedidos").select("id").eq("cliente_id", clienteId)
    .eq("num_orden_compra", oc).maybeSingle();
  return !!data;
}

/** Inserta el pedido + lineas. Devuelve el pedido_id. */
async function guardarPedido(pedido, clienteId, estatus, docUrl = null) {
  const h = pedido.encabezado;
  if (!supabase) {
    console.log(`[dry] guardarPedido OC ${h.num_orden_compra} estatus=${estatus}`);
    return "dry-pedido-id";
  }
  const { data: ped, error } = await supabase.from("pedidos").insert({
    cliente_id: clienteId,
    num_orden_compra: h.num_orden_compra,
    fecha_pedido: h.fecha_pedido,
    fecha_envio: h.fecha_envio,
    fecha_cancelacion: h.fecha_cancelacion,
    tipo_orden: h.tipo_orden,
    moneda: h.moneda,
    departamento: h.departamento,
    evento_promocional: h.evento_promocional,
    condicion_pago: h.condicion_pago,
    cedis_codigo: h.cedis_destino,
    gln_destino: h.gln_destino,
    formato_tienda: h.formato_tienda,
    instrucciones: h.instrucciones,
    total: pedido.totales_pdf.total,
    total_unidades: pedido.totales_pdf.total_unidades,
    total_lineas: pedido.totales_pdf.total_lineas,
    estatus,
    hash_pedido: hashPedido(clienteId, h.num_orden_compra),
    doc_original_url: docUrl,
  }).select("id").single();

  if (error) throw new Error(`Error guardando pedido: ${error.message}`);
  const pedidoId = ped.id;

  const lineas = pedido.lineas.map((l) => ({
    pedido_id: pedidoId,
    num_linea: l.num_linea,
    sku_cliente: l.sku_walmart,
    sku_interno: l.sku_interno,
    gtin: l.gtin,
    color: l.color,
    cantidad: l.cantidad,
    cantidad_surtir: l.cantidad,
    uom: l.uom,
    piezas_por_caja: l.piezas_por_caja,
    cajas: l.cajas,
    precio_unitario: l.precio_unitario,
    total_linea: l.total_linea,
  }));
  const { error: e2 } = await supabase.from("pedido_lineas").insert(lineas);
  if (e2) throw new Error(`Error guardando lineas: ${e2.message}`);

  return pedidoId;
}

/** Guarda las validaciones fallidas. */
async function guardarValidaciones(pedidoId, errores) {
  if (!errores.length) return;
  if (!supabase) {
    console.log(`[dry] ${errores.length} validaciones para ${pedidoId}`);
    return;
  }
  const rows = errores.map((e) => ({
    pedido_id: pedidoId,
    tipo: e.tipo,
    descripcion: e.descripcion,
    severidad: e.severidad,
  }));
  await supabase.from("pedido_validaciones").insert(rows);
}

/** Encola un job para el agente SAE (crear factura). */
async function encolarFacturaSAE(pedidoId, payload) {
  if (!supabase) {
    console.log(`[dry] encolar factura SAE para ${pedidoId}`);
    return "dry-job-id";
  }
  const { data, error } = await supabase.from("job_queue").insert({
    tipo: "crear_factura",
    pedido_id: pedidoId,
    payload,
  }).select("id").single();
  if (error) throw new Error(`Error encolando job SAE: ${error.message}`);
  return data.id;
}

/** Guarda las etiquetas generadas. */
async function guardarEtiquetas(pedidoId, etiquetas) {
  if (!supabase) {
    console.log(`[dry] ${etiquetas.length} etiquetas para ${pedidoId}`);
    return;
  }
  const rows = etiquetas.map((e) => ({
    pedido_id: pedidoId,
    caja_x: e.caja_x,
    caja_y: e.caja_y,
    zpl_render: e.zpl,
    estatus: "pendiente",
  }));
  // insertar en lotes de 500 para no exceder limites
  for (let i = 0; i < rows.length; i += 500) {
    await supabase.from("etiquetas").insert(rows.slice(i, i + 500));
  }
}

/** Lee catalogos para validacion (productos y precios). */
async function cargarCatalogos(clienteId) {
  if (!supabase) return { productos: {}, precios: {}, existencias: {} };
  const productos = {};
  const precios = {};
  const { data: prods } = await supabase.from("productos").select("sku_interno, descripcion, gtin");
  (prods || []).forEach((p) => { productos[p.sku_interno] = p; });
  const { data: pr } = await supabase.from("precios_autorizados")
    .select("sku_interno, precio").eq("cliente_id", clienteId);
  (pr || []).forEach((p) => { precios[p.sku_interno] = p.precio; });
  return { productos, precios, existencias: {} };
}

/** El agente toma el siguiente job pendiente (lo marca 'tomado'). */
async function tomarSiguienteJob(agenteId) {
  if (!supabase) {
    console.log(`[dry] agente ${agenteId} pide job (no hay en modo dry)`);
    return null;
  }
  // toma el job pendiente mas antiguo
  const { data: jobs } = await supabase
    .from("job_queue").select("*").eq("estatus", "pendiente")
    .order("creado_en", { ascending: true }).limit(1);
  if (!jobs || !jobs.length) return null;
  const job = jobs[0];
  // marcar como tomado
  await supabase.from("job_queue").update({
    estatus: "tomado", agente_id: agenteId, tomado_en: new Date().toISOString(),
  }).eq("id", job.id);
  return {
    id: job.id,
    tipo: job.tipo,
    pedidoId: job.pedido_id,
    payload: job.payload,
  };
}

/** El agente reporta el resultado; actualiza job y pedido. */
async function reportarResultadoJob(jobId, resultado) {
  if (!supabase) {
    console.log(`[dry] resultado job ${jobId}: ${resultado.estatus}`);
    return;
  }
  await supabase.from("job_queue").update({
    estatus: resultado.ok ? "ok" : "error",
    resultado,
    procesado_en: new Date().toISOString(),
  }).eq("id", jobId);

  // actualizar el pedido y el vinculo pedido_sae
  const { data: job } = await supabase
    .from("job_queue").select("pedido_id").eq("id", jobId).single();
  if (job?.pedido_id) {
    const nuevoEstatus = resultado.ok ? "factura_creada" : "error_sae";
    await supabase.from("pedidos").update({ estatus: nuevoEstatus }).eq("id", job.pedido_id);
    if (resultado.ok && resultado.folioSae) {
      await supabase.from("pedido_sae").upsert({
        pedido_id: job.pedido_id,
        tipo_doc: "factura",
        folio_sae: resultado.folioSae,
        estatus_sae: "creada",
        timbrada: false,
        respuesta_sae: resultado,
        procesado_en: new Date().toISOString(),
      }, { onConflict: "pedido_id,tipo_doc" });
    }
  }
}

/** Crea una alerta (en pantalla / para correo). */
async function crearAlerta({ tipo, severidad = "media", titulo, detalle = null, pedidoId = null }) {
  if (!supabase) { console.log(`[dry] alerta ${tipo}: ${titulo}`); return; }
  await supabase.from("alertas").insert({
    tipo, severidad, titulo, detalle, pedido_id: pedidoId,
  });
}

/** Lista alertas no leídas. */
async function listarAlertas(soloNoLeidas = true) {
  if (!supabase) return [];
  let q = supabase.from("alertas").select("*").order("creada_en", { ascending: false }).limit(50);
  if (soloNoLeidas) q = q.eq("leida", false);
  const { data } = await q;
  return data || [];
}

/** Marca una alerta como leída. */
async function marcarAlertaLeida(id) {
  if (!supabase) return;
  await supabase.from("alertas").update({ leida: true }).eq("id", id);
}

/** Registra una acción en la bitácora de auditoría. */
async function auditar({ usuarioId = null, accion, entidad, entidadId = null, antes = null, despues = null, ip = null }) {
  if (!supabase) { console.log(`[dry] auditoría: ${accion} ${entidad}`); return; }
  await supabase.from("auditoria").insert({
    usuario_id: usuarioId, accion, entidad, entidad_id: entidadId,
    datos_antes: antes, datos_despues: despues, ip,
  });
}

/** Historial de pedidos con filtros (OC, estatus, fechas). */
async function buscarHistorial({ oc = null, estatus = null, desde = null, hasta = null, limite = 50 } = {}) {
  if (!supabase) return [];
  let q = supabase.from("v_historial").select("*").order("creado_en", { ascending: false }).limit(limite);
  if (oc) q = q.ilike("num_orden_compra", `%${oc}%`);
  if (estatus) q = q.eq("estatus", estatus);
  if (desde) q = q.gte("creado_en", desde);
  if (hasta) q = q.lte("creado_en", hasta);
  const { data } = await q;
  return data || [];
}

/** Actualiza la cantidad a surtir de una línea (edición antes de mandar). */
async function editarCantidadSurtir(lineaId, nuevaCantidad, usuarioId = null) {
  if (!supabase) { console.log(`[dry] editar línea ${lineaId} -> surtir ${nuevaCantidad}`); return; }
  const { data: antes } = await supabase.from("pedido_lineas").select("cantidad_surtir").eq("id", lineaId).single();
  await supabase.from("pedido_lineas").update({ cantidad_surtir: nuevaCantidad }).eq("id", lineaId);
  await auditar({ usuarioId, accion: "editar_cantidad", entidad: "pedido_linea", entidadId: lineaId,
    antes, despues: { cantidad_surtir: nuevaCantidad } });
}

/** Registra el inicio de un lote de impresión. */
async function crearLoteImpresion(pedidoId, totalEtiquetas, ip, usuarioId = null) {
  if (!supabase) return "dry-lote-id";
  const { data } = await supabase.from("impresion_lotes").insert({
    pedido_id: pedidoId, total_etiquetas: totalEtiquetas, impresora_ip: ip, iniciado_por: usuarioId,
  }).select("id").single();
  return data?.id;
}

/** Actualiza el avance/cierre de un lote de impresión. */
async function actualizarLoteImpresion(loteId, { impresas, fallidas, estatus }) {
  if (!supabase) return;
  const upd = { impresas, fallidas };
  if (estatus) { upd.estatus = estatus; upd.finalizado_en = new Date().toISOString(); }
  await supabase.from("impresion_lotes").update(upd).eq("id", loteId);
}

/** Marca pedido como revisar_manual con sus problemas. */
async function marcarRevisionManual(pedidoId, problemas) {
  if (!supabase) { console.log(`[dry] pedido ${pedidoId} -> revisar_manual`); return; }
  await supabase.from("pedidos").update({
    estatus: "revisar_manual", requiere_revision: true, problemas_extraccion: problemas,
  }).eq("id", pedidoId);
}

/** Encola un trabajo de impresión para que la PC de la Zebra lo jale. */
async function encolarImpresion(pedidoId, etiquetas, estacion = "zebra-01") {
  if (!supabase) { console.log(`[dry] encolar impresión: ${etiquetas.length} etiquetas`); return "dry-print-job"; }
  const { data, error } = await supabase.from("print_queue").insert({
    pedido_id: pedidoId, estacion, etiquetas, total: etiquetas.length,
  }).select("id").single();
  if (error) throw new Error(`Error encolando impresión: ${error.message}`);
  return data.id;
}

/** La estación de impresión jala el siguiente trabajo pendiente. */
async function tomarTrabajoImpresion(estacion = "zebra-01") {
  if (!supabase) return null;
  const { data: jobs } = await supabase.from("print_queue")
    .select("*").eq("estatus", "pendiente").eq("estacion", estacion)
    .order("creado_en", { ascending: true }).limit(1);
  if (!jobs || !jobs.length) return null;
  const job = jobs[0];
  await supabase.from("print_queue").update({
    estatus: "tomado", tomado_en: new Date().toISOString(),
  }).eq("id", job.id);
  return { id: job.id, pedido_id: job.pedido_id, etiquetas: job.etiquetas, total: job.total };
}

/** La estación reporta el avance/resultado. Devuelve {cancelar} para que la
 *  estación se detenga si el usuario canceló el trabajo. */
async function reportarImpresion(jobId, { impresas, fallidas, estatus, error_msg }) {
  if (!supabase) { console.log(`[dry] impresión ${jobId}: ${impresas} ok, ${fallidas} fallas`); return { cancelar: false }; }
  // Si el trabajo fue cancelado, no lo sobreescribimos; avisamos a la estación.
  const { data: cur } = await supabase.from("print_queue").select("estatus").eq("id", jobId).single();
  if (cur && cur.estatus === "cancelado") {
    await supabase.from("print_queue").update({ impresas, fallidas }).eq("id", jobId);
    return { cancelar: true };
  }
  const upd = { impresas, fallidas, estatus };
  if (estatus === "completo" || estatus === "error") upd.completado_en = new Date().toISOString();
  if (error_msg) upd.error_msg = error_msg;
  await supabase.from("print_queue").update(upd).eq("id", jobId);

  if (fallidas > 0 || estatus === "error") {
    await crearAlerta({
      tipo: "impresora_sin_respuesta", severidad: fallidas > 0 ? "media" : "alta",
      titulo: estatus === "error" ? "Falló un trabajo de impresión" : `${fallidas} etiquetas fallaron`,
      detalle: error_msg || "Revisar la impresora Zebra",
    });
  }
  return { cancelar: false };
}

/** Cancela un trabajo de impresión en curso (la estación se detiene al reportar). */
async function cancelarImpresion(jobId) {
  if (!supabase) return;
  await supabase.from("print_queue")
    .update({ estatus: "cancelado", completado_en: new Date().toISOString() })
    .eq("id", jobId).in("estatus", ["pendiente", "tomado", "imprimiendo"]);
}

/** Estado de un trabajo de impresión (para avance en dashboard). */
async function estadoTrabajoImpresion(jobId) {
  if (!supabase) return { estatus: "dry", impresas: 0, total: 0 };
  const { data } = await supabase.from("print_queue")
    .select("estatus, impresas, fallidas, total, error_msg").eq("id", jobId).single();
  return data;
}

/** Plantilla ZPL de la etiqueta de caja de HEB (texto + 1 código EAN13).
 *  Marcadores {{oc}} {{embalaje}} {{descripcion}} {{sku}} {{gtin}}. */
const HEB_ZPL =
`^XA
^CI28
^PW812^LL671^LH0,0
^FO30,45^A0N,30,30^FDPROVEEDOR: FUTUREENTS TECH SA DE CV^FS
^FO30,93^A0N,30,30^FDNUMERO DE PROVEEDOR: 13217^FS
^FO30,141^A0N,30,30^FDORDEN DE COMPRA: {{oc}}^FS
^FO30,189^A0N,30,30^FDEMBALAJE: {{embalaje}} PIEZAS^FS
^FO30,237^A0N,30,30^FDDESCRIPCION: {{descripcion}}^FS
^FO30,285^A0N,30,30^FDSKU: {{sku}}^FS
^FO210,470^BY3^BEN,120,Y,N^FD{{gtin}}^FS
^XZ`;

/** Plantilla ZPL de la etiqueta de caja de ALSUPER (texto + EAN13).
 *  Marcadores {{embalaje}} {{descripcion}} {{gtin}}. */
const ALSUPER_ZPL =
`^XA
^CI28
^PW812^LL671^LH0,0
^FO30,70^A0N,32,32^FDPROVEEDOR: FUTUREENTS TECH SA DE CV^FS
^FO30,124^A0N,32,32^FDEMBALAJE: {{embalaje}} PIEZAS^FS
^FO30,178^A0N,32,32^FDDESCRIPCION: {{descripcion}}^FS
^FO150,430^BY3^BEN,130,Y,N^FD{{gtin}}^FS
^XZ`;

/** Da de alta un cliente + su plantilla de etiqueta (idempotente). */
async function darDeAltaCliente({ codigo, nombre, numProv, nombreTpl, zpl }) {
  if (!supabase) return;
  try {
    let { data: cli } = await supabase.from("clientes").select("id")
      .eq("codigo_interno", codigo).maybeSingle();
    let clienteId = cli && cli.id;
    if (!clienteId) {
      const { data } = await supabase.from("clientes").insert({
        nombre, codigo_interno: codigo, metodo_extraccion: "archivo",
        num_proveedor: numProv || null, activo: true,
      }).select("id").single();
      clienteId = data.id;
      console.log(`[seed] cliente ${codigo} dado de alta:`, clienteId);
    }
    const { data: tpl } = await supabase.from("plantillas_zpl").select("id")
      .eq("cliente_id", clienteId).eq("nombre", nombreTpl).maybeSingle();
    if (!tpl) {
      await supabase.from("plantillas_zpl").insert({
        cliente_id: clienteId, nombre: nombreTpl, zpl_template: zpl,
        ancho_mm: 101.6, alto_mm: 84, activa: true,
      });
      console.log(`[seed] plantilla ${nombreTpl} dada de alta`);
    }
  } catch (e) {
    console.log(`[seed] ${codigo}:`, e.message);
  }
}

/** Da de alta los artículos de un pedido en el catálogo (idempotente):
 *  productos (sku_interno = nuestra clave, gtin, descripción) y
 *  sku_map (sku del cliente -> nuestra clave). */
async function registrarArticulos(clienteCodigo, lineas) {
  if (!supabase) return { productos: 0, mapeos: 0 };
  let clienteId;
  try { clienteId = await getClienteId(clienteCodigo); } catch (e) { return { productos: 0, mapeos: 0 }; }

  // nuestra clave: cod_proveedor (Alsuper) o el sku/articulo del cliente
  const norm = (l) => ({
    claveInterna: (l.cod_proveedor || l.sku || l.articulo || "").toString().trim(),
    skuCliente: (l.articulo || l.sku || "").toString().trim(),
    gtin: l.gtin, descripcion: l.descripcion,
  });
  const items = lineas.map(norm).filter((x) => x.claveInterna && x.skuCliente);

  // productos (dedup por claveInterna)
  const vistos = {};
  const prods = items.filter((x) => !vistos[x.claveInterna] && (vistos[x.claveInterna] = 1))
    .map((x) => ({ sku_interno: x.claveInterna, descripcion: x.descripcion, gtin: x.gtin, activo: true }));
  if (prods.length) {
    const { error } = await supabase.from("productos").upsert(prods, { onConflict: "sku_interno" });
    if (error) console.log("[catalogo] productos:", error.message);
  }
  // sku_map (dedup por skuCliente)
  const vistos2 = {};
  const maps = items.filter((x) => !vistos2[x.skuCliente] && (vistos2[x.skuCliente] = 1))
    .map((x) => ({ cliente_id: clienteId, sku_cliente: x.skuCliente,
      sku_interno: x.claveInterna, descripcion_cliente: x.descripcion }));
  if (maps.length) {
    const { error } = await supabase.from("sku_map").upsert(maps, { onConflict: "cliente_id,sku_cliente" });
    if (error) console.log("[catalogo] sku_map:", error.message);
  }
  return { productos: prods.length, mapeos: maps.length };
}

/** Plantilla ZPL de la etiqueta de caja de CASA LEY (texto + UPC EAN13 + DUN-14). */
const CASALEY_ZPL =
`^XA
^CI28
^PW812^LL671^LH0,0
^FO30,34^A0N,27,27^FDPROVEEDOR: FUTUREENTS TECH SA DE CV^FS
^FO30,74^A0N,27,27^FDNUMERO DE PROVEEDOR SAP: 1018566^FS
^FO30,114^A0N,27,27^FDORDEN DE COMPRA: {{oc}}^FS
^FO30,154^A0N,27,27^FDEMBALAJE: {{embalaje}} PIEZAS^FS
^FO30,194^A0N,27,27^FDDESCRIPCION: {{descripcion}}^FS
^FO30,274^A0N,27,27^FDSKU: {{sku}}^FS
^FO250,320^BY2^BEN,70,Y,N^FD{{gtin}}^FS
^FO120,450^BY2^B2N,70,N,N,N^FD{{dun14}}^FS
^FO120,532^A0N,24,24^FDDUN 14  {{dun14}}^FS
^XZ`;

/** Da de alta HEB, Alsuper y Casa Ley (cliente + plantilla). */
async function seedHEB() {
  await darDeAltaCliente({ codigo: "HEB", nombre: "HEB", numProv: "13217", nombreTpl: "HEB caja", zpl: HEB_ZPL });
  await darDeAltaCliente({ codigo: "ALSUPER", nombre: "Alsuper", numProv: "207850", nombreTpl: "Alsuper caja", zpl: ALSUPER_ZPL });
  await darDeAltaCliente({ codigo: "CASALEY", nombre: "Casa Ley", numProv: "1018566", nombreTpl: "Casa Ley caja", zpl: CASALEY_ZPL });
}

/** Reconstruye un pedido completo (encabezado + líneas) para reabrirlo en el
 *  dashboard, con la misma forma que produce el extractor. */
async function obtenerPedidoCompleto(id) {
  if (!supabase) return null;
  const { data: ped } = await supabase.from("pedidos").select("*").eq("id", id).single();
  if (!ped) return null;
  const { data: lns } = await supabase.from("pedido_lineas")
    .select("*").eq("pedido_id", id).order("num_linea", { ascending: true });
  const lineas = (lns || []).map((l) => ({
    num_linea: l.num_linea, sku_walmart: l.sku_cliente, sku_interno: l.sku_interno,
    gtin: l.gtin, color: l.color, cantidad: l.cantidad, cantidad_surtir: l.cantidad_surtir,
    uom: l.uom, piezas_por_caja: l.piezas_por_caja, cajas: l.cajas,
    precio_unitario: l.precio_unitario, total_linea: l.total_linea,
  }));
  const totalCajas = lineas.reduce((a, l) => a + (l.cajas || 0), 0);
  return {
    _id: ped.id, cliente: "WALMART", estatus: ped.estatus,
    encabezado: {
      num_orden_compra: ped.num_orden_compra, fecha_pedido: ped.fecha_pedido,
      fecha_envio: ped.fecha_envio, fecha_cancelacion: ped.fecha_cancelacion,
      tipo_orden: ped.tipo_orden, moneda: ped.moneda, departamento: ped.departamento,
      evento_promocional: ped.evento_promocional, condicion_pago: ped.condicion_pago,
      cedis_destino: ped.cedis_codigo, cedis_nombre: ped.cedis_codigo,
      gln_destino: ped.gln_destino, formato_tienda: ped.formato_tienda,
      instrucciones: ped.instrucciones, num_proveedor_walmart: "", nombre_proveedor: "",
    },
    lineas,
    totales_pdf: { total: ped.total, total_lineas: ped.total_lineas, total_unidades: ped.total_unidades },
    control: {
      total_cajas_etiquetas: totalCajas,
      coincide_total: true, coincide_unidades: true, coincide_num_lineas: true,
    },
  };
}

/** Elimina un pedido y, por cascada (FK on delete cascade), sus líneas,
 *  validaciones, factura SAE, etiquetas y cola de impresión. */
async function eliminarPedido(id) {
  if (!supabase) { console.log(`[dry] eliminar pedido ${id}`); return; }
  const { error } = await supabase.from("pedidos").delete().eq("id", id);
  if (error) throw new Error(`Error eliminando pedido: ${error.message}`);
}

/** Elimina TODOS los pedidos (con cascada). Devuelve cuántos había. */
async function eliminarTodosLosPedidos() {
  if (!supabase) { console.log("[dry] eliminar todos los pedidos"); return 0; }
  const { data: ids } = await supabase.from("pedidos").select("id");
  const n = (ids || []).length;
  // Supabase exige un filtro para borrar; este matchea todo.
  const { error } = await supabase.from("pedidos")
    .delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (error) throw new Error(`Error eliminando pedidos: ${error.message}`);
  return n;
}

module.exports = {
  HAS_CREDS,
  getClienteId,
  pedidoExiste,
  eliminarPedido,
  eliminarTodosLosPedidos,
  guardarPedido,
  guardarValidaciones,
  encolarFacturaSAE,
  guardarEtiquetas,
  cargarCatalogos,
  tomarSiguienteJob,
  reportarResultadoJob,
  crearAlerta,
  listarAlertas,
  marcarAlertaLeida,
  auditar,
  buscarHistorial,
  editarCantidadSurtir,
  crearLoteImpresion,
  actualizarLoteImpresion,
  marcarRevisionManual,
  encolarImpresion,
  obtenerPedidoCompleto,
  registrarArticulos,
  seedHEB,
  tomarTrabajoImpresion,
  reportarImpresion,
  cancelarImpresion,
  estadoTrabajoImpresion,
};
