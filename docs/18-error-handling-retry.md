# Error Handling & Retry


### 18.1 Error taxonomy

| Layer | Code | Retryable |
|-------|------|-----------|
| Validation | VALIDATION_FAILED | No |
| Auth | UNAUTHORIZED | No |
| Authz | FORBIDDEN | No |
| Resource | NOT_FOUND | No |
| Provider | ELEVENLABS_RATE_LIMIT | Yes |
| Provider | ELEVENLABS_API_ERROR | Yes |
| Provider billing / credits | ELEVENLABS_PAYMENT_REQUIRED | No |
| Provider | ELEVENLABS_TIMEOUT | Yes |
| Provider | ELEVENLABS_BAD_REQUEST | No |
| Media | FFMPEG_FAILED | Yes |
| Internal | INTERNAL | Yes |

### 18.2 Retry policy
- Queue-level: `attempts: 3`, backoff exponential 3s.
- Manual retry: reset `retry_count = 0`, re-enqueue.
- Max retry_count = 5.

### 18.3 Partial failure
- Batch có thể `PARTIAL`.
- UI hiển thị chunk failed + Retry.
- User có thể compose trước với chunk COMPLETED.

### 18.4 Correlation ID
- Sinh ở middleware.
- Truyền vào job payload.
- Trả về client trong `error.correlationId`.

### 18.5 Circuit breaker (optional)
- Nếu 429 liên tục > N lần trong 60s → pause queue 5 phút.

---
