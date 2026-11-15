# FFmpeg Merge Pipeline


### 14.1 Concat approach

```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp3
```

`list.txt`:
```
file '/abs/path/chunk01.mp3'
file '/abs/path/silence_300ms.mp3'
file '/abs/path/chunk02.mp3'
```

### 14.2 Silence generation

```bash
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.3 -q:a 9 -acodec libmp3lame silence.mp3
```

### 14.3 Merge flow

```
1. Load composition + items (ordered)
2. Tải tất cả audio về tmp dir
3. Tạo silence files cho gap
4. Sinh list.txt
5. Chạy ffmpeg concat
6. Verify output (ffprobe)
7. Upload final MP3 lên Storage
8. Insert audios (kind='final')
9. composition.output_audio_id = audios.id
10. composition.status = READY
```

### 14.4 Safety
- Timeout FFmpeg: 5 phút.
- Kill process nếu treo.
- Cleanup tmp dir trong `finally`.
- Validate output tồn tại & size > 0.

### 14.5 Video export
- Nhận final MP3, các clip MP4/QuickTime/WebM (tối đa 100 MB/file, 15 phút, 40 MP) hoặc clip sinh qua ElevenLabs.
- ElevenLabs gọi `POST /v1/flows/video` với `bytedance-seedance-v2-fast`, poll trạng thái tới khi hoàn thành rồi tải signed URL về local storage. Cần quyền Image & Video Generation và gói trả phí.
- Probe clip bằng FFprobe; chuẩn hóa từng clip về 1280×720 H.264/30fps, pad giữ đúng tỷ lệ và bỏ audio gốc.
- Ghép clip theo thứ tự, lặp chuỗi hình khi cần; final audio điều khiển thời lượng đầu ra. Encode audio AAC 192 kbps.
- Nếu chọn SRT/VTT của chính final audio đó, burn captions vào khung hình và nhúng thêm `mov_text` track để bật/tắt trong trình phát MP4.
- Render chạy nền; lưu trạng thái `PROCESSING` / `READY` / `FAILED` và file MP4 trong storage local.
- Dùng FFmpeg argument array (không qua shell), timeout cấu hình mặc định 30 phút và dọn thư mục tạm trong `finally`.
- Download chỉ hoạt động khi video `READY`, và kiểm tra quyền sở hữu episode.

---
