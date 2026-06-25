using Microsoft.Extensions.Configuration;
using Serilog;

namespace AgenteSAE;

/// <summary>
/// AGENTE SAE - Servicio que corre en el servidor donde esta SAE 10.
///
/// Loop principal:
///   1. Jala el siguiente job de la cola del cloud (polling saliente).
///   2. Segun el tipo:
///        - leer_existencia -> consulta InterBase (lectura) y reporta.
///        - crear_factura    -> crea factura SIN timbrar via SDK Aspel (TODO).
///   3. Reporta el resultado al cloud.
///   4. Espera N segundos y repite.
///
/// Ejecutar:  dotnet run        (o publicar como servicio Windows, ver README)
/// </summary>
public class Program
{
    public static async Task Main(string[] args)
    {
        // --- Logging ---
        Log.Logger = new LoggerConfiguration()
            .WriteTo.Console()
            .WriteTo.File("logs/agente-.log", rollingInterval: RollingInterval.Day)
            .CreateLogger();

        Log.Information("=== Agente SAE iniciando ===");

        // --- Configuracion ---
        var config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: false)
            .Build();

        var saeCfg = config.GetSection("Sae").Get<SaeConfig>() ?? new SaeConfig();
        var cloudCfg = config.GetSection("Cloud").Get<CloudConfig>() ?? new CloudConfig();

        var sae = new SaeRepository(saeCfg, Log.Logger);
        var cloud = new CloudClient(cloudCfg, Log.Logger);

        // --- Verificar conexion a SAE al arrancar ---
        if (!sae.ProbarConexion())
        {
            Log.Warning("No hay conexion a SAE al iniciar. El agente seguira "
                      + "intentando; revisa appsettings.json (ruta, usuario, puerto).");
        }

        Log.Information("Polling cada {Seg}s contra {Url}",
            cloudCfg.PollIntervalSeconds, cloudCfg.BaseUrl);

        // --- Loop principal ---
        var intervalo = TimeSpan.FromSeconds(cloudCfg.PollIntervalSeconds);
        while (true)
        {
            try
            {
                var job = await cloud.TomarSiguienteJobAsync();
                if (job != null)
                {
                    Log.Information("Job recibido: {Id} tipo={Tipo}", job.Id, job.Tipo);
                    var resultado = ProcesarJob(job, sae);
                    await cloud.ReportarResultadoAsync(resultado);
                }
            }
            catch (Exception ex)
            {
                Log.Error(ex, "Error en el loop principal (se continua)");
            }

            await Task.Delay(intervalo);
        }
    }

    /// <summary>Decide que hacer segun el tipo de job.</summary>
    private static ResultadoJob ProcesarJob(Job job, SaeRepository sae)
    {
        switch (job.Tipo)
        {
            case "crear_factura":
                // Crea la factura SIN timbrar (escritura via SDK Aspel - TODO).
                return sae.CrearFacturaSinTimbrar(job);

            case "leer_existencia":
                // Lectura pura: devuelve existencias de los SKU del payload.
                try
                {
                    var skus = job.Payload.Lineas.Select(l => l.SkuInterno);
                    var exist = sae.LeerExistencias(skus);
                    return new ResultadoJob
                    {
                        JobId = job.Id,
                        Ok = true,
                        Estatus = "existencias_leidas",
                        Mensaje = string.Join(", ",
                            exist.Select(kv => $"{kv.Key}={kv.Value}"))
                    };
                }
                catch (Exception ex)
                {
                    return new ResultadoJob
                    {
                        JobId = job.Id, Ok = false, Estatus = "error_sae",
                        Mensaje = ex.Message
                    };
                }

            default:
                return new ResultadoJob
                {
                    JobId = job.Id, Ok = false, Estatus = "error_sae",
                    Mensaje = $"Tipo de job desconocido: {job.Tipo}"
                };
        }
    }
}
