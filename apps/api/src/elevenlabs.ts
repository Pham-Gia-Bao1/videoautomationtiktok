import { ALLOWED_OUTPUT_FORMATS, AppError, ERROR_CODES } from '@podcast/core';
import { ElevenLabsClient, ElevenLabsTimeoutError, type ElevenLabs } from '@elevenlabs/elevenlabs-js';
import type {
  CreateDialogueRequest,
  ElevenLabsVoice,
  TranscriptionSegment,
} from '@podcast/types';
import { readFile } from 'node:fs/promises';
import { concatenateMp3Buffers } from './media';

const apiBase = (process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
const MAX_GENERATED_VIDEO_BYTES = 100 * 1024 * 1024;

export type ElevenLabsVideoStatus =
  | { id: string; status: 'pending' | 'generating' }
  | { id: string; status: 'failed'; error_message: string }
  | { id: string; status: 'completed'; content_mime_type: string; content_url: string };

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new AppError(
      ERROR_CODES.ELEVENLABS_UNAUTHORIZED,
      'Set ELEVENLABS_API_KEY in the API environment to use ElevenLabs features.',
      503,
    );
  }
  return key;
}

function providerErrorForStatus(status: number, detail = ''): AppError {
  const code =
    status === 400 ? ERROR_CODES.ELEVENLABS_BAD_REQUEST
      : status === 401 ? ERROR_CODES.ELEVENLABS_UNAUTHORIZED
        : status === 402 ? ERROR_CODES.ELEVENLABS_PAYMENT_REQUIRED
        : status === 422 ? ERROR_CODES.ELEVENLABS_UNPROCESSABLE
          : status === 429 ? ERROR_CODES.ELEVENLABS_RATE_LIMIT
            : ERROR_CODES.ELEVENLABS_API_ERROR;
  const messageByStatus: Record<number, string> = {
    400: 'ElevenLabs rejected the request. Check the payload and voice IDs.',
    401: 'ElevenLabs rejected the API key.',
    402: 'ElevenLabs requires an active plan or available credits for voice generation. Check your account billing and usage limits.',
    422: 'ElevenLabs could not process this payload.',
    429: 'ElevenLabs rate limit reached.',
  };
  return new AppError(
    code,
    messageByStatus[status] ?? `ElevenLabs request failed with HTTP ${status}.`,
    status === 429 ? 429 : status === 400 || status === 422 ? 422 : status === 401 ? 401 : status === 402 ? 402 : 502,
    detail ? { providerMessage: detail.slice(0, 1000) } : undefined,
  );
}

async function providerError(response: Response): Promise<AppError> {
  const detail = await response.text().catch(() => '');
  return providerErrorForStatus(response.status, detail);
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: AbortSignal.timeout(Number(process.env.ELEVENLABS_TIMEOUT_MS ?? 120_000)),
      headers: { 'xi-api-key': apiKey(), ...init.headers },
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(ERROR_CODES.ELEVENLABS_TIMEOUT, 'ElevenLabs request timed out or could not connect.', 502);
  }
  if (!response.ok) throw await providerError(response);
  return response;
}

function parseVideoStatus(value: unknown): ElevenLabsVideoStatus {
  if (!value || typeof value !== 'object') {
    throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned an invalid video-generation response.', 502);
  }
  const result = value as Record<string, unknown>;
  if (typeof result.id !== 'string') {
    throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned a video response without an ID.', 502);
  }
  if (result.status === 'pending' || result.status === 'generating') {
    return { id: result.id, status: result.status };
  }
  if (result.status === 'failed') {
    return {
      id: result.id,
      status: 'failed',
      error_message: typeof result.error_message === 'string' ? result.error_message : 'Video generation failed.',
    };
  }
  if (result.status === 'completed' && typeof result.content_url === 'string' && typeof result.content_mime_type === 'string') {
    return {
      id: result.id,
      status: 'completed',
      content_url: result.content_url,
      content_mime_type: result.content_mime_type,
    };
  }
  throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned an unsupported video-generation status.', 502);
}

export async function createElevenLabsVideo(prompt: string): Promise<ElevenLabsVideoStatus> {
  const response = await request('/v1/flows/video', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model_id: 'bytedance-seedance-v2-fast',
      prompt,
      aspect_ratio: '16:9',
      duration_secs: 5,
      resolution: '720p',
      generate_audio: false,
    }),
  });
  return parseVideoStatus(await response.json());
}

export async function getElevenLabsVideo(generationId: string): Promise<ElevenLabsVideoStatus> {
  const response = await request(`/v1/flows/video/${encodeURIComponent(generationId)}`, { method: 'GET' });
  return parseVideoStatus(await response.json());
}

export async function downloadElevenLabsVideo(contentUrl: string): Promise<{ mimeType: string; data: Buffer }> {
  let url: URL;
  try {
    url = new URL(contentUrl);
  } catch {
    throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned an invalid video download URL.', 502);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned an unsafe video download URL.', 502);
  }

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  } catch (error) {
    throw new AppError(ERROR_CODES.ELEVENLABS_TIMEOUT, 'Could not download the generated video from ElevenLabs.', 502, {
      cause: error instanceof Error ? error.message.slice(0, 500) : 'Unknown download error.',
    });
  }
  if (!response.ok) {
    throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, `Generated video download failed with HTTP ${response.status}.`, 502);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_GENERATED_VIDEO_BYTES) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Generated video exceeds the 100 MB size limit.', 413);
  }
  if (!response.body) {
    throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'Generated video download returned no content.', 502);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_GENERATED_VIDEO_BYTES) {
      await reader.cancel();
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Generated video exceeds the 100 MB size limit.', 413);
    }
    chunks.push(value);
  }
  return { mimeType: response.headers.get('content-type')?.split(';', 1)[0].toLowerCase() ?? 'video/mp4', data: Buffer.concat(chunks) };
}

function voiceSettings(settings?: Record<string, unknown>): ElevenLabs.VoiceSettings | undefined {
  if (!settings) return undefined;
  const result: ElevenLabs.VoiceSettings = {};
  for (const key of ['stability', 'similarity_boost', 'style', 'speed', 'clone_strength'] as const) {
    const value = settings[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (key === 'stability') result.stability = value;
      else if (key === 'similarity_boost') result.similarityBoost = value;
      else if (key === 'style') result.style = value;
      else if (key === 'speed') result.speed = value;
      else result.cloneStrength = value;
    }
  }
  if (typeof settings.use_speaker_boost === 'boolean') result.useSpeakerBoost = settings.use_speaker_boost;
  return Object.keys(result).length > 0 ? result : undefined;
}

function sdkProviderError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ElevenLabsTimeoutError) {
    return new AppError(ERROR_CODES.ELEVENLABS_TIMEOUT, 'ElevenLabs request timed out.', 502);
  }
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') {
      const body = (error as { body?: unknown }).body;
      const detail = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body);
      return providerErrorForStatus(status, detail);
    }
  }
  return new AppError(
    ERROR_CODES.ELEVENLABS_API_ERROR,
    error instanceof Error ? `ElevenLabs voice generation failed: ${error.message}` : 'ElevenLabs voice generation failed.',
    502,
    error instanceof Error ? { cause: error.name } : undefined,
  );
}

export async function listVoices(): Promise<ElevenLabsVoice[]> {
  const response = await request('/v1/voices', { method: 'GET' });
  const result = await response.json() as { voices?: Array<Record<string, unknown>> };
  return (result.voices ?? []).map((voice) => ({
    voiceId: String(voice.voice_id ?? ''),
    name: String(voice.name ?? 'Unnamed voice'),
    category: typeof voice.category === 'string' ? voice.category : undefined,
    labels: voice.labels && typeof voice.labels === 'object' ? voice.labels as Record<string, string> : undefined,
    previewUrl: typeof voice.preview_url === 'string' ? voice.preview_url : undefined,
    description: typeof voice.description === 'string' ? voice.description : undefined,
  }));
}

export async function generateDialogue(payload: CreateDialogueRequest): Promise<{ audio: Buffer; mimeType: string }> {
  const key = apiKey();
  const timeoutMs = Number(process.env.ELEVENLABS_TIMEOUT_MS ?? 120_000);
  const outputFormat = ALLOWED_OUTPUT_FORMATS.find((format) => format === payload.output_format) ?? 'mp3_44100_128';
  const client = new ElevenLabsClient({
    apiKey: key,
    baseUrl: apiBase,
    timeoutInSeconds: timeoutMs / 1000,
    maxRetries: 0,
  });
  const audioSegments: Buffer[] = [];

  for (const input of payload.inputs) {
    try {
      const response = await client.textToSpeech.convert(input.voice_id, {
        text: input.text,
        modelId: payload.model_id,
        outputFormat,
        languageCode: payload.language_code,
        voiceSettings: voiceSettings(payload.settings),
        seed: payload.seed ?? undefined,
        applyTextNormalization: payload.apply_text_normalization,
      }, { maxRetries: 0 });
      const audio = Buffer.from(await new Response(response).arrayBuffer());
      if (audio.length === 0) {
        throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned an empty audio file.', 502);
      }
      audioSegments.push(audio);
    } catch (error) {
      throw sdkProviderError(error);
    }
  }
  const audio = await concatenateMp3Buffers(audioSegments, outputFormat);
  return {
    audio,
    mimeType: 'audio/mpeg',
  };
}

export async function transcribeAudio(
  filePath: string,
  languageCode: string | null,
): Promise<{ text: string; segments: TranscriptionSegment[] }> {
  const file = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL_ID ?? 'scribe_v3');
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'word');
  if (languageCode) form.append('language_code', languageCode);
  const response = await request('/v1/speech-to-text', { method: 'POST', body: form });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new AppError(
      ERROR_CODES.ELEVENLABS_API_ERROR,
      'ElevenLabs returned an unreadable speech-to-text response.',
      502,
    );
  }
  if (
    !result || typeof result !== 'object' ||
    typeof (result as { text?: unknown }).text !== 'string' ||
    !Array.isArray((result as { words?: unknown }).words)
  ) {
    throw new AppError(
      ERROR_CODES.ELEVENLABS_API_ERROR,
      'ElevenLabs returned an invalid speech-to-text response.',
      502,
    );
  }

  const text = (result as { text: string }).text;
  const words = (result as { words: unknown[] }).words;
  const segments: TranscriptionSegment[] = [];
  for (const word of words) {
    if (
      !word || typeof word !== 'object' ||
      typeof (word as { text?: unknown }).text !== 'string' ||
      !['word', 'spacing', 'audio_event'].includes(String((word as { type?: unknown }).type))
    ) {
      throw new AppError(
        ERROR_CODES.ELEVENLABS_API_ERROR,
        'ElevenLabs returned an invalid word in its speech-to-text response.',
        502,
      );
    }

    const item = word as { text: string; type: string; start?: unknown; end?: unknown };
    if (item.type === 'spacing' || !item.text.trim()) continue;
    if (item.start == null && item.end == null) continue;
    if (
      typeof item.start !== 'number' || !Number.isFinite(item.start) || item.start < 0 ||
      typeof item.end !== 'number' || !Number.isFinite(item.end) || item.end < item.start
    ) {
      throw new AppError(
        ERROR_CODES.ELEVENLABS_API_ERROR,
        'ElevenLabs returned invalid word timestamps.',
        502,
      );
    }
    segments.push({ start: item.start, end: item.end, text: item.text });
  }

  if (text.trim() && segments.length === 0) {
    throw new AppError(
      ERROR_CODES.ELEVENLABS_API_ERROR,
      'ElevenLabs returned transcription text without word timestamps.',
      502,
    );
  }
  return { text, segments };
}
