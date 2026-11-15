# Open Items


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

The application uses a normalized `inputs[] + voice_id + text` payload, then
calls the official ElevenLabs Text-to-Speech SDK once per dialogue turn and
assembles MP3 segments in script order. Local chunks are limited to 2,000
characters; the Text-to-Dialogue 10-voice limit does not apply. Generation
runs in the API background worker. **Do not** call ElevenLabs from the
frontend or strip audio tags.

---

**END OF DOCUMENT**
