# Database Schema


### 7.1 ERD

```
users ─┬─< projects ─< episodes ─┬─< scripts ─< script_lines
       │                         │
       │                         ├─< characters ─< voice_mappings
       │                         │
       │                         ├─< generation_batches ─< generation_chunks ─< audios
       │                         │                                             └─< episode_videos
       │                         │
       │                         ├─< compositions ─< composition_items
       │                         │
       │                         └─< transcriptions ─< subtitles
```

### 7.2 Tables

**projects**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| user_id | uuid | FK → auth.users |
| name | text | |
| description | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**episodes**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| project_id | uuid | FK → projects |
| title | text | |
| language_code | text | default 'en' |
| default_model_id | text | default 'eleven_v3' |
| status | text | draft/generating/ready/archived |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**scripts**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| raw_text | text | |
| source | text | chatgpt/manual/import |
| version | int | |
| created_at | timestamptz | |

**script_lines**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| script_id | uuid | FK → scripts |
| sequence | int | bắt đầu 1 |
| speaker_key | text | lowercase slug |
| speaker_name | text | |
| text | text | giữ audio tags |
| created_at | timestamptz | |

**characters**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| key | text | slug |
| name | text | |
| created_at | timestamptz | |

**voice_mappings**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| character_id | uuid | FK → characters |
| voice_id | text | ElevenLabs voice_id |
| voice_name | text | |
| settings | jsonb | |
| created_at | timestamptz | |

**generation_batches**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| script_id | uuid | FK → scripts |
| label | text | "Batch #1" |
| model_id | text | eleven_v3 |
| language_code | text | |
| settings | jsonb | |
| status | text | DRAFT/QUEUED/RUNNING/PARTIAL/COMPLETED/FAILED/CANCELLED |
| total_chunks | int | |
| completed_chunks | int | |
| failed_chunks | int | |
| created_at | timestamptz | |
| started_at | timestamptz | |
| completed_at | timestamptz | |

**generation_chunks**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| batch_id | uuid | FK → generation_batches |
| chunk_index | int | 1-based |
| start_line | int | |
| end_line | int | |
| character_count | int | |
| input_count | int | |
| payload | jsonb | snapshot |
| payload_hash | text | sha256 |
| status | text | PENDING/QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED |
| audio_id | uuid | FK → audios |
| error_code | text | |
| error_message | text | |
| retry_count | int | default 0 |
| created_at | timestamptz | |
| completed_at | timestamptz | |

**audios**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| chunk_id | uuid | nullable |
| kind | text | 'chunk' / 'final' |
| storage_path | text | |
| mime_type | text | audio/mpeg |
| duration_seconds | numeric | |
| size_bytes | bigint | |
| output_format | text | mp3_44100_128 |
| metadata | jsonb | voice_segments |
| created_at | timestamptz | |

**episode_videos**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| audio_id | uuid | FK → audios (final composition only) |
| title | text | |
| status | text | PROCESSING/READY/FAILED |
| source_mode | text | elevenlabs/uploaded/cover (cover for legacy exports) |
| prompt | text | nullable generation prompt |
| model_id | text | nullable ElevenLabs model |
| generation_id | text | nullable provider job ID |
| clip_ids | jsonb | ordered uploaded clip IDs |
| subtitle_id | uuid | nullable SRT generated from selected audio |
| cover_storage_path | text | nullable legacy cover storage |
| storage_path | text | private MP4 path, nullable until READY |
| mime_type | text | video/mp4 |
| size_bytes | bigint | |
| error_message | text | nullable |
| created_at | timestamptz | |
| completed_at | timestamptz | |

**video_clips**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| title | text | original upload filename |
| storage_path | text | private local video storage |
| mime_type | text | MP4 / QuickTime / WebM |
| size_bytes | bigint | maximum 100 MB |
| duration_seconds | numeric | maximum 900 seconds |
| created_at | timestamptz | |

**compositions**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| name | text | |
| status | text | DRAFT/MERGING/READY/FAILED |
| output_audio_id | uuid | FK → audios |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**composition_items**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| composition_id | uuid | FK → compositions |
| audio_id | uuid | FK → audios |
| order_index | int | |
| trim_start_ms | int | |
| trim_end_ms | int | |
| gap_ms | int | default 0 |

**transcriptions**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| audio_id | uuid | FK → audios |
| language_code | text | |
| text | text | |
| segments | jsonb | |
| status | text | PENDING/RUNNING/COMPLETED/FAILED |
| provider | text | 'elevenlabs' |
| created_at | timestamptz | |
| completed_at | timestamptz | |

**subtitles**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| transcription_id | uuid | FK → transcriptions |
| format | text | 'srt' / 'vtt' |
| storage_path | text | |
| content | text | |
| created_at | timestamptz | |

### 7.3 Storage buckets

| Bucket | Path pattern | Public |
|--------|--------------|--------|
| `audio` | `{userId}/{episodeId}/chunks/{chunkId}.mp3` | private |
| `audio` | `{userId}/{episodeId}/final/{compositionId}.mp3` | private |
| `videos` | `{videoId}.mp4` | private local data directory |
| `videos` | `{clipId}.{ext}` | private local uploaded clips |
| `videos` | `{videoId}-generated.mp4` | private local generated clips |
| `videos` | `{videoId}-cover.{ext}` | private legacy cover exports |
| `subtitles` | `{userId}/{episodeId}/{subtitleId}.srt` | private |
| `payloads` | `{userId}/{episodeId}/batches/{batchId}/{chunkId}.json` | private |

### 7.4 RLS sample

```sql
create policy "projects_select_own"
on projects for select
using (auth.uid() = user_id);

create policy "projects_insert_own"
on projects for insert
with check (auth.uid() = user_id);
```

### 7.5 Indexes

```sql
create index idx_episodes_project on episodes(project_id);
create index idx_script_lines_script on script_lines(script_id, sequence);
create index idx_batches_episode on generation_batches(episode_id, created_at desc);
create index idx_chunks_batch on generation_chunks(batch_id, chunk_index);
create index idx_chunks_status on generation_chunks(status);
create index idx_audios_episode on audios(episode_id, kind);
create index idx_composition_items_order on composition_items(composition_id, order_index);
```

---
