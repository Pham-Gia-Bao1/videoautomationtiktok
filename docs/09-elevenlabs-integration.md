# ElevenLabs Integration

### 9.1 SDK and endpoints

Audio generation uses the official `@elevenlabs/elevenlabs-js` SDK on the API
server. Each script turn is sent to
`client.textToSpeech.convert(voiceId, { text, modelId })`; the returned MP3
segments are assembled in script order with FFmpeg. The API key is never sent
to the frontend.

| Purpose | Method | Endpoint |
|---------|--------|----------|
| Text to speech | POST | `/v1/text-to-speech/{voice_id}` |
| List voices | GET | `/v1/voices` |
| Speech to Text | POST | `/v1/speech-to-text` |

Base URL: `https://api.elevenlabs.io`
Auth header: `xi-api-key: ${ELEVENLABS_API_KEY}`

### 9.2 Local chunk payload

The app keeps a normalized multi-speaker payload internally, then makes one
TTS request per input turn:

```json
{
  "inputs": [
    { "text": "[giggling] Knock knock", "voice_id": "JBFqnCBsd6RMkjVDRZzb" },
    { "text": "[curious] Who is there?", "voice_id": "Aw4FAjKCGjjNkVhN1Xmq" }
  ],
  "model_id": "eleven_v3",
  "language_code": "en",
  "apply_text_normalization": "auto",
  "output_format": "mp3_44100_128"
}
```

Rules:
- A local generation chunk contains at most 2,000 dialogue characters.
- Each input's `voice_id` is passed as the voice ID argument to `textToSpeech.convert`.
- Audio tags remain part of the text.
- `model_id` defaults to `eleven_v3`; MP3 output defaults to `mp3_44100_128`.
- Each ElevenLabs call is a single-voice request, so the Text-to-Dialogue
  10-unique-voice limit does not apply.

### 9.3 SDK call

```ts
const client = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

const audioStream = await client.textToSpeech.convert(voiceId, {
  text,
  modelId: 'eleven_v3',
  outputFormat: 'mp3_44100_128',
});
const audio = Buffer.from(await new Response(audioStream).arrayBuffer());
```

The application makes SDK requests only from the backend, disables SDK
automatic retries, maps provider errors to application errors, and combines
the returned segments in order.

### 9.4 Constants

```ts
export const ELEVENLABS_LIMITS = {
  MAX_CHARS_PER_REQUEST: 2000,
  DEFAULT_MODEL_ID: 'eleven_v3',
  DEFAULT_OUTPUT_FORMAT: 'mp3_44100_128',
};
```

### 9.5 Error mapping

| HTTP | Internal code | Retry |
|------|---------------|-------|
| 400 | ELEVENLABS_BAD_REQUEST | no |
| 401 | ELEVENLABS_UNAUTHORIZED | no |
| 402 | ELEVENLABS_PAYMENT_REQUIRED | no |
| 422 | ELEVENLABS_UNPROCESSABLE | no |
| 429 | ELEVENLABS_RATE_LIMIT | yes |
| 5xx | ELEVENLABS_API_ERROR | yes |
| timeout | ELEVENLABS_TIMEOUT | yes |

### 9.6 Requirements

- Keep `ELEVENLABS_API_KEY` server-side and grant only required API permissions.
- Do not call ElevenLabs directly from the frontend.
- Do not hard-code voice IDs or strip audio tags.
- Confirm account billing and available credits before starting a live generation.
