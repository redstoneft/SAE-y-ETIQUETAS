# Agente SAE (.NET) — esqueleto

Servicio que corre en el **servidor donde está instalado Aspel SAE 10**.
Jala trabajos de la cola del backend cloud (polling saliente), lee la base
de SAE para validar existencias, y crea la factura SIN TIMBRAR.

## Estado actual

| Parte | Estado |
|---|---|
| Polling de la cola cloud | ✅ funcional |
| Lectura de InterBase/Firebird (existencias, productos) | ✅ funcional (faltan nombres reales de tabla) |
| Manejo de charset ISO8859_1 | ✅ configurado |
| **Escritura de factura (SDK Aspel)** | ⛔ **pendiente** — punto marcado en el código |

## Lo que falta para completar — CONFIRMAR CON DISTRIBUIDOR ASPEL

Dos cosas, ambas en `SaeRepository.cs`:

1. **La vía de escritura de la factura.** El método `CrearFacturaSinTimbrar`
   tiene marcado dónde enchufar el SDK/API de Aspel. NO escribir directo a las
   tablas (corrompe folios y datos fiscales). Pregunta al distribuidor qué SDK,
   componente COM o conector soporta tu SAE 10 para crear documentos.

2. **Los nombres reales de tabla/campo para LECTURA.** En `LeerProducto` puse
   placeholders comunes de SAE (`INVE`, `CVE_ART`, `EXIST`, `DESCR`,
   `COSTO_PROM`). Confirma los nombres reales con el diccionario de datos de tu
   SAE 10 (el distribuidor lo tiene). Solo hay que ajustar el SQL.

## Datos de conexión (ya identificados de tu SAE)

De la "Configuración avanzada de bases de datos" de SAE:
- Motor: InterBase/Firebird vía driver **DevartInterBase**
- Usuario: `sysdba`, Dialect: 3, Charset: `ISO8859_1`
- DataBase: ruta del archivo en el servidor

Pon estos valores en `appsettings.json` (copia de `appsettings.example.json`).
**No subas `appsettings.json` a git ni a la nube** — contiene la contraseña.

> Nota de seguridad: el usuario/clave `sysdba` / `masterkey` son los valores
> por defecto de InterBase. Considera con tu distribuidor cambiar la contraseña
> si el servidor está expuesto.

## Sobre el driver de conexión

El proyecto usa `FirebirdSql.Data.FirebirdClient` (cliente .NET de
Firebird/InterBase). SAE usa el driver Devart sobre dbExpress, que apunta a la
misma base. Si la conexión fuera rechazada por el InterBase propietario:
- Verifica que el servicio de base de datos (puerto 3050) acepte conexiones.
- Alternativa: usar el cliente .NET de Devart para InterBase (de pago).
- Para producción, primero prueba `ProbarConexion()` que el agente ejecuta al
  arrancar; si falla, el log dirá el motivo exacto.

## Compilar y correr

```bash
# requiere .NET 8 SDK
cd AgenteSAE
cp appsettings.example.json appsettings.json
# edita appsettings.json con tus datos reales
dotnet restore
dotnet run
```

## Convertir en servicio Windows (opcional, para 24/7)

```bash
dotnet publish -c Release -r win-x64 --self-contained
# luego registrar con sc.exe o usar un host de Windows Service
```

## Flujo

```
backend cloud (cola)  ──jobs──►  Agente SAE  ──lee──►  InterBase (existencias)
        ▲                            │
        └────resultado───────────────┴──crea factura sin timbrar──► SAE (SDK)
```

El agente nunca timbra. La factura queda lista en SAE para que tu equipo la
revise y timbre manualmente. La OC de Walmart se escribe en la factura
(campo orden de compra) — es obligatorio para Walmart.
