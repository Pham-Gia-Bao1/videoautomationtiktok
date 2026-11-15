# MVP Acceptance Criteria


### A. Script & Mapping
- [ ] Paste script → parse đúng.
- [ ] Warning khi dòng không match.
- [ ] Gán voice + preview.
- [ ] Mỗi lượt thoại được tạo với voice đã mapping.

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
