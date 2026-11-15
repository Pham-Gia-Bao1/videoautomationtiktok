# State Machines


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
  elif cancelled == total: status = CANCELLED
  elif completed > 0 and completed + failed + cancelled == total: status = PARTIAL
  elif completed + failed + cancelled == total: status = FAILED
  else: status = QUEUED
```

---
