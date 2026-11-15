-- Normalize the legacy studio_state document into queryable relational tables.
-- The migration is transactional: source data is removed only after every entity
-- has been copied and checked against its source array count.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.projects (
  id uuid primary key,
  owner_id text,
  name text not null check (length(btrim(name)) between 1 and 200),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.episodes (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 200),
  language_code text not null default 'en',
  default_model_id text not null default 'eleven_v3',
  status text not null default 'draft' check (status in ('draft','generating','ready','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scripts (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  raw_text text not null,
  source text not null check (source in ('chatgpt','manual','import')),
  version integer not null check (version > 0),
  created_at timestamptz not null default now(),
  unique (episode_id, version)
);

create table if not exists public.characters (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  key text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (episode_id, key)
);

create table if not exists public.voice_mappings (
  id uuid primary key,
  character_id uuid not null references public.characters(id) on delete cascade,
  voice_id text not null,
  voice_name text,
  settings jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.generation_batches (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  script_id uuid not null references public.scripts(id) on delete restrict,
  label text not null,
  model_id text not null,
  language_code text not null,
  settings jsonb,
  status text not null check (status in ('DRAFT','QUEUED','RUNNING','PARTIAL','COMPLETED','FAILED','CANCELLED')),
  total_chunks integer not null default 0 check (total_chunks >= 0),
  completed_chunks integer not null default 0 check (completed_chunks >= 0),
  failed_chunks integer not null default 0 check (failed_chunks >= 0),
  apply_text_normalization text not null default 'auto' check (apply_text_normalization in ('auto','on','off')),
  seed integer,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.generation_batch_voice_mappings (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.generation_batches(id) on delete cascade,
  speaker_key text not null,
  voice_id text not null,
  created_at timestamptz not null default now(),
  unique (batch_id, speaker_key)
);

create table if not exists public.generation_chunks (
  id uuid primary key,
  batch_id uuid not null references public.generation_batches(id) on delete cascade,
  chunk_index integer not null check (chunk_index > 0),
  start_line integer not null check (start_line > 0),
  end_line integer not null check (end_line >= start_line),
  character_count integer not null default 0 check (character_count >= 0),
  input_count integer not null default 0 check (input_count >= 0),
  payload jsonb not null,
  payload_hash text not null,
  status text not null check (status in ('PENDING','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  audio_id uuid,
  error_code text,
  error_message text,
  retry_count integer not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (batch_id, chunk_index)
);

create table if not exists public.audios (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  chunk_id uuid references public.generation_chunks(id) on delete set null,
  kind text not null check (kind in ('chunk','final')),
  storage_path text not null,
  mime_type text not null,
  duration_seconds numeric(12,3) check (duration_seconds is null or duration_seconds >= 0),
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  output_format text not null,
  metadata jsonb,
  label text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.generation_chunks
  drop constraint if exists generation_chunks_audio_id_fkey;
alter table public.generation_chunks
  add constraint generation_chunks_audio_id_fkey
  foreign key (audio_id) references public.audios(id) on delete set null
  deferrable initially deferred;

create table if not exists public.compositions (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  name text not null,
  status text not null check (status in ('DRAFT','MERGING','READY','FAILED')),
  output_audio_id uuid references public.audios(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.composition_items (
  id uuid primary key,
  composition_id uuid not null references public.compositions(id) on delete cascade,
  audio_id uuid not null references public.audios(id) on delete restrict,
  order_index integer not null check (order_index >= 0),
  trim_start_ms integer check (trim_start_ms is null or trim_start_ms >= 0),
  trim_end_ms integer check (trim_end_ms is null or trim_end_ms >= 0),
  gap_ms integer not null default 0 check (gap_ms between 0 and 10000),
  unique (composition_id, order_index)
);

create table if not exists public.transcriptions (
  id uuid primary key,
  audio_id uuid not null references public.audios(id) on delete cascade,
  language_code text,
  text text not null default '',
  status text not null check (status in ('PENDING','RUNNING','COMPLETED','FAILED')),
  provider text not null,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.transcription_segments (
  id uuid primary key default gen_random_uuid(),
  transcription_id uuid not null references public.transcriptions(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  start_seconds numeric(12,3) not null check (start_seconds >= 0),
  end_seconds numeric(12,3) not null check (end_seconds >= start_seconds),
  text text not null,
  unique (transcription_id, sequence)
);

create table if not exists public.subtitles (
  id uuid primary key,
  transcription_id uuid not null references public.transcriptions(id) on delete cascade,
  format text not null check (format in ('srt','vtt')),
  storage_path text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.episode_videos (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  audio_id uuid not null references public.audios(id) on delete cascade,
  title text not null,
  aspect_ratio text check (aspect_ratio is null or aspect_ratio in ('16:9','9:16','1:1')),
  resolution integer check (resolution is null or resolution in (720,1080)),
  status text not null check (status in ('DRAFT','PROCESSING','READY','FAILED')),
  source_mode text check (source_mode is null or source_mode in ('elevenlabs','uploaded','cover','ghost')),
  ghost_style text,
  transcription_id uuid references public.transcriptions(id) on delete set null,
  prompt text,
  model_id text,
  generation_id text,
  subtitle_id uuid references public.subtitles(id) on delete set null,
  cover_storage_path text,
  storage_path text,
  mime_type text not null default 'video/mp4' check (mime_type = 'video/mp4'),
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.video_clips (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  title text not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  duration_seconds numeric(12,3) not null check (duration_seconds between 0 and 900),
  created_at timestamptz not null default now()
);

create table if not exists public.episode_video_clips (
  id uuid primary key default gen_random_uuid(),
  episode_video_id uuid not null references public.episode_videos(id) on delete cascade,
  video_clip_id uuid not null references public.video_clips(id) on delete cascade,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (episode_video_id, position),
  unique (episode_video_id, video_clip_id)
);

create table if not exists public.music_assets (
  id uuid primary key, episode_id uuid not null references public.episodes(id) on delete cascade,
  name text not null, storage_path text not null unique, mime_type text not null,
  format text not null check (format in ('mp3','mp4')), size_bytes bigint not null check (size_bytes > 0),
  duration_seconds numeric(12,3) not null check (duration_seconds between 0 and 3600),
  status text not null check (status in ('READY','FAILED')), created_at timestamptz not null default now(), error_message text
);
create table if not exists public.episode_video_music_tracks (
  id uuid primary key default gen_random_uuid(), episode_video_id uuid not null references public.episode_videos(id) on delete cascade,
  music_asset_id uuid not null references public.music_assets(id) on delete cascade, order_index integer not null check (order_index >= 0),
  volume double precision not null default 0.2 check (volume between 0 and 2), start_seconds double precision not null default 0 check (start_seconds >= 0),
  end_seconds double precision check (end_seconds > start_seconds), output_start_seconds double precision not null default 0 check (output_start_seconds >= 0),
  fade_in_seconds double precision not null default 0 check (fade_in_seconds between 0 and 60), fade_out_seconds double precision not null default 0 check (fade_out_seconds between 0 and 60),
  created_at timestamptz not null default now(), unique (episode_video_id, order_index)
);
create table if not exists public.episode_video_subtitle_styles (
  id uuid primary key default gen_random_uuid(), episode_video_id uuid not null unique references public.episode_videos(id) on delete cascade,
  animation text not null default 'karaoke', font_family text not null default 'Arial', font_size integer not null default 52,
  font_weight text not null default 'bold', text_color text not null default '#ffffff', highlight_color text not null default '#ffe45e',
  alignment text not null default 'center', position text not null default 'bottom', outline_color text not null default '#000000', outline_width double precision not null default 2,
  background_color text not null default '#000000', background_opacity double precision not null default 0, shadow double precision not null default 1,
  line_spacing double precision not null default 1, letter_spacing double precision not null default 0, created_at timestamptz not null default now()
);

create index if not exists idx_episodes_project_created on public.episodes(project_id, created_at desc);
create index if not exists idx_scripts_episode_version on public.scripts(episode_id, version desc);
create index if not exists idx_characters_episode on public.characters(episode_id);
create index if not exists idx_voice_mappings_character on public.voice_mappings(character_id);
create index if not exists idx_batches_episode_created on public.generation_batches(episode_id, created_at desc);
create index if not exists idx_batches_status on public.generation_batches(status);
create index if not exists idx_batch_voice_mappings_batch on public.generation_batch_voice_mappings(batch_id);
create index if not exists idx_chunks_batch_index on public.generation_chunks(batch_id, chunk_index);
create index if not exists idx_chunks_status on public.generation_chunks(status);
create index if not exists idx_audios_episode_kind_created on public.audios(episode_id, kind, created_at desc);
create index if not exists idx_audios_chunk on public.audios(chunk_id);
create index if not exists idx_compositions_episode_created on public.compositions(episode_id, created_at desc);
create index if not exists idx_composition_items_order on public.composition_items(composition_id, order_index);
create index if not exists idx_transcriptions_audio on public.transcriptions(audio_id, created_at desc);
create index if not exists idx_transcription_segments_sequence on public.transcription_segments(transcription_id, sequence);
create index if not exists idx_subtitles_transcription on public.subtitles(transcription_id, created_at desc);
create index if not exists idx_episode_videos_episode_created on public.episode_videos(episode_id, created_at desc);
create index if not exists idx_video_clips_episode on public.video_clips(episode_id, created_at desc);
create index if not exists idx_episode_video_clips_position on public.episode_video_clips(episode_video_id, position);

-- Existing schema has no login flow. Keep the same anonymous single-workspace
-- access model as the legacy state table. Add user-scoped RLS before production use.
do $$
declare t text;
begin
  foreach t in array array[
    'projects','episodes','scripts','characters','voice_mappings','generation_batches',
    'generation_batch_voice_mappings','generation_chunks','audios','compositions',
    'composition_items','transcriptions','transcription_segments','subtitles',
    'episode_videos','video_clips','episode_video_clips','music_assets','episode_video_music_tracks','episode_video_subtitle_styles'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to anon', t);
    execute format('drop policy if exists anon_full_access on public.%I', t);
    execute format('create policy anon_full_access on public.%I for all to anon using (true) with check (true)', t);
  end loop;
end $$;

-- One transaction-safe RPC applies all changed rows and relationship snapshots.
create or replace function public.apply_studio_changes(p_changes jsonb)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  i integer;
  t text;
  v_ids jsonb;
  v_rows jsonb;
  v_parent text;
  v_columns text;
  v_updates text;
  v_base_order text[] := array[
    'projects','episodes','scripts','characters','voice_mappings','generation_batches',
    'generation_chunks','audios','compositions','composition_items','transcriptions',
    'subtitles','music_assets','episode_videos','video_clips'
  ];
  v_relations text[] := array['generation_batch_voice_mappings','transcription_segments','episode_video_clips','episode_video_music_tracks','episode_video_subtitle_styles'];
begin
  -- Replace child snapshots inside the same transaction as their owning records.
  foreach t in array v_relations loop
    v_rows := p_changes->'replacements'->t->'rows';
    v_ids := p_changes->'replacements'->t->'parent_ids';
    v_parent := case t
      when 'generation_batch_voice_mappings' then 'batch_id'
      when 'transcription_segments' then 'transcription_id'
      when 'episode_video_clips' then 'episode_video_id'
      else 'episode_video_id' end;
    if jsonb_typeof(v_ids) = 'array' and jsonb_array_length(v_ids) > 0 then
      execute format('delete from public.%I where %I = any(array(select jsonb_array_elements_text($1)::uuid))', t, v_parent) using v_ids;
    end if;
  end loop;

  -- Delete dependent records first; foreign keys provide cascading cleanup.
  for i in reverse array_length(v_base_order, 1)..1 loop
    t := v_base_order[i];
    v_ids := p_changes->'deletes'->t;
    if jsonb_typeof(v_ids) = 'array' and jsonb_array_length(v_ids) > 0 then
      execute format('delete from public.%I where id = any(array(select jsonb_array_elements_text($1)::uuid))', t) using v_ids;
    end if;
  end loop;

  -- Explicit columns come from each table's catalog, while JSON rows are typed
  -- using that table's composite type. No entity is stored as an opaque document.
  foreach t in array v_base_order loop
    v_rows := p_changes->'upserts'->t;
    if jsonb_typeof(v_rows) = 'array' and jsonb_array_length(v_rows) > 0 then
      select string_agg(format('%I', a.attname), ', ' order by a.attnum),
             string_agg(format('%1$I = excluded.%1$I', a.attname), ', ' order by a.attnum)
        into v_columns, v_updates
        from pg_attribute a
       where a.attrelid = format('public.%I', t)::regclass
         and a.attnum > 0 and not a.attisdropped and a.attname <> 'id';
      v_columns := 'id, ' || v_columns;
      execute format(
        'insert into public.%I (%s) select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (id) do update set %s',
        t, v_columns, t, v_updates
      ) using v_rows;
    end if;
  end loop;

  foreach t in array v_relations loop
    v_rows := p_changes->'replacements'->t->'rows';
    if jsonb_typeof(v_rows) = 'array' and jsonb_array_length(v_rows) > 0 then
      select string_agg(format('%I', a.attname), ', ' order by a.attnum),
             string_agg(format('%1$I = excluded.%1$I', a.attname), ', ' order by a.attnum)
        into v_columns, v_updates
        from pg_attribute a
       where a.attrelid = format('public.%I', t)::regclass
         and a.attnum > 0 and not a.attisdropped and a.attname <> 'id';
      v_columns := 'id, ' || v_columns;
      execute format(
        'insert into public.%I (%s) select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (id) do update set %s',
        t, v_columns, t, v_updates
      ) using v_rows;
    end if;
  end loop;
end;
$$;
revoke all on function public.apply_studio_changes(jsonb) from public;
grant execute on function public.apply_studio_changes(jsonb) to anon;

-- Normalize camelCase keys from the legacy API aggregate into SQL column names.
create or replace function pg_temp.studio_legacy_rows(p_key text)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg((
    select jsonb_object_agg(lower(regexp_replace(k, '([A-Z])', '_\1', 'g')), v)
    from jsonb_each(item) as e(k, v)
  )), '[]'::jsonb)
  from jsonb_array_elements(coalesce((select data->p_key from public.studio_state where id = 'main'), '[]'::jsonb)) as src(item)
$$;

do $$
declare
  t text;
keys text[] := array[
  'projects','episodes','scripts','characters','voiceMappings','batches','chunks','audios',
  'compositions','compositionItems','transcriptions','subtitles','videos','videoClips'
];
tables text[] := array[
  'projects','episodes','scripts','characters','voice_mappings','generation_batches','generation_chunks','audios',
  'compositions','composition_items','transcriptions','subtitles','episode_videos','video_clips'
];
source_index integer;
actual_count integer;
expected_count integer;
begin
  if to_regclass('public.studio_state') is null then
    raise exception 'Expected legacy public.studio_state table before normalized migration';
  end if;

  for source_index in 1..array_length(keys, 1) loop
    t := tables[source_index];
    execute format(
      'insert into public.%I select * from jsonb_populate_recordset(null::public.%I, pg_temp.studio_legacy_rows($1)) on conflict (id) do nothing',
      t, t
    ) using keys[source_index];
    execute format(
      'select count(*) from jsonb_array_elements(pg_temp.studio_legacy_rows($1)) src(item) where not exists (select 1 from public.%I dst where dst.id = (src.item->>''id'')::uuid)',
      t
    ) into actual_count using keys[source_index];
    if actual_count > 0 then
      raise exception 'Data copy validation failed for table %: % source row(s) are missing', t, actual_count;
    end if;
  end loop;

  -- Snapshot mappings and ordered arrays become first-class relation rows.
  insert into public.generation_batch_voice_mappings(id, batch_id, speaker_key, voice_id, created_at)
  select gen_random_uuid(), (b->>'id')::uuid, m.key, m.value #>> '{}', coalesce((b->>'createdAt')::timestamptz, now())
  from jsonb_array_elements(pg_temp.studio_legacy_rows('batches')) b
  cross join lateral jsonb_each(coalesce(b->'voice_mappings', '{}'::jsonb)) m
  on conflict (batch_id, speaker_key) do nothing;

  insert into public.transcription_segments(id, transcription_id, sequence, start_seconds, end_seconds, text)
  select gen_random_uuid(), (tr->>'id')::uuid, seg.ordinality::integer,
         (seg.value->>'start')::numeric, (seg.value->>'end')::numeric, seg.value->>'text'
  from jsonb_array_elements(pg_temp.studio_legacy_rows('transcriptions')) tr
  cross join lateral jsonb_array_elements(coalesce(tr->'segments', '[]'::jsonb)) with ordinality seg(value, ordinality)
  on conflict (transcription_id, sequence) do nothing;

  insert into public.episode_video_clips(id, episode_video_id, video_clip_id, position, created_at)
  select gen_random_uuid(), (v->>'id')::uuid, c.value::text::uuid, c.ordinality::integer - 1,
         coalesce((v->>'createdAt')::timestamptz, now())
  from jsonb_array_elements(pg_temp.studio_legacy_rows('videos')) v
  cross join lateral jsonb_array_elements_text(coalesce(v->'clip_ids', '[]'::jsonb)) with ordinality c(value, ordinality)
  on conflict (episode_video_id, position) do nothing;

  select coalesce(sum((select count(*) from jsonb_each(coalesce(item->'voice_mappings', '{}'::jsonb)))), 0)::integer
    into expected_count from jsonb_array_elements(pg_temp.studio_legacy_rows('batches')) src(item);
  select count(*) into actual_count from public.generation_batch_voice_mappings;
  if actual_count < expected_count then raise exception 'Batch voice snapshot migration is incomplete'; end if;

  select coalesce(sum(jsonb_array_length(coalesce(item->'segments', '[]'::jsonb))), 0)::integer
    into expected_count from jsonb_array_elements(pg_temp.studio_legacy_rows('transcriptions')) src(item);
  select count(*) into actual_count from public.transcription_segments;
  if actual_count < expected_count then raise exception 'Transcription segment migration is incomplete'; end if;

  select coalesce(sum(jsonb_array_length(coalesce(item->'clip_ids', '[]'::jsonb))), 0)::integer
    into expected_count from jsonb_array_elements(pg_temp.studio_legacy_rows('videos')) src(item);
  select count(*) into actual_count from public.episode_video_clips;
  if actual_count < expected_count then raise exception 'Video source clip migration is incomplete'; end if;

  -- The source row has been copied and count-checked inside this transaction.
  drop table public.studio_state;
end $$;

drop function pg_temp.studio_legacy_rows(text);

-- Make newly created tables visible to Supabase REST/PostgREST immediately.
notify pgrst, 'reload schema';
