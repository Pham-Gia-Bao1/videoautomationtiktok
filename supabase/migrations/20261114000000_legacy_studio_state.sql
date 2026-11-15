-- Baseline migration for the single JSONB state table previously created manually.
-- Idempotent so it can be recorded in Supabase migration history after that manual run.
create table if not exists public.studio_state (
  id text primary key check (id = 'main'),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.studio_state enable row level security;
grant select, insert, update on public.studio_state to anon;

drop policy if exists "Allow anonymous studio state read" on public.studio_state;
create policy "Allow anonymous studio state read"
  on public.studio_state for select to anon using (id = 'main');

drop policy if exists "Allow anonymous studio state create" on public.studio_state;
create policy "Allow anonymous studio state create"
  on public.studio_state for insert to anon with check (id = 'main');

drop policy if exists "Allow anonymous studio state update" on public.studio_state;
create policy "Allow anonymous studio state update"
  on public.studio_state for update to anon using (id = 'main') with check (id = 'main');
