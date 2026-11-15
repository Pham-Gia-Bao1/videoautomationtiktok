# API Specification


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

**POST /api/episodes/:id/video-clips?title=...** — raw MP4, QuickTime, or WebM body, maximum 100 MB. Probes the file and stores it privately for that episode.

**POST /api/audio/:id/video** — JSON body; the audio must be a final composition. Returns `202` with a video record in `PROCESSING` state.

```json
{
  "mode": "elevenlabs",
  "title": "Episode video",
  "prompt": "Cinematic ocean at night, slow camera movement",
  "subtitleId": "optional-srt-id"
}
```

For uploaded clips, send `{"mode":"uploaded","title":"...","clipIds":["..."],"subtitleId":"..."}`. Clip IDs are processed in the supplied order (1–10). An SRT or VTT subtitle must belong to a transcription of the selected final audio.

**GET /api/videos/:id** — returns `PROCESSING`, `READY`, or `FAILED` status.

**GET /api/videos/:id/download** — downloads the MP4 after rendering completes.

ElevenLabs mode uses `POST /v1/flows/video` with `bytedance-seedance-v2-fast`, then polls `GET /v1/flows/video/{generation_id}`. It requires Image & Video Generation API access and a paid plan. The generated 5-second silent visual is looped to audio duration. Uploaded clips are normalized to 1280×720 H.264; the sequence loops if short and is trimmed to the final audio. MP4 audio is AAC 192 kbps; optional SRT/VTT is burned into the video and embedded as a selectable `mov_text` subtitle track.

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
