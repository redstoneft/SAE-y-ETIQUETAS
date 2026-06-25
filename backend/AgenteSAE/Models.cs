namespace AgenteSAE;

/// <summary>Job que viene de la cola del backend cloud.</summary>
public class Job
{
    public string Id { get; set; } = "";
    public string Tipo { get; set; } = "";          // crear_factura | leer_existencia
    public string? PedidoId { get; set; }
    public JobPayload Payload { get; set; } = new();
}

public class JobPayload
{
    public string Cliente { get; set; } = "";
    public string ReferenciaOc { get; set; } = "";   // OC de Walmart -> va en la factura
    public string Moneda { get; set; } = "MXN";
    public string? CondicionPago { get; set; }
    public bool Timbrar { get; set; } = false;        // SIEMPRE false; el agente nunca timbra
    public List<LineaPayload> Lineas { get; set; } = new();
}

public class LineaPayload
{
    public string SkuInterno { get; set; } = "";
    public int Cantidad { get; set; }
    public decimal PrecioUnitario { get; set; }
}

/// <summary>Resultado que el agente devuelve al cloud.</summary>
public class ResultadoJob
{
    public string JobId { get; set; } = "";
    public bool Ok { get; set; }
    public string Estatus { get; set; } = "";        // factura_creada | error_sae
    public string? FolioSae { get; set; }
    public string? Mensaje { get; set; }
}

/// <summary>Datos de producto leidos de SAE (solo lectura).</summary>
public class ProductoSae
{
    public string SkuInterno { get; set; } = "";
    public string? Descripcion { get; set; }
    public decimal Existencia { get; set; }
    public decimal Precio { get; set; }
}
