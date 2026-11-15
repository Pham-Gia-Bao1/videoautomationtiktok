# Testing Strategy


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
- [ ] > 10 voices bị block.
- [ ] Chunk > 2000 chars bị block.
- [ ] Audio tags giữ nguyên.
- [ ] Retry hoạt động.
- [ ] Merge MP3 với gap.
- [ ] SRT khớp audio.

---

