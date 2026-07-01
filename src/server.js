/**
 * BACKEND - Automatizacion pedidos Walmart -> SAE -> Zebra
 * ========================================================
 * Orquesta el flujo completo:
 *   subir PDF -> extraer -> validar -> guardar -> encolar SAE -> etiquetas -> imprimir
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/pedidos/upload      (multipart: file=PDF)  -> extrae, valida, guarda
 *   POST /api/pedidos/:id/sae      -> encola creacion de factura en SAE
 *   POST /api/pedidos/:id/etiquetas -> genera ZPL de todas las cajas
 *   POST /api/imprimir            (body: {zpl|etiquetas, printer}) -> manda a print_station
 *
 * Config por entorno:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  (si faltan, corre en modo "dry")
 *   PRINT_STATION_URL  (default http://127.0.0.1:9100)
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const { extractFromBuffer } = require("./lib/walmartExtractor");
const { validarPedido } = require("./lib/validaciones");
const { generarEtiquetasPedido } = require("./lib/zplEngine");
const { generarArchivoSAE, CONFIG_WALMART } = require("./lib/saeExport");
const { AUTH_ENABLED, login, requireAuth } = require("./lib/auth");
const db = require("./lib/db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// memoria temporal para modo dry (sin Supabase): guarda el ultimo extraido
const cache = new Map();

app.get("/api/health", (req, res) => {
  res.json({ ok: true, modo: db.HAS_CREDS ? "supabase" : "dry",
    impresion: "estación USB (polling)", auth_required: AUTH_ENABLED });
});

// Login: devuelve un token si el usuario/clave es válido.
app.post("/api/login", (req, res) => {
  const { usuario, clave } = req.body || {};
  const token = login((usuario || "").trim(), clave || "");
  if (!token) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  res.json({ ok: true, token, usuario: (usuario || "").trim() });
});

/**
 * Sube un PDF de Walmart: extrae, valida, guarda, decide estatus.
 * Si la extracción no es confiable, marca el pedido como "revisar_manual".
 */
app.post("/api/pedidos/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Falta el archivo PDF (campo 'file')" });

    // 1. Extraer (con manejo de PDF corrupto/ilegible)
    let pedido;
    try {
      pedido = await extractFromBuffer(req.file.buffer);
    } catch (e) {
      // PDF no legible: alerta y respuesta clara, sin crashear
      await db.crearAlerta({
        tipo: "extraccion_dudosa", severidad: "alta",
        titulo: "No se pudo leer un PDF subido",
        detalle: e.message,
      });
      return res.status(422).json({
        error: "No se pudo leer el PDF. Puede estar dañado o no ser un pedido de Walmart.",
        detalle: e.message, requiere_revision: true,
      });
    }

    const oc = pedido.encabezado.num_orden_compra;

    // 2. ¿Extracción confiable? Si no, marcar para revisión manual.
    if (pedido.extraccion.requiere_revision) {
      const clienteId = await db.getClienteId("WMT");
      let pedidoId = null;
      if (oc && !(await db.pedidoExiste(clienteId, oc))) {
        pedidoId = await db.guardarPedido(pedido, clienteId, "revisar_manual");
        await db.marcarRevisionManual(pedidoId, pedido.extraccion.problemas);
        cache.set(pedidoId, pedido);
      }
      await db.crearAlerta({
        tipo: "extraccion_dudosa", severidad: "alta",
        titulo: `Pedido ${oc || "(sin OC)"} requiere revisión manual`,
        detalle: pedido.extraccion.problemas.join("; "),
        pedidoId,
      });
      return res.status(200).json({
        ok: true, pedido_id: pedidoId, oc, estatus: "revisar_manual",
        requiere_revision: true,
        problemas: pedido.extraccion.problemas,
        mensaje: "La extracción no es confiable. Revisa el pedido a mano antes de continuar.",
        pedido,
      });
    }

    // 3. Cliente + anti-duplicado
    const clienteId = await db.getClienteId("WMT");
    if (await db.pedidoExiste(clienteId, oc)) {
      return res.status(409).json({ error: `El pedido ${oc} ya fue procesado (duplicado)`, oc });
    }

    // 4. Validar contra catálogos
    const catalogos = await db.cargarCatalogos(clienteId);
    const validacion = validarPedido(pedido, catalogos);
    const estatus = validacion.valido ? "validado" : "con_errores";

    // 5. Guardar
    const pedidoId = await db.guardarPedido(pedido, clienteId, estatus);
    await db.guardarValidaciones(pedidoId, validacion.errores);
    await db.auditar({ accion: "subir_pedido", entidad: "pedido", entidadId: pedidoId,
      despues: { oc, estatus }, ip: req.ip });

    if (!validacion.valido) {
      await db.crearAlerta({ tipo: "error_validacion", severidad: "media",
        titulo: `Pedido ${oc} tiene errores de validación`,
        detalle: validacion.errores.map((e) => e.descripcion).join("; "), pedidoId });
    }

    cache.set(pedidoId, pedido);

    res.json({
      ok: true, pedido_id: pedidoId, oc, estatus, validacion,
      requiere_revision: false,
      pedido,
      resumen: {
        lineas: pedido.lineas.length,
        unidades: pedido.totales_pdf.total_unidades,
        total: pedido.totales_pdf.total,
        etiquetas_a_generar: pedido.control.total_cajas_etiquetas,
        control_extraccion: pedido.control,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Reabre un pedido guardado: devuelve el pedido completo (encabezado + líneas)
 * para volver a verlo, reimprimir etiquetas o regenerar el archivo SAE.
 */
app.get("/api/pedidos/:id", requireAuth, async (req, res) => {
  try {
    const pedido = (cache.get(req.params.id)) || (await db.obtenerPedidoCompleto(req.params.id));
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado" });
    cache.set(req.params.id, pedido);
    res.json({ ok: true, pedido });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Elimina TODOS los pedidos guardados (con cascada). Va antes del :id para
 * que Express no lo confunda con un id.
 */
app.delete("/api/pedidos", requireAuth, async (req, res) => {
  try {
    const n = await db.eliminarTodosLosPedidos();
    cache.clear();
    res.json({ ok: true, eliminados: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Elimina un pedido por id (con cascada a sus líneas, etiquetas, etc.). */
app.delete("/api/pedidos/:id", requireAuth, async (req, res) => {
  try {
    await db.eliminarPedido(req.params.id);
    cache.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Genera el ARCHIVO DE IMPORTACIÓN de factura para SAE (.xlsx).
 * El usuario lo descarga y lo importa en SAE -> SAE crea la factura
 * SIN timbrar con su propia lógica (folios, impuestos, addenda).
 *
 * Body: { config: { folio, clienteSae, metodoPago, formaPagoSat, usoCfdi,
 *                    almacen, usarCantidadSurtir }, pedido? }
 */
app.post("/api/pedidos/:id/sae", requireAuth, async (req, res) => {
  try {
    const pedidoId = req.params.id;
    let pedido = cache.get(pedidoId) || req.body?.pedido;
    if (!pedido && pedidoId) pedido = await db.obtenerPedidoCompleto(pedidoId);
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado; reenvialo en body.pedido" });

    // config real de Walmart por defecto; se puede sobreescribir en el body
    const cfg = { ...CONFIG_WALMART, ...(req.body?.config || {}) };
    if (!cfg.folio) return res.status(400).json({ error: "Falta el folio del documento (Clave)" });
    if (!cfg.clienteSae) return res.status(400).json({ error: "Falta la clave del cliente en SAE" });

    let archivo;
    try {
      archivo = generarArchivoSAE(pedido, cfg);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    await db.auditar({ accion: "generar_archivo_sae", entidad: "pedido", entidadId: pedidoId,
      despues: { folio: cfg.folio, oc: pedido.encabezado.num_orden_compra }, ip: req.ip });

    // descargar como archivo
    const nombre = `factura_SAE_OC${pedido.encabezado.num_orden_compra}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(archivo);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Genera el ZPL de todas las etiquetas (una por caja) y las guarda.
 */
app.post("/api/pedidos/:id/etiquetas", requireAuth, async (req, res) => {
  try {
    const pedidoId = req.params.id;
    const pedido = cache.get(pedidoId) || req.body?.pedido;
    if (!pedido) return res.status(404).json({ error: "Pedido no encontrado; reenvialo en body.pedido" });

    const etiquetas = generarEtiquetasPedido(pedido);
    await db.guardarEtiquetas(pedidoId, etiquetas);

    res.json({
      ok: true,
      total_etiquetas: etiquetas.length,
      etiquetas: etiquetas.map((e) => ({
        sku: e.sku_interno, caja: `${e.caja_x} de ${e.caja_y}`, zpl: e.zpl,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Encola etiquetas para imprimir. La PC con la Zebra (USB) las jala.
 * Body: { pedido_id?, etiquetas:[{zpl,caja_x,caja_y,sku_interno}],
 *         estacion?, desde?, hasta? }
 * desde/hasta = reimprimir solo ese rango de cajas.
 */
app.post("/api/imprimir", requireAuth, async (req, res) => {
  try {
    const { pedido_id, etiquetas, estacion, desde, hasta } = req.body;
    if (!etiquetas || !etiquetas.length) return res.status(400).json({ error: "No hay etiquetas para imprimir" });

    // aplicar rango si se pidió reimpresión parcial
    let lista = etiquetas;
    if (desde || hasta) {
      const d = desde || 1, h = hasta || etiquetas.length;
      lista = etiquetas.filter((e, i) => (i + 1) >= d && (i + 1) <= h);
    }

    const jobId = await db.encolarImpresion(pedido_id, lista, estacion || "zebra-01");
    await db.auditar({ accion: "encolar_impresion", entidad: "pedido", entidadId: pedido_id,
      despues: { etiquetas: lista.length }, ip: req.ip });

    res.json({ ok: true, job_id: jobId, encoladas: lista.length,
      mensaje: "Etiquetas en cola. La estación de impresión las tomará en segundos." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * ENDPOINTS PARA LA ESTACIÓN DE IMPRESIÓN (PC con la Zebra USB)
 * La estación jala trabajos y reporta resultados (polling saliente).
 */

// La estación pide el siguiente trabajo de impresión.
app.get("/api/print-station/siguiente", async (req, res) => {
  try {
    const job = await db.tomarTrabajoImpresion(req.query.estacion || "zebra-01");
    if (!job) return res.status(204).end();
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// La estación reporta avance/resultado.
app.post("/api/print-station/:id/resultado", async (req, res) => {
  try {
    await db.reportarImpresion(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estado de un trabajo de impresión (para que el dashboard muestre avance).
app.get("/api/print-station/trabajo/:id", requireAuth, async (req, res) => {
  try {
    const e = await db.estadoTrabajoImpresion(req.params.id);
    res.json(e || { error: "no encontrado" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Editar la cantidad a surtir de una línea (antes de generar factura/etiquetas).
 */
app.patch("/api/lineas/:id/cantidad", requireAuth, async (req, res) => {
  try {
    const { cantidad } = req.body;
    if (!Number.isInteger(cantidad) || cantidad < 0)
      return res.status(400).json({ error: "Cantidad inválida" });
    await db.editarCantidadSurtir(req.params.id, cantidad, req.body.usuario_id || null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Historial de pedidos con filtros: ?oc=&estatus=&desde=&hasta=
 */
app.get("/api/historial", requireAuth, async (req, res) => {
  try {
    const r = await db.buscarHistorial({
      oc: req.query.oc, estatus: req.query.estatus,
      desde: req.query.desde, hasta: req.query.hasta,
    });
    res.json({ ok: true, pedidos: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Alertas: listar no leídas / marcar leída.
 */
app.get("/api/alertas", requireAuth, async (req, res) => {
  const r = await db.listarAlertas(req.query.todas !== "1");
  res.json({ ok: true, alertas: r });
});
app.post("/api/alertas/:id/leida", requireAuth, async (req, res) => {
  await db.marcarAlertaLeida(req.params.id);
  res.json({ ok: true });
});

/**
 * ENDPOINTS PARA EL AGENTE SAE (.NET)
 * El agente jala jobs y reporta resultados (polling saliente).
 */

// El agente pide el siguiente job pendiente de la cola.
app.get("/api/agente/jobs/siguiente", async (req, res) => {
  try {
    const job = await db.tomarSiguienteJob(req.query.agente || "agente-sae-01");
    if (!job) return res.status(204).end(); // sin jobs
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// El agente reporta el resultado de un job (factura creada o error).
app.post("/api/agente/jobs/:id/resultado", async (req, res) => {
  try {
    await db.reportarResultadoJob(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Backend escuchando en http://localhost:${PORT}`);
    console.log(`Modo: ${db.HAS_CREDS ? "Supabase" : "DRY (sin BD, solo prueba)"}`);
    db.seedHEB();   // da de alta cliente HEB + plantilla de etiqueta (idempotente)
  });
}

module.exports = app;
