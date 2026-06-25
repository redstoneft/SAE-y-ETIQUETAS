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

/** La estación reporta el avance/resultado de un trabajo de impresión. */
async function reportarImpresion(jobId, { impresas, fallidas, estatus, error_msg }) {
  if (!supabase) { console.log(`[dry] impresión ${jobId}: ${impresas} ok, ${fallidas} fallas`); return; }
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
}

/** Estado de un trabajo de impresión (para avance en dashboard). */
async function estadoTrabajoImpresion(jobId) {
  if (!supabase) return { estatus: "dry", impresas: 0, total: 0 };
  const { data } = await supabase.from("print_queue")
    .select("estatus, impresas, fallidas, total, error_msg").eq("id", jobId).single();
  return data;
}

module.exports = {
  HAS_CREDS,
  getClienteId,
  pedidoExiste,
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
  tomarTrabajoImpresion,
  reportarImpresion,
  estadoTrabajoImpresion,
};
