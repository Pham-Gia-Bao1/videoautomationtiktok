create table if not exists public.episode_video_edit_events (
  id uuid primary key,
  episode_video_id uuid not null references public.episode_videos(id) on delete cascade,
  track text not null check (track in ('typography','sticker','visual-effect','sound-effect')),
  start_seconds double precision not null check (start_seconds >= 0),
  end_seconds double precision not null check (end_seconds > start_seconds),
  text text not null default '',
  animation text not null default 'pop',
  position text not null default 'center' check (position in ('top','center','bottom')),
  scale double precision not null default 1 check (scale between 0.25 and 4),
  opacity double precision not null default 1 check (opacity between 0 and 1),
  volume double precision not null default 0.2 check (volume between 0 and 2),
  enabled boolean not null default true,
  order_index integer not null default 0 check (order_index >= 0),
  music_asset_id uuid references public.music_assets(id) on delete set null,
  effect text,
  created_at timestamptz not null default now(),
  check (track <> 'sound-effect' or music_asset_id is not null)
);
create index if not exists episode_video_edit_events_timeline_idx
  on public.episode_video_edit_events(episode_video_id, start_seconds, order_index);
alter table public.episode_video_edit_events enable row level security;
grant select, insert, update, delete on public.episode_video_edit_events to anon;
drop policy if exists anon_full_access on public.episode_video_edit_events;
create policy anon_full_access on public.episode_video_edit_events for all to anon using (true) with check (true);

create or replace function public.apply_studio_changes(p_changes jsonb)
returns void language plpgsql set search_path = public, pg_temp as $$
declare i integer; t text; v_ids jsonb; v_rows jsonb; v_columns text; v_updates text;
  v_base_order text[] := array['projects','episodes','scripts','characters','voice_mappings','generation_batches','generation_chunks','audios','compositions','composition_items','transcriptions','subtitles','music_assets','episode_videos','video_clips','episode_video_edit_events'];
  v_relations text[] := array['generation_batch_voice_mappings','transcription_segments','episode_video_clips','episode_video_music_tracks','episode_video_subtitle_styles'];
begin
  foreach t in array v_relations loop
    v_rows := p_changes->'replacements'->t->'rows'; v_ids := p_changes->'replacements'->t->'parent_ids';
    if t = 'generation_batch_voice_mappings' then
      if jsonb_typeof(v_ids)='array' and jsonb_array_length(v_ids)>0 then execute format('delete from public.%I where batch_id = any(array(select jsonb_array_elements_text($1)::uuid))',t) using v_ids; end if;
    elsif t = 'transcription_segments' then
      if jsonb_typeof(v_ids)='array' and jsonb_array_length(v_ids)>0 then execute format('delete from public.%I where transcription_id = any(array(select jsonb_array_elements_text($1)::uuid))',t) using v_ids; end if;
    else
      if jsonb_typeof(v_ids)='array' and jsonb_array_length(v_ids)>0 then execute format('delete from public.%I where episode_video_id = any(array(select jsonb_array_elements_text($1)::uuid))',t) using v_ids; end if;
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
