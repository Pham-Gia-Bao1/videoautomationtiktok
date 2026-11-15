import './env';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat as statFile, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import {
  AppError,
  ERROR_CODES,
  buildPayload,
  generateSrt,
  generateVtt,
  parseScript,
  validatePayload,
} from '@podcast/core';
import type {
  AudioRecord,
  CharacterRecord,
  Composition,
  CompositionItem,
  Episode,
  EpisodeVideo,
  GenerationBatch,
  GenerationChunk,
  Project,
  Script,
  Subtitle,
  VoiceMapping,
  VideoClip,
} from '@podcast/types';
import { listVoices } from './elevenlabs';
import { ghostEditorStatus, isGhostStyle } from './ghost-editor';
import { ensureAudioDirectory, probeVideoClip, readStoredAudio, resolveAudioPath, resolveVideoPath, storeVideoClip, storeVideoCover } from './media';
import { mergeComposition, recoverInterruptedVideoRenders, retryFailedChunks, startGenerationBatch, startVideoRender, studioEvents, transcribe } from './jobs';
import { id, now, readData, updateData } from './store';

const port = Number(process.env.PORT ?? 3001);
const maxBodyBytes = 1_000_000;
const maxCoverBytes = 10 * 1024 * 1024;
const maxVideoClipBytes = 100 * 1024 * 1024;
const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000').split(','));
const jwtSecret = process.env.SUPABASE_JWT_SECRET;

if (process.env.NODE_ENV === 'production' && !jwtSecret) {
  throw new Error('SUPABASE_JWT_SECRET is required in production.');
}

interface Principal {
  userId: string;
}

function sendJson(response: ServerResponse, status: number, body: unknown, correlationId: string): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-correlation-id': correlationId,
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBodyBytes) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Request body exceeds the 1 MB limit.', 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Request body must be valid JSON.', 400);
  }
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, `Request body exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`, 413);
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'A file is required.', 400);
  return Buffer.concat(chunks, bytes);
}

function isSupportedImage(data: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/webp') return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function isSupportedVideo(data: Buffer, mimeType: string): boolean {
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    return data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp';
  }
  if (mimeType === 'video/webm') {
    return data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  return false;
}

function publicVideo(video: EpisodeVideo): Omit<EpisodeVideo, 'coverStoragePath' | 'storagePath'> {
  const { coverStoragePath: _coverStoragePath, storagePath: _storagePath, ...result } = video;
  return result;
}

function publicVideoClip(clip: VideoClip): Omit<VideoClip, 'storagePath'> {
  const { storagePath: _storagePath, ...result } = clip;
  return result;
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Request body must be a JSON object.', 400);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, `${field} is required and must be at most ${maxLength} characters.`, 400, { field });
  }
  return value.trim();
}

function optionalString(value: unknown, fallback: string, field: string, maxLength = 200): string {
  return value === undefined || value === null ? fallback : requiredString(value, field, maxLength);
}

function authenticate(request: IncomingMessage): Principal {
  if (!jwtSecret) return { userId: 'local' };
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'A valid Supabase access token is required.', 401);
  }

  let header: { alg?: string };
  let payload: { sub?: string; exp?: number };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'The access token is malformed.', 401);
  }
  if (header.alg !== 'HS256' || !payload.sub || (payload.exp && payload.exp <= Date.now() / 1000)) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'The access token is invalid or expired.', 401);
  }
  const expected = createHmac('sha256', jwtSecret).update(`${encodedHeader}.${encodedPayload}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'The access token signature is invalid.', 401);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'The access token signature is invalid.', 401);
  }
  return { userId: payload.sub };
}

function findProjectForEpisode(episodeId: string, data: Awaited<ReturnType<typeof readData>>): Project {
  const episode = data.episodes.find((item) => item.id === episodeId);
  const project = episode && data.projects.find((item) => item.id === episode.projectId);
  if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, 'Episode not found.', 404);
  return project;
}

function assertProjectOwner(project: Project, principal: Principal): void {
  if ((project.ownerId ?? (principal.userId === 'local' ? 'local' : '')) !== principal.userId) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'You do not have access to this project.', 403);
  }
}

function ownedEpisode(episodeId: string, principal: Principal, data: Awaited<ReturnType<typeof readData>>): Episode {
  const project = findProjectForEpisode(episodeId, data);
  assertProjectOwner(project, principal);
  return data.episodes.find((item) => item.id === episodeId)!;
}

function ownedScript(scriptId: string, principal: Principal, data: Awaited<ReturnType<typeof readData>>): Script {
  const script = data.scripts.find((item) => item.id === scriptId);
  if (!script) throw new AppError(ERROR_CODES.NOT_FOUND, 'Script not found.', 404);
  ownedEpisode(script.episodeId, principal, data);
  return script;
}

function ownedBatch(batchId: string, principal: Principal, data: Awaited<ReturnType<typeof readData>>): GenerationBatch {
  const batch = data.batches.find((item) => item.id === batchId);
  if (!batch) throw new AppError(ERROR_CODES.NOT_FOUND, 'Generation batch not found.', 404);
  ownedEpisode(batch.episodeId, principal, data);
  return batch;
}

function ownedAudio(audioId: string, principal: Principal, data: Awaited<ReturnType<typeof readData>>): AudioRecord {
  const audio = data.audios.find((item) => item.id === audioId && !item.deletedAt);
  if (!audio) throw new AppError(ERROR_CODES.NOT_FOUND, 'Audio not found.', 404);
  ownedEpisode(audio.episodeId, principal, data);
  return audio;
}

function ownedComposition(compositionId: string, principal: Principal, data: Awaited<ReturnType<typeof readData>>): Composition {
  const composition = data.compositions.find((item) => item.id === compositionId);
  if (!composition) throw new AppError(ERROR_CODES.NOT_FOUND, 'Composition not found.', 404);
  ownedEpisode(composition.episodeId, principal, data);
  return composition;
}

function applyCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    response.setHeader('access-control-allow-headers', 'authorization, content-type');
    response.setHeader('access-control-max-age', '600');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(origin && !allowedOrigins.has(origin) ? 403 : 204);
    response.end();
    return true;
  }
  return false;
}

function sendSseSnapshot(request: IncomingMessage, response: ServerResponse, batch: GenerationBatch, chunks: GenerationChunk[]) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(`data: ${JSON.stringify({ type: 'snapshot', batchId: batch.id, batchStatus: batch.status, chunks })}\n\n`);
  const listener = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
  studioEvents.on(batch.id, listener);
  request.on('close', () => {
    clearInterval(heartbeat);
    studioEvents.off(batch.id, listener);
  });
}

async function route(request: IncomingMessage, response: ServerResponse, principal: Principal, correlationId: string): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method ?? 'GET';
  const data = await readData();

  if (method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { status: 'ok', service: 'podcast-api' }, correlationId);
    return;
  }
  if (method === 'GET' && url.pathname === '/api/voices') {
    sendJson(response, 200, { voices: await listVoices() }, correlationId);
    return;
  }
  if (method === 'GET' && url.pathname === '/api/ghost-editor/status') {
    sendJson(response, 200, await ghostEditorStatus(), correlationId);
    return;
  }
  if (parts[0] !== 'api') throw new AppError(ERROR_CODES.NOT_FOUND, 'Route not found.', 404);

  if (parts[1] === 'projects') {
    if (parts.length === 2 && method === 'GET') {
      sendJson(response, 200, { projects: data.projects.filter((project) => (project.ownerId ?? 'local') === principal.userId) }, correlationId);
      return;
    }
    if (parts.length === 2 && method === 'POST') {
      const body = objectBody(await readJson(request));
      const project: Project = {
        id: id(), ownerId: principal.userId, name: requiredString(body.name, 'name'),
        description: typeof body.description === 'string' ? body.description.slice(0, 2000) : null,
        createdAt: now(), updatedAt: now(),
      };
      await updateData((current) => current.projects.push(project));
      sendJson(response, 201, { project }, correlationId);
      return;
    }
    if (parts.length === 4 && parts[3] === 'episodes' && method === 'GET') {
      const project = data.projects.find((item) => item.id === parts[2]);
      if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, 'Project not found.', 404);
      assertProjectOwner(project, principal);
      sendJson(response, 200, { episodes: data.episodes.filter((episode) => episode.projectId === project.id) }, correlationId);
      return;
    }
    if (parts.length === 4 && parts[3] === 'episodes' && method === 'POST') {
      const project = data.projects.find((item) => item.id === parts[2]);
      if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, 'Project not found.', 404);
      assertProjectOwner(project, principal);
      const body = objectBody(await readJson(request));
      const episode: Episode = {
        id: id(), projectId: project.id, title: requiredString(body.title, 'title'),
        languageCode: optionalString(body.languageCode, 'en', 'languageCode', 16),
        defaultModelId: optionalString(body.modelId, 'eleven_v3', 'modelId', 80),
        status: 'draft', createdAt: now(), updatedAt: now(),
      };
      await updateData((current) => current.episodes.push(episode));
      sendJson(response, 201, { episode }, correlationId);
      return;
    }
  }

  if (parts[1] === 'episodes' && parts.length === 4 && parts[3] === 'video-clips' && method === 'POST') {
    const episode = ownedEpisode(parts[2], principal, data);
    const mimeType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() ?? '';
    const body = await readBinaryBody(request, maxVideoClipBytes);
    if (!isSupportedVideo(body, mimeType)) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Video clip must be a valid MP4, QuickTime, or WebM file.', 415);
    }
    const clipId = id();
    const storagePath = await storeVideoClip(clipId, mimeType, body);
    let mediaInfo: Awaited<ReturnType<typeof probeVideoClip>>;
    try {
      mediaInfo = await probeVideoClip(await resolveVideoPath(storagePath));
    } catch (error) {
      await unlink(await resolveVideoPath(storagePath));
      throw error;
    }
    const clip: VideoClip = {
      id: clipId,
      episodeId: episode.id,
      title: optionalString(url.searchParams.get('title'), `Video clip ${data.videoClips.filter((item) => item.episodeId === episode.id).length + 1}`, 'title', 120),
      storagePath,
      mimeType,
      sizeBytes: body.length,
      durationSeconds: mediaInfo.durationSeconds,
      createdAt: now(),
    };
    await updateData((current) => current.videoClips.push(clip));
    sendJson(response, 201, { clip: publicVideoClip(clip) }, correlationId);
    return;
  }

  if (parts[1] === 'episodes' && parts.length === 3) {
    const episode = ownedEpisode(parts[2], principal, data);
    if (method === 'GET') {
      const scripts = data.scripts.filter((script) => script.episodeId === episode.id);
      const latestScript = scripts.sort((a, b) => b.version - a.version)[0] ?? null;
      const parsed = latestScript ? parseScript(latestScript.rawText) : null;
      sendJson(response, 200, {
        episode,
        project: data.projects.find((item) => item.id === episode.projectId),
        scripts,
        script: latestScript,
        parsed,
        characters: data.characters.filter((item) => item.episodeId === episode.id),
        voiceMappings: data.voiceMappings.filter((mapping) => data.characters.some((character) => character.id === mapping.characterId && character.episodeId === episode.id)),
        batches: data.batches.filter((batch) => batch.episodeId === episode.id),
        audios: data.audios.filter((audio) => audio.episodeId === episode.id && !audio.deletedAt),
        compositions: data.compositions.filter((composition) => composition.episodeId === episode.id),
        transcriptions: data.transcriptions.filter((transcription) => data.audios.some((audio) => audio.id === transcription.audioId && audio.episodeId === episode.id)),
        subtitles: data.subtitles.filter((subtitle) => data.transcriptions.some((transcription) => transcription.id === subtitle.transcriptionId && data.audios.some((audio) => audio.id === transcription.audioId && audio.episodeId === episode.id))),
        videos: data.videos.filter((video) => video.episodeId === episode.id).map(publicVideo),
        videoClips: data.videoClips.filter((clip) => clip.episodeId === episode.id).map(publicVideoClip),
      }, correlationId);
      return;
    }
    if (method === 'PATCH') {
      const body = objectBody(await readJson(request));
      const updated = await updateData((current) => {
        const record = current.episodes.find((item) => item.id === episode.id)!;
        if (typeof body.title === 'string') record.title = requiredString(body.title, 'title');
        if (typeof body.languageCode === 'string') record.languageCode = requiredString(body.languageCode, 'languageCode', 16);
        if (typeof body.modelId === 'string') record.defaultModelId = requiredString(body.modelId, 'modelId', 80);
        record.updatedAt = now();
        return record;
      });
      sendJson(response, 200, { episode: updated }, correlationId);
      return;
    }
  }

  if (parts[1] === 'episodes' && parts[3] === 'scripts' && parts.length === 4 && method === 'POST') {
    const episode = ownedEpisode(parts[2], principal, data);
    const body = objectBody(await readJson(request));
    const rawText = requiredString(body.rawText ?? body.text, 'rawText', 500_000);
    const version = Math.max(0, ...data.scripts.filter((script) => script.episodeId === episode.id).map((script) => script.version)) + 1;
    const script: Script = {
      id: id(), episodeId: episode.id, rawText, source: body.source === 'chatgpt' || body.source === 'import' ? body.source : 'manual',
      version, createdAt: now(),
    };
    const parsed = parseScript(rawText, { mergeAdjacent: body.mergeAdjacent === true });
    const characters: CharacterRecord[] = parsed.characters.map((character) => {
      const existing = data.characters.find((item) => item.episodeId === episode.id && item.key === character.key);
      return existing ?? { ...character, id: id(), episodeId: episode.id, createdAt: now() };
    });
    await updateData((current) => {
      current.scripts.push(script);
      const existingKeys = new Set(current.characters.filter((item) => item.episodeId === episode.id).map((item) => item.key));
      current.characters.push(...characters.filter((character) => !existingKeys.has(character.key)));
    });
    sendJson(response, 201, { script, ...parsed }, correlationId);
    return;
  }

  if (parts[1] === 'scripts' && parts.length === 4) {
    const script = ownedScript(parts[2], principal, data);
    if (method === 'POST' && parts[3] === 'parse') {
      let body: Record<string, unknown> = {};
      if (Number(request.headers['content-length'] ?? 0) > 0) body = objectBody(await readJson(request));
      const parsed = parseScript(script.rawText, { mergeAdjacent: body.mergeAdjacent === true });
      sendJson(response, 200, { scriptId: script.id, ...parsed }, correlationId);
      return;
    }
    if (method === 'POST' && parts[3] === 'build-payload') {
      const body = objectBody(await readJson(request));
      const parsed = parseScript(script.rawText, { mergeAdjacent: body.mergeAdjacent === true });
      const suppliedMappings = body.voiceMappings && typeof body.voiceMappings === 'object'
        ? body.voiceMappings as Record<string, string> : {};
      const mappings = Object.fromEntries(data.voiceMappings
        .filter((mapping) => data.characters.some((character) => character.id === mapping.characterId && character.episodeId === script.episodeId))
        .map((mapping) => [data.characters.find((character) => character.id === mapping.characterId)!.key, mapping.voiceId]));
      const built = buildPayload({
        lines: parsed.lines,
        voiceMappings: { ...mappings, ...suppliedMappings },
        modelId: optionalString(body.modelId, data.episodes.find((item) => item.id === script.episodeId)?.defaultModelId ?? 'eleven_v3', 'modelId', 80),
        languageCode: optionalString(body.languageCode, data.episodes.find((item) => item.id === script.episodeId)?.languageCode ?? 'en', 'languageCode', 16),
        settings: body.settings && typeof body.settings === 'object' ? body.settings as Record<string, unknown> : undefined,
        seed: typeof body.seed === 'number' ? body.seed : null,
        applyTextNormalization: body.applyTextNormalization === 'on' || body.applyTextNormalization === 'off' ? body.applyTextNormalization : 'auto',
        outputFormat: typeof body.outputFormat === 'string' ? body.outputFormat : undefined,
      });
      sendJson(response, 200, { scriptId: script.id, ...built }, correlationId);
      return;
    }
    if (method === 'POST' && parts[3] === 'validate-payload') {
      const body = objectBody(await readJson(request));
      const result = validatePayload(body.payload as never, Array.isArray(body.chunked) ? body.chunked as never : undefined);
      sendJson(response, 200, result, correlationId);
      return;
    }
  }

  if (parts[1] === 'episodes' && parts.length === 4 && parts[3] === 'voice-mappings' && method === 'PUT') {
    const episode = ownedEpisode(parts[2], principal, data);
    const body = objectBody(await readJson(request));
    if (!Array.isArray(body.mappings)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'mappings must be an array.', 400);
    const available = new Map(data.characters.filter((character) => character.episodeId === episode.id).map((character) => [character.key, character]));
    const mappings: VoiceMapping[] = body.mappings.map((entry) => {
      const mapping = objectBody(entry);
      const character = available.get(requiredString(mapping.characterKey, 'characterKey', 64));
      if (!character) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Unknown character key.', 400);
      return {
        id: id(), characterId: character.id, voiceId: requiredString(mapping.voiceId, 'voiceId', 128),
        voiceName: typeof mapping.voiceName === 'string' ? mapping.voiceName.slice(0, 100) : null,
        settings: mapping.settings && typeof mapping.settings === 'object' ? mapping.settings as Record<string, unknown> : null,
        createdAt: now(),
      };
    });
    await updateData((current) => {
      current.voiceMappings = current.voiceMappings.filter((mapping) => !available.has(current.characters.find((character) => character.id === mapping.characterId)?.key ?? ''));
      current.voiceMappings.push(...mappings);
    });
    sendJson(response, 200, { voiceMappings: mappings }, correlationId);
    return;
  }

  if (parts[1] === 'generation-batches') {
    if (parts.length === 2 && method === 'POST') {
      const body = objectBody(await readJson(request));
      const episode = ownedEpisode(requiredString(body.episodeId, 'episodeId'), principal, data);
      const script = ownedScript(requiredString(body.scriptId, 'scriptId'), principal, data);
      if (script.episodeId !== episode.id) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Script does not belong to this episode.', 400);
      const parsed = parseScript(script.rawText);
      const savedMappings = Object.fromEntries(data.voiceMappings
        .filter((mapping) => data.characters.some((character) => character.id === mapping.characterId && character.episodeId === episode.id))
        .map((mapping) => [data.characters.find((character) => character.id === mapping.characterId)!.key, mapping.voiceId]));
      const voiceMappings = body.voiceMappings && typeof body.voiceMappings === 'object'
        ? { ...savedMappings, ...body.voiceMappings as Record<string, string> } : savedMappings;
      const built = buildPayload({
        lines: parsed.lines,
        voiceMappings,
        modelId: optionalString(body.modelId, episode.defaultModelId, 'modelId', 80),
        languageCode: optionalString(body.languageCode, episode.languageCode, 'languageCode', 16),
        settings: body.settings && typeof body.settings === 'object' ? body.settings as Record<string, unknown> : undefined,
        applyTextNormalization: body.applyTextNormalization === 'on' || body.applyTextNormalization === 'off' ? body.applyTextNormalization : 'auto',
        seed: typeof body.seed === 'number' && Number.isInteger(body.seed) ? body.seed : null,
        outputFormat: typeof body.outputFormat === 'string' ? body.outputFormat : undefined,
      });
      if (built.chunked.length === 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Script has no parseable dialogue.', 400);
      const batchId = id();
      const batch: GenerationBatch = {
        id: batchId, episodeId: episode.id, scriptId: script.id, label: optionalString(body.label, `Generation ${data.batches.filter((item) => item.episodeId === episode.id).length + 1}`, 'label'),
        modelId: built.payload.model_id, languageCode: built.payload.language_code ?? episode.languageCode,
        settings: built.payload.settings ?? null, status: 'DRAFT', totalChunks: built.chunked.length, completedChunks: 0, failedChunks: 0,
        voiceMappings, applyTextNormalization: built.payload.apply_text_normalization ?? 'auto',
        seed: built.payload.seed ?? null, createdAt: now(), startedAt: null, completedAt: null,
      };
      const chunks: GenerationChunk[] = built.chunked.map((chunk) => ({
        id: id(), batchId, chunkIndex: chunk.chunkIndex, startLine: chunk.startLine, endLine: chunk.endLine,
        characterCount: chunk.characterCount, inputCount: chunk.inputCount, payload: chunk.payload,
        payloadHash: chunk.payloadHash, status: 'PENDING', audioId: null, errorCode: null, errorMessage: null,
        retryCount: 0, createdAt: now(), completedAt: null,
      }));
      await updateData((current) => { current.batches.push(batch); current.chunks.push(...chunks); });
      sendJson(response, 201, { batch, chunks, warnings: built.warnings }, correlationId);
      return;
    }

    const batch = ownedBatch(parts[2] ?? '', principal, data);
    if (parts.length === 3 && method === 'GET') {
      sendJson(response, 200, { batch, chunks: data.chunks.filter((chunk) => chunk.batchId === batch.id) }, correlationId);
      return;
    }
    if (parts.length === 4 && parts[3] === 'events' && method === 'GET') {
      sendSseSnapshot(request, response, batch, data.chunks.filter((chunk) => chunk.batchId === batch.id));
      return;
    }
    if (parts.length === 4 && parts[3] === 'start' && method === 'POST') {
      if (!['DRAFT', 'FAILED', 'PARTIAL'].includes(batch.status)) throw new AppError(ERROR_CODES.CONFLICT, `Cannot start a batch in ${batch.status} status.`, 409);
      await updateData((current) => {
        const record = current.batches.find((item) => item.id === batch.id)!;
        record.status = 'QUEUED';
        record.startedAt ??= now();
        record.completedAt = null;
        for (const chunk of current.chunks.filter((item) => item.batchId === batch.id && item.status === 'PENDING')) chunk.status = 'QUEUED';
      });
      startGenerationBatch(batch.id);
      sendJson(response, 202, { status: 'QUEUED', batchId: batch.id }, correlationId);
      return;
    }
    if (parts.length === 4 && parts[3] === 'retry' && method === 'POST') {
      const chunkIds = await retryFailedChunks(batch.id);
      sendJson(response, 202, { chunkIds }, correlationId);
      return;
    }
  }

  if (parts[1] === 'audio') {
    if (parts.length === 2 && method === 'GET') {
      const episodeId = requiredString(url.searchParams.get('episodeId'), 'episodeId');
      ownedEpisode(episodeId, principal, data);
      const kind = url.searchParams.get('kind');
      sendJson(response, 200, { audios: data.audios.filter((audio) => audio.episodeId === episodeId && !audio.deletedAt && (!kind || audio.kind === kind)) }, correlationId);
      return;
    }
    const audio = ownedAudio(parts[2] ?? '', principal, data);
    if (parts.length === 4 && ['download', 'stream'].includes(parts[3]) && method === 'GET') {
      const filePath = await resolveAudioPath(audio.storagePath);
      try {
        const fileInfo = await statFile(filePath);
        if (!fileInfo.isFile() || fileInfo.size === 0) throw new Error('Stored audio file is missing or empty.');
      } catch (error) {
        throw new AppError(
          ERROR_CODES.STORAGE_FAILED,
          'The stored audio file is unavailable.',
          500,
          { cause: error instanceof Error ? error.message : 'Unknown file error.' },
        );
      }
      const disposition = parts[3] === 'stream' ? 'inline' : 'attachment';
      const audioStream = createReadStream(filePath);
      response.writeHead(200, {
        'content-type': audio.mimeType,
        'content-length': String(audio.sizeBytes),
        'content-disposition': `${disposition}; filename="${basename(audio.label).replace(/[^\x20-\x7E"\\]/g, '_').replace(/["\\]/g, '_')}.mp3"`,
        'x-correlation-id': correlationId,
        'cache-control': 'private, no-store',
      });
      audioStream.on('error', (error) => {
        console.error(`[${correlationId}] Could not stream audio: ${error.message}`);
        if (!response.headersSent) {
          sendJson(response, 500, {
            error: { code: ERROR_CODES.STORAGE_FAILED, message: 'Could not read the audio file.', correlationId },
          }, correlationId);
        } else {
          response.destroy(error);
        }
      });
      audioStream.pipe(response);
      return;
    }
    if (parts.length === 4 && parts[3] === 'transcribe' && method === 'POST') {
      if (audio.kind !== 'final') throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Only final audio can be transcribed.', 422);
      const transcriptionId = await transcribe(audio.id);
      const record = (await readData()).transcriptions.find((item) => item.id === transcriptionId);
      sendJson(response, 201, { transcription: record }, correlationId);
      return;
    }
    if (parts.length === 4 && parts[3] === 'video' && method === 'POST') {
      if (audio.kind !== 'final') throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Create a final composition before exporting a video.', 422);
      const mimeType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() ?? '';
      const videoId = id();
      let video: EpisodeVideo;
      if (mimeType === 'application/json') {
        const body = objectBody(await readJson(request));
        const mode = body.mode;
        const title = optionalString(body.title, 'Episode video', 'title', 120);
        const aspectRatio = body.aspectRatio === undefined ? '16:9' : String(body.aspectRatio);
        const resolution = body.resolution === undefined ? 720 : body.resolution;
        if (!['16:9', '9:16', '1:1'].includes(String(aspectRatio))) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'aspectRatio must be 16:9, 9:16, or 1:1.', 422);
        }
        if (resolution !== 720 && resolution !== 1080) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'resolution must be 720 or 1080.', 422);
        }
        const subtitleId = typeof body.subtitleId === 'string' && body.subtitleId.trim() ? body.subtitleId.trim() : null;
        if (subtitleId) {
          const subtitle = data.subtitles.find((item) => item.id === subtitleId && ['srt', 'vtt'].includes(item.format));
          const transcription = subtitle && data.transcriptions.find((item) => item.id === subtitle.transcriptionId);
          if (!subtitle || !transcription || transcription.audioId !== audio.id) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Select an SRT or VTT subtitle generated from this final audio.', 422);
          }
        }
        if (mode === 'elevenlabs') {
          const prompt = requiredString(body.prompt, 'prompt', 1000);
          video = {
            id: videoId,
            episodeId: audio.episodeId,
            audioId: audio.id,
            title,
            aspectRatio: aspectRatio as '16:9' | '9:16' | '1:1',
            resolution,
            status: 'PROCESSING',
            sourceMode: 'elevenlabs',
            prompt,
            modelId: 'bytedance-seedance-v2-fast',
            generationId: null,
            clipIds: [],
            subtitleId,
            coverStoragePath: null,
            storagePath: null,
            mimeType: 'video/mp4',
            sizeBytes: 0,
            errorMessage: null,
            createdAt: now(),
            completedAt: null,
          };
        } else if (mode === 'uploaded' || mode === 'ghost') {
          if (!Array.isArray(body.clipIds)) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Choose between 1 and 10 unique uploaded video clips.', 422);
          }
          const clipIds = body.clipIds.filter((clipId): clipId is string => typeof clipId === 'string');
          if (clipIds.length < 1 || clipIds.length > 10 || clipIds.length !== body.clipIds.length ||
            new Set(clipIds).size !== clipIds.length) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Choose between 1 and 10 unique uploaded video clips.', 422);
          }
          const clips = clipIds.map((clipId) => data.videoClips.find((clip) =>
            clip.id === clipId && clip.episodeId === audio.episodeId));
          if (clips.some((clip) => !clip)) {
            throw new AppError(ERROR_CODES.NOT_FOUND, 'One or more selected video clips were not found in this episode.', 404);
          }
          const ghostStyle = mode === 'ghost' ? body.ghostStyle : undefined;
          if (mode === 'ghost' && !isGhostStyle(ghostStyle)) {
            throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Choose a supported Ghost Editor style.', 422);
          }
          video = {
            id: videoId,
            episodeId: audio.episodeId,
            audioId: audio.id,
            title,
            aspectRatio: aspectRatio as '16:9' | '9:16' | '1:1',
            resolution,
            status: 'PROCESSING',
            sourceMode: mode as 'uploaded' | 'ghost',
            ghostStyle: mode === 'ghost' ? ghostStyle as string : null,
            transcriptionId: null,
            prompt: null,
            modelId: null,
            generationId: null,
            clipIds,
            subtitleId,
            coverStoragePath: null,
            storagePath: null,
            mimeType: 'video/mp4',
            sizeBytes: 0,
            errorMessage: null,
            createdAt: now(),
            completedAt: null,
          };
        } else {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Video mode must be "elevenlabs" or "uploaded".', 422);
        }
      } else {
        const body = await readBinaryBody(request, maxCoverBytes);
        if (!isSupportedImage(body, mimeType)) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Cover must be a valid PNG, JPEG, or WebP image.', 415);
        }
        const title = requiredString(url.searchParams.get('title') ?? 'Episode video', 'title', 120);
        const aspectRatio = url.searchParams.get('aspectRatio') ?? '16:9';
        const resolution = Number(url.searchParams.get('resolution') ?? 720);
        if (!['16:9', '9:16', '1:1'].includes(aspectRatio) || (resolution !== 720 && resolution !== 1080)) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Invalid video aspect ratio or resolution.', 422);
        }
        const coverStoragePath = await storeVideoCover(videoId, mimeType, body);
        video = {
          id: videoId,
          episodeId: audio.episodeId,
          audioId: audio.id,
          title,
          aspectRatio: aspectRatio as '16:9' | '9:16' | '1:1',
          resolution: resolution as 720 | 1080,
          status: 'PROCESSING',
          sourceMode: 'cover',
          coverStoragePath,
          storagePath: null,
          mimeType: 'video/mp4',
          sizeBytes: 0,
          errorMessage: null,
          createdAt: now(),
          completedAt: null,
        };
      }
      await updateData((current) => current.videos.push(video));
      startVideoRender(videoId);
      sendJson(response, 202, { video: publicVideo(video) }, correlationId);
      return;
    }
    if (parts.length === 3 && method === 'DELETE') {
      await updateData((current) => {
        const record = current.audios.find((item) => item.id === audio.id)!;
        record.deletedAt = now();
      });
      sendJson(response, 200, { deleted: true }, correlationId);
      return;
    }
  }

  if (parts[1] === 'videos' && parts.length === 3 && (method === 'GET')) {
    const video = data.videos.find((item) => item.id === parts[2]);
    if (!video) throw new AppError(ERROR_CODES.NOT_FOUND, 'Video not found.', 404);
    ownedEpisode(video.episodeId, principal, data);
    sendJson(response, 200, { video: publicVideo(video) }, correlationId);
    return;
  }

  if (parts[1] === 'videos' && parts.length === 4 && parts[3] === 'download' && method === 'GET') {
    const video = data.videos.find((item) => item.id === parts[2]);
    if (!video) throw new AppError(ERROR_CODES.NOT_FOUND, 'Video not found.', 404);
    ownedEpisode(video.episodeId, principal, data);
    if (video.status !== 'READY' || !video.storagePath) {
      throw new AppError(ERROR_CODES.CONFLICT, 'The video is not ready to download.', 409);
    }
    let filePath: string;
    try {
      filePath = await resolveVideoPath(video.storagePath);
      const fileInfo = await statFile(filePath);
      if (!fileInfo.isFile() || fileInfo.size === 0) throw new Error('Video file is missing or empty.');
    } catch (error) {
      throw new AppError(ERROR_CODES.STORAGE_FAILED, 'The generated video file is unavailable.', 500, {
        cause: error instanceof Error ? error.message : 'Unknown file error.',
      });
    }
    const filename = `${basename(video.title).replace(/[^\x20-\x7E"\\]/g, '_').replace(/["\\]/g, '_')}.mp4`;
    response.writeHead(200, {
      'content-type': video.mimeType,
      'content-length': String(video.sizeBytes),
      'content-disposition': `attachment; filename="${filename}"`,
      'x-correlation-id': correlationId,
      'cache-control': 'private, no-store',
    });
    const videoStream = createReadStream(filePath);
    videoStream.on('error', (error) => {
      console.error(`[${correlationId}] Could not stream video: ${error.message}`);
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: { code: ERROR_CODES.STORAGE_FAILED, message: 'Could not read the video file.', correlationId },
        }, correlationId);
      } else {
        response.destroy(error);
      }
    });
    videoStream.pipe(response);
    return;
  }

  if (parts[1] === 'compositions') {
    if (parts.length === 2 && method === 'POST') {
      const body = objectBody(await readJson(request));
      const episode = ownedEpisode(requiredString(body.episodeId, 'episodeId'), principal, data);
      const composition: Composition = {
        id: id(), episodeId: episode.id, name: requiredString(body.name, 'name'), status: 'DRAFT',
        outputAudioId: null, errorMessage: null, createdAt: now(), updatedAt: now(),
      };
      await updateData((current) => current.compositions.push(composition));
      sendJson(response, 201, { composition, items: [] }, correlationId);
      return;
    }
    const composition = ownedComposition(parts[2] ?? '', principal, data);
    if (parts.length === 3 && method === 'GET') {
      const items = data.compositionItems.filter((item) => item.compositionId === composition.id).sort((a, b) => a.orderIndex - b.orderIndex);
      sendJson(response, 200, { composition, items }, correlationId);
      return;
    }
    if (parts.length === 4 && parts[3] === 'items' && method === 'PATCH') {
      const body = objectBody(await readJson(request));
      if (!Array.isArray(body.items)) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'items must be an array.', 400);
      const items: CompositionItem[] = body.items.map((entry, index) => {
        const item = objectBody(entry);
        const audio = ownedAudio(requiredString(item.audioId, 'audioId'), principal, data);
        if (audio.episodeId !== composition.episodeId || audio.kind !== 'chunk') {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Composition items must be chunk audio from the same episode.', 422);
        }
        const orderIndex = typeof item.orderIndex === 'number' && Number.isInteger(item.orderIndex) ? item.orderIndex : index;
        const gapMs = typeof item.gapMs === 'number' ? item.gapMs : 0;
        if (gapMs < 0 || gapMs > 10_000) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'gapMs must be between 0 and 10000.', 400);
        const trimStartMs = typeof item.trimStartMs === 'number' ? item.trimStartMs : null;
        const trimEndMs = typeof item.trimEndMs === 'number' ? item.trimEndMs : null;
        if (trimStartMs !== null && trimStartMs < 0 || trimEndMs !== null && trimEndMs <= (trimStartMs ?? 0)) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Audio trim bounds are invalid.', 400);
        }
        return { id: id(), compositionId: composition.id, audioId: audio.id, orderIndex, gapMs, trimStartMs, trimEndMs };
      });
      await updateData((current) => {
        current.compositionItems = current.compositionItems.filter((item) => item.compositionId !== composition.id);
        current.compositionItems.push(...items);
        const record = current.compositions.find((item) => item.id === composition.id)!;
        record.status = 'DRAFT';
        record.outputAudioId = null;
        record.updatedAt = now();
      });
      sendJson(response, 200, { items }, correlationId);
      return;
    }
    if (parts.length === 4 && parts[3] === 'merge' && method === 'POST') {
      void mergeComposition(composition.id).catch((error: unknown) => console.error(`[${correlationId}] composition merge failed`, error));
      sendJson(response, 202, { status: 'MERGING', compositionId: composition.id }, correlationId);
      return;
    }
  }

  if (parts[1] === 'transcriptions' && parts.length === 4 && parts[3] === 'generate-srt' && method === 'POST') {
    const transcription = data.transcriptions.find((item) => item.id === parts[2]);
    if (!transcription) throw new AppError(ERROR_CODES.NOT_FOUND, 'Transcription not found.', 404);
    ownedAudio(transcription.audioId, principal, data);
    if (transcription.status !== 'COMPLETED') throw new AppError(ERROR_CODES.CONFLICT, 'Transcription must be completed before generating subtitles.', 409);
    let body: Record<string, unknown> = {};
    if (Number(request.headers['content-length'] ?? 0) > 0) body = objectBody(await readJson(request));
    const format = body.format === 'vtt' ? 'vtt' : 'srt';
    const content = typeof body.content === 'string'
      ? body.content
      : format === 'srt'
        ? generateSrt(transcription.segments)
        : generateVtt(transcription.segments);
    const subtitle: Subtitle = {
      id: id(), transcriptionId: transcription.id, format,
      storagePath: `subtitles/${transcription.id}.${format}`, content, createdAt: now(),
    };
    await updateData((current) => {
      current.subtitles = current.subtitles.filter((item) => item.transcriptionId !== transcription.id || item.format !== format);
      current.subtitles.push(subtitle);
    });
    sendJson(response, 201, { subtitle }, correlationId);
    return;
  }

  if (parts[1] === 'subtitles' && parts.length === 4 && parts[3] === 'download' && method === 'GET') {
    const subtitle = data.subtitles.find((item) => item.id === parts[2]);
    if (!subtitle) throw new AppError(ERROR_CODES.NOT_FOUND, 'Subtitle not found.', 404);
    const transcription = data.transcriptions.find((item) => item.id === subtitle.transcriptionId);
    if (!transcription) throw new AppError(ERROR_CODES.NOT_FOUND, 'Transcription not found.', 404);
    ownedAudio(transcription.audioId, principal, data);
    response.writeHead(200, {
      'content-type': subtitle.format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8',
      'content-disposition': `attachment; filename="transcript.${subtitle.format}"`,
      'x-correlation-id': correlationId,
    });
    response.end(subtitle.content);
    return;
  }

  throw new AppError(ERROR_CODES.NOT_FOUND, 'Route not found.', 404);
}

const server = createServer((request, response) => {
  const correlationId = randomUUID();
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  if (applyCors(request, response)) return;
  void (async () => {
    try {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw new AppError(ERROR_CODES.FORBIDDEN, 'Origin is not allowed.', 403);
      const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
      if (path === '/api/health') {
        await route(request, response, { userId: 'local' }, correlationId);
        return;
      }
      const principal = authenticate(request);
      await route(request, response, principal, correlationId);
    } catch (error) {
      const appError = error instanceof AppError
        ? error
        : new AppError(ERROR_CODES.INTERNAL, 'An unexpected server error occurred.', 500);
      if (appError.status >= 500) {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`[${correlationId}] ${appError.code}: ${detail}`);
      }
      if (!response.headersSent) {
        sendJson(response, appError.status, {
          error: { code: appError.code, message: appError.message, correlationId, details: appError.meta },
        }, correlationId);
      } else {
        response.end();
      }
    }
  })();
});

ensureAudioDirectory().then(recoverInterruptedVideoRenders).then(() => {
  server.listen(port, '127.0.0.1', () => {
    console.log(`Podcast API listening on http://127.0.0.1:${port}`);
  });
}).catch((error: unknown) => {
  console.error('Could not initialize local audio storage:', error);
  process.exitCode = 1;
});
