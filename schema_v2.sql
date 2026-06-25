-- ============================================================
--  MEJORAS v2: extracción robusta, reimpresión, edición,
--  historial, alertas, auditoría.
--  Correr DESPUES de schema_mvp.sql (es incremental).
-- ============================================================

-- --- Pedidos: bandera de revisión manual por extracción dudosa ---
alter table pedidos add column if not exists requiere_revision boolean not null default false;
alter table pedidos add column if not exists problemas_extraccion jsonb;

-- nuevo estatus posible
do $$ begin
  alter type estatus_pedido add value if not exists 'revisar_manual';
exception when others then null; end $$;

-- --- Lineas: cantidad editada por el usuario (surtir distinto a lo pedido) ---
-- cantidad_surtir ya existe en el schema base; aseguramos default
alter table pedido_lineas alter column cantidad_surtir drop not null;

-- --- Etiquetas: control de impresión por caja y reintentos ---
alter table etiquetas add column if not exists intentos_impresion integer not null default 0;
alter table etiquetas add column if not exists ultimo_error text;
-- estatus ya es enum estatus_etiqueta (pendiente|impresa|reimpresa|error)

-- --- Lotes de impresión: para seguir avance "caja 45 de 110" ---
create table if not exists impresion_lotes (
    id              uuid primary key default gen_random_uuid(),
    pedido_id       uuid references pedidos(id) on delete cascade,
    total_etiquetas integer not null,
    impresas        integer not null default 0,
    fallidas        integer not null default 0,
    estatus         text not null default 'en_proceso', -- en_proceso|completo|con_errores|cancelado
    impresora_ip    text,
    iniciado_por    uuid references usuarios(id),
    iniciado_en     timestamptz not null default now(),
    finalizado_en   timestamptz
);
create index if not exists idx_lotes_pedido on impresion_lotes(pedido_id);

-- --- Alertas: para avisar problemas (en pantalla / correo) ---
create table if not exists alertas (
    id          uuid primary key default gen_random_uuid(),
    tipo        text not null,    -- pedido_atorado | impresora_sin_respuesta | extraccion_dudosa | error_sae
    severidad   text not null default 'media',  -- baja | media | alta
    titulo      text not null,
    detalle     text,
    pedido_id   uuid references pedidos(id) on delete cascade,
    leida       boolean not null default false,
    resuelta    boolean not null default false,
    creada_en   timestamptz not null default now()
);
create index if not exists idx_alertas_no_leidas on alertas(leida, creada_en);

-- --- Vista de historial: pedidos con su info de impresión y SAE ---
create or replace view v_historial as
select
    p.id, p.num_orden_compra, p.cliente_id, p.estatus,
    p.fecha_pedido, p.total, p.total_unidades, p.requiere_revision,
    p.creado_en, p.actualizado_en,
    ps.folio_sae, ps.timbrada,
    coalesce(l.impresas, 0) as etiquetas_impresas,
    coalesce(l.total_etiquetas, 0) as etiquetas_total
from pedidos p
left join pedido_sae ps on ps.pedido_id = p.id and ps.tipo_doc = 'factura'
left join lateral (
    select total_etiquetas, impresas from impresion_lotes
    where pedido_id = p.id order by iniciado_en desc limit 1
) l on true;

-- ============================================================
--  COLA DE IMPRESION (la PC de la Zebra jala trabajos - polling)
-- ============================================================
create table if not exists print_queue (
    id            uuid primary key default gen_random_uuid(),
    pedido_id     uuid references pedidos(id) on delete cascade,
    estacion      text not null default 'zebra-01',  -- por si hay varias PCs/Zebras
    etiquetas     jsonb not null,                     -- [{zpl, caja_x, caja_y, sku}]
    total         integer not null,
    estatus       text not null default 'pendiente',  -- pendiente|tomado|imprimiendo|completo|error
    impresas      integer not null default 0,
    fallidas      integer not null default 0,
    error_msg     text,
    tomado_en     timestamptz,
    completado_en timestamptz,
    creado_en     timestamptz not null default now()
);
create index if not exists idx_printq_pend on print_queue(estatus, creado_en);
