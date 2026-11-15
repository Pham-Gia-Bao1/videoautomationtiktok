# Environment Variables


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
