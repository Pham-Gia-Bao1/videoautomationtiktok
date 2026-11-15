import { AppError, ERROR_CODES } from '@podcast/core';
import type { EpisodeEditEvent, SubtitleStyle, TranscriptionSegment, VideoClip } from '@podcast/types';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveProjectPath } from './paths';
import { probeVideoClip, resolveAudioPath, resolveMusicPath, resolveVideoPath, storeRenderedVideoFile } from './media';

const execFileAsync = promisify(execFile);
const ghostRoot = resolveProjectPath(process.env.GHOST_EDITOR_PATH ?? 'integrations/ghost-editor');
const styles = ['clean', 'editorial', 'meme', 'cinematic', 'launch', 'kinetic', 'pop'] as const;
export type GhostStyle = (typeof styles)[number];
type Cut = { clipIndex: number; start: number; end: number };
type EditPlan = { cuts: Cut[]; note?: string };

export function isGhostStyle(value: unknown): value is GhostStyle {
  return typeof value === 'string' && (styles as readonly string[]).includes(value);
}

function claudePath(): string {
  const configured = process.env.CLAUDE_CODE_PATH;
  if (configured) return configured;
  const npmShim = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'claude.cmd') : '';
  return npmShim && existsSync(npmShim) ? npmShim : 'claude';
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH ?? 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (existsSync(gitBash)) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  return env;
}

function runClaudePrint(cli: string, args: string[], prompt: string, cwd: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(cli, args, {
      cwd,
      env: claudeEnv(),
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    const timer = setTimeout(() => child.kill(), Number(process.env.GHOST_EDITOR_TIMEOUT_MS ?? 180_000));
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 4 * 1024 * 1024) child.kill();
      else stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 32_000) stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(stdout);
      else reject(new Error(stderr.trim().slice(-1200) || `Claude Code exited with status ${code}.`));
    });
    child.stdin.end(prompt);
  });
}

export async function ghostEditorStatus(): Promise<{ installed: boolean; authenticated: boolean; styles: GhostStyle[] }> {
  let cli = claudePath();
  if (cli === 'claude') {
    try {
      const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], {
        timeout: 5_000, maxBuffer: 64 * 1024, shell: false, env: claudeEnv(),
      });
      cli = stdout.split(/\r?\n/)[0].trim() || cli;
    } catch {
      return { installed: false, authenticated: false, styles: [...styles] };
    }
  }
  if (!existsSync(cli)) return { installed: false, authenticated: false, styles: [...styles] };
  try {
    const { stdout } = await execFileAsync(cli, ['auth', 'status'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      shell: process.platform === 'win32',
      env: claudeEnv(),
    });
    const status = JSON.parse(stdout) as { loggedIn?: boolean };
    return { installed: true, authenticated: status.loggedIn === true, styles: [...styles] };
  } catch {
    return { installed: true, authenticated: false, styles: [...styles] };
  }
}

function jsonFromClaudeOutput(stdout: string): unknown {
  let text = stdout.trim();
  try {
    const envelope = JSON.parse(text) as { result?: unknown };
    if (typeof envelope.result === 'string') text = envelope.result.trim();
  } catch {
    // Some CLI versions emit the result as plain text even with JSON output requested.
  }
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Claude did not return a JSON edit plan.');
  return JSON.parse(text.slice(start, end + 1));
}

async function createContactSheet(clipPath: string, duration: number, outputPath: string): Promise<void> {
  const sampleRate = (12 / duration).toFixed(6);
  const filter = `fps=${sampleRate},scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,tile=4x3`;
  await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', clipPath,
    '-vf', filter, '-frames:v', '1', outputPath,
  ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
}

async function askClaudeForPlan(
  workDir: string,
  sheetPaths: string[],
  audioDuration: number,
  clips: Array<{ title: string; duration: number }>,
  scriptText: string,
  transcript: TranscriptionSegment[],
  style: GhostStyle,
): Promise<EditPlan> {
  const status = await ghostEditorStatus();
  if (!status.installed) {
    throw new AppError(ERROR_CODES.INTERNAL, 'Claude Code CLI is not available. Install Claude Code and configure CLAUDE_CODE_PATH, then restart the API.', 503);
  }
  if (!status.authenticated) {
    throw new AppError(ERROR_CODES.UNAUTHORIZED, 'Claude Code is installed but not signed in. Run "claude auth login" in a terminal, then retry the Ghost Editor job.', 503);
  }

  const references = [
    join(ghostRoot, 'SKILL.md'),
    join(ghostRoot, 'references', 'reel-json.md'),
    ...sheetPaths,
  ];
  const wordTimeline = transcript.slice(0, 1200).map(({ start, end, text }) => ({
    start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text,
  }));
  const prompt = [
    'Read the Ghost Editor skill and reel JSON reference, then inspect every contact sheet image listed below using the Read tool.',
    'Create a concise, visually varied cut plan for a 9:16 talking-head reel. The final voiceover is already generated and must remain untouched; use the supplied word timeline to keep source cuts near matching spoken phrases. Do not invent visual events or text.',
    'Return only JSON with this shape: {"cuts":[{"clipIndex":0,"start":0.0,"end":2.0}],"note":"brief edit rationale"}.',
    'Cuts are played in array order. Each cut must use one source clip index and source seconds. Use 1.5–6 second cuts where possible, preserve the full voiceover duration in aggregate, keep the subject visible, and avoid cutting through a word if timing permits.',
    'Do not call tools other than Read. Do not edit files or run commands.',
    `STYLE: ${style}`,
    `FINAL AUDIO DURATION: ${audioDuration.toFixed(2)} seconds`,
    `SOURCE CLIPS: ${JSON.stringify(clips.map((clip, clipIndex) => ({ clipIndex, title: clip.title, durationSeconds: clip.duration.toFixed(2), contactSheet: sheetPaths[clipIndex] })))}`,
    `SCRIPT: ${scriptText.slice(0, 50_000)}`,
    `WORD TIMELINE: ${JSON.stringify(wordTimeline)}`,
    `REFERENCE FILES: ${JSON.stringify(references)}`,
  ].join('\n\n');
  const cli = claudePath();
  try {
    const stdout = await runClaudePrint(cli, [
      '-p', '--output-format', 'json', '--model', process.env.GHOST_EDITOR_CLAUDE_MODEL ?? 'sonnet',
      '--permission-mode', 'plan', '--tools', 'Read', '--add-dir', ghostRoot, '--max-turns', '3',
      'Plan the reel from the edit brief provided on standard input. Inspect the referenced Ghost Editor docs and contact sheets. Return only the requested JSON.',
    ], prompt, workDir);
    const parsed = jsonFromClaudeOutput(stdout) as Partial<EditPlan>;
    if (!Array.isArray(parsed.cuts) || parsed.cuts.length === 0 || parsed.cuts.length > 80) {
      throw new Error('Claude returned an empty or oversized cut list.');
    }
    return {
      cuts: parsed.cuts.map((cut) => ({
        clipIndex: Number(cut.clipIndex), start: Number(cut.start), end: Number(cut.end),
      })),
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 500) : undefined,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const detail = error instanceof Error ? error.message.slice(0, 350) : 'Unknown Claude Code error.';
    throw new AppError(ERROR_CODES.INTERNAL, `Claude could not create the reel edit plan: ${detail}`, 502);
  }
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const secs = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`;
}

function assColor(value: string, alpha = '00'): string {
  const hex = value.replace('#', '');
  if (!/^[\da-fA-F]{6}$/.test(hex)) return `&H${alpha}FFFFFF`;
  const rr = hex.slice(0, 2); const gg = hex.slice(2, 4); const bb = hex.slice(4, 6);
  return `&H${alpha}${bb}${gg}${rr}`.toUpperCase();
}

function assText(value: string): string {
  return value.replace(/[\\{}]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function makeAss(segments: TranscriptionSegment[], style: GhostStyle, preset: Record<string, any>, custom?: SubtitleStyle, editEvents: EpisodeEditEvent[] = []): string {
  if (custom) {
    const align = (custom.position==='top'?7:custom.position==='center'?4:1)+(custom.alignment==='left'?0:custom.alignment==='right'?2:1);
    const alpha=Math.round((1-custom.backgroundOpacity)*255).toString(16).padStart(2,'0');
    const bold=['bold','extra-bold'].includes(custom.fontWeight)?-1:0;
    const bg=assColor(custom.backgroundColor).replace('&H','&H'+alpha);
    const border=custom.backgroundOpacity>0?3:1;
    const ordered=segments.filter((word)=>word.text.trim()&&word.end>word.start).slice().sort((a,b)=>a.start-b.start);
    const groups:TranscriptionSegment[][]=[];
    if(['karaoke','smooth','typewriter','edit','stagger'].includes(custom.animation)){for(let i=0;i<ordered.length;i+=5)groups.push(ordered.slice(i,i+5));}else ordered.forEach((word)=>groups.push([word]));
    const events=groups.flatMap((group)=>{
      const words=group.map((word)=>({...word,text:assText(word.text.trim())}));
      if(custom.animation==='typewriter')return words.map((word,index)=>`Dialogue: 0,${assTime(word.start)},${assTime(Math.max(index+1<words.length?words[index+1].start:word.end,word.start+0.05))},Custom,,0,0,0,,{\\fsp${custom.letterSpacing}}${words.slice(0,index+1).map((part)=>part.text).join(' ')}`);
      const intensity=custom.intensity??'balanced';const punch=intensity==='creative'?140:intensity==='subtle'?112:126;const emphasisScale=intensity==='creative'?148:intensity==='subtle'?112:130;
      const fxByAnimation:Record<string,string>={fade:'\\fad(140,120)','fade-out':'\\fad(0,240)',pop:`\\fscx65\\fscy65\\t(0,130,\\fscx${punch}\\fscy${punch})\\t(130,260,\\fscx100\\fscy100)`,'pop-out':'\\t(0,120,\\fscx115\\fscy115)\\t(180,300,\\fscx0\\fscy0)',bounce:`\\fscx75\\fscy75\\t(0,180,\\fscx${punch}\\fscy${punch})\\t(180,340,\\fscx100\\fscy100)`,'scale-punch':`\\fscx85\\fscy85\\t(0,100,\\fscx${punch}\\fscy${punch})\\t(100,220,\\fscx100\\fscy100)`,slide:'\\fscx75\\t(0,180,\\fscx100)',shake:'\\frz-3\\t(0,70,\\frz4)\\t(70,140,\\frz-3)\\t(140,230,\\frz0)',elastic:`\\fscx60\\fscy60\\t(0,150,\\fscx${punch+12}\\fscy${punch+12})\\t(150,300,\\fscx100\\fscy100)`,glitch:'\\fsp5\\1c&H00FFFF&\\t(80,180,\\fsp0\\1c&H00FFFFFF&)',rotation:'\\frz12\\t(0,220,\\frz0)',blur:'\\blur5\\t(0,240,\\blur0)',wave:'\\frz-3\\t(0,180,\\frz3)\\t(180,360,\\frz0)',tracking:'\\fsp8\\t(0,220,\\fsp0)'};
      const fx=fxByAnimation[custom.animation]??'';
      const text=words.map((word)=>{
        const duration=Math.max(1,Math.round((word.end-word.start)*100));
        if(custom.animation==='edit'){
          const emphatic=/[!?！？]{1,}$/.test(word.text)||(word.text.length>2&&word.text===word.text.toLocaleUpperCase()&&/[\\p{L}]/u.test(word.text));
          const marker=/[!?！？]{2,}$/.test(word.text)?' ‼':/[?？]$/.test(word.text)?' ?':/[!！]$/.test(word.text)?' ✦':'';
          return emphatic?`{\\k${duration}}{\\fscx${emphasisScale}\\fscy${emphasisScale}\\bord${custom.outlineWidth+1}\\1c${assColor(custom.highlightColor)}}${word.text}${marker}{\\fscx100\\fscy100\\bord${custom.outlineWidth}}`:`{\\k${duration}}${word.text}`;
        }
        const timed=['karaoke','smooth','stagger'].includes(custom.animation)?`{\\${custom.animation==='smooth'?'kf':'k'}${duration}}`:'';
        if(custom.animation==='stagger')return `${timed}{\\t(0,${Math.min(280,words.indexOf(word)*55)},\\fscx${punch}\\fscy${punch})}${word.text}{\\fscx100\\fscy100}`;
        return `${timed}${word.text}`;
      }).join(' ');
      return [`Dialogue: 0,${assTime(words[0].start)},${assTime(Math.max(words.at(-1)!.end,words[0].start+0.05))},Custom,,0,0,0,,{${fx}\\fsp${custom.letterSpacing}}${text}`];
    });
    const primaryColor=custom.animation==='word'?custom.textColor:custom.highlightColor;
    const overlays=editEvents.filter((event)=>event.enabled&&['typography','sticker'].includes(event.track)&&event.text.trim()).map((event)=>{const y=event.position==='top'?380:event.position==='bottom'?1500:960;const size=Math.max(24,Math.min(220,Math.round(custom.fontSize*event.scale)));const alpha=Math.round((1-event.opacity)*255).toString(16).padStart(2,'0');const fx=event.animation==='shake'?'\\frz-5\\t(0,80,\\frz5)\\t(80,160,\\frz-3)\\t(160,240,\\frz0)':event.animation==='slide'?'\\fscx75\\t(0,180,\\fscx100)':'\\fscx65\\fscy65\\t(0,140,\\fscx110\\fscy110)\\t(140,260,\\fscx100\\fscy100)';const text=assText(event.text).replace(/\\n/g,'\\N');return `Dialogue: 1,${assTime(event.startSeconds)},${assTime(Math.max(event.endSeconds,event.startSeconds+0.08))},Custom,,0,0,0,,{\\an5\\pos(540,${y})\\fs${size}\\alpha&H${alpha}&\\bord${custom.outlineWidth+1}\\1c${assColor(custom.highlightColor)}${fx}}${text}`;});
    return ['[Script Info]','ScriptType: v4.00+','WrapStyle: 2','ScaledBorderAndShadow: yes','PlayResX: 1080','PlayResY: 1920','','[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',`Style: Custom,${custom.fontFamily},${custom.fontSize},${assColor(primaryColor)},${assColor(custom.textColor)},${assColor(custom.outlineColor)},${bg},${bold},0,0,0,100,100,${custom.letterSpacing},0,${border},${custom.outlineWidth},${custom.shadow},${align},55,55,${custom.position==='top'?70:64},1`,'','[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',...events,...overlays,''].join('\n');
  }
  const brand = preset.brand ?? {};
  const captions = preset.captions ?? {};
  const fontSize = Number(brand.capSize ?? 60);
  const accent = assColor(String(brand.accent ?? '#FFD23F'));
  const foreground = assColor(String(brand.ink ?? '#FFFFFF'));
  const font = style === 'cinematic' ? 'Georgia' : 'Arial';
  const borderStyle = style === 'editorial' || style === 'launch' ? 3 : 1;
  const back = style === 'editorial' ? '&H6608080A' : style === 'launch' ? '&H6615151B' : '&H80000000';
  const size = Math.max(42, Math.min(76, fontSize));
  const marginV = style === 'kinetic' ? 670 : 440;
  const groupMax = style === 'kinetic' ? 2 : Number(captions.group ?? 3);
  const sorted = segments.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.text.trim())
    .slice().sort((a, b) => a.start - b.start);
  const groups: TranscriptionSegment[][] = [];
  for (const word of sorted) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    const gap = previous ? word.start - previous.end : 0;
    const sentenceEnd = previous ? /[.!?]$/.test(previous.text.trim()) : false;
    if (!group || group.length >= groupMax || gap > 0.55 || sentenceEnd) groups.push([word]);
    else group.push(word);
  }
  const events = groups.map((group) => {
    const start = group[0].start;
    const end = group[group.length - 1].end + 0.35;
    const words = group.map((word) => {
      const duration = Math.max(1, Math.round((word.end - word.start) * 100));
      return `{\\kf${duration}}${assText(word.text.trim())}`;
    }).join(' ');
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Ghost,,0,0,0,,{\\an2\\pos(540,1420)\\fscx94\\fscy94\\t(0,90,\\fscx100\\fscy100)}${words}`;
  });
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', 'PlayResX: 1080', 'PlayResY: 1920',
    '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Ghost,${font},${size},${foreground},${accent},&HCC000000,${back},-1,0,0,0,100,100,0,0,${borderStyle},4,2,2,85,85,${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, '',
  ].join('\n');
}

async function mediaDuration(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH ?? 'ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath,
  ], { timeout: 15_000, maxBuffer: 64 * 1024 });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0 || duration > 900) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Final audio duration is invalid for a Ghost Editor reel.', 422);
  }
  return duration;
}

export async function renderGhostEdit(input: {
  audioStoragePath: string;
  clips: VideoClip[];
  segments: TranscriptionSegment[];
  scriptText: string;
  videoId: string;
  title: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  resolution: 720 | 1080;
  style: GhostStyle;
  musicTracks?: Array<{ storagePath:string; volume:number; startSeconds:number; endSeconds:number|null; outputStartSeconds:number; fadeInSeconds:number; fadeOutSeconds:number; durationSeconds:number }>;
  voiceVolume?: number;
  subtitleStyle?: SubtitleStyle;
  editEvents?: EpisodeEditEvent[];
}): Promise<{ storagePath: string; sizeBytes: number; note?: string }> {
  const stylePath = join(ghostRoot, 'styles', `${input.style}.json`);
  if (!existsSync(stylePath)) throw new AppError(ERROR_CODES.INTERNAL, `Ghost Editor style '${input.style}' is missing.`, 500);
  const preset = JSON.parse(await readFile(stylePath, 'utf8')) as Record<string, any>;
  const audioPath = await resolveAudioPath(input.audioStoragePath);
  const clipPaths = await Promise.all(input.clips.map((clip) => resolveVideoPath(clip.storagePath)));
  const durations = await Promise.all(clipPaths.map(async (path) => (await probeVideoClip(path)).durationSeconds));
  const audioDuration = await mediaDuration(audioPath);
  const workDir = await mkdtemp(join(tmpdir(), 'ghost-editor-job-'));
  const sheetsDir = join(workDir, 'sheets');
  await mkdir(sheetsDir, { recursive: true });

  try {
    const sheetPaths: string[] = [];
    for (let i = 0; i < clipPaths.length; i++) {
      const sheet = join(sheetsDir, `clip-${i}.jpg`);
      await createContactSheet(clipPaths[i], durations[i], sheet);
      sheetPaths.push(sheet);
    }
    const plan = await askClaudeForPlan(
      workDir,
      sheetPaths,
      audioDuration,
      input.clips.map((clip, index) => ({ title: clip.title, duration: durations[index] })),
      input.scriptText,
      input.segments,
      input.style,
    );
    const cuts = plan.cuts.filter((cut) =>
      Number.isInteger(cut.clipIndex) && cut.clipIndex >= 0 && cut.clipIndex < clipPaths.length &&
      Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.start >= 0 && cut.end <= durations[cut.clipIndex] && cut.end - cut.start >= 0.4,
    );
    if (!cuts.length) throw new AppError(ERROR_CODES.VALIDATION_FAILED, 'Claude returned no usable video cuts for the uploaded footage.', 422);

    const [width, height] = input.aspectRatio === '9:16'
      ? [input.resolution === 1080 ? 1080 : 720, input.resolution === 1080 ? 1920 : 1280]
      : input.aspectRatio === '1:1' ? [input.resolution, input.resolution]
        : [input.resolution === 1080 ? 1920 : 1280, input.resolution === 1080 ? 1080 : 720];
    const fit = `fps=30,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,format=yuv420p`;
    const normalized: string[] = [];
    for (let index = 0; index < cuts.length; index++) {
      const cut = cuts[index];
      const output = join(workDir, `cut-${String(index).padStart(3, '0')}.mp4`);
      await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(cut.start), '-i', clipPaths[cut.clipIndex],
        '-t', String(cut.end - cut.start), '-an', '-vf', fit, '-c:v', 'libx264', '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
      ], { timeout: Number(process.env.FFMPEG_VIDEO_TIMEOUT_MS ?? 1_800_000), maxBuffer: 1024 * 1024 });
      normalized.push(output);
    }

    const concatList = join(workDir, 'cuts.txt');
    const escaped = normalized.map((path) => `file '${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    await writeFile(concatList, `${escaped.join('\n')}\n`, 'utf8');
    const assPath = join(workDir, 'captions.ass');
    await writeFile(assPath, makeAss(input.segments, input.style, preset, input.subtitleStyle, input.editEvents), 'utf8');
    const output = join(workDir, 'reel.mp4');
    const filterPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const visualEffects=(input.editEvents??[]).filter((event)=>event.enabled&&event.track==='visual-effect').flatMap((event)=>{const interval=`:enable='between(t,${event.startSeconds},${event.endSeconds})'`;if(event.effect==='flash')return [`eq=brightness=${Math.min(.8,.25*event.scale)}${interval}`];if(event.effect==='vignette')return [`vignette=PI/${Math.max(2,Math.round(8/event.scale))}${interval}`];if(event.effect==='soft-blur')return [`gblur=sigma=${Math.min(8,event.scale*2)}${interval}`];if(event.effect==='contrast')return [`eq=contrast=${Math.min(1.8,1+event.scale*.2)}${interval}`];return [];}).join(',');
    const filter = `${visualEffects ? `${visualEffects},` : ''}subtitles='${filterPath}'`;
    const musicPaths=await Promise.all((input.musicTracks??[]).map((track)=>resolveMusicPath(track.storagePath)));
    const ffmpegArgs=[
      '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', concatList,
      '-i', audioPath,
    ];
    for(const path of musicPaths)ffmpegArgs.push('-i',path);
    const voiceVolume=Math.max(0,Math.min(2,input.voiceVolume??1));
    if(musicPaths.length||voiceVolume!==1){
      const mix=['[voice]'];const filters=[`[1:a]volume=${voiceVolume}[voice]`];
      (input.musicTracks??[]).forEach((track,index)=>{
        const start=Math.max(0,track.startSeconds);const end=track.endSeconds&&track.endSeconds>start?`:end=${track.endSeconds}`:'';const delay=Math.round(Math.max(0,track.outputStartSeconds)*1000);const duration=Math.max(0,(track.endSeconds??track.durationSeconds)-start);
        const fades=`${track.fadeInSeconds?`,afade=t=in:st=0:d=${Math.min(duration,track.fadeInSeconds)}`:''}${track.fadeOutSeconds?`,afade=t=out:st=${Math.max(0,duration-track.fadeOutSeconds)}:d=${Math.min(duration,track.fadeOutSeconds)}`:''}`;
        filters.push(`[${index+2}:a]atrim=start=${start}${end},asetpts=PTS-STARTPTS,volume=${Math.max(0,Math.min(2,track.volume))}${fades},adelay=${delay}|${delay}[music${index}]`);mix.push(`[music${index}]`);
      });
      filters.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=2:normalize=0,alimiter=limit=0.95,atrim=duration=${audioDuration}[aout]`);
      ffmpegArgs.push('-filter_complex',filters.join(';'),'-map','[aout]');
    }else ffmpegArgs.push('-map','1:a:0');
    ffmpegArgs.push('-vf', filter, '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', audioDuration.toFixed(3), '-movflags', '+faststart',
      '-metadata', `title=${input.title}`, output);
    await execFileAsync(process.env.FFMPEG_PATH ?? 'ffmpeg',ffmpegArgs,{ timeout: Number(process.env.FFMPEG_VIDEO_TIMEOUT_MS ?? 1_800_000), maxBuffer: 1024 * 1024, cwd: workDir });

    const stored = await storeRenderedVideoFile(input.videoId, output);
    return { ...stored, note: plan.note };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

