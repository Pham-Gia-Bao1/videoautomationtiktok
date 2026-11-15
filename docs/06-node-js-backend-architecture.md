# Node.js Backend Architecture


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

