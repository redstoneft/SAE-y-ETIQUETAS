-- ============================================================
--  AUTOMATIZACION PEDIDOS RETAIL -> SAE -> ZEBRA
--  Esquema MVP (Walmart). PostgreSQL / Supabase.
--  Confirmado con documentos reales: 1 OC = 1 factura,
--  SKU interno viene en el pedido, descripcion la da SAE.
-- ============================================================

-- ----------  EXTENSIONES  ----------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ============================================================
--  CATALOGOS MAESTROS
-- ============================================================

-- Clientes retail (Walmart en el MVP; preparado para mas)
create table clientes (
    id                uuid primary key default gen_random_uuid(),
    nombre            text not null,                 -- WALMART
    codigo_interno    text unique not null,          -- WMT
    metodo_extraccion text not null default 'pdf',   -- pdf | edi | api | scraper
    -- datos fiscales / SAE
    cliente_sae_id    text,                          -- id del cliente dentro de SAE
    rfc               text,
    razon_social      text,
    num_proveedor     text,                          -- nuestro num de proveedor ante el cliente (826370140)
    activo            boolean not null default true,
    creado_en         timestamptz not null default now()
);

-- Productos (espejo de lo relevante de SAE; la descripcion "oficial" vive en SAE)
create table productos (
    id              uuid primary key default gen_random_uuid(),
    sku_interno     text unique not null,            -- SIC24G  (= Clave en SAE)
    descripcion     text,                            -- referencia local; SAE manda
    gtin            text,                            -- 7500462718718 (EAN13)
    almacen_default text,
    iva_tasa        numeric(5,4) not null default 0.16,
    activo          boolean not null default true,
    creado_en       timestamptz not null default now()
);
create index idx_productos_gtin on productos(gtin);

-- Mapeo SKU del cliente -> SKU interno.
-- En Walmart el SKU interno YA viene en el pedido (col "Nro Stock de Prov"),
-- pero guardamos el Artc Walmart por si hay que mapear por ese codigo.
create table sku_map (
    id            uuid primary key default gen_random_uuid(),
    cliente_id    uuid not null references clientes(id) on delete cascade,
    sku_cliente   text not null,                     -- 101581796 (Artc Walmart)
    sku_interno   text not null references productos(sku_interno),
    descripcion_cliente text,
    creado_en     timestamptz not null default now(),
    unique (cliente_id, sku_cliente)
);

-- Precios autorizados por cliente (para validar contra el Cost del pedido)
create table precios_autorizados (
    id              uuid primary key default gen_random_uuid(),
    cliente_id      uuid not null references clientes(id) on delete cascade,
    sku_interno     text not null references productos(sku_interno),
    precio          numeric(14,4) not null,
    moneda          text not null default 'MXN',
    vigencia_desde  date not null default current_date,
    vigencia_hasta  date,
    creado_en       timestamptz not null default now()
);
create index idx_precios_cliente_sku on precios_autorizados(cliente_id, sku_interno);

-- CEDIS / tiendas destino por cliente
create table cedis (
    id           uuid primary key default gen_random_uuid(),
    cliente_id   uuid not null references clientes(id) on delete cascade,
    codigo       text not null,                      -- 7494 / 7471
    nombre       text,                               -- CD NAVE 1 SECOS
    gln          text,                               -- 7507003116675
    es_tienda    boolean not null default false,     -- false=CEDIS, true=tienda
    direccion    text,
    cp           text,
    ciudad       text,
    estado       text,
    creado_en    timestamptz not null default now(),
    unique (cliente_id, codigo)
);

-- ============================================================
--  OPERACION DE PEDIDOS
-- ============================================================

-- Estados del pedido a lo largo del flujo
create type estatus_pedido as enum (
    'nuevo',                  -- recien extraido
    'con_errores',            -- fallo validacion
    'validado',               -- listo para SAE
    'enviado_sae',            -- encolado al agente
    'factura_creada',         -- factura SIN timbrar en SAE
    'timbrada',               -- timbrada manualmente en SAE
    'error_sae',              -- el agente reporto error
    'cancelado'
);

create table pedidos (
    id                   uuid primary key default gen_random_uuid(),
    cliente_id           uuid not null references clientes(id),
    num_orden_compra     text not null,              -- 8834970382 (OC Walmart)
    fecha_pedido         date,
    fecha_envio          date,
    fecha_cancelacion    date,                       -- fecha limite de entrega
    tipo_orden           text,                       -- 0033
    moneda               text default 'MXN',
    departamento         text,
    evento_promocional   text,
    condicion_pago       text,                       -- NET 90 ROG
    cedis_codigo         text,                       -- 7494
    gln_destino          text,
    formato_tienda       text,                       -- BODEGA
    instrucciones        text,                       -- NO PRETICKET
    -- totales
    subtotal             numeric(14,2),
    total                numeric(14,2),
    total_unidades       integer,
    total_lineas         integer,
    -- control / trazabilidad
    estatus              estatus_pedido not null default 'nuevo',
    hash_pedido          text not null,              -- anti-duplicado
    doc_original_url     text,                       -- PDF guardado
    fecha_descarga       timestamptz not null default now(),
    creado_en            timestamptz not null default now(),
    actualizado_en       timestamptz not null default now(),
    -- Regla de oro: 1 OC = 1 pedido por cliente
    unique (cliente_id, num_orden_compra)
);
create index idx_pedidos_estatus on pedidos(estatus);
create index idx_pedidos_fecha on pedidos(fecha_pedido);

create table pedido_lineas (
    id               uuid primary key default gen_random_uuid(),
    pedido_id        uuid not null references pedidos(id) on delete cascade,
    num_linea        text,                           -- 001
    sku_cliente      text,                           -- 101581796 (Artc)
    sku_interno      text,                           -- SIC24G
    gtin             text,                           -- para etiqueta
    descripcion      text,                           -- la "oficial" la pone SAE
    color            text,
    talla            text,
    cantidad         integer not null,               -- cantidad pedida
    cantidad_surtir  integer,                        -- la real a facturar (puede diferir)
    uom              text default 'EA',
    piezas_por_caja  integer,                        -- 6
    cajas            integer,                        -- = num de etiquetas
    precio_unitario  numeric(14,4),
    descuento        numeric(14,4) default 0,
    iva              numeric(14,4) default 0,
    total_linea      numeric(14,2),
    almacen          text,
    creado_en        timestamptz not null default now()
);
create index idx_lineas_pedido on pedido_lineas(pedido_id);

-- Resultado de las validaciones pre-SAE
create type severidad_val as enum ('error', 'advertencia');

create table pedido_validaciones (
    id            uuid primary key default gen_random_uuid(),
    pedido_id     uuid not null references pedidos(id) on delete cascade,
    linea_id      uuid references pedido_lineas(id) on delete cascade,
    tipo          text not null,    -- duplicado | sku_inexistente | sin_mapeo |
                                    -- precio_distinto | existencia_insuficiente |
                                    -- cliente_inexistente | datos_fiscales | formato
    descripcion   text,
    severidad     severidad_val not null default 'error',
    resuelto      boolean not null default false,
    resuelto_por  uuid,
    resuelto_en   timestamptz,
    creado_en     timestamptz not null default now()
);
create index idx_val_pedido on pedido_validaciones(pedido_id);

-- Vinculo con el documento creado en SAE (1 OC = 1 factura)
create table pedido_sae (
    id              uuid primary key default gen_random_uuid(),
    pedido_id       uuid not null references pedidos(id) on delete cascade,
    tipo_doc        text not null default 'factura', -- pedido | remision | factura
    folio_sae       text,                            -- folio devuelto por SAE
    referencia_oc   text,                            -- OC escrita en la factura SAE
    estatus_sae     text,                            -- creada | error
    timbrada        boolean not null default false,  -- nunca lo hace el agente
    payload_enviado jsonb,                           -- lo que se mando al agente
    respuesta_sae   jsonb,                           -- folio + status del agente
    enviado_en      timestamptz,
    procesado_en    timestamptz,
    unique (pedido_id, tipo_doc)
);

-- ============================================================
--  ETIQUETAS ZEBRA
-- ============================================================

create table plantillas_zpl (
    id           uuid primary key default gen_random_uuid(),
    cliente_id   uuid not null references clientes(id),
    nombre       text not null,
    zpl_template text not null,            -- ZPL con marcadores {{variable}}
    ancho_mm     numeric(6,2),
    alto_mm      numeric(6,2),
    version      integer not null default 1,
    activa       boolean not null default true,
    creado_en    timestamptz not null default now()
);

create type estatus_etiqueta as enum ('pendiente','impresa','reimpresa','error');

create table etiquetas (
    id              uuid primary key default gen_random_uuid(),
    pedido_id       uuid not null references pedidos(id) on delete cascade,
    linea_id        uuid references pedido_lineas(id) on delete cascade,
    plantilla_id    uuid references plantillas_zpl(id),
    caja_x          integer,                 -- caja X
    caja_y          integer,                 -- de Y
    zpl_render      text,                    -- ZPL ya con variables resueltas
    estatus         estatus_etiqueta not null default 'pendiente',
    reimpresiones   integer not null default 0,
    impreso_en      timestamptz,
    creado_en       timestamptz not null default now()
);
create index idx_etiquetas_pedido on etiquetas(pedido_id);

-- ============================================================
--  COLA PARA EL AGENTE SAE (modelo de polling saliente)
-- ============================================================

create type estatus_job as enum ('pendiente','tomado','ok','error');

create table job_queue (
    id          uuid primary key default gen_random_uuid(),
    tipo        text not null,              -- crear_factura | leer_existencia | ...
    pedido_id   uuid references pedidos(id) on delete cascade,
    payload     jsonb not null,
    estatus     estatus_job not null default 'pendiente',
    intentos    integer not null default 0,
    agente_id   text,                       -- que agente lo tomo
    resultado   jsonb,
    tomado_en   timestamptz,
    procesado_en timestamptz,
    creado_en   timestamptz not null default now()
);
create index idx_job_estatus on job_queue(estatus, creado_en);

-- ============================================================
--  SEGURIDAD: USUARIOS, ROLES, CREDENCIALES, AUDITORIA
-- ============================================================

-- Las 3 personas tienen todos los roles; el modelo soporta granularidad futura
create table usuarios (
    id          uuid primary key default gen_random_uuid(),
    auth_id     uuid,                       -- id de Supabase Auth
    nombre      text not null,
    email       text unique not null,
    rol         text not null default 'admin',  -- admin | operador | facturacion | almacen | auditor
    activo      boolean not null default true,
    creado_en   timestamptz not null default now()
);

-- Credenciales de portales, CIFRADAS (nunca en claro)
create table portal_credenciales (
    id            uuid primary key default gen_random_uuid(),
    cliente_id    uuid not null references clientes(id) on delete cascade,
    usuario_enc   bytea,                    -- cifrado con pgcrypto
    password_enc  bytea,
    endpoint      text,
    tipo_auth     text,
    actualizado_en timestamptz not null default now()
);

create table auditoria (
    id            uuid primary key default gen_random_uuid(),
    usuario_id    uuid references usuarios(id),
    accion        text not null,            -- crear | editar | reprocesar | imprimir | timbrar
    entidad       text not null,            -- pedido | factura | etiqueta | catalogo
    entidad_id    uuid,
    datos_antes   jsonb,
    datos_despues jsonb,
    ip            text,
    creado_en     timestamptz not null default now()
);
create index idx_auditoria_entidad on auditoria(entidad, entidad_id);

-- ============================================================
--  TRIGGER: actualizar 'actualizado_en' en pedidos
-- ============================================================
create or replace function touch_actualizado_en()
returns trigger as $$
begin
    new.actualizado_en = now();
    return new;
end;
$$ language plpgsql;

create trigger trg_pedidos_touch
    before update on pedidos
    for each row execute function touch_actualizado_en();

-- ============================================================
--  SEED MINIMO: cliente Walmart
-- ============================================================
insert into clientes (nombre, codigo_interno, metodo_extraccion, num_proveedor, activo)
values ('WALMART', 'WMT', 'pdf', '826370140', true);
