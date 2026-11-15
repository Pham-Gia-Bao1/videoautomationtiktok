# Podcast Studio — Build Documentation

> Hệ thống tạo podcast multi-speaker từ script hội thoại, sử dụng ElevenLabs Text-to-Speech SDK cho từng lượt thoại, sau đó merge, transcribe và export MP3/SRT.

**Version:** 1.0
**Last updated:** 2024
**Status:** Ready for Agent build

---

## Mục lục

1. [Product Overview & Scope](#1-product-overview--scope)
2. [System Architecture](#2-system-architecture)
3. [End-to-End Business Flow](#3-end-to-end-business-flow)
4. [Functional Requirements](#4-functional-requirements)
5. [Next.js Frontend Architecture](#5-nextjs-frontend-architecture)
6. [Node.js Backend Architecture](#6-nodejs-backend-architecture)
7. [Database Schema](#7-database-schema)
8. [API Specification](#8-api-specification)
9. [ElevenLabs Integration](#9-elevenlabs-integration)
10. [Script Parser & Payload Mapper](#10-script-parser--payload-mapper)
11. [Chunking Engine](#11-chunking-engine)
12. [Generation Queue / Worker](#12-generation-queue--worker)
13. [MP3 Library & Composer](#13-mp3-library--composer)
14. [FFmpeg Merge Pipeline](#14-ffmpeg-merge-pipeline)
15. [Speech-to-Text & SRT](#15-speech-to-text--srt)
16. [State Machines](#16-state-machines)
17. [Security](#17-security)
18. [Error Handling & Retry](#18-error-handling--retry)
19. [Testing Strategy](#19-testing-strategy)
20. [MVP Acceptance Criteria](#20-mvp-acceptance-criteria)
21. [Deployment Architecture](#21-deployment-architecture)
22. [Environment Variables](#22-environment-variables)
23. [Future Enhancements](#23-future-enhancements)
24. [Open Items](#24-open-items)

---

## 1. Product Overview & Scope

### 1.1 Mục tiêu sản phẩm
Cho phép người dùng biến **script hội thoại nhiều nhân vật** (do ChatGPT hoặc người dùng viết) thành **podcast MP3 hoàn chỉnh** với:
- Nhiều giọng nói (multi-speaker dialogue)
- Biểu cảm (emotion/audio tags)
- Chọn lựa nhiều phiên bản generation
- Ghép nối, export MP3
- Sinh phụ đề SRT tự động từ audio cuối cùng

### 1.2 Đối tượng người dùng
- Content creator làm podcast/audio drama.
- Người dùng ChatGPT muốn chuyển script thành audio.
- Team nhỏ cần quy trình generate → chọn lựa → merge → export.

### 1.3 Trong scope MVP
- Tạo project + episode.
- Paste script hội thoại (format `Speaker: text`).
- Parser nhận diện nhân vật & lời thoại.
- Mapping nhân vật → voice ElevenLabs.
- Build normalized multi-speaker payload and call Text-to-Speech once per turn.
- Chunking theo rule ≤ 2,000 characters/chunk, không cắt giữa turn.
- Background generation qua queue worker.
- MP3 Library lưu trữ tất cả chunk audio.
- Drag & drop composer để ghép chunk thành final audio.
- FFmpeg merge MP3.
- Speech-to-Text trên final MP3.
- Sinh SRT + export MP3 / SRT.
- Video export: tạo clip bằng ElevenLabs Image & Video Generation hoặc upload, chọn và sắp thứ tự clip cá nhân; ghép final MP3 và SRT bằng FFmpeg.
- Retry khi lỗi.
- Xem status/state của batch & chunk.

### 1.4 Ngoài scope MVP
- Multi-tenant org & billing.
- Voice cloning.
- Realtime collaboration.
- Mobile app native.
- Pronunciation dictionary editor UI (chỉ hỗ trợ API).
- Music / SFX library (chỉ merge voice chunks).

### 1.5 Assumptions
- ElevenLabs API key có quyền dùng `eleven_v3` và Text-to-Speech.
- User chấp nhận rule ≤ 2,000 chars/request.
- Backend chạy được FFmpeg.
- Redis khả dụng cho BullMQ.

### 1.6 Success metrics (MVP)
- Generate thành công ≥ 95% chunk khi API không lỗi.
- Thời gian từ click Generate → có final MP3 < 5 phút với script ~8,500 chars.
- SRT khớp audio final ≥ 90% theo spot check.
- Zero plaintext API key ở FE.

---

## 2. System Architecture

### 2.1 Sơ đồ tổng thể

```
                         ┌───────────────┐
                         │    ChatGPT    │
                         │ Script Writer │
                         └───────┬───────┘
                                 │ Copy
                                 ▼
┌─────────────────────────────────────────────────────┐
│                  NEXT.JS FRONTEND                   │
│  Projects                                           │
│     ├── Script Editor                               │
│     ├── Payload Editor                              │
│     ├── Generation Monitor                          │
│     ├── Audio Library                               │
│     ├── Audio Composer                              │
│     ├── Composition Library                         │
│     ├── Transcription                               │
│     └── SRT Editor / Export                         │
└───────────────────────┬─────────────────────────────┘
                        │ REST /api/*
                        ▼
┌─────────────────────────────────────────────────────┐
│                  NODE.JS BACKEND                    │
│  Script Parser        Payload Mapper                │
│  Chunking Engine      Generation Service            │
│  Audio Service        Composition Service           │
│  Transcription Svc    SRT Service                   │
│  ElevenLabs Adapter                                 │
└───────────────┬───────────────────┬─────────────────┘
                │                   │
                ▼                   ▼
        ┌──────────────┐    ┌─────────────────┐
        │   Supabase   │    │   BullMQ/Redis  │
        │ PostgreSQL   │    │ Generation Jobs │
        │ Storage      │    │ Merge Jobs      │
        │ Auth         │    │ STT Jobs        │
        └──────────────┘    └────────┬────────┘
                                     ▼
                            ┌──────────────────┐
                            │   Job Worker     │
                            └────────┬─────────┘
                                     │
                         ┌───────────┴────────────┐
                         ▼                        ▼
                  ┌─────────────┐          ┌──────────┐
                  │ ElevenLabs  │          │ FFmpeg   │
                  └─────────────┘          └──────────┘
```

### 2.2 Layer responsibilities

**Frontend (Next.js)**
- Chỉ gọi API nội bộ `/api/*`.
- Không chứa API key.
- Hiển thị state, kéo thả, editor.

**Backend (Node.js)**
- Toàn bộ business logic.
- Giao tiếp ElevenLabs, FFmpeg, DB.
- Chịu trách nhiệm validation, chunking, retry.

**Worker (BullMQ)**
- Xử lý job dài: generate chunk, merge MP3, transcribe.
- Retry, backoff, dead-letter.
- Ghi kết quả vào Supabase Storage + DB.

**Supabase**
- PostgreSQL: metadata.
- Storage: file MP3, SRT, payload JSON snapshot.
- Auth: session cho user.

### 2.3 Data flow ngắn gọn

```
Script (text)
  → parse
  → normalized conversation
  → map character → voice
  → build payload
  → validate
  → chunk (≤2,000 chars)
  → enqueue generation jobs
  → worker gọi ElevenLabs
  → save MP3 + metadata
  → user chọn chunk
  → enqueue merge job
  → worker FFmpeg
  → final MP3
  → enqueue STT job
  → transcription
  → SRT
  → export
```

### 2.4 Không được làm
- ❌ FE gọi trực tiếp ElevenLabs.
- ❌ Nhét API key vào client bundle.
- ❌ Xử lý generation đồng bộ trong request HTTP.
- ❌ Chia chunk giữa turn hội thoại.
- ❌ Strip audio tags `[giggling]`, `[curious]` trước khi gửi API.

---

## 3. End-to-End Business Flow

### 3.1 Flow chính

```
ChatGPT
   ↓
Generate conversation
   ↓
Copy Script
   ↓
Podcast Studio
   ↓
Script Parser
   ↓
Normalized Conversation
   ↓
Character → Voice Mapping
   ↓
ElevenLabs Payload Builder
   ↓
Payload Review / Edit
   ↓
Validate
   ↓
Auto Chunk ≤ 2,000 chars
   ↓
Generate Multiple Chunks
   ↓
MP3 Library
   ↓
Drag & Drop
   ↓
FFmpeg Merge
   ↓
Final Podcast MP3
   ↓
ElevenLabs Speech-to-Text
   ↓
Transcription
   ↓
SRT
   ↓
Export MP3 / SRT
```

### 3.2 Script Input

User paste script dạng:

```
Sarah: I thought you forgot about me.

Daniel: How could I forget?

Sarah: You haven't called me for three months.

Daniel: I was afraid.

Sarah: Afraid of what?

Daniel: Afraid that you had moved on.
```

Parser nhận diện:
- Pattern `^([A-Za-z0-9 _\-']+):\s*(.+)$`
- Bỏ dòng trống.
- Gom dòng cùng speaker liên tiếp thành 1 turn (optional flag `mergeAdjacent`).

### 3.3 Normalized Conversation

```json
{
  "characters": [
    { "key": "sarah",  "name": "Sarah" },
    { "key": "daniel", "name": "Daniel" }
  ],
  "lines": [
    { "sequence": 1, "speaker": "sarah",  "text": "I thought you forgot about me." },
    { "sequence": 2, "speaker": "daniel", "text": "How could I forget?" },
    { "sequence": 3, "speaker": "sarah",  "text": "You haven't called me for three months." },
    { "sequence": 4, "speaker": "daniel", "text": "I was afraid." },
    { "sequence": 5, "speaker": "sarah",  "text": "Afraid of what?" },
    { "sequence": 6, "speaker": "daniel", "text": "Afraid that you had moved on." }
  ]
}
```

### 3.4 Character → Voice Mapping

```
Sarah  → Rachel → voice_id = xxx
Daniel → Adam   → voice_id = xxx
```

Ràng buộc:
- Mỗi character **phải** có mapping.
- Tổng unique voice_ids trong 1 request ≤ 10.
- Voice list lấy từ ElevenLabs `/v1/voices`.

### 3.5 Payload Builder

Output:

```json
{
  "model_id": "eleven_v3",
  "language_code": "en",
  "inputs": [
    { "text": "I thought you forgot about me.", "voice_id": "SARAH_VOICE_ID" },
    { "text": "How could I forget?",            "voice_id": "DANIEL_VOICE_ID" }
  ],
  "settings": {},
  "seed": null,
  "apply_text_normalization": "auto"
}
```

### 3.6 Chunking

Ví dụ total = 8,500 chars:

```
Chunk 01 → 1,850 chars
Chunk 02 → 1,920 chars
Chunk 03 → 1,970 chars
Chunk 04 → 1,760 chars
Chunk 05 → 1,000 chars
```

**Boundary rule:** chia tại ranh giới turn, không cắt giữa câu.

### 3.7 Generation — Multiple Batches

```
Batch #1 → Chunk 01, 02, 03
Batch #2 → Chunk 01, 02, 03
```

User có thể mix:

```
Batch #1 Chunk 01
Batch #2 Chunk 02
Batch #1 Chunk 03
→ Compose → Final Podcast
```

### 3.8 Transcription & SRT

- Final MP3 → `POST /v1/speech-to-text`.
- Kết quả transcription lưu DB.
- Sinh SRT từ transcription.

**Lý do dùng STT trên final MP3** thay vì cộng timestamp từ chunk:
- Tránh sai số do cắt chunk.
- SRT khớp đúng audio cuối.
- Giảm complexity.

---

## 4. Functional Requirements

### FR-01 Project & Episode
- FR-01.1: User tạo Project (name, description).
- FR-01.2: Mỗi Project chứa nhiều Episode.
- FR-01.3: Episode có title, language, default model.

### FR-02 Script Editor
- FR-02.1: Paste raw script.
- FR-02.2: Hiển thị normalized lines.
- FR-02.3: Cảnh báo khi dòng không match pattern `Speaker: text`.
- FR-02.4: Cho phép sửa từng line.
- FR-02.5: Cho phép thêm/xóa line.

### FR-03 Character & Voice Mapping
- FR-03.1: List characters auto-detect.
- FR-03.2: Fetch voice list từ ElevenLabs.
- FR-03.3: Gán voice cho từng character.
- FR-03.4: Preview voice (gọi sample).
- FR-03.5: Mỗi lượt thoại dùng voice đã được mapping.

### FR-04 Payload Editor
- FR-04.1: Visual editor cho từng dialogue input.
- FR-04.2: Toggle `[ Visual ] / [ JSON ]`.
- FR-04.3: Cho phép sửa text (giữ audio tags).
- FR-04.4: Cho phép đổi voice per-line.
- FR-04.5: Cho phép override model_id, language_code.
- FR-04.6: Advanced: seed, apply_text_normalization, pronunciation_dictionary_locators, settings.
- FR-04.7: Nút Validate.

### FR-05 Validation
- FR-05.1: `inputs.length > 0`.
- FR-05.2: Mỗi input: `text !== "" && voice_id !== ""`.
- FR-05.3: `unique voice_ids ≤ 10`.
- FR-05.4: `total characters/chunk ≤ 2000`.
- FR-05.5: `model_id ∈ {eleven_v3, ...whitelist}`.
- FR-05.6: Payload JSON hợp lệ.
- FR-05.7: Tất cả speaker đều được mapping.

### FR-06 Chunking
- FR-06.1: Tự động chia chunk khi > 2000 chars.
- FR-06.2: Chia tại ranh giới turn, không cắt giữa câu.
- FR-06.3: Lưu `start_line`, `end_line`, `character_count`, `input_count`.
- FR-06.4: Preview chunk trước khi generate.

### FR-07 Generation
- FR-07.1: Tạo batch gồm nhiều chunk.
- FR-07.2: Start batch → enqueue jobs.
- FR-07.3: Retry chunk lỗi.
- FR-07.4: Regenerate chunk (tạo batch mới).
- FR-07.5: Hiển thị status realtime (SSE hoặc polling).
- FR-07.6: Hỗ trợ nhiều batch trên cùng script.

### FR-08 Audio Library
- FR-08.1: List tất cả chunk audio theo episode.
- FR-08.2: Filter theo batch, status.
- FR-08.3: Play preview.
- FR-08.4: Download chunk.
- FR-08.5: Xóa chunk (soft delete).

### FR-09 Audio Composer
- FR-09.1: Drag & drop chunk vào timeline.
- FR-09.2: Reorder.
- FR-09.3: Remove item.
- FR-09.4: Insert silence giữa item.
- FR-09.5: Lưu composition.
- FR-09.6: Preview.

### FR-10 Merge
- FR-10.1: Enqueue merge job.
- FR-10.2: FFmpeg concat MP3.
- FR-10.3: Upload final MP3 lên Supabase Storage.
- FR-10.4: Download final MP3.

### FR-11 Transcription
- FR-11.1: Gửi final MP3 → ElevenLabs STT.
- FR-11.2: Lưu transcription với segments.
- FR-11.3: Hiển thị transcript.

### FR-12 SRT
- FR-12.1: Sinh SRT từ transcription.
- FR-12.2: Editor chỉnh sửa SRT.
- FR-12.3: Download SRT.

### FR-13 Status & Monitoring
- FR-13.1: State machine cho Batch, Chunk, Composition, Transcription.
- FR-13.2: Realtime cập nhật.
- FR-13.3: Xem error message khi FAILED.

### FR-14 Error Handling
- FR-14.1: Retry tự động với exponential backoff.
- FR-14.2: Manual retry.
- FR-14.3: Dead-letter queue.
- FR-14.4: Log với correlation ID.

### FR-15 Auth & Permissions
- FR-15.1: Supabase Auth (email + OAuth).
- FR-15.2: Row Level Security cho user chỉ xem data của mình.
- FR-15.3: API key ElevenLabs chỉ ở server.

### FR-16 Video Export
- FR-16.1: Chọn final composition audio và nguồn ElevenLabs hoặc video upload.
- FR-16.2: Tạo clip 5 giây bằng `bytedance-seedance-v2-fast`; cần quyền Image & Video Generation và gói trả phí.
- FR-16.3: Chấp nhận MP4, QuickTime hoặc WebM tối đa 100 MB/file, 15 phút và 40 megapixels.
- FR-16.4: Sắp xếp tối đa 10 clip; chuẩn hóa thành 1280×720 H.264, lặp hoặc cắt để khớp độ dài audio.
- FR-16.5: Chọn SRT/VTT từ đúng final audio; burn captions vào hình và nhúng thêm subtitle track `mov_text`.
- FR-16.6: Hiển thị PROCESSING/READY/FAILED và chỉ tải MP4 khi READY; kiểm tra quyền sở hữu.

---

## 5. Next.js Frontend Architecture

### 5.1 Stack
- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- shadcn/ui
- `@dnd-kit/core` + `@dnd-kit/sortable`
- `zustand` (client state)
- `@tanstack/react-query` (server state)
- `wavesurfer.js` (audio preview)
- `zod` (form validation)

### 5.2 Cấu trúc thư mục

```
apps/web/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── callback/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── projects/page.tsx
│   │   ├── projects/[projectId]/
│   │   │   ├── page.tsx
│   │   │   └── episodes/[episodeId]/
│   │   │       ├── script/page.tsx
│   │   │       ├── payload/page.tsx
│   │   │       ├── generation/page.tsx
│   │   │       ├── library/page.tsx
│   │   │       ├── composer/page.tsx
│   │   │       ├── transcript/page.tsx
│   │   │       └── export/page.tsx
│   │   └── layout.tsx
│   └── api/
├── components/
│   ├── script/
│   ├── payload/
│   ├── generation/
│   ├── library/
│   ├── composer/
│   ├── transcript/
│   └── ui/
├── lib/
│   ├── api-client.ts
│   ├── query-keys.ts
│   ├── audio.ts
│   └── format.ts
├── hooks/
│   ├── useEpisode.ts
│   ├── useGeneration.ts
│   ├── useSse.ts
│   └── useAudioPlayer.ts
├── stores/
│   ├── composer.store.ts
│   └── script.store.ts
└── types/
    └── api.ts
```

### 5.3 Routing

| Route | Màn hình |
|-------|----------|
| `/projects` | Danh sách project |
| `/projects/[id]` | Episodes trong project |
| `/projects/[id]/episodes/[eid]/script` | Script Editor |
| `/projects/[id]/episodes/[eid]/payload` | Payload Editor |
| `/projects/[id]/episodes/[eid]/generation` | Generation Monitor |
| `/projects/[id]/episodes/[eid]/library` | Audio Library |
| `/projects/[id]/episodes/[eid]/composer` | Audio Composer |
| `/projects/[id]/episodes/[eid]/transcript` | Transcript + SRT |
| `/projects/[id]/episodes/[eid]/export` | Export |

### 5.4 React Query keys

```ts
export const qk = {
  projects: ['projects'] as const,
  episodes: (pid: string) => ['projects', pid, 'episodes'] as const,
  episode: (eid: string) => ['episodes', eid] as const,
  script: (eid: string) => ['episodes', eid, 'script'] as const,
  characters: (eid: string) => ['episodes', eid, 'characters'] as const,
  batches: (eid: string) => ['episodes', eid, 'batches'] as const,
  batch: (bid: string) => ['batches', bid] as const,
  audios: (eid: string) => ['episodes', eid, 'audios'] as const,
  compositions: (eid: string) => ['episodes', eid, 'compositions'] as const,
  transcription: (aid: string) => ['audio', aid, 'transcription'] as const,
};
```

### 5.5 SSE hook

```ts
export function useSse<T>(url: string, onMessage: (data: T) => void) {
  useEffect(() => {
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onerror = () => es.close();
    return () => es.close();
  }, [url]);
}
```

### 5.6 Composer store

```ts
type TimelineItem = {
  id: string;
  audioId: string;
  order: number;
  trimStart?: number;
  trimEnd?: number;
};

export const useComposer = create<ComposerState>((set) => ({
  items: [],
  addItem: ({ audioId }) =>
    set((s) => ({
      items: [...s.items, { id: crypto.randomUUID(), audioId, order: s.items.length }],
    })),
  reorder: (from, to) =>
    set((s) => {
      const items = [...s.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { items: items.map((it, i) => ({ ...it, order: i })) };
    }),
  removeItem: (id) =>
    set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  reset: () => set({ items: [] }),
}));
```

### 5.7 Payload Editor layout

```
┌──────────────────────────────────────────────┐
│ ElevenLabs Payload                           │
├──────────────────────────────────────────────┤
│ Model      [ eleven_v3                    ▼ ]│
│ Language   [ en                           ▼ ]│
│                                              │
│ Dialogue                                     │
│ ┌──────────────────────────────────────────┐ │
│ │ Sarah                                    │ │
│ │ Voice: Rachel                            │ │
│ │ [gently] I thought you forgot about me.  │ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ Daniel                                   │ │
│ │ Voice: Adam                              │ │
│ │ [quietly] How could I forget?            │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ [ Add dialogue ]                             │
│ [ Validate ]                 [ Generate ]    │
└──────────────────────────────────────────────┘

Toggle: [ Visual ] [ JSON ]
```

---

## 6. Node.js Backend Architecture

### 6.1 Stack
- Node.js 20+
- NestJS (hoặc Express + TypeScript)
- Zod / class-validator
- Prisma hoặc Supabase JS client
- BullMQ
- `fluent-ffmpeg` / `ffmpeg-static`
- `axios` (qua Adapter)
- `pino` (logging)

### 6.2 Cấu trúc thư mục

```
apps/api/
├── src/
│   ├── main.ts
│   ├── config/
│   │   ├── env.ts
│   │   └── logger.ts
│   ├── common/
│   │   ├── errors/
│   │   ├── middleware/
│   │   └── guards/
│   ├── modules/
│   │   ├── projects/
│   │   ├── episodes/
│   │   ├── scripts/
│   │   ├── characters/
│   │   ├── payload/
│   │   ├── generation/
│   │   ├── audio/
│   │   ├── compositions/
│   │   ├── transcriptions/
│   │   └── subtitles/
│   ├── integrations/
│   │   └── elevenlabs/
│   │       ├── elevenlabs.client.ts
│   │       ├── elevenlabs.types.ts
│   │       ├── elevenlabs.mapper.ts
│   │       ├── elevenlabs.validator.ts
│   │       ├── elevenlabs.errors.ts
│   │       └── elevenlabs.constants.ts
│   ├── services/
│   │   ├── script-parser.service.ts
│   │   ├── payload-mapper.service.ts
│   │   ├── chunking.service.ts
│   │   ├── generation.service.ts
│   │   ├── composition.service.ts
│   │   ├── merge.service.ts
│   │   ├── transcription.service.ts
│   │   └── srt.service.ts
│   ├── jobs/
│   │   ├── queues.ts
│   │   ├── generation.worker.ts
│   │   ├── merge.worker.ts
│   │   └── transcription.worker.ts
│   └── storage/
│       └── supabase.storage.ts
└── test/
```

### 6.3 ElevenLabs Adapter contract

```ts
export interface ElevenLabsClient {
  createDialogue(
    payload: CreateDialogueRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<CreateDialogueResponse>;

  createDialogueWithTimestamps(
    payload: CreateDialogueRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<CreateDialogueWithTimestampsResponse>;

  createTranscription(
    input: CreateTranscriptionRequest,
  ): Promise<TranscriptionResponse>;

  listVoices(): Promise<Voice[]>;
}
```

### 6.4 Services — trách nhiệm

| Service | Trách nhiệm |
|---------|-------------|
| `ScriptParserService` | Parse raw text → characters + lines |
| `PayloadMapperService` | lines + mapping → ElevenLabs payload |
| `ChunkingService` | Chia payload thành chunks ≤ 2000 chars |
| `GenerationService` | Tạo batch, chunk, enqueue jobs |
| `CompositionService` | CRUD composition, timeline items |
| `MergeService` | Gọi FFmpeg concat |
| `TranscriptionService` | Gọi ElevenLabs STT |
| `SrtService` | Sinh SRT từ transcription |

### 6.5 Job queues

```ts
export const QUEUES = {
  GENERATION: 'generation',
  MERGE: 'merge',
  TRANSCRIPTION: 'transcription',
} as const;
```

| Queue | Job name | Payload |
|-------|----------|---------|
| `generation` | `generate-chunk` | `{ chunkId, batchId }` |
| `merge` | `merge-composition` | `{ compositionId }` |
| `transcription` | `transcribe-audio` | `{ audioId }` |

Options:
- `attempts: 3`
- `backoff: { type: 'exponential', delay: 3000 }`
- `removeOnComplete: { age: 3600 }`
- `removeOnFail: false`

### 6.6 AppError

```ts
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 500,
    public meta?: Record<string, unknown>,
  ) {
    super(message);
  }
}
```

### 6.7 Env config

```ts
export const env = {
  NODE_ENV: z.enum(['development', 'test', 'production']).parse(process.env.NODE_ENV),
  PORT: z.coerce.number().default(3001),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string(),
  REDIS_URL: z.string(),
  ELEVENLABS_API_KEY: z.string(),
  ELEVENLABS_BASE_URL: z.string().default('https://api.elevenlabs.io'),
  STORAGE_BUCKET_AUDIO: z.string().default('audio'),
  STORAGE_BUCKET_SUBTITLE: z.string().default('subtitles'),
};
```

---

## 7. Database Schema

### 7.1 ERD

```
users ─┬─< projects ─< episodes ─┬─< scripts ─< script_lines
       │                         │
       │                         ├─< characters ─< voice_mappings
       │                         │
       │                         ├─< generation_batches ─< generation_chunks ─< audios
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
| audio_id | uuid | FK → audios, final composition only |
| source_mode | text | elevenlabs/uploaded/cover (cover for legacy exports) |
| prompt | text | nullable generation prompt |
| model_id | text | nullable ElevenLabs model |
| generation_id | text | nullable provider generation ID |
| clip_ids | jsonb | ordered uploaded clip IDs |
| subtitle_id | uuid | nullable matching SRT |
| storage_path | text | private MP4, nullable until READY |
| status | text | PROCESSING/READY/FAILED |
| error_message | text | nullable |
| created_at | timestamptz | |
| completed_at | timestamptz | |

**video_clips**

| column | type | notes |
|--------|------|-------|
| id | uuid | PK |
| episode_id | uuid | FK → episodes |
| title | text | original filename |
| storage_path | text | private MP4/QuickTime/WebM |
| mime_type | text | |
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
| `videos` | `{clipId}.{ext}` | private local uploaded clips |
| `videos` | `{videoId}.mp4` | private local rendered videos |
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

## 8. API Specification

Base URL: `/api`
Auth: Supabase session.

### 8.1 Scripts

**POST /api/scripts/:id/parse**

Body: `{ "mergeAdjacent": false }`

Response:
```json
{
  "scriptId": "...",
  "characters": [{ "key": "sarah", "name": "Sarah" }],
  "lines": [{ "sequence": 1, "speaker": "sarah", "text": "..." }],
  "warnings": []
}
```

**POST /api/scripts/:id/build-payload**

Body:
```json
{
  "modelId": "eleven_v3",
  "languageCode": "en",
  "voiceMappings": {
    "sarah": "voice_id_sarah",
    "daniel": "voice_id_daniel"
  },
  "options": { "seed": null, "applyTextNormalization": "auto" }
}
```

Response:
```json
{
  "payload": { "model_id": "eleven_v3", "inputs": [] },
  "chunked": [
    {
      "chunkIndex": 1,
      "startLine": 1,
      "endLine": 18,
      "characterCount": 1862,
      "inputCount": 12,
      "payload": {}
    }
  ]
}
```

**POST /api/scripts/:id/validate-payload**

Body: `{ "payload": {}, "chunked": [] }`

Response:
```json
{
  "valid": true,
  "errors": [],
  "warnings": [{ "code": "NEAR_CHAR_LIMIT", "chunkIndex": 3 }]
}
```

### 8.2 Generation Batches

**POST /api/generation-batches**

Body:
```json
{
  "episodeId": "...",
  "scriptId": "...",
  "modelId": "eleven_v3",
  "languageCode": "en",
  "chunked": []
}
```

**POST /api/generation-batches/:id/start** → `{ "status": "QUEUED" }`

**POST /api/generation-batches/:id/retry** — Body: `{ "chunkIds": [] }`

**GET /api/generation-batches/:id**

**GET /api/generation-batches/:id/events** (SSE)

### 8.3 Audio

**GET /api/audio?episodeId=...&kind=chunk**

**POST /api/audio/:id/transcribe**

**GET /api/audio/:id/download** → 302 signed URL

### 8.4 Compositions

**POST /api/compositions** — Body: `{ "episodeId": "...", "name": "Final v1" }`

**PATCH /api/compositions/:id/items**

Body:
```json
{
  "items": [
    { "audioId": "...", "orderIndex": 0, "gapMs": 0 },
    { "audioId": "...", "orderIndex": 1, "gapMs": 300 }
  ]
}
```

**POST /api/compositions/:id/merge**

**GET /api/compositions/:id**

### 8.5 Video Export

**POST /api/episodes/:id/video-clips?title=...** — raw MP4, QuickTime, or WebM, maximum 100 MB.

**POST /api/audio/:id/video** — JSON body, final audio only; returns `202` with a video record in `PROCESSING`.

ElevenLabs mode: `{"mode":"elevenlabs","title":"...","prompt":"...","subtitleId":"optional-srt-or-vtt-id"}`.

Uploaded mode: `{"mode":"uploaded","title":"...","clipIds":["..."],"subtitleId":"optional-srt-or-vtt-id"}`. Clip order follows `clipIds`; 1–10 clips allowed.

**GET /api/videos/:id** — returns `PROCESSING`, `READY`, or `FAILED` status.

**GET /api/videos/:id/download** — downloads the MP4 after rendering completes.

ElevenLabs mode uses `POST /v1/flows/video` and polls `GET /v1/flows/video/{generation_id}`. FFmpeg normalizes/loops/trims visuals to final-audio duration, encodes H.264/AAC, and burns matching SRT/VTT captions into the video while also embedding a selectable `mov_text` track.

### 8.6 Transcriptions

**POST /api/transcriptions/:id/generate-srt**

**GET /api/subtitles/:id/download**

### 8.6 Error format

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable",
    "correlationId": "uuid"
  }
}
```

| Code | HTTP |
|------|------|
| VALIDATION_FAILED | 400 |
| UNAUTHORIZED | 401 |
| FORBIDDEN | 403 |
| NOT_FOUND | 404 |
| ELEVENLABS_RATE_LIMIT | 429 |
| ELEVENLABS_API_ERROR | 502 |
| CHUNK_TOO_LARGE | 422 |
| FFMPEG_FAILED | 500 |
| INTERNAL | 500 |

---

## 9. ElevenLabs Integration

### 9.1 Endpoints sử dụng

| Mục đích | Method | Endpoint |
|----------|--------|----------|
| Text to speech | POST | `/v1/text-to-speech/{voice_id}` |
| Speech-to-Text | POST | `/v1/speech-to-text` |
| List voices | GET | `/v1/voices` |

Base URL: `https://api.elevenlabs.io`
Auth header: `xi-api-key: ${ELEVENLABS_API_KEY}`

### 9.2 Request payload

```json
{
  "inputs": [
    { "text": "[giggling] Knock knock", "voice_id": "JBFqnCBsd6RMkjVDRZzb" },
    { "text": "[curious] Who is there?", "voice_id": "Aw4FAjKCGjjNkVhN1Xmq" }
  ],
  "model_id": "eleven_v3",
  "language_code": "en",
  "settings": {},
  "pronunciation_dictionary_locators": [],
  "seed": 123,
  "apply_text_normalization": "auto"
}
```

Field rules:
- `inputs` **bắt buộc**.
- Local generation chunk tối đa **2,000 characters**.
- Mỗi input được gửi thành một request với một voice ID.
- `model_id` mặc định `eleven_v3`.
- Audio tags **giữ nguyên**.

### 9.3 TypeScript types

```ts
export type DialogueInput = {
  text: string;
  voice_id: string;
};

export type CreateDialogueRequest = {
  inputs: DialogueInput[];
  model_id: string;
  language_code?: string;
  settings?: Record<string, unknown>;
  pronunciation_dictionary_locators?: unknown[];
  seed?: number | null;
  apply_text_normalization?: 'auto' | 'on' | 'off';
  output_format?: string;
};

export type CreateDialogueResponse = {
  audio: Buffer;
  mimeType: string;
};

export type VoiceSegment = {
  voiceId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  characterStartIndex: number;
  characterEndIndex: number;
  dialogueInputIndex: number;
};

export type CreateDialogueWithTimestampsResponse = {
  audio: Buffer;
  voiceSegments: VoiceSegment[];
};
```

### 9.4 Constants

```ts
export const ELEVENLABS_LIMITS = {
  MAX_CHARS_PER_REQUEST: 2000,
  DEFAULT_MODEL_ID: 'eleven_v3',
  DEFAULT_OUTPUT_FORMAT: 'mp3_44100_128',
};
```

### 9.5 Error mapping

| HTTP | Internal code | Retry |
|------|---------------|-------|
| 400 | ELEVENLABS_BAD_REQUEST | no |
| 401 | ELEVENLABS_UNAUTHORIZED | no |
| 422 | ELEVENLABS_UNPROCESSABLE | no |
| 429 | ELEVENLABS_RATE_LIMIT | yes |
| 5xx | ELEVENLABS_API_ERROR | yes |
| timeout | ELEVENLABS_TIMEOUT | yes |

### 9.6 Không được làm
- ❌ Gửi > 2000 chars/chunk.
- ❌ Strip audio tags.
- ❌ Gọi từ FE.
- ❌ Hard-code voice_id.

---

## 10. Script Parser & Payload Mapper

### 10.1 Input format

```
Sarah: I thought you forgot about me.

Daniel: How could I forget?
```

Patterns:
- `^([A-Za-z0-9 _\-'.]+):\s*(.+)$` — speaker + text.
- Dòng trống: bỏ qua.
- Dòng không match: emit warning.

### 10.2 ParseOutput

```ts
type ParseOutput = {
  characters: { key: string; name: string }[];
  lines: { sequence: number; speaker: string; text: string }[];
  warnings: { code: string; line: number; raw: string }[];
  unparsed: { line: number; raw: string }[];
};
```

### 10.3 PayloadMapper input/output

Input:
```ts
{
  lines: ScriptLine[];
  voiceMappings: Record<string, string>;
  modelId: string;
  languageCode: string;
  settings?: Record<string, unknown>;
  seed?: number | null;
  applyTextNormalization?: 'auto' | 'on' | 'off';
}
```

Output:
```ts
{
  payload: CreateDialogueRequest;
  missingMappings: string[];
  uniqueVoiceCount: number;
}
```

### 10.4 Edge cases

| Case | Handling |
|------|----------|
| Script rỗng | 400 VALIDATION_FAILED |
| 1 nhân vật | OK |
| Tên chứa `:` | Escape `Name\:` |
| Audio tag giữa text | Giữ nguyên |
| Text chứa `\n` | Nối bằng space |
| Character name trùng sau slug | Merge + warning |

---

## 11. Chunking Engine

### 11.1 Nguyên tắc
- **≤ 2,000 characters / chunk**.
- Không cắt giữa **turn**.
- Không cắt giữa **câu**.
- Giữ `start_line` / `end_line`.

### 11.2 Algorithm

```
FUNCTION chunk(lines, charLimit = 2000):
  chunks = []
  current = { inputs: [], chars: 0, startLine: null, endLine: null }

  FOR line IN lines:
    lineLen = length(line.text)
    nextLen = current.chars + lineLen

    IF nextLen > charLimit AND current.inputs.length > 0:
      chunks.push(current)
      current = { inputs: [], chars: 0, startLine: null, endLine: null }

    IF lineLen > charLimit:
      subChunks = splitOversizedLine(line, charLimit)
      FOR sc IN subChunks: push as its own chunk
      CONTINUE

    current.inputs.push(line)
    current.chars += lineLen
    IF current.startLine == null: current.startLine = line.sequence
    current.endLine = line.sequence

  IF current.inputs.length > 0: chunks.push(current)
  RETURN chunks
```

### 11.3 Oversized line handling
1. Split theo câu (`[.!?…]`).
2. Split theo mệnh đề (`[;,]`).
3. Hard cut nếu vẫn > limit → warning `LINE_HARD_CUT`.

### 11.4 Validation trước enqueue
- Mỗi chunk `characterCount ≤ 2000`.
- Mỗi chunk `inputCount ≥ 1`.
- Mỗi chunk `unique voice_ids ≤ 10`.
- `startLine`, `endLine` liên tục.

---

## 12. Generation Queue / Worker

### 12.1 Queues

| Queue | Job | Concurrency |
|-------|-----|-------------|
| generation | generate-chunk | 3–5 |
| merge | merge-composition | 2 |
| transcription | transcribe-audio | 2 |

### 12.2 Job payloads

```ts
type GenerateChunkJob = { chunkId: string; batchId: string };
type MergeCompositionJob = { compositionId: string };
type TranscribeAudioJob = { audioId: string };
```

### 12.3 Generation worker flow

```
1. Load chunk + batch + episode
2. Mark chunk.status = RUNNING
3. Call ElevenLabsClient.createDialogue(chunk.payload)
4. Buffer → upload Supabase Storage
5. Insert audios row (kind='chunk')
6. chunk.status = COMPLETED, chunk.audio_id = audios.id
7. Update batch counters
8. Emit SSE event chunk.updated
9. Recompute batch status
```

### 12.4 Retry policy
- `attempts: 3`
- Backoff: 3s → 9s → 27s
- Retry khi: RATE_LIMIT, API_ERROR, TIMEOUT
- Không retry: BAD_REQUEST, UNPROCESSABLE

### 12.5 Worker code sample

```ts
export function startGenerationWorker() {
  const worker = new Worker<GenerateChunkJob>(
    QUEUES.GENERATION,
    async (job) => {
      const { chunkId } = job.data;
      const chunk = await chunkRepo.getById(chunkId);
      await chunkRepo.updateStatus(chunkId, 'RUNNING');

      try {
        const { audio, mimeType } = await eleven.createDialogue(chunk.payload);
        const path = storage.buildChunkPath(chunk);
        await storage.upload(path, audio, mimeType);
        const audioRow = await audioRepo.insert({
          episodeId: chunk.episodeId,
          chunkId: chunk.id,
          kind: 'chunk',
          storagePath: path,
          mimeType,
          sizeBytes: audio.byteLength,
        });
        await chunkRepo.markCompleted(chunkId, audioRow.id);
        await batchRepo.recount(chunk.batchId);
        await sse.publish(chunk.batchId, {
          type: 'chunk.updated',
          chunkId,
          status: 'COMPLETED',
          audioId: audioRow.id,
        });
      } catch (err) {
        await chunkRepo.markFailed(chunkId, err);
        await batchRepo.recount(chunk.batchId);
        throw err;
      }
    },
    { connection, concurrency: 3 },
  );

  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }));
  return worker;
}
```

---

## 13. MP3 Library & Composer

### 13.1 Library UI

```
┌────────────────────────────────────────────────┐
│ Audio Library — Episode: Love After Distance   │
├────────────────────────────────────────────────┤
│ Filter: [ All ] [ Batch #1 ] [ Batch #2 ]      │
│                                                │
│ ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│ │ Chunk 01 │  │ Chunk 02 │  │ Chunk 03 │      │
│ │ Batch #1 │  │ Batch #1 │  │ Batch #1 │      │
│ │ ▶ 0:42   │  │ ▶ 0:55   │  │ ▶ 0:38   │      │
│ └──────────┘  └──────────┘  └──────────┘      │
└────────────────────────────────────────────────┘
```

### 13.2 Composer layout

```
┌───────────────────────┬───────────────────────┐
│ Audio Pool            │ Timeline              │
│                       │                       │
│ [Chunk 01][Chunk 02]  │ ┌─1─┬─2─┬─3─┬─4─┐    │
│ [Chunk 03][Final 01]  │ │ A │ B │ C │   │    │
│                       │ └───┴───┴───┴───┘    │
│                       │ [ Merge ] [ Save ]    │
└───────────────────────┴───────────────────────┘
```

### 13.3 TimelineItem schema

```ts
type TimelineItem = {
  id: string;
  audioId: string;
  orderIndex: number;
  gapMs: number;
  trimStartMs?: number;
  trimEndMs?: number;
};
```

### 13.4 Composition states
`DRAFT → MERGING → READY` hoặc `FAILED`.

---

## 14. FFmpeg Merge Pipeline

### 14.1 Concat approach

```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp3
```

`list.txt`:
```
file '/abs/path/chunk01.mp3'
file '/abs/path/silence_300ms.mp3'
file '/abs/path/chunk02.mp3'
```

### 14.2 Silence generation

```bash
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.3 -q:a 9 -acodec libmp3lame silence.mp3
```

### 14.3 Merge flow

```
1. Load composition + items (ordered)
2. Tải tất cả audio về tmp dir
3. Tạo silence files cho gap
4. Sinh list.txt
5. Chạy ffmpeg concat
6. Verify output (ffprobe)
7. Upload final MP3 lên Storage
8. Insert audios (kind='final')
9. composition.output_audio_id = audios.id
10. composition.status = READY
```

### 14.4 Safety
- Timeout FFmpeg: 5 phút.
- Kill process nếu treo.
- Cleanup tmp dir trong `finally`.
- Validate output tồn tại & size > 0.

### 14.5 Video export
- Nhận final MP3, clip MP4/QuickTime/WebM hoặc clip sinh qua ElevenLabs.
- ElevenLabs dùng `/v1/flows/video`, `bytedance-seedance-v2-fast`, sau đó poll và tải clip về local storage.
- Probe và chuẩn hóa clip về 1280×720 H.264/30fps; sắp theo thứ tự, lặp/cắt theo thời lượng final audio.
- Encode audio AAC 192 kbps; nếu chọn SRT/VTT của đúng audio thì burn captions vào hình và nhúng thêm thành `mov_text`.
- Render chạy nền; lưu trạng thái `PROCESSING` / `READY` / `FAILED` và file MP4 trong storage local.
- Dùng FFmpeg argument array (không qua shell), timeout cấu hình mặc định 30 phút và dọn thư mục tạm trong `finally`.
- Download chỉ hoạt động khi video `READY`, và kiểm tra quyền sở hữu episode.

---

## 15. Speech-to-Text & SRT

### 15.1 Flow

```
Final MP3
   ↓
POST /v1/speech-to-text (ElevenLabs)
   ↓
Transcription
   ↓
SRT Generator
   ↓
subtitles row
```

### 15.2 SRT format

```
1
00:00:00,000 --> 00:00:02,340
I thought you forgot about me.

2
00:00:02,500 --> 00:00:04,120
How could I forget?
```

### 15.3 SRT generator rules
- Max 2 dòng / subtitle.
- Max 42 ký tự / dòng.
- Không cắt giữa từ.
- Min duration 1s, max 7s.
- Merge segment < 1s liền nhau.

### 15.4 Timestamp helper

```ts
function toSrtTime(seconds: number): string {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}
```

---

## 16. State Machines

### 16.1 Generation Batch

```
DRAFT ──► QUEUED ──► RUNNING ──► COMPLETED
                        │
                        ├──► PARTIAL
                        └──► FAILED
              │
              └──► CANCELLED
```

### 16.2 Generation Chunk

```
PENDING ──► QUEUED ──► RUNNING ──► COMPLETED
                          │
                          └──► FAILED ──(retry)──► QUEUED
```

### 16.3 Composition

```
DRAFT ──► MERGING ──► READY
              │
              └──► FAILED
```

### 16.4 Transcription

```
PENDING ──► RUNNING ──► COMPLETED
                │
                └──► FAILED
```

### 16.5 Recompute batch

```
function recomputeBatch(batchId):
  chunks = getChunks(batchId)
  total = chunks.length
  completed = count(status == COMPLETED)
  failed = count(status == FAILED)
  running = count(status in [RUNNING, QUEUED])
  if running > 0: status = RUNNING
  elif completed == total: status = COMPLETED
  elif failed == total: status = FAILED
  elif completed + failed == total: status = PARTIAL
  else: status = QUEUED
```

---

## 17. Security

### 17.1 API keys
- `ELEVENLABS_API_KEY` **chỉ** ở backend.
- Không prefix `NEXT_PUBLIC_`.
- Rotate định kỳ.

### 17.2 Auth
- Supabase Auth (email + OAuth).
- Backend verify JWT.

### 17.3 Authorization
- RLS trên mọi bảng.
- Backend check `userId` khớp `project.user_id`.

### 17.4 Input validation
- Zod schema cho mọi request.
- Whitelist `model_id`, `output_format`, `language_code`.
- Giới hạn độ dài `rawText`.
- Sanitize tên file storage.

### 17.5 Storage
- Buckets private.
- Signed URL TTL ≤ 1h.
- Path pattern `{userId}/...`.

### 17.6 Rate limiting
- Per-user: 60 req/phút.
- `POST /generation-batches/:id/start`: 5 req/phút.

### 17.7 Headers
- CORS whitelist.
- CSP.
- HSTS.

### 17.8 Logging
- Correlation ID mỗi request.
- Audit log cho action quan trọng.
- Không log raw script text ở prod.

---

## 18. Error Handling & Retry

### 18.1 Error taxonomy

| Layer | Code | Retryable |
|-------|------|-----------|
| Validation | VALIDATION_FAILED | No |
| Auth | UNAUTHORIZED | No |
| Authz | FORBIDDEN | No |
| Resource | NOT_FOUND | No |
| Provider | ELEVENLABS_RATE_LIMIT | Yes |
| Provider | ELEVENLABS_API_ERROR | Yes |
| Provider | ELEVENLABS_TIMEOUT | Yes |
| Provider | ELEVENLABS_BAD_REQUEST | No |
| Media | FFMPEG_FAILED | Yes |
| Internal | INTERNAL | Yes |

### 18.2 Retry policy
- Queue-level: `attempts: 3`, backoff exponential 3s.
- Manual retry: reset `retry_count = 0`, re-enqueue.
- Max retry_count = 5.

### 18.3 Partial failure
- Batch có thể `PARTIAL`.
- UI hiển thị chunk failed + Retry.
- User có thể compose trước với chunk COMPLETED.

### 18.4 Correlation ID
- Sinh ở middleware.
- Truyền vào job payload.
- Trả về client trong `error.correlationId`.

### 18.5 Circuit breaker (optional)
- Nếu 429 liên tục > N lần trong 60s → pause queue 5 phút.

---

## 19. Testing Strategy

### 19.1 Levels

| Level | Tool | Coverage |
|-------|------|----------|
| Unit | Vitest | Services ≥ 80% |
| Integration | Vitest + Supabase local | Repos, adapters |
| E2E (API) | Supertest | Endpoints chính |
| E2E (UI) | Playwright | Happy path + retry |
| Contract | Mock ElevenLabs | Adapter |

### 19.2 Unit tests
- `ScriptParserService`: pattern, dòng lỗi, unicode.
- `ChunkingService`: boundary, > limit, oversized.
- `PayloadMapperService`: missing mapping, > 10 voices.
- `SrtService`: format timestamp, merge segment.

### 19.3 E2E scenarios
1. Login → tạo project → tạo episode.
2. Paste script → parse → mapping voice.
3. Build payload → validate → start batch.
4. Chờ chunk COMPLETED → library → compose → merge.
5. Transcribe → generate SRT → export.
6. Retry chunk failed.

### 19.4 Manual QA checklist
- [ ] Chunk > 2000 chars bị block.
- [ ] Audio tags giữ nguyên.
- [ ] Retry hoạt động.
- [ ] Merge MP3 với gap.
- [ ] SRT khớp audio.

---

## 20. MVP Acceptance Criteria

### A. Script & Mapping
- [ ] Paste script → parse đúng.
- [ ] Warning khi dòng không match.
- [ ] Gán voice + preview.
- [ ] Mỗi voice mapping được dùng cho đúng lượt thoại.

### B. Payload
- [ ] Build payload có `model_id = eleven_v3`.
- [ ] Audio tags giữ nguyên.
- [ ] Visual + JSON editor đồng bộ.
- [ ] Validate trả error rõ ràng.

### C. Chunking
- [ ] Mọi chunk ≤ 2000 chars.
- [ ] Không cắt giữa turn.
- [ ] Hiển thị start_line/end_line/char_count.

### D. Generation
- [ ] Start batch → tất cả chunk có status.
- [ ] Realtime update.
- [ ] Chunk COMPLETED playable.
- [ ] Retry chunk FAILED thành công.
- [ ] Nhiều batch trên cùng episode.

### E. Library & Composer
- [ ] Library list tất cả chunk.
- [ ] Drag & drop vào timeline.
- [ ] Reorder, remove, gap.
- [ ] Save composition.

### F. Merge
- [ ] Merge thành final MP3.
- [ ] Download final MP3.
- [ ] Duration final = sum ± 1s.

### G. Transcription & SRT
- [ ] STT thành công.
- [ ] SRT mở đúng trên VLC.
- [ ] SRT khớp audio ≥ 90%.

### H. System
- [ ] Zero plaintext API key ở FE.
- [ ] RLS hoạt động.
- [ ] Correlation ID trong error.
- [ ] Log không chứa script text.

### I. Performance
- [ ] Script 8,500 chars → final < 5 phút.
- [ ] API p95 < 500ms.

### J. Video export
- [ ] Tạo video bằng ElevenLabs prompt hoặc upload/chọn/sắp xếp clip cá nhân.
- [ ] Từ chối video không hợp lệ, quá 100 MB, quá 15 phút hoặc vượt giới hạn dimensions.
- [ ] Video hoàn tất thành MP4 1280×720 H.264/AAC, khớp độ dài final audio.
- [ ] SRT/VTT từ đúng final audio được burn vào hình và nhúng làm subtitle track có thể bật/tắt.
- [ ] Poll status và tải MP4 chỉ khi READY; FAILED hiển thị lỗi.

---

## 21. Deployment Architecture

### 21.1 Topology

```
┌──────────────────────┐
│  Vercel              │  Next.js FE
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  Railway / Fly.io    │  Node.js API + Worker
└──────────┬───────────┘
           │
   ┌───────┼───────────┐
   ▼       ▼           ▼
┌──────┐ ┌─────────┐ ┌──────────┐
│Supabase│ │Redis   │ │Storage   │
└──────┘ └─────────┘ └──────────┘
```

### 21.2 Runtime services

| Service | Vai trò | Scaling |
|---------|---------|---------|
| web | Next.js | Vercel auto |
| api | REST | 1–3 replicas |
| worker-generation | Generation | 1–5 replicas |
| worker-merge | FFmpeg | 1–2 replicas |
| worker-stt | STT | 1–2 replicas |
| redis | BullMQ | managed |

### 21.3 Dockerfile worker

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
CMD ["node", "dist/jobs/merge.worker.js"]
```

### 21.4 Observability
- Logs: pino → Loki / Datadog.
- Metrics: Prometheus.
- Tracing: OpenTelemetry (optional).
- Alerts: queue backlog, error rate.

---

## 22. Environment Variables

### 22.1 Frontend

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

### 22.2 Backend

```env
NODE_ENV=development
PORT=3001

SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
STORAGE_BUCKET_AUDIO=audio
STORAGE_BUCKET_SUBTITLE=subtitles
STORAGE_BUCKET_PAYLOAD=payloads

REDIS_URL=redis://localhost:6379

ELEVENLABS_API_KEY=sk_...
ELEVENLABS_BASE_URL=https://api.elevenlabs.io
ELEVENLABS_DEFAULT_MODEL=eleven_v3
ELEVENLABS_MAX_CHARS_PER_REQUEST=2000
ELEVENLABS_VIDEO_TIMEOUT_MS=1200000

FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
FFMPEG_VIDEO_TIMEOUT_MS=1800000

GENERATION_CONCURRENCY=3
MERGE_CONCURRENCY=2
STT_CONCURRENCY=2

LOG_LEVEL=info
```

### 22.3 Rules
- Không commit `.env`.
- Chỉ `NEXT_PUBLIC_*` được expose.
- Prod dùng secret manager.

---

## 23. Future Enhancements

### 23.1 ElevenLabs
- Dùng `with-timestamps` cho speaker timeline.
- Voice visualization.
- Pronunciation dictionary editor UI.
- Multi-language per line.

### 23.2 Audio
- Crossfade giữa chunk.
- Background music / SFX.
- Loudness normalization (EBU R128).
- Multi-track waveform.

### 23.3 Workflow
- Realtime collaboration.
- Version history.
- Approval workflow.

### 23.4 Distribution
- RSS feed.
- Upload Spotify / YouTube.
- Share link công khai.

### 23.5 AI
- Auto-generate script từ prompt.
- Auto emotion tagging.
- Auto diarization.

### 23.6 Enterprise
- Multi-tenant org.
- Billing & usage quota.
- SSO.
- Audit log export.

---

## 24. Open Items

Các điểm cần chốt trước khi implement chính xác ElevenLabs v3 payload.

### 24.1 ElevenLabs payload v3
- [ ] `settings` schema chính xác cho `eleven_v3`.
- [ ] Danh sách `apply_text_normalization` hợp lệ.
- [ ] `output_format` khả dụng cho dialogue.
- [ ] Giới hạn `pronunciation_dictionary_locators`.
- [ ] Rate limit chi tiết theo plan.

### 24.2 Timestamps
- [ ] Dùng `with-timestamps` cho MVP hay không.
- [ ] Schema `voice_segments` chính xác.
- [ ] Map `dialogue_input_index` về `script_lines.sequence`.

### 24.3 STT
- [ ] Model STT nào dùng.
- [ ] Giới hạn độ dài file.
- [ ] Diarization support.

### 24.4 Audio
- [ ] Normalize loudness?
- [ ] Bitrate chuẩn cho final.
- [ ] Crossfade hay gap.

### 24.5 Storage
- [ ] Retention policy.
- [ ] Chính sách xóa chunk cũ.

### 24.6 Security
- [ ] Mã hoá audio at-rest?
- [ ] Audit log retention.

### 24.7 Cost
- [ ] Ước tính cost / 1000 chars / voice.
- [ ] Cảnh báo khi vượt quota.

### 24.8 UX
- [ ] Raw JSON editor cho tất cả user?
- [ ] Cho sửa payload sau khi batch start?

---

## Phụ lục A — Ghi chú quan trọng

Generation dùng normalized `inputs[] + voice_id + text` payload, sau đó gọi
Text-to-Speech SDK một lần cho mỗi lượt thoại và ghép audio theo thứ tự script.
Chunk nội bộ giới hạn **2,000 characters**; giới hạn 10 voice của
Text-to-Dialogue không áp dụng. Generation chạy trong background worker.
**Không** gọi ElevenLabs trực tiếp từ FE và **không** strip audio tags.

---

**END OF DOCUMENT**