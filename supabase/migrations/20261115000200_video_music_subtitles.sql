-- Normalized music library and per-video timeline/style configuration.
create table if not exists public.music_assets (
  id uuid primary key,
  episode_id uuid not null references public.episodes(id) on delete cascade,
  name text not null,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('audio/mpeg','audio/mp4','video/mp4')),
  format text not null check (format in ('mp3','mp4')),
  size_bytes bigint not null check (size_bytes > 0),
  duration_seconds double precision not null check (duration_seconds > 0 and duration_seconds <= 3600),
  status text not null check (status in ('READY','FAILED')),
  created_at timestamptz not null default now(),
  error_message text
);
create index if not exists music_assets_episode_created_idx on public.music_assets(episode_id, created_at desc);

create table if not exists public.episode_video_music_tracks (
  id uuid primary key default gen_random_uuid(),
  episode_video_id uuid not null references public.episode_videos(id) on delete cascade,
  music_asset_id uuid not null references public.music_assets(id) on delete cascade,
  order_index integer not null check (order_index >= 0),
  volume double precision not null default 0.2 check (volume between 0 and 2),
  start_seconds double precision not null default 0 check (start_seconds >= 0),
  end_seconds double precision check (end_seconds > start_seconds),
  output_start_seconds double precision not null default 0 check (output_start_seconds >= 0),
  fade_in_seconds double precision not null default 0 check (fade_in_seconds between 0 and 60),
  fade_out_seconds double precision not null default 0 check (fade_out_seconds between 0 and 60),
  created_at timestamptz not null default now(),
  unique (episode_video_id, order_index)
);
create index if not exists episode_video_music_video_idx on public.episode_video_music_tracks(episode_video_id, order_index);

create table if not exists public.episode_video_subtitle_styles (
  id uuid primary key default gen_random_uuid(),
  episode_video_id uuid not null unique references public.episode_videos(id) on delete cascade,
  animation text not null default 'karaoke' check (animation in ('karaoke','word','fade','pop','typewriter','smooth')),
  font_family text not null default 'Arial', font_size integer not null default 52 check (font_size between 12 and 160),
  font_weight text not null default 'bold' check (font_weight in ('regular','medium','bold','extra-bold')),
  text_color text not null default '#ffffff', highlight_color text not null default '#ffe45e',
  alignment text not null default 'center' check (alignment in ('left','center','right')),
  position text not null default 'bottom' check (position in ('top','center','bottom')),
  outline_color text not null default '#000000', outline_width double precision not null default 2 check (outline_width between 0 and 12),
  background_color text not null default '#000000', background_opacity double precision not null default 0 check (background_opacity between 0 and 1),
  shadow double precision not null default 1 check (shadow between 0 and 10),
  line_spacing double precision not null default 1 check (line_spacing between 0.5 and 3),
  letter_spacing double precision not null default 0 check (letter_spacing between -5 and 20),
  created_at timestamptz not null default now()
);

-- Keep the API's existing transactional change RPC in sync for installations that
-- already applied the normalized schema migration before this feature was added.
do $$ declare t text; begin
  foreach t in array array['music_assets','episode_video_music_tracks','episode_video_subtitle_styles'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('grant select, insert, update, delete on public.%I to anon',t);
    execute format('drop policy if exists anon_full_access on public.%I',t);
    execute format('create policy anon_full_access on public.%I for all to anon using (true) with check (true)',t);
  end loop;
end $$;

create or replace function public.apply_studio_changes(p_changes jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
declare i integer; t text; v_ids jsonb; v_rows jsonb; v_parent text; v_columns text; v_updates text;
  v_base_order text[] := array['projects','episodes','scripts','characters','voice_mappings','generation_batches','generation_chunks','audios','compositions','composition_items','transcriptions','subtitles','music_assets','episode_videos','video_clips'];
  v_relations text[] := array['generation_batch_voice_mappings','transcription_segments','episode_video_clips','episode_video_music_tracks','episode_video_subtitle_styles'];
begin
  foreach t in array v_relations loop
    v_rows := p_changes->'replacements'->t->'rows'; v_ids := p_changes->'replacements'->t->'parent_ids';
    v_parent := case t when 'generation_batch_voice_mappings' then 'batch_id' when 'transcription_segments' then 'transcription_id' else 'episode_video_id' end;
    if jsonb_typeof(v_ids)='array' and jsonb_array_length(v_ids)>0 then
      execute format('delete from public.%I where %I = any(array(select jsonb_array_elements_text($1)::uuid))',t,v_parent) using v_ids;
    end if;
  end loop;
  for i in reverse array_length(v_base_order,1)..1 loop
    t:=v_base_order[i]; v_ids:=p_changes->'deletes'->t;
    if jsonb_typeof(v_ids)='array' and jsonb_array_length(v_ids)>0 then execute format('delete from public.%I where id = any(array(select jsonb_array_elements_text($1)::uuid))',t) using v_ids; end if;
  end loop;
  foreach t in array v_base_order loop
    v_rows:=p_changes->'upserts'->t;
    if jsonb_typeof(v_rows)='array' and jsonb_array_length(v_rows)>0 then
      select string_agg(format('%I',a.attname),', ' order by a.attnum), string_agg(format('%1$I = excluded.%1$I',a.attname),', ' order by a.attnum) into v_columns,v_updates
        from pg_attribute a where a.attrelid=format('public.%I',t)::regclass and a.attnum>0 and not a.attisdropped and a.attname<>'id';
      execute format('insert into public.%I (id, %s) select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (id) do update set %s',t,v_columns,t,v_updates) using v_rows;
    end if;
  end loop;
  foreach t in array v_relations loop
    v_rows:=p_changes->'replacements'->t->'rows';
    if jsonb_typeof(v_rows)='array' and jsonb_array_length(v_rows)>0 then
      select string_agg(format('%I',a.attname),', ' order by a.attnum), string_agg(format('%1$I = excluded.%1$I',a.attname),', ' order by a.attnum) into v_columns,v_updates
        from pg_attribute a where a.attrelid=format('public.%I',t)::regclass and a.attnum>0 and not a.attisdropped and a.attname<>'id';
      execute format('insert into public.%I (id, %s) select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (id) do update set %s',t,v_columns,t,v_updates) using v_rows;
    end if;
  end loop;
end; $$;
revoke all on function public.apply_studio_changes(jsonb) from public;
grant execute on function public.apply_studio_changes(jsonb) to anon;

notify pgrst, 'reload schema';
