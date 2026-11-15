# Product Overview & Scope


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
- Build a normalized multi-speaker payload and call ElevenLabs Text-to-Speech
  once per dialogue turn using each mapped voice ID.
- Chunking theo rule ≤ 2,000 characters/chunk, không cắt giữa turn.
- Background generation qua queue worker.
- MP3 Library lưu trữ tất cả chunk audio.
- Drag & drop composer để ghép chunk thành final audio.
- FFmpeg merge MP3.
- Speech-to-Text trên final MP3.
- Sinh SRT + export MP3 / SRT.
- Video export có hai nguồn hình: tạo clip bằng ElevenLabs Image & Video Generation hoặc upload, chọn và sắp thứ tự clip cá nhân.
- Ghép clip với final MP3 bằng FFmpeg; tự lặp/cắt video theo độ dài audio và nhúng SRT thành subtitle track.
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
- ElevenLabs API key có quyền dùng `eleven_v3` và Text-to-Speech; tạo video cần quyền Image & Video Generation và gói trả phí.
- User chấp nhận rule ≤ 2,000 chars/request.
- Backend chạy được FFmpeg.
- Redis khả dụng cho BullMQ.

### 1.6 Success metrics (MVP)
- Generate thành công ≥ 95% chunk khi API không lỗi.
- Thời gian từ click Generate → có final MP3 < 5 phút với script ~8,500 chars.
- SRT khớp audio final ≥ 90% theo spot check.
- Zero plaintext API key ở FE.

---
