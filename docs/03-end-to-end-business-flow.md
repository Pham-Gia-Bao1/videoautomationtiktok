# End-to-End Business Flow


### 3.1 Flow chính

```
ChatGPT
   ↓
Generate conversation
   ↓
Copy Script
   ↓
Podcast Studio
   ↓
Script Parser
   ↓
Normalized Conversation
   ↓
Character → Voice Mapping
   ↓
ElevenLabs Payload Builder
   ↓
Payload Review / Edit
   ↓
Validate
   ↓
Auto Chunk ≤ 2,000 chars
   ↓
Generate Multiple Chunks
   ↓
MP3 Library
   ↓
Drag & Drop
   ↓
FFmpeg Merge
   ↓
Final Podcast MP3
   ↓
ElevenLabs Speech-to-Text
   ↓
Transcription
   ↓
SRT
   ↓
Export MP3 / SRT
```

### 3.2 Script Input

User paste script dạng:

```
Sarah: I thought you forgot about me.

Daniel: How could I forget?

Sarah: You haven't called me for three months.

Daniel: I was afraid.

Sarah: Afraid of what?

Daniel: Afraid that you had moved on.
```

Parser nhận diện:
- Pattern `^([A-Za-z0-9 _\-']+):\s*(.+)$`
- Bỏ dòng trống.
- Gom dòng cùng speaker liên tiếp thành 1 turn (optional flag `mergeAdjacent`).

### 3.3 Normalized Conversation

```json
{
  "characters": [
    { "key": "sarah",  "name": "Sarah" },
    { "key": "daniel", "name": "Daniel" }
  ],
  "lines": [
    { "sequence": 1, "speaker": "sarah",  "text": "I thought you forgot about me." },
    { "sequence": 2, "speaker": "daniel", "text": "How could I forget?" },
    { "sequence": 3, "speaker": "sarah",  "text": "You haven't called me for three months." },
    { "sequence": 4, "speaker": "daniel", "text": "I was afraid." },
    { "sequence": 5, "speaker": "sarah",  "text": "Afraid of what?" },
    { "sequence": 6, "speaker": "daniel", "text": "Afraid that you had moved on." }
  ]
}
```

### 3.4 Character → Voice Mapping

```
Sarah  → Rachel → voice_id = xxx
Daniel → Adam   → voice_id = xxx
```

Ràng buộc:
- Mỗi character **phải** có mapping.
- Tổng unique voice_ids trong 1 request ≤ 10.
- Voice list lấy từ ElevenLabs `/v1/voices`.

### 3.5 Payload Builder

Output:

```json
{
  "model_id": "eleven_v3",
  "language_code": "en",
  "inputs": [
    { "text": "I thought you forgot about me.", "voice_id": "SARAH_VOICE_ID" },
    { "text": "How could I forget?",            "voice_id": "DANIEL_VOICE_ID" }
  ],
  "settings": {},
  "seed": null,
  "apply_text_normalization": "auto"
}
```

### 3.6 Chunking

Ví dụ total = 8,500 chars:

```
Chunk 01 → 1,850 chars
Chunk 02 → 1,920 chars
Chunk 03 → 1,970 chars
Chunk 04 → 1,760 chars
Chunk 05 → 1,000 chars
```

**Boundary rule:** chia tại ranh giới turn, không cắt giữa câu.

### 3.7 Generation — Multiple Batches

```
Batch #1 → Chunk 01, 02, 03
Batch #2 → Chunk 01, 02, 03
```

User có thể mix:

```
Batch #1 Chunk 01
Batch #2 Chunk 02
Batch #1 Chunk 03
→ Compose → Final Podcast
```

### 3.8 Transcription & SRT

- Final MP3 → `POST /v1/speech-to-text`.
- Kết quả transcription lưu DB.
- Sinh SRT từ transcription.

**Lý do dùng STT trên final MP3** thay vì cộng timestamp từ chunk:
- Tránh sai số do cắt chunk.
- SRT khớp đúng audio cuối.
- Giảm complexity.

---

