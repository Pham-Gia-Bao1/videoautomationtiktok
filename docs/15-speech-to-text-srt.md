# Speech-to-Text & SRT


### 15.1 Flow

```
Final MP3
   ↓
POST /v1/speech-to-text (ElevenLabs)
   ↓
Transcription
   ↓
SRT Generator
   ↓
subtitles row
```

The API uploads the final MP3 as multipart `file`, sets `model_id` to
`scribe_v3` by default (`ELEVENLABS_STT_MODEL_ID` can override it), and requests
word-level timestamps with `timestamps_granularity=word`. It maps the response's
`text` and timed `words` into subtitle segments; non-empty text without usable
word timestamps is treated as an API error instead of producing empty subtitles.
See the [ElevenLabs Speech to Text API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

### 15.2 SRT format

```
1
00:00:00,000 --> 00:00:02,340
I thought you forgot about me.

2
00:00:02,500 --> 00:00:04,120
How could I forget?
```

### 15.3 SRT generator rules
- Max 2 dòng / subtitle.
- Max 42 ký tự / dòng.
- Không cắt giữa từ.
- Min duration 1s, max 7s.
- Merge segment < 1s liền nhau.

### 15.4 Timestamp helper

```ts
function toSrtTime(seconds: number): string {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}
```

---
