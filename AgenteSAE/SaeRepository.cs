using System.Data;
using FirebirdSql.Data.FirebirdClient;
using Serilog;

namespace AgenteSAE;

/// <summary>
/// Capa de acceso a la base de datos de SAE 10 (InterBase/Firebird via Devart).
///
/// LECTURA: funcional. Se conecta a la misma base que SAE y consulta
///          existencias, productos, clientes, precios. SOLO LECTURA.
///
/// ESCRITURA: NO se escribe directo a las tablas (corromperia folios y
///            relaciones de SAE). El metodo CrearFacturaSinTimbrar esta
///            marcado como TODO: ahi se enchufa el SDK/API de Aspel cuando
///            el distribuidor confirme la via para SAE 10.
///
/// IMPORTANTE - CHARSET: la base usa ISO8859_1 (Latin-1), no UTF-8.
/// El driver maneja la conversion via Charset en la cadena de conexion.
/// </summary>
public class SaeRepository
{
    private readonly string _connString;
    private readonly ILogger _log;

    public SaeRepository(SaeConfig cfg, ILogger log)
    {
        _log = log;
        // Cadena de conexion para InterBase/Firebird.
        // NOTA: SAE usa el driver Devart sobre dbExpress; FirebirdClient
        // conecta a la misma base. Si el InterBase propietario rechaza la
        // conexion, ver README (opcion cliente Devart / InterBase).
        var builder = new FbConnectionStringBuilder
        {
            DataSource = cfg.Host,            // "SERVIDOR"
            Port = cfg.Port,                 // 3050 por defecto
            Database = cfg.DatabasePath,     // ruta del archivo de BD
            UserID = cfg.User,               // sysdba
            Password = cfg.Password,         // (de appsettings, no en codigo)
            Charset = cfg.Charset,           // ISO8859_1
            Dialect = cfg.Dialect,           // 3
            Pooling = true,
        };
        _connString = builder.ToString();
    }

    /// <summary>Prueba la conexion (para /health del agente).</summary>
    public bool ProbarConexion()
    {
        try
        {
            using var conn = new FbConnection(_connString);
            conn.Open();
            _log.Information("Conexion a SAE OK");
            return true;
        }
        catch (Exception ex)
        {
            _log.Error(ex, "Fallo la conexion a SAE");
            return false;
        }
    }

    /// <summary>
    /// Lee la existencia de un SKU. SOLO LECTURA.
    ///
    /// IMPORTANTE: el nombre real de la tabla/campo depende del diccionario
    /// de datos de tu SAE 10. Los nombres aqui son PLACEHOLDERS comunes en
    /// SAE (tabla INVE = inventario/productos, campo CTRL = clave, EXIS =
    /// existencia). CONFIRMA los nombres reales con tu distribuidor o el
    /// diccionario de datos antes de usar en produccion.
    /// </summary>
    public ProductoSae? LeerProducto(string skuInterno)
    {
        const string sql = @"
            SELECT CVE_ART, DESCR, EXIST, COSTO_PROM
            FROM INVE
            WHERE CVE_ART = @sku";
        try
        {
            using var conn = new FbConnection(_connString);
            conn.Open();
            using var cmd = new FbCommand(sql, conn);
            cmd.Parameters.AddWithValue("@sku", skuInterno);
            using var r = cmd.ExecuteReader();
            if (r.Read())
            {
                return new ProductoSae
                {
                    SkuInterno = r["CVE_ART"]?.ToString()?.Trim() ?? skuInterno,
                    Descripcion = r["DESCR"]?.ToString()?.Trim(),
                    Existencia = r["EXIST"] is DBNull ? 0 : Convert.ToDecimal(r["EXIST"]),
                    Precio = r["COSTO_PROM"] is DBNull ? 0 : Convert.ToDecimal(r["COSTO_PROM"]),
                };
            }
            return null;
        }
        catch (Exception ex)
        {
            _log.Error(ex, "Error leyendo producto {Sku} de SAE", skuInterno);
            throw;
        }
    }

    /// <summary>Lee existencias de varios SKU de un jalon (para validar un pedido).</summary>
    public Dictionary<string, decimal> LeerExistencias(IEnumerable<string> skus)
    {
        var result = new Dictionary<string, decimal>();
        foreach (var sku in skus.Distinct())
        {
            var p = LeerProducto(sku);
            if (p != null) result[sku] = p.Existencia;
        }
        return result;
    }

    /// <summary>
    /// Crea la FACTURA SIN TIMBRAR en SAE.
    ///
    /// ====================================================================
    ///  PUNTO DE ESCRITURA - ENCHUFAR AQUI EL SDK/API DE ASPEL SAE 10
    /// ====================================================================
    /// NO escribir directo a las tablas (CVE_DOC, FACTF, PAR_FACTF, etc.):
    /// SAE administra folios, consecutivos fiscales y relaciones que se
    /// corromperian. La factura debe crearse por la via oficial de Aspel.
    ///
    /// Opciones a confirmar con el distribuidor para TU SAE 10:
    ///   1. SDK / API de Aspel SAE (la via correcta).
    ///   2. Componentes de automatizacion / objetos COM que exponga SAE.
    ///   3. Conector / add-on oficial de Aspel.
    ///
    /// Cuando confirmes la via, este metodo:
    ///   - Recibe el payload (lineas, referencia OC, condicion de pago).
    ///   - Llama al SDK para crear la factura SIN timbrar.
    ///   - Escribe la REFERENCIA OC (job.Payload.ReferenciaOc) en el campo
    ///     de orden de compra de la factura  (OBLIGATORIO para Walmart).
    ///   - NUNCA timbra (Timbrar siempre es false).
    ///   - Devuelve el folio que SAE asigne.
    /// </summary>
    public ResultadoJob CrearFacturaSinTimbrar(Job job)
    {
        _log.Information("Solicitud de crear factura para OC {Oc} ({Lineas} lineas)",
            job.Payload.ReferenciaOc, job.Payload.Lineas.Count);

        // Salvaguarda: el agente jamas timbra.
        if (job.Payload.Timbrar)
        {
            _log.Warning("Job pidio timbrar; se ignora. El agente nunca timbra.");
        }

        // --- TODO: enchufar SDK de Aspel aqui ---
        // Ejemplo conceptual (pseudocodigo, ajustar al SDK real):
        //   var doc = aspel.NuevoDocumento(TipoDoc.Factura);
        //   doc.Cliente = ResolverClienteSae(job.Payload.Cliente);
        //   doc.OrdenCompra = job.Payload.ReferenciaOc;     // OBLIGATORIO
        //   doc.CondicionPago = job.Payload.CondicionPago;
        //   foreach (var l in job.Payload.Lineas)
        //       doc.AgregarPartida(l.SkuInterno, l.Cantidad, l.PrecioUnitario);
        //   doc.Timbrar = false;                            // NUNCA timbrar
        //   var folio = aspel.Guardar(doc);
        //   return new ResultadoJob { JobId=job.Id, Ok=true,
        //       Estatus="factura_creada", FolioSae=folio };

        return new ResultadoJob
        {
            JobId = job.Id,
            Ok = false,
            Estatus = "error_sae",
            Mensaje = "Escritura no implementada: falta enchufar el SDK de Aspel "
                    + "(confirmar via con distribuidor para SAE 10)."
        };
    }
}

public class SaeConfig
{
    public string Host { get; set; } = "SERVIDOR";
    public string DatabasePath { get; set; } = "";
    public string User { get; set; } = "sysdba";
    public string Password { get; set; } = "";
    public string Charset { get; set; } = "ISO8859_1";
    public int Dialect { get; set; } = 3;
    public int Port { get; set; } = 3050;
}
