-- Existing installations already applied the normalized schema. Extend the
-- video status constraint so saved, editable video drafts can be persisted.
alter table public.episode_videos
  drop constraint if exists episode_videos_status_check;

alter table public.episode_videos
  add constraint episode_videos_status_check
  check (status in ('DRAFT','PROCESSING','READY','FAILED'));
