import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ALLOWED_OUTPUT_FORMATS, AppError, ERROR_CODES } from '@podcast/core';
import type { CompositionItem, EpisodeEditEvent, SubtitleStyle, TranscriptionSegment } from '@podcast/types';
import { resolveProjectPath } from './paths';

const execFileAsync = promisify(execFile);
const dataRoot = process.env.DATA_DIR
  ? resolveProjectPath(process.env.DATA_DIR)
  : resolve(__dirname, '..', 'data');
const audioRoot = process.env.AUDIO_DIR
  ? resolveProjectPath(process.env.AUDIO_DIR)
  : join(dataRoot, 'audio');
const videoRoot = join(dataRoot, 'videos');
const musicRoot = join(dataRoot, 'music');

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

export async function storeMusicFile(musicId: string, mimeType: string, data: Buffer): Promise<string> {
  const ext = mimeType === 'audio/mpeg' ? 'mp3' : 'mp4';
  const target = resolve(musicRoot, `${musicId}.${ext}`);
  await mkdir(musicRoot, { recursive: true });
  await writeFile(target, data, { flag: 'wx' });
  return `${musicId}.${ext}`;
}

export async function resolveMusicPath(relativePath: string): Promise<string> {
  const target = resolve(musicRoot, relativePath);
  if (!target.startsWith(`${musicRoot}\\`) && !target.startsWith(`${musicRoot}/`)) throw new AppError(ERROR_CODES.FORBIDDEN, 'Invalid music storage path.', 403);
  return target;
}

export async function probeMusic(path: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(process.env.FFPROBE_PATH ?? 'ffprobe', ['-v','error','-select_streams','a:0','-show_entries','format=duration:stream=codec_type','-of','json',path], { timeout: 15000, maxBuffer: 65536 });
    const result = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const duration = Number(result.format?.duration);
    if (!result.streams?.some((stream) => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error('No valid audio stream or duration.');
    return duration;
  } catch (error) { throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'The music file has no supported audio stream or exceeds 60 minutes.', 415, { cause: error instanceof Error ? error.message.slice(0, 300) : 'Probe failed' }); }
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
  musicTracks: Array<{ storagePath: string; volume: number; startSeconds: number; endSeconds: number | null; outputStartSeconds: number; fadeInSeconds: number; fadeOutSeconds: number; durationSeconds: number }> = [],
  voiceVolume = 1,
  timedWords: TranscriptionSegment[] = [],
  subtitleStyle?: SubtitleStyle,
  editEvents: EpisodeEditEvent[] = [],
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
    const musicPaths = await Promise.all(musicTracks.map((track) => resolveMusicPath(track.storagePath)));
    const args = ['-y', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', concatList, '-i', audioPath];
    for (const musicPath of musicPaths) args.push('-i', musicPath);
    let subtitlePath: string | null = null;
    if ((timedWords.length || editEvents.some((event) => event.enabled && ['typography','sticker'].includes(event.track))) && subtitleStyle) {
      const assColor = (hex: string, alpha = '00') => `&H${alpha}${hex.replace('#','').match(/.{2}/g)?.reverse().join('') ?? 'FFFFFF'}`;
      const align = (subtitleStyle.position === 'top' ? 7 : subtitleStyle.position === 'center' ? 4 : 1) + (subtitleStyle.alignment === 'left' ? 0 : subtitleStyle.alignment === 'right' ? 2 : 1);
      const primary = assColor(subtitleStyle.animation === 'word' ? subtitleStyle.textColor : subtitleStyle.highlightColor); const secondary = assColor(subtitleStyle.textColor);
      const fontWeight = ['bold','extra-bold'].includes(subtitleStyle.fontWeight) ? -1 : 0;
      const alpha = Math.round((1 - subtitleStyle.backgroundOpacity) * 255).toString(16).padStart(2,'0');
      const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${subtitleStyle.fontFamily},${subtitleStyle.fontSize},${primary},${secondary},${assColor(subtitleStyle.outlineColor)},${assColor(subtitleStyle.backgroundColor,alpha)},${fontWeight},0,${subtitleStyle.backgroundOpacity > 0 ? 3 : 1},${subtitleStyle.outlineWidth},${subtitleStyle.shadow},${align},54,54,${subtitleStyle.position === 'top' ? 70 : 64},1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
      const stamp = (n: number) => { const cs = Math.max(0, Math.floor(n * 100)); return `${String(Math.floor(cs / 360000)).padStart(1,'0')}:${String(Math.floor(cs / 6000) % 60).padStart(2,'0')}:${String(Math.floor(cs / 100) % 60).padStart(2,'0')}.${String(cs % 100).padStart(2,'0')}`; };
      const chunks: TranscriptionSegment[][] = [];
      if (['karaoke','smooth','typewriter','edit','stagger'].includes(subtitleStyle.animation)) {
        for (let index=0; index<timedWords.length; index+=5) chunks.push(timedWords.slice(index,index+5));
      } else timedWords.forEach((word) => chunks.push([word]));
      const captionEvents = chunks.flatMap((words) => {
        const valid = words.map((word) => ({ ...word, text: word.text.replace(/[{}\\]/g,'').trim() })).filter((word) => word.text);
        if (!valid.length) return [];
        const intensity = subtitleStyle.intensity ?? 'balanced';
        const punch = intensity === 'creative' ? 140 : intensity === 'subtle' ? 112 : 126;
        const emphasisScale = intensity === 'creative' ? 148 : intensity === 'subtle' ? 112 : 130;
        const fxByAnimation: Record<string, string> = {
          fade: '\\fad(140,120)', 'fade-out': '\\fad(0,240)', pop: `\\fscx65\\fscy65\\t(0,130,\\fscx${punch}\\fscy${punch})\\t(130,260,\\fscx100\\fscy100)`,
          'pop-out': `\\t(0,120,\\fscx115\\fscy115)\\t(180,300,\\fscx0\\fscy0)`, bounce: `\\fscx75\\fscy75\\t(0,180,\\fscx${punch}\\fscy${punch})\\t(180,340,\\fscx100\\fscy100)`,
          'scale-punch': `\\fscx85\\fscy85\\t(0,100,\\fscx${punch}\\fscy${punch})\\t(100,220,\\fscx100\\fscy100)`, slide: '\\fscx75\\t(0,180,\\fscx100)', shake: '\\frz-3\\t(0,70,\\frz4)\\t(70,140,\\frz-3)\\t(140,230,\\frz0)',
          elastic: `\\fscx60\\fscy60\\t(0,150,\\fscx${punch + 12}\\fscy${punch + 12})\\t(150,300,\\fscx100\\fscy100)`, glitch: '\\fsp5\\1c&H00FFFF&\\t(80,180,\\fsp0\\1c&H00FFFFFF&)',
          rotation: '\\frz12\\t(0,220,\\frz0)', blur: '\\blur5\\t(0,240,\\blur0)', wave: '\\frz-3\\t(0,180,\\frz3)\\t(180,360,\\frz0)', tracking: '\\fsp8\\t(0,220,\\fsp0)',
        };
        const fx = fxByAnimation[subtitleStyle.animation] ?? '';
        const karaoke = ['karaoke','smooth','edit','stagger'].includes(subtitleStyle.animation);
        const spacing = subtitleStyle.letterSpacing ? `\\fsp${subtitleStyle.letterSpacing}` : '';
        if (subtitleStyle.animation === 'typewriter') return valid.map((word,index) => {
          const end = index+1<valid.length ? Math.max(word.end,valid[index+1].start) : word.end;
          const text = valid.slice(0,index+1).map((part)=>part.text).join(' ');
          return `Dialogue: 0,${stamp(word.start)},${stamp(Math.max(end,word.start+0.05))},Default,,0,0,0,,{${spacing}}${text}`;
        });
        const text = valid.map((word) => {
          const duration = Math.max(1,Math.round((word.end-word.start)*100));
          if (subtitleStyle.animation !== 'edit') {
            const timing = karaoke ? `{\\${subtitleStyle.animation === 'smooth' ? 'kf' : 'k'}${duration}}` : '';
            if (subtitleStyle.animation === 'stagger') return `${timing}{\\t(0,${Math.min(280, valid.indexOf(word) * 55)},\\fscx${punch}\\fscy${punch})}${word.text}{\\fscx100\\fscy100}`;
            return `${timing}${word.text}`;
          }
          const emphatic = /[!?！？]{1,}$/.test(word.text) || (word.text.length > 2 && word.text === word.text.toLocaleUpperCase() && /[\\p{L}]/u.test(word.text));
          const marker = /[!?！？]{2,}$/.test(word.text) ? ' ‼' : /[?？]$/.test(word.text) ? ' ?' : /[!！]$/.test(word.text) ? ' ✦' : '';
          const base = word.text;
          const timed = `{\\k${duration}}`;
          return emphatic
            ? `${timed}{\\fscx${emphasisScale}\\fscy${emphasisScale}\\bord${subtitleStyle.outlineWidth + 1}\\1c${primary}}${base}${marker}{\\fscx100\\fscy100\\bord${subtitleStyle.outlineWidth}}`
            : `${timed}${word.text}`;
        }).join(' ');
        return [`Dialogue: 0,${stamp(valid[0].start)},${stamp(Math.max(valid[valid.length-1].end, valid[0].start + 0.05))},Default,,0,0,0,,{${fx}${spacing}}${text}`];
      }).filter(Boolean).join('\n');
      const overlayEvents = editEvents.filter((event) => event.enabled && ['typography','sticker'].includes(event.track) && event.text.trim()).map((event) => {
        const y = event.position === 'top' ? Math.round(height * 0.2) : event.position === 'bottom' ? Math.round(height * 0.78) : Math.round(height * 0.5);
        const size = Math.max(24, Math.min(220, Math.round(subtitleStyle.fontSize * event.scale)));
        const alpha = Math.round((1 - event.opacity) * 255).toString(16).padStart(2,'0');
        const animation = event.animation === 'bounce' ? `\\fscx70\\fscy70\\t(0,180,\\fscx120\\fscy120)\\t(180,320,\\fscx100\\fscy100)`
          : event.animation === 'shake' ? '\\frz-5\\t(0,80,\\frz5)\\t(80,160,\\frz-3)\\t(160,240,\\frz0)'
            : event.animation === 'slide' ? '\\fscx75\\t(0,180,\\fscx100)' : `\\fscx65\\fscy65\\t(0,140,\\fscx110\\fscy110)\\t(140,260,\\fscx100\\fscy100)`;
        const overlayText = event.text.replace(/[{}\\]/g, '').replace(/\r?\n/g, '\\N').slice(0,160);
        return `Dialogue: 1,${stamp(event.startSeconds)},${stamp(Math.max(event.endSeconds,event.startSeconds+0.08))},Default,,0,0,0,,{\\an5\\pos(${Math.round(width/2)},${y})\\fs${size}\\alpha&H${alpha}&\\bord${Math.max(2,subtitleStyle.outlineWidth+1)}\\1c${primary}${animation}}${overlayText}`;
      });
      const events = [captionEvents, ...overlayEvents].filter(Boolean).join('\n');
      subtitlePath = join(workDir, 'captions.ass');
      await writeFile(subtitlePath, `${header}${events}\n`, 'utf8');
    } else if (subtitleContent?.trim() && subtitleFormat) {
      subtitlePath = join(workDir, `captions.${subtitleFormat}`);
      await writeFile(subtitlePath, subtitleContent, 'utf8');
    }
    if (subtitlePath) args.push('-i', subtitlePath);
    const presetFilter = subtitleStyle?.preset === 'cinematic' ? ',eq=contrast=1.06:saturation=0.88,vignette=PI/5'
      : ['tiktok','energetic'].includes(subtitleStyle?.preset ?? '') ? ',eq=contrast=1.08:saturation=1.2'
        : subtitleStyle?.preset === 'meme' ? ',eq=contrast=1.1:saturation=1.12' : '';
    const eventVideoFilters = editEvents.filter((event) => event.enabled && event.track === 'visual-effect').flatMap((event) => {
      const interval = `:enable='between(t,${event.startSeconds},${event.endSeconds})'`;
      if (event.effect === 'flash') return [`eq=brightness=${Math.min(0.8,0.25*event.scale)}${interval}`];
      if (event.effect === 'vignette') return [`vignette=PI/${Math.max(2,Math.round(8/event.scale))}${interval}`];
      if (event.effect === 'soft-blur') return [`gblur=sigma=${Math.min(8,event.scale*2)}${interval}`];
      if (event.effect === 'contrast') return [`eq=contrast=${Math.min(1.8,1+event.scale*0.2)}${interval}`];
      return [];
    }).join(',');
    const videoFilter = `fps=30,${fitFilter}${presetFilter}${eventVideoFilters ? `,${eventVideoFilters}` : ''}`
      + (subtitlePath ? `,subtitles=captions.${extname(subtitlePath).slice(1)}` : '');
    let audioFilter: string | null = null;
    if (musicTracks.length || voiceVolume !== 1) {
      const filters: string[] = [`[1:a]volume=${Math.max(0, Math.min(2, voiceVolume))}[voice]`];
      const mixInputs = ['[voice]'];
      musicTracks.forEach((track, index) => {
        const start = Math.max(0, track.startSeconds);
        const end = track.endSeconds && track.endSeconds > start ? `:end=${track.endSeconds}` : '';
        const delay = Math.max(0, Math.round(track.outputStartSeconds * 1000));
        const duration = Math.max(0, (track.endSeconds ?? track.durationSeconds) - start);
        const fades = `${track.fadeInSeconds > 0 ? `,afade=t=in:st=0:d=${Math.min(track.fadeInSeconds,duration)}` : ''}${track.fadeOutSeconds > 0 ? `,afade=t=out:st=${Math.max(0,duration-track.fadeOutSeconds)}:d=${Math.min(track.fadeOutSeconds,duration)}` : ''}`;
        filters.push(`[${index + 2}:a]atrim=start=${start}${end},asetpts=PTS-STARTPTS,volume=${Math.max(0, Math.min(2, track.volume))}${fades},adelay=${delay}|${delay}[music${index}]`);
        mixInputs.push(`[music${index}]`);
      });
      filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95,atrim=duration=${audioDurationSeconds}[aout]`);
      audioFilter = filters.join(';');
    }
    args.push(
      '-map', '0:v:0', ...(audioFilter ? ['-filter_complex', audioFilter, '-map', '[aout]'] : ['-map', '1:a:0']),
      ...(subtitlePath ? ['-map', `${musicPaths.length + 2}:s:0`] : []),
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
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr.trim().slice(-1500) : '';
    throw new AppError(
      isTimeout ? ERROR_CODES.FFMPEG_TIMEOUT : ERROR_CODES.FFMPEG_FAILED,
      isTimeout ? 'FFmpeg exceeded its configured processing time limit.' : 'FFmpeg failed to process the media file.',
      500,
      { cause: stderr || (error instanceof Error ? error.message.slice(0, 1000) : 'Unknown FFmpeg failure.') },
    );
  }
}

export async function ensureAudioDirectory(): Promise<void> {
  await mkdir(audioRoot, { recursive: true });
}
