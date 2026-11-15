# Generation Queue / Worker


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

