# Security


### 17.1 API keys
- `ELEVENLABS_API_KEY` **chỉ** ở backend.
- Không prefix `NEXT_PUBLIC_`.
- Rotate định kỳ.

### 17.2 Auth
- Supabase Auth (email + OAuth).
- Backend verify JWT.

### 17.3 Authorization
- RLS trên mọi bảng.
- Backend check `userId` khớp `project.user_id`.

### 17.4 Input validation
- Zod schema cho mọi request.
- Whitelist `model_id`, `output_format`, `language_code`.
- Giới hạn độ dài `rawText`.
- Sanitize tên file storage.

### 17.5 Storage
- Buckets private.
- Signed URL TTL ≤ 1h.
- Path pattern `{userId}/...`.

### 17.6 Rate limiting
- Per-user: 60 req/phút.
- `POST /generation-batches/:id/start`: 5 req/phút.

### 17.7 Headers
- CORS whitelist.
- CSP.
- HSTS.

### 17.8 Logging
- Correlation ID mỗi request.
- Audit log cho action quan trọng.
- Không log raw script text ở prod.

---

