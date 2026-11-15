import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@podcast/core';
import type { CreateDialogueRequest } from '@podcast/types';
import {
  createElevenLabsVideo,
  downloadElevenLabsVideo,
  generateDialogue,
  getElevenLabsVideo,
  transcribeAudio,
} from '../src/elevenlabs';
import { concatenateMp3Buffers } from '../src/media';

const originalApiKey = process.env.ELEVENLABS_API_KEY;
const originalModelId = process.env.ELEVENLABS_STT_MODEL_ID;
let temporaryDirectory: string | undefined;

vi.mock('../src/media', () => ({
  concatenateMp3Buffers: vi.fn(async (audioBuffers: Buffer[]) => Buffer.concat(audioBuffers)),
}));

async function createAudioFile(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'podcast-stt-test-'));
  const filePath = join(temporaryDirectory, 'input.mp3');
  await writeFile(filePath, Buffer.from('mock audio'));
  return filePath;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(concatenateMp3Buffers).mockClear();
  if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalApiKey;
  if (originalModelId === undefined) delete process.env.ELEVENLABS_STT_MODEL_ID;
  else process.env.ELEVENLABS_STT_MODEL_ID = originalModelId;
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe('transcribeAudio', () => {
  it('sends the documented multipart fields and maps timed words', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    delete process.env.ELEVENLABS_STT_MODEL_ID;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.elevenlabs.io/v1/speech-to-text');
      expect(new Headers(init?.headers).get('xi-api-key')).toBe('test-key');
      const form = init?.body as FormData;
      expect(form.get('model_id')).toBe('scribe_v3');
      expect(form.get('tag_audio_events')).toBe('false');
      expect(form.get('timestamps_granularity')).toBe('word');
      expect(form.get('language_code')).toBe('en');
      expect(form.get('file')).toBeInstanceOf(Blob);
      return Response.json({
        text: 'Hello, world!',
        words: [
          { text: 'Hello,', type: 'word', start: 0, end: 0.4 },
          { text: ' ', type: 'spacing' },
          { text: 'world!', type: 'word', start: 0.5, end: 0.9 },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcribeAudio(await createAudioFile(), 'en');

    expect(result).toEqual({
      text: 'Hello, world!',
      segments: [
        { start: 0, end: 0.4, text: 'Hello,' },
        { start: 0.5, end: 0.9, text: 'world!' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects non-empty text without word timestamps', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      text: 'Transcript without timings',
      words: [{ text: 'Transcript', type: 'word' }],
    })));

    await expect(transcribeAudio(await createAudioFile(), null)).rejects.toMatchObject({
      code: 'ELEVENLABS_API_ERROR',
      message: 'ElevenLabs returned transcription text without word timestamps.',
    });
  });
});

describe('generateDialogue provider errors', () => {
  it('uses the official TTS SDK once per dialogue turn and combines the returned audio', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const responses = [Buffer.from('speaker one'), Buffer.from('speaker two')];
    let responseIndex = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(input));
      expect(requestUrl.pathname).toMatch(/^\/v1\/text-to-speech\/voice-/);
      expect(requestUrl.searchParams.get('output_format')).toBe('mp3_44100_128');
      expect(new Headers(init?.headers).get('xi-api-key')).toBe('test-key');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model_id).toBe('eleven_v3');
      expect(body.text).toBe(responseIndex === 0 ? '[dark narrator voice] First line.' : '[whisper] Second line.');
      expect(body.apply_text_normalization).toBe('off');
      return new Response(responses[responseIndex++]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const payload: CreateDialogueRequest = {
      model_id: 'eleven_v3',
      language_code: 'en',
      apply_text_normalization: 'off',
      inputs: [
        { text: '[dark narrator voice] First line.', voice_id: 'voice-one' },
        { text: '[whisper] Second line.', voice_id: 'voice-two' },
      ],
    };

    const result = await generateDialogue(payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.audio).toEqual(Buffer.concat(responses));
    expect(result.mimeType).toBe('audio/mpeg');
    expect(concatenateMp3Buffers).toHaveBeenCalledWith(responses, 'mp3_44100_128');
  });

  it('does not retry HTTP 402 errors and explains the billing requirement', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response('{"detail":"Payment required"}', { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload: CreateDialogueRequest = {
      model_id: 'eleven_v3',
      inputs: [{ text: 'Hello there.', voice_id: 'test-voice' }],
    };

    let caught: unknown;
    try {
      await generateDialogue(payload);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'ELEVENLABS_PAYMENT_REQUIRED',
      status: 402,
      retryable: false,
      message: 'ElevenLabs requires an active plan or available credits for voice generation. Check your account billing and usage limits.',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('ElevenLabs video generation', () => {
  it('starts and polls a documented video generation', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('xi-api-key')).toBe('test-key');
      if (String(input).endsWith('/v1/flows/video')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          model_id: 'bytedance-seedance-v2-fast',
          prompt: 'A quiet forest at dawn',
          aspect_ratio: '16:9',
          duration_secs: 5,
          resolution: '720p',
          generate_audio: false,
        });
        return Response.json({ id: 'generation-1', status: 'pending' });
      }
      expect(String(input)).toBe('https://api.elevenlabs.io/v1/flows/video/generation-1');
      return Response.json({
        id: 'generation-1',
        status: 'completed',
        content_mime_type: 'video/mp4',
        content_url: 'https://storage.googleapis.com/generated/video.mp4',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createElevenLabsVideo('A quiet forest at dawn')).resolves.toEqual({
      id: 'generation-1',
      status: 'pending',
    });
    await expect(getElevenLabsVideo('generation-1')).resolves.toEqual({
      id: 'generation-1',
      status: 'completed',
      content_mime_type: 'video/mp4',
      content_url: 'https://storage.googleapis.com/generated/video.mp4',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('downloads the generated MP4 without forwarding the API key', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).has('xi-api-key')).toBe(false);
      return new Response(Buffer.from('video bytes'), { headers: { 'content-type': 'video/mp4' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadElevenLabsVideo('https://storage.googleapis.com/generated/video.mp4')).resolves.toEqual({
      mimeType: 'video/mp4',
      data: Buffer.from('video bytes'),
    });
  });

  it('rejects insecure generated video download URLs', async () => {
    await expect(downloadElevenLabsVideo('http://localhost/video.mp4')).rejects.toMatchObject({
      code: 'ELEVENLABS_API_ERROR',
      message: 'ElevenLabs returned an unsafe video download URL.',
    });
  });
});
