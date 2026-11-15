import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ALLOWED_OUTPUT_FORMATS, AppError, ERROR_CODES } from '@podcast/core';
import type { CompositionItem } from '@podcast/types';
import { resolveProjectPath } from './paths';

const execFileAsync = promisify(execFile);
const dataRoot = process.env.DATA_DIR
  ? resolveProjectPath(process.env.DATA_DIR)
  : resolve(__dirname, '..', 'data');
const audioRoot = process.env.AUDIO_DIR
  ? resolveProjectPath(process.env.AUDIO_DIR)
  : join(dataRoot, 'audio');
const videoRoot = join(dataRoot, 'videos');

function safeStoredPath(relativePath: string): string {
  const path = resolve(audioRoot, relativePath);
  if (path !== audioRoot && !path.startsWith(`${audioRoot}\\`) && !path.startsWith(`${audioRoot}/`)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Invalid audio storage path.', 403);
  }
  return path;
}

export async function storeAudio(audioId: string, data: Buffer, format = 'mp3'): Promise<string> {
  const relativePath = `${audioId}.${format}`;
  const target = safeStoredPath(relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return relativePath;
}

export async function resolveAudioPath(relativePath: string): Promise<string> {
  return safeStoredPath(relativePath);
}

function safeVideoPath(relativePath: string): string {
  const path = resolve(videoRoot, relativePath);
  if (path !== videoRoot && !path.startsWith(`${videoRoot}\\`) && !path.startsWith(`${videoRoot}/`)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Invalid video storage path.', 403);
  }
  return path;
}

export async function storeVideoCover(videoId: string, mimeType: string, data: Buffer): Promise<string> {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const relativePath = `${videoId}-cover.${extension}`;
  const target = safeVideoPath(relativePath);
  await mkdir(videoRoot, { recursive: true });
  await writeFile(target, data, { flag: 'wx' });
  return relativePath;
}

function videoExtension(mimeType: string): string {
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'video/quicktime') return 'mov';
  if (mimeType === 'video/webm') return 'webm';
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Only MP4, QuickTime, or WebM videos are supported.', 415);
}

export async function storeVideoClip(clipId: string, mimeType: string, data: Buffer): Promise<string> {
  const relativePath = `${clipId}.${videoExtension(mimeType)}`;
  const target = safeVideoPath(relativePath);
  await mkdir(videoRoot, { recursive: true });
  await writeFile(target, data, { flag: 'wx' });
  return relativePath;
}

export async function storeGeneratedVideo(videoId: string, mimeType: string, data: Buffer): Promise<string> {
  const extension = mimeType === 'video/mp4' ? 'mp4' : 'bin';
  const relativePath = `${videoId}-generated.${extension}`;
  const target = safeVideoPath(relativePath);
  await mkdir(videoRoot, { recursive: true });
  await writeFile(target, data, { flag: 'wx' });
  return relativePath;
}

export async function storeRenderedVideoFile(videoId: string, sourcePath: string): Promise<{ storagePath: string; sizeBytes: number }> {
  const info = await stat(sourcePath);
  if (!info.isFile() || info.size === 0) {
    throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'The video renderer produced an empty MP4 file.', 500);
  }
  const storagePath = `${videoId}.mp4`;
  const target = safeVideoPath(storagePath);
  await mkdir(videoRoot, { recursive: true });
  await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
  return { storagePath, sizeBytes: info.size };
}

export async function resolveVideoPath(relativePath: string): Promise<string> {
  return safeVideoPath(relativePath);
}

export async function probeVideoClip(filePath: string): Promise<{ durationSeconds: number; width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync(process.env.FFPROBE_PATH ?? 'ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,width,height',
      '-of', 'json',
      filePath,
    ], { timeout: 15_000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    };
    const stream = result.streams?.find((item) => item.codec_type === 'video');
    const durationSeconds = Number(result.format?.duration);
    const width = stream?.width ?? 0;
    const height = stream?.height ?? 0;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 900 ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 12_000 || height > 12_000 || width * height > 40_000_000) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Video must be at most 15 minutes, 12,000 px per side, and 40 megapixels.', 422);
    }
    return { durationSeconds, width, height };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Video file could not be decoded.', 415, {
      cause: error instanceof Error ? error.message.slice(0, 500) : 'Unknown video decoding error.',
    });
  }
}

export async function renderVideoWithClips(
  audioStoragePath: string,
  clipStoragePaths: string[],
  subtitleContent: string | null,
  subtitleFormat: 'srt' | 'vtt' | null,
  videoId: string,
  title: string,
  aspectRatio: '16:9' | '9:16' | '1:1' = '16:9',
  resolution: 720 | 1080 = 720,
): Promise<{ storagePath: string; sizeBytes: number }> {
  if (clipStoragePaths.length === 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Select at least one video clip.', 400);
  }
  const audioPath = await resolveAudioPath(audioStoragePath);
  const clipPaths = await Promise.all(clipStoragePaths.map(resolveVideoPath));
  const workDir = await mkdtemp(join(tmpdir(), 'podcast-video-'));
  const output = join(workDir, 'episode.mp4');
  const timeout = Number(process.env.FFMPEG_VIDEO_TIMEOUT_MS ?? 1_800_000);
  const [width, height] = aspectRatio === '9:16' ? [resolution === 1080 ? 1080 : 720, resolution === 1080 ? 1920 : 1280]
    : aspectRatio === '1:1' ? [resolution, resolution]
      : [resolution === 1080 ? 1920 : 1280, resolution === 1080 ? 1080 : 720];
  const fitFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;

  try {
    const [audioInfo, ...clipInfos] = await Promise.all([stat(audioPath), ...clipPaths.map((path) => stat(path))]);
    if (!audioInfo.isFile() || audioInfo.size === 0 || clipInfos.some((info) => !info.isFile() || info.size === 0)) {
      throw new AppError(ERROR_CODES.STORAGE_FAILED, 'The audio or one of the selected video clips is missing or empty.', 422);
    }
    let audioDurationSeconds: number;
    try {
      const { stdout } = await execFileAsync(process.env.FFPROBE_PATH ?? 'ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
      ], { timeout: 15_000, maxBuffer: 64 * 1024 });
      audioDurationSeconds = Number(stdout.trim());
      if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) throw new Error('Audio duration is invalid.');
    } catch (error) {
      throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'FFprobe could not determine the final audio duration.', 422, {
        cause: error instanceof Error ? error.message.slice(0, 500) : 'Unknown FFprobe failure.',
      });
    }
    for (const clipPath of clipPaths) await probeVideoClip(clipPath);

    const normalizedPaths: string[] = [];
    for (let index = 0; index < clipPaths.length; index++) {
      const normalizedPath = join(workDir, `clip-${index}.mp4`);
      await runFfmpeg(process.env.FFMPEG_PATH ?? 'ffmpeg', [
        '-y', '-i', clipPaths[index],
        '-map', '0:v:0',
        '-vf', `fps=30,${fitFilter}`,
        '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-r', '30',
        '-movflags', '+faststart', normalizedPath,
      ], timeout);
      normalizedPaths.push(normalizedPath);
    }

    const concatList = join(workDir, 'clips.txt');
    const escapedPaths = normalizedPaths.map((path) => `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    await writeFile(concatList, `${escapedPaths.join('\n')}\n`, 'utf8');
    const args = ['-y', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', concatList, '-i', audioPath];
    let subtitlePath: string | null = null;
    if (subtitleContent?.trim() && subtitleFormat) {
      subtitlePath = join(workDir, `captions.${subtitleFormat}`);
      await writeFile(subtitlePath, subtitleContent, 'utf8');
      args.push('-i', subtitlePath);
    }
    const videoFilter = `fps=30,${fitFilter}`
      + (subtitlePath ? `,subtitles=captions.${subtitleFormat}` : '');
    args.push(
      '-map', '0:v:0', '-map', '1:a:0',
      ...(subtitlePath ? ['-map', '2:s:0'] : []),
      '-vf', videoFilter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      ...(subtitlePath ? ['-c:s', 'mov_text'] : []),
      '-t', String(audioDurationSeconds), '-movflags', '+faststart',
      '-metadata', `title=${title}`,
      output,
    );
    await runFfmpeg(process.env.FFMPEG_PATH ?? 'ffmpeg', args, timeout, workDir);

    const outputInfo = await stat(output);
    if (!outputInfo.isFile() || outputInfo.size === 0) {
      throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'FFmpeg produced an empty MP4 file.', 500);
    }

    const relativePath = `${videoId}.mp4`;
    await mkdir(videoRoot, { recursive: true });
    await copyFile(output, safeVideoPath(relativePath), constants.COPYFILE_EXCL);
    return { storagePath: relativePath, sizeBytes: outputInfo.size };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function readStoredAudio(relativePath: string): Promise<Buffer> {
  return readFile(await resolveAudioPath(relativePath));
}

export async function renderAudioVideo(
  audioStoragePath: string,
  coverStoragePath: string,
  videoId: string,
  title: string,
  aspectRatio: '16:9' | '9:16' | '1:1' = '16:9',
  resolution: 720 | 1080 = 720,
): Promise<{ storagePath: string; sizeBytes: number }> {
  const audioPath = await resolveAudioPath(audioStoragePath);
  const coverPath = await resolveVideoPath(coverStoragePath);
  const workDir = await mkdtemp(join(tmpdir(), 'podcast-video-'));
  const output = join(workDir, 'episode.mp4');
  const timeout = Number(process.env.FFMPEG_VIDEO_TIMEOUT_MS ?? 1_800_000);
  const [width, height] = aspectRatio === '9:16' ? [resolution === 1080 ? 1080 : 720, resolution === 1080 ? 1920 : 1280]
    : aspectRatio === '1:1' ? [resolution, resolution]
      : [resolution === 1080 ? 1920 : 1280, resolution === 1080 ? 1080 : 720];
  const fitFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`;

  try {
    const [audioInfo, coverInfo] = await Promise.all([stat(audioPath), stat(coverPath)]);
    if (!audioInfo.isFile() || audioInfo.size === 0 || !coverInfo.isFile() || coverInfo.size === 0) {
      throw new AppError(ERROR_CODES.STORAGE_FAILED, 'The audio or cover image is missing or empty.', 422);
    }

    try {
      const { stdout } = await execFileAsync(process.env.FFPROBE_PATH ?? 'ffprobe', [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', coverPath,
      ], { timeout: 15_000, maxBuffer: 64 * 1024 });
      const stream = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
      const width = stream?.width ?? 0;
      const height = stream?.height ?? 0;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 12_000 || height > 12_000 || width * height > 40_000_000) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Cover image dimensions must be at most 12,000 px per side and 40 megapixels.', 422);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Cover file could not be decoded as an image.', 415, {
        cause: error instanceof Error ? error.message.slice(0, 500) : 'Unknown image decoding error.',
      });
    }

    await runFfmpeg(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-y',
      '-loop', '1',
      '-framerate', '30',
      '-i', coverPath,
      '-i', audioPath,
      '-vf', fitFilter,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'stillimage',
      '-r', '30',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      '-metadata', `title=${title}`,
      output,
    ], timeout);

    const outputInfo = await stat(output);
    if (!outputInfo.isFile() || outputInfo.size === 0) {
      throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'FFmpeg produced an empty MP4 file.', 500);
    }

    const relativePath = `${videoId}.mp4`;
    await mkdir(videoRoot, { recursive: true });
    await copyFile(output, safeVideoPath(relativePath), constants.COPYFILE_EXCL);
    return { storagePath: relativePath, sizeBytes: outputInfo.size };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function concatenateMp3Buffers(
  audioBuffers: Buffer[],
  outputFormat: typeof ALLOWED_OUTPUT_FORMATS[number],
): Promise<Buffer> {
  if (audioBuffers.length === 0 || audioBuffers.some((audio) => audio.length === 0)) {
    throw new AppError(ERROR_CODES.ELEVENLABS_API_ERROR, 'ElevenLabs returned an empty audio segment.', 502);
  }
  if (audioBuffers.length === 1) return audioBuffers[0];

  const [codec, sampleRate, bitRate] = outputFormat.split('_');
  if (codec !== 'mp3' || !sampleRate || !bitRate) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Unsupported audio format for dialogue assembly.', 400);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'podcast-tts-'));
  try {
    const filenames = audioBuffers.map((_, index) => `segment-${index}.mp3`);
    await Promise.all(audioBuffers.map((audio, index) => writeFile(join(workDir, filenames[index]), audio)));
    const concatList = join(workDir, 'segments.txt');
    await writeFile(concatList, `${filenames.map((filename) => `file '${filename}'`).join('\n')}\n`, 'utf8');
    const output = join(workDir, 'dialogue.mp3');
    await runFfmpeg(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
      '-ar', sampleRate, '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', `${bitRate}k`, output,
    ], Number(process.env.FFMPEG_TIMEOUT_MS ?? 300_000));
    const result = await readFile(output);
    if (result.length === 0) {
      throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'FFmpeg produced an empty dialogue audio file.', 500);
    }
    return result;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function mergeAudio(
  items: Array<CompositionItem & { storagePath: string }>,
  outputId: string,
): Promise<{ storagePath: string; sizeBytes: number; durationSeconds: number | null }> {
  if (items.length === 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Add at least one audio item before merging.', 400);
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
  const workDir = await mkdtemp(join(tmpdir(), 'podcast-studio-'));
  const timeout = Number(process.env.FFMPEG_TIMEOUT_MS ?? 300_000);
  const normalized: string[] = [];

  try {
    let order = 0;
    for (const item of items) {
      const source = await resolveAudioPath(item.storagePath);
      const sourceInfo = await stat(source);
      if (!sourceInfo.isFile() || sourceInfo.size === 0) {
        throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'An audio item is missing or empty.', 422, { audioId: item.audioId });
      }

      const inputExt = extname(source).toLowerCase();
      const target = join(workDir, `audio-${order++}.mp3`);
      const args = ['-y', '-i', source];
      if (item.trimStartMs !== null) args.push('-ss', String(Math.max(0, item.trimStartMs) / 1000));
      if (item.trimEndMs !== null) {
        const start = Math.max(0, item.trimStartMs ?? 0);
        const duration = item.trimEndMs - start;
        if (duration <= 0) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Trim end must be after trim start.', 400);
        args.push('-t', String(duration / 1000));
      }
      args.push('-ar', '44100', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '128k', target);
      if (inputExt !== '.mp3') {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Only MP3 audio can be added to a composition.', 422);
      }
      await runFfmpeg(ffmpeg, args, timeout);
      normalized.push(target);

      const gapSeconds = Math.max(0, Math.min(item.gapMs, 10_000)) / 1000;
      if (gapSeconds > 0 && order < items.length) {
        const silence = join(workDir, `silence-${order}.mp3`);
        await runFfmpeg(ffmpeg, [
          '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(gapSeconds),
          '-q:a', '9', '-acodec', 'libmp3lame', silence,
        ], timeout);
        normalized.push(silence);
      }
    }

    const concatList = join(workDir, 'list.txt');
    const escaped = normalized.map((path) => `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    await writeFile(concatList, `${escaped.join('\n')}\n`, 'utf8');
    const output = join(workDir, 'merged.mp3');
    await runFfmpeg(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', output], timeout);

    const outputInfo = await stat(output);
    if (!outputInfo.isFile() || outputInfo.size === 0) {
      throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'FFmpeg produced an empty output file.', 500);
    }
    let durationSeconds: number | null = null;
    try {
      const probe = await execFileAsync(ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', output,
      ], { timeout });
      const parsed = Number(probe.stdout.trim());
      if (Number.isFinite(parsed)) durationSeconds = parsed;
    } catch (error) {
      throw new AppError(ERROR_CODES.FFMPEG_FAILED, 'FFprobe could not verify the merged audio.', 500, {
        cause: error instanceof Error ? error.message : 'Unknown FFprobe failure.',
      });
    }

    const storagePath = await storeAudio(outputId, await readFile(output));
    return { storagePath, sizeBytes: outputInfo.size, durationSeconds };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runFfmpeg(command: string, args: string[], timeout: number, cwd?: string): Promise<void> {
  try {
    await execFileAsync(command, args, { timeout, maxBuffer: 2 * 1024 * 1024, cwd });
  } catch (error) {
    const timeoutError = error as NodeJS.ErrnoException;
    const isTimeout = timeoutError.code === 'ETIMEDOUT';
    throw new AppError(
      isTimeout ? ERROR_CODES.FFMPEG_TIMEOUT : ERROR_CODES.FFMPEG_FAILED,
      isTimeout ? 'FFmpeg exceeded its configured processing time limit.' : 'FFmpeg failed to process the media file.',
      500,
      { cause: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown FFmpeg failure.' },
    );
  }
}

export async function ensureAudioDirectory(): Promise<void> {
  await mkdir(audioRoot, { recursive: true });
}
