-- ==========================================================================
-- Relevo · esquema del panel en Supabase
-- Pégalo completo en el SQL Editor del proyecto y dale Run. Es idempotente.
--
-- Modelo: el panel guarda todo su estado como un solo documento JSON por
-- dueño. Con menos de mil pedidos eso pesa unos cientos de KB, carga en una
-- sola petición y no hay forma de que las tablas se desincronicen del panel.
-- El tráfico y la bandeja del bot van aparte porque crecen sin parar.
-- ==========================================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------- panel: estado completo

create table if not exists panel_state (
  owner       uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ tráfico

create table if not exists events (
  id      bigint generated always as identity primary key,
  owner   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type    text not null check (type in ('page', 'wa')),
  path    text not null default '/',
  src     text not null default 'directo',
  at      timestamptz not null default now()
);

create index if not exists events_owner_at_idx on events (owner, at desc);

-- ------------------------------------------------- bandeja del bot (fase 3)

-- El bot no escribe pedidos: deja aquí lo que entendió y tú lo apruebas
-- desde el panel. Así un bot confundido nunca ensucia tu cartera.
create table if not exists bot_inbox (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  phone       text not null,
  name        text,
  raw         text not null,
  parsed      jsonb not null default '{}'::jsonb,
  status      text not null default 'pendiente' check (status in ('pendiente', 'aceptado', 'descartado')),
  created_at  timestamptz not null default now()
);

create index if not exists bot_inbox_status_idx on bot_inbox (owner, status, created_at desc);

-- --------------------------------------------------------------- trigger

create or replace function touch_panel_state() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists panel_state_touch on panel_state;
create trigger panel_state_touch
  before update on panel_state
  for each row execute function touch_panel_state();

-- -------------------------------------------------------------- políticas

alter table panel_state enable row level security;
alter table events      enable row level security;
alter table bot_inbox   enable row level security;

do $$ begin
  create policy "dueño lee su panel"      on panel_state for select using (owner = auth.uid());
  create policy "dueño crea su panel"     on panel_state for insert with check (owner = auth.uid());
  create policy "dueño guarda su panel"   on panel_state for update using (owner = auth.uid());

  create policy "dueño lee su tráfico"    on events      for select using (owner = auth.uid());
  create policy "dueño borra su tráfico"  on events      for delete using (owner = auth.uid());

  create policy "dueño lee su bandeja"    on bot_inbox   for select using (owner = auth.uid());
  create policy "dueño edita su bandeja"  on bot_inbox   for update using (owner = auth.uid());
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- permisos

revoke all on panel_state, events, bot_inbox from anon;
grant select, insert, update on panel_state to authenticated;
grant select, delete on events to authenticated;
grant select, update on bot_inbox to authenticated;

-- ------------------------------------------------------------------ notas
--
-- El sitio público y el bot escriben con service_role desde una función de
-- Vercel (/api/pedido y /api/whatsapp). Nunca desde el navegador: el rol anon
-- no tiene permiso para leer ni escribir nada aquí.
--
-- Para el panel en el teléfono: activa Authentication > Providers > Email y
-- entra con un enlace mágico. Ese usuario es el único que puede leer su fila.
