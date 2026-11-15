# System Architecture


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

