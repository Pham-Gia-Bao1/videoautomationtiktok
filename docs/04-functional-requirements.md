# Functional Requirements


### FR-01 Project & Episode
- FR-01.1: User tạo Project (name, description).
- FR-01.2: Mỗi Project chứa nhiều Episode.
- FR-01.3: Episode có title, language, default model.

### FR-02 Script Editor
- FR-02.1: Paste raw script.
- FR-02.2: Hiển thị normalized lines.
- FR-02.3: Cảnh báo khi dòng không match pattern `Speaker: text`.
- FR-02.4: Cho phép sửa từng line.
- FR-02.5: Cho phép thêm/xóa line.

### FR-03 Character & Voice Mapping
- FR-03.1: List characters auto-detect.
- FR-03.2: Fetch voice list từ ElevenLabs.
- FR-03.3: Gán voice cho từng character.
- FR-03.4: Preview voice (gọi sample).
- FR-03.5: Mỗi lượt thoại dùng voice đã được mapping.

### FR-04 Payload Editor
- FR-04.1: Visual editor cho từng dialogue input.
- FR-04.2: Toggle `[ Visual ] / [ JSON ]`.
- FR-04.3: Cho phép sửa text (giữ audio tags).
- FR-04.4: Cho phép đổi voice per-line.
- FR-04.5: Cho phép override model_id, language_code.
- FR-04.6: Advanced: seed, apply_text_normalization, pronunciation_dictionary_locators, settings.
- FR-04.7: Nút Validate.

### FR-05 Validation
- FR-05.1: `inputs.length > 0`.
- FR-05.2: Mỗi input: `text !== "" && voice_id !== ""`.
- FR-05.3: Mỗi lượt thoại có đúng một `voice_id`.
- FR-05.4: `total characters/chunk ≤ 2000`.
- FR-05.5: `model_id ∈ {eleven_v3, ...whitelist}`.
- FR-05.6: Payload JSON hợp lệ.
- FR-05.7: Tất cả speaker đều được mapping.

### FR-06 Chunking
- FR-06.1: Tự động chia chunk khi > 2000 chars.
- FR-06.2: Chia tại ranh giới turn, không cắt giữa câu.
- FR-06.3: Lưu `start_line`, `end_line`, `character_count`, `input_count`.
- FR-06.4: Preview chunk trước khi generate.

### FR-07 Generation
- FR-07.1: Tạo batch gồm nhiều chunk.
- FR-07.2: Start batch → enqueue jobs.
- FR-07.3: Retry chunk lỗi.
- FR-07.4: Regenerate chunk (tạo batch mới).
- FR-07.5: Hiển thị status realtime (SSE hoặc polling).
- FR-07.6: Hỗ trợ nhiều batch trên cùng script.

### FR-08 Audio Library
- FR-08.1: List tất cả chunk audio theo episode.
- FR-08.2: Filter theo batch, status.
- FR-08.3: Play preview.
- FR-08.4: Download chunk.
- FR-08.5: Xóa chunk (soft delete).

### FR-09 Audio Composer
- FR-09.1: Drag & drop chunk vào timeline.
- FR-09.2: Reorder.
- FR-09.3: Remove item.
- FR-09.4: Insert silence giữa item.
- FR-09.5: Lưu composition.
- FR-09.6: Preview.

### FR-10 Merge
- FR-10.1: Enqueue merge job.
- FR-10.2: FFmpeg concat MP3.
- FR-10.3: Upload final MP3 lên Supabase Storage.
- FR-10.4: Download final MP3.

### FR-11 Transcription
- FR-11.1: Gửi final MP3 → ElevenLabs STT.
- FR-11.2: Lưu transcription với segments.
- FR-11.3: Hiển thị transcript.

### FR-12 SRT
- FR-12.1: Sinh SRT từ transcription.
- FR-12.2: Editor chỉnh sửa SRT.
- FR-12.3: Download SRT.

### FR-13 Status & Monitoring
- FR-13.1: State machine cho Batch, Chunk, Composition, Transcription.
- FR-13.2: Realtime cập nhật.
- FR-13.3: Xem error message khi FAILED.

### FR-14 Error Handling
- FR-14.1: Retry tự động với exponential backoff.
- FR-14.2: Manual retry.
- FR-14.3: Dead-letter queue.
- FR-14.4: Log với correlation ID.

### FR-15 Auth & Permissions
- FR-15.1: Supabase Auth (email + OAuth).
- FR-15.2: Row Level Security cho user chỉ xem data của mình.
- FR-15.3: API key ElevenLabs chỉ ở server.

### FR-16 Video Export
- FR-16.1: Chọn final composition audio và một trong hai nguồn: ElevenLabs Video Generation hoặc video clip người dùng upload.
- FR-16.2: ElevenLabs tạo clip 5 giây bằng `bytedance-seedance-v2-fast`, 720p; yêu cầu API key có quyền Image & Video Generation và gói trả phí.
- FR-16.3: Chấp nhận MP4, QuickTime hoặc WebM tối đa 100 MB/file, 15 phút và 40 megapixels; mỗi episode lưu clip riêng.
- FR-16.4: Sắp xếp tối đa 10 clip; chuẩn hóa thành 1280×720 H.264, lặp hoặc cắt để khớp độ dài audio.
- FR-16.5: Cho phép chọn SRT/VTT sinh từ đúng final audio; burn captions vào hình và nhúng subtitle track `mov_text`.
- FR-16.6: Hiển thị trạng thái PROCESSING, READY hoặc FAILED; chỉ tải MP4 khi READY.
- FR-16.7: Kiểm tra quyền sở hữu episode/audio/clip/subtitle; không nhận đường dẫn file tùy ý.

---
