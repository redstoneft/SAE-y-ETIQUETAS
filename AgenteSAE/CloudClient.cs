using System.Net.Http.Json;
using System.Text.Json;
using Serilog;

namespace AgenteSAE;

/// <summary>
/// Cliente del backend cloud. Modelo de POLLING SALIENTE:
/// el agente JALA trabajo del cloud (nunca recibe conexiones entrantes),
/// asi no se expone SAE a internet ni se abren puertos en la oficina.
/// </summary>
public class CloudClient
{
    private readonly HttpClient _http;
    private readonly CloudConfig _cfg;
    private readonly ILogger _log;
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public CloudClient(CloudConfig cfg, ILogger log)
    {
        _cfg = cfg;
        _log = log;
        _http = new HttpClient { BaseAddress = new Uri(cfg.BaseUrl) };
        _http.DefaultRequestHeaders.Add("X-Agent-Key", cfg.ApiKey);
        _http.DefaultRequestHeaders.Add("X-Agent-Id", cfg.AgenteId);
    }

    /// <summary>Pide el siguiente job pendiente. null si no hay.</summary>
    public async Task<Job?> TomarSiguienteJobAsync()
    {
        try
        {
            var resp = await _http.GetAsync($"/api/agente/jobs/siguiente?agente={_cfg.AgenteId}");
            if (resp.StatusCode == System.Net.HttpStatusCode.NoContent) return null;
            resp.EnsureSuccessStatusCode();
            return await resp.Content.ReadFromJsonAsync<Job>(JsonOpts);
        }
        catch (Exception ex)
        {
            _log.Warning(ex, "No se pudo tomar job (¿cloud caido? se reintenta)");
            return null;
        }
    }

    /// <summary>Reporta el resultado de un job al cloud.</summary>
    public async Task ReportarResultadoAsync(ResultadoJob resultado)
    {
        try
        {
            var resp = await _http.PostAsJsonAsync(
                $"/api/agente/jobs/{resultado.JobId}/resultado", resultado);
            resp.EnsureSuccessStatusCode();
            _log.Information("Resultado reportado para job {JobId}: {Estatus}",
                resultado.JobId, resultado.Estatus);
        }
        catch (Exception ex)
        {
            _log.Error(ex, "No se pudo reportar resultado del job {JobId}", resultado.JobId);
        }
    }
}

public class CloudConfig
{
    public string BaseUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public int PollIntervalSeconds { get; set; } = 8;
    public string AgenteId { get; set; } = "agente-sae-01";
}
