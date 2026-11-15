# Podcast Studio

Podcast Studio turns multi-speaker scripts into generated audio, compositions,
and subtitles. The numbered specifications are in [`docs/`](./docs/).

## Run locally

Requires Node.js 18.18+ and npm.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open the UI at [http://localhost:3000](http://localhost:3000). The API listens
on `127.0.0.1:3001`. Project metadata and audio are stored under
`apps/api/data/` and are ignored by git.

The local preview supports project/episode management, script parsing and
versioning, voice mapping, payload preview/validation, asynchronous chunk
generation with retries, audio library management, composition/merge, and
transcription plus SRT/VTT export. ElevenLabs features require
`ELEVENLABS_API_KEY`; merging also requires `ffmpeg` and `ffprobe` on `PATH`.
No credentials are required just to open the UI or create projects/scripts.

### Ghost Editor reels on Windows

The Video step includes an optional **Ghost Editor · AI reel** mode for uploaded
footage. Claude Code reads contact sheets and the episode script to plan source
cuts. The Windows FFmpeg renderer then makes a vertical reel and styles word
captions from the Ghost Editor presets in `integrations/ghost-editor/styles/`.
The original repository's macOS/Whisper/HyperFrames workflow is not run directly
by the Windows API; this adapter uses its edit guidance and style presets with
the app's existing FFmpeg and ElevenLabs speech-to-text services.

Install Claude Code for Windows and Git for Windows, then sign in once from a
terminal:

```powershell
npm install --global --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
claude auth login
```

The API detects the npm global `claude.cmd` under `%APPDATA%` and Git Bash at
`C:\Program Files\Git\bin\bash.exe`. Set `CLAUDE_CODE_PATH` or
`CLAUDE_CODE_GIT_BASH_PATH` in `.env` if they are installed elsewhere. Ghost
reel creation also needs a saved episode script, a final MP3, and one or more
uploaded source clips. If the selected audio has no word timings yet, the API
transcribes it with ElevenLabs before rendering.

For an ElevenLabs API key, grant only:

- **Text to Speech: Access** for dialogue generation.
- **Speech to Text: Access** for transcription.
- **Voices: Read** to list voices and voice previews.

Other permissions are not used by this MVP. Keep the key server-side in `.env`,
apply a credit limit and a finite expiration when practical, and restart the API
after changing `.env`.

### Environment

Copy `.env.example` to `.env`. Keep API keys in the API environment only;
never add them to `NEXT_PUBLIC_*` variables. Provider features report an explicit
configuration error when a key is missing.

### Run a workspace separately

```powershell
npm run dev:api
npm run dev:web
```

### Validate

```powershell
npm run typecheck
npm test
npm run build
```

The local development API is intentionally bound to loopback and uses a
single-user local identity. Production startup requires `SUPABASE_JWT_SECRET`
and validates signed HS256 bearer tokens. Production deployment still requires
proper Supabase-backed persistence/RLS and a durable shared job queue; the local
JSON store and in-process workers are development-only and must not be exposed
to multiple API instances or treated as a production deployment.
