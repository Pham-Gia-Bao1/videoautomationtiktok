# Supabase relational persistence

## What changed

The old `studio_state` row stored the complete workspace as one JSONB document. That made each small edit read and rewrite the full workspace, prevented normal foreign-key enforcement, and made filtering/reporting by project, episode, status, or date difficult.

The normalized migration creates one table per persisted entity. The TypeScript domain model remains camelCase; the API adapter maps it to snake_case SQL columns. API route URLs and JSON response shapes remain stable for the web app.

## Tables and relationships

| Table | Purpose and key columns |
|---|---|
| `projects` | Project name, description, owner scope, created/updated timestamps |
| `episodes` | Project FK, title, language, default model, lifecycle status |
| `scripts` | Episode FK, raw text, source, version, creation timestamp; unique episode/version |
| `characters` | Episode FK, stable speaker key, display name |
| `voice_mappings` | Character FK, provider voice ID/name, optional voice settings |
| `generation_batches` | Episode and script FKs, model/language/settings, state, counts, normalization, seed, lifecycle timestamps |
| `generation_batch_voice_mappings` | Immutable per-batch speaker-to-voice snapshot |
| `generation_chunks` | Batch FK, chunk boundaries/counts, generation status, provider payload/hash, retry and error fields, linked audio ID |
| `audios` | Episode and optional chunk FKs, storage path, MIME type, duration, byte size, format, metadata, soft-delete timestamp |
| `compositions` | Episode FK, state, output audio FK, error and lifecycle timestamps |
| `composition_items` | Composition/audio FKs, order, trims, gap duration |
| `transcriptions` | Audio FK, language, transcript text, provider, status, error and lifecycle timestamps |
| `transcription_segments` | Transcription FK, ordered start/end times and text |
| `subtitles` | Transcription FK, format, content, storage path |
| `episode_videos` | Episode/audio/subtitle/transcription references, source mode, prompt/model/provider IDs, aspect/resolution, render status/path/size/errors |
| `video_clips` | Episode FK, uploaded clip path, MIME type, size, duration |
| `episode_video_clips` | Ordered many-to-many relationship between rendered videos and source clips |
| `music_assets` | Episode music library metadata; audio bytes remain in the configured media directory |
| `episode_video_music_tracks` | Ordered track selections, volume, trims, timeline offsets, and fades for each export |
| `episode_video_subtitle_styles` | Typed subtitle font, color, position, animation, and layout settings for each export |

Provider payloads, flexible voice/generation settings, and audio metadata remain JSONB because their shape is provider-defined or extensible. The project, episode, generation, composition, transcript, subtitle, and video records are stored as typed columns. Transcript segments and ordered clip IDs are relational child tables rather than JSON arrays.

## Persistence behavior

`apps/api/src/store.ts` loads entity rows from their individual tables once when the API process starts and joins the three child collections into the existing domain shapes. The single API process keeps that aggregate in memory for the existing route handlers. `updateData()` computes changed, inserted, and removed entity rows, then sends only those changes to the `apply_studio_changes(jsonb)` PostgreSQL function. That function applies the change set in one Postgres transaction, in FK-safe order. The JSONB parameter is a transient change-set transport; it is not a persisted workspace blob.

The current route handlers use the domain aggregate for validation and response composition. Startup reads are parallel and paginated at 1,000 rows; ordinary API reads use the in-memory snapshot, while writes persist only changed rows. Run one API instance as the writer. If the app later runs multiple API instances or needs cross-client live database edits, add row-version checks/change notifications or move the handlers to route-specific repository queries.

## Migration and data preservation

Apply migrations from the repository root with Supabase CLI after authentication/linking. Run `supabase db push`; do not manually apply only one SQL file when the database still has the legacy `studio_state` table.

1. `20261114000000_legacy_studio_state.sql` records the legacy table as an idempotent baseline for projects where it was created manually.
2. `20261115000100_normalize_studio_data.sql` creates the relational schema and indexes, copies every legacy entity while retaining IDs and timestamps, copies voice snapshots/transcript segments/ordered clip links, checks source counts, and only then drops `studio_state` in the same transaction.
3. `20261115000200_video_music_subtitles.sql` adds the normalized music library and per-video track/style tables and updates the transactional persistence RPC. This also works if migration 2 was applied before these features were added.

`apps/api/supabase/001_studio_state.sql` was a duplicate of the legacy baseline and has been removed. The root `supabase/migrations/` directory is the only migration source of truth.

The normalized migration deliberately has no fallback to a local JSON store. Audio/video/music bytes and uploads still use the current local media directories; their metadata/path records are relational. Supabase Storage migration is a separate step.

## Access model

The project currently has no authentication flow. The migration retains anonymous read/write access so the existing single-workspace API continues to work with the publishable key. Every anonymous client can access all workspace rows; this is suitable only for private development data. Add Supabase Auth, user IDs, and owner-scoped RLS before exposing the project to the public internet.
