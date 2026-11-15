import { randomUUID } from 'node:crypto';
import type {
  AudioRecord, CharacterRecord, Composition, CompositionItem, Episode, EpisodeVideo,
  GenerationBatch, GenerationChunk, Project, Script, Subtitle, Transcription,
  VideoClip, VoiceMapping, MusicAsset, EpisodeEditEvent,
} from '@podcast/types';

/** Runtime aggregate used by the existing domain/API layer. Persistence is normalized in Postgres. */
export interface StudioData {
  projects: Project[];
  episodes: Episode[];
  scripts: Script[];
  characters: CharacterRecord[];
  voiceMappings: VoiceMapping[];
  batches: GenerationBatch[];
  chunks: GenerationChunk[];
  audios: AudioRecord[];
  compositions: Composition[];
  compositionItems: CompositionItem[];
  transcriptions: Transcription[];
  subtitles: Subtitle[];
  videos: EpisodeVideo[];
  videoClips: VideoClip[];
  musicAssets: MusicAsset[];
  editEvents: EpisodeEditEvent[];
}

type CollectionKey = keyof StudioData;
type DbRow = Record<string, unknown>;
const emptyData = (): StudioData => ({
  projects: [], episodes: [], scripts: [], characters: [], voiceMappings: [], batches: [], chunks: [],
  audios: [], compositions: [], compositionItems: [], transcriptions: [], subtitles: [], videos: [], videoClips: [], musicAssets: [], editEvents: [],
});
const collectionTables: Record<CollectionKey, string> = {
  projects: 'projects', episodes: 'episodes', scripts: 'scripts', characters: 'characters',
  voiceMappings: 'voice_mappings', batches: 'generation_batches', chunks: 'generation_chunks',
  audios: 'audios', compositions: 'compositions', compositionItems: 'composition_items',
  transcriptions: 'transcriptions', subtitles: 'subtitles', videos: 'episode_videos', videoClips: 'video_clips', musicAssets: 'music_assets',
  editEvents: 'episode_video_edit_events',
};
const writeOrder: CollectionKey[] = [
  'projects', 'episodes', 'scripts', 'characters', 'voiceMappings', 'batches', 'chunks', 'audios',
  'compositions', 'compositionItems', 'transcriptions', 'subtitles', 'videos', 'videoClips', 'musicAssets', 'editEvents',
];
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
let mutationQueue: Promise<unknown> = Promise.resolve();
let dataCache: StudioData | null = null;
let initialLoad: Promise<StudioData> | null = null;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY before starting the API.');
  }
  return { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`, 'content-type': 'application/json', ...extra };
}

function toSnake(row: DbRow): DbRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]));
}

function toCamel<T>(row: DbRow): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()), value])) as T;
}

function dbRow(key: CollectionKey, record: DbRow): DbRow {
  const row = toSnake(record);
  if (key === 'batches') delete row.voice_mappings;
  if (key === 'transcriptions') delete row.segments;
  if (key === 'videos') delete row.clip_ids;
  if (key === 'videos') { delete row.music_tracks; delete row.subtitle_style; }
  return row;
}

async function readTable(table: string): Promise<DbRow[]> {
  const result: DbRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&limit=${pageSize}&offset=${offset}`, {
      headers: headers({ range: `${offset}-${offset + pageSize - 1}` }),
    });
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 404 && body.includes('PGRST205')) {
        throw new Error(`Supabase cannot see public.${table}. From the repository root, apply pending migrations with "supabase db push", then refresh the PostgREST schema cache with NOTIFY pgrst, 'reload schema'. Details: ${body}`);
      }
      throw new Error(`Could not read Supabase table ${table} (${response.status}): ${body}`);
    }
    const rows = await response.json() as DbRow[];
    result.push(...rows);
    if (rows.length < pageSize) return result;
  }
}

async function load(): Promise<StudioData> {
  const names = [...new Set([...Object.values(collectionTables), 'generation_batch_voice_mappings', 'transcription_segments', 'episode_video_clips', 'episode_video_music_tracks', 'episode_video_subtitle_styles'])];
  const records = Object.fromEntries(await Promise.all(names.map(async (table) => [table, await readTable(table)] as const))) as Record<string, DbRow[]>;
  const data = emptyData();
  for (const key of Object.keys(collectionTables) as CollectionKey[]) {
    (data[key] as unknown[]) = records[collectionTables[key]].map((row) => toCamel(row));
  }

  const batchMappings = new Map<string, Record<string, string>>();
  for (const row of records.generation_batch_voice_mappings) {
    const batchId = String(row.batch_id);
    const snapshot = batchMappings.get(batchId) ?? {};
    snapshot[String(row.speaker_key)] = String(row.voice_id);
    batchMappings.set(batchId, snapshot);
  }
  data.batches = data.batches.map((batch) => ({ ...batch, voiceMappings: batchMappings.get(batch.id) ?? {} }));

  const segments = new Map<string, Transcription['segments']>();
  for (const row of records.transcription_segments) {
    const transcriptionId = String(row.transcription_id);
    const current = segments.get(transcriptionId) ?? [];
    current.push({ start: Number(row.start_seconds), end: Number(row.end_seconds), text: String(row.text) });
    segments.set(transcriptionId, current);
  }
  for (const value of segments.values()) value.sort((a, b) => a.start - b.start);
  data.transcriptions = data.transcriptions.map((item) => ({ ...item, segments: segments.get(item.id) ?? [] }));

  const clipIds = new Map<string, Array<{ position: number; clipId: string }>>();
  for (const row of records.episode_video_clips) {
    const videoId = String(row.episode_video_id);
    const current = clipIds.get(videoId) ?? [];
    current.push({ position: Number(row.position), clipId: String(row.video_clip_id) });
    clipIds.set(videoId, current);
  }
  data.videos = data.videos.map((video) => ({
    ...video,
    clipIds: (clipIds.get(video.id) ?? []).sort((a, b) => a.position - b.position).map((item) => item.clipId),
  }));
  const music = new Map<string, NonNullable<EpisodeVideo['musicTracks']>>();
  for (const row of records.episode_video_music_tracks) {
    const key = String(row.episode_video_id); const tracks = music.get(key) ?? [];
    tracks.push({ musicId: String(row.music_asset_id), orderIndex: Number(row.order_index), volume: Number(row.volume), startSeconds: Number(row.start_seconds), endSeconds: row.end_seconds === null ? null : Number(row.end_seconds), outputStartSeconds: Number(row.output_start_seconds), fadeInSeconds:Number(row.fade_in_seconds??0), fadeOutSeconds:Number(row.fade_out_seconds??0) }); music.set(key, tracks);
  }
  const styles = new Map(records.episode_video_subtitle_styles.map((row) => [String(row.episode_video_id), toCamel<NonNullable<EpisodeVideo['subtitleStyle']>>(row)]));
  data.videos = data.videos.map((video) => { const saved = styles.get(video.id); return { ...video, musicTracks: (music.get(video.id) ?? []).sort((a,b) => a.orderIndex-b.orderIndex), subtitleStyle: saved ? { animation:saved.animation,fontFamily:saved.fontFamily,fontSize:saved.fontSize,fontWeight:saved.fontWeight,textColor:saved.textColor,highlightColor:saved.highlightColor,alignment:saved.alignment,position:saved.position,outlineColor:saved.outlineColor,outlineWidth:saved.outlineWidth,backgroundColor:saved.backgroundColor,backgroundOpacity:saved.backgroundOpacity,shadow:saved.shadow,lineSpacing:saved.lineSpacing,letterSpacing:saved.letterSpacing,preset:saved.preset,intensity:saved.intensity } : undefined }; });
  return data;
}

function changedIds<T extends { id: string }>(before: T[], after: T[]): { removed: string[]; changed: T[] } {
  const oldById = new Map(before.map((item) => [item.id, item]));
  const newById = new Map(after.map((item) => [item.id, item]));
  return {
    removed: before.filter((item) => !newById.has(item.id)).map((item) => item.id),
    changed: after.filter((item) => {
      const old = oldById.get(item.id);
      return !old || JSON.stringify(old) !== JSON.stringify(item);
    }),
  };
}

function relationRows(changes: Record<string, unknown>, table: string, parentColumn: string, parentIds: string[], rows: DbRow[]) {
  if (!parentIds.length) return;
  const relation = (changes.replacements as Record<string, unknown>)[table] as Record<string, unknown>;
  relation.parent_ids = [...new Set([...(relation.parent_ids as string[]), ...parentIds])];
  relation.rows = [...relation.rows as DbRow[], ...rows];
}

async function persist(before: StudioData, after: StudioData): Promise<void> {
  const changes: Record<string, unknown> = { deletes: {}, upserts: {}, replacements: {
    generation_batch_voice_mappings: { parent_column: 'batch_id', parent_ids: [], rows: [] },
    transcription_segments: { parent_column: 'transcription_id', parent_ids: [], rows: [] },
    episode_video_clips: { parent_column: 'episode_video_id', parent_ids: [], rows: [] },
    episode_video_music_tracks: { parent_column: 'episode_video_id', parent_ids: [], rows: [] },
    episode_video_subtitle_styles: { parent_column: 'episode_video_id', parent_ids: [], rows: [] },
  } };
  const deletes = changes.deletes as Record<string, string[]>;
  const upserts = changes.upserts as Record<string, DbRow[]>;

  for (const key of Object.keys(collectionTables) as CollectionKey[]) {
    const diff = changedIds(before[key] as Array<{ id: string }>, after[key] as Array<{ id: string }>);
    deletes[collectionTables[key]] = diff.removed;
    upserts[collectionTables[key]] = diff.changed.map((item) => dbRow(key, item as unknown as DbRow));

    if (key === 'batches') {
      const rows = diff.changed.flatMap((batch) => Object.entries((batch as GenerationBatch).voiceMappings ?? {}).map(([speakerKey, voiceId]) => ({
        id: randomUUID(), batch_id: batch.id, speaker_key: speakerKey, voice_id: voiceId, created_at: (batch as GenerationBatch).createdAt,
      })));
      relationRows(changes, 'generation_batch_voice_mappings', 'batch_id', [...diff.removed, ...diff.changed.map((item) => item.id)], rows);
    } else if (key === 'transcriptions') {
      const rows = diff.changed.flatMap((item) => (item as Transcription).segments.map((segment, position) => ({
        id: randomUUID(), transcription_id: item.id, sequence: position + 1,
        start_seconds: segment.start, end_seconds: segment.end, text: segment.text,
      })));
      relationRows(changes, 'transcription_segments', 'transcription_id', [...diff.removed, ...diff.changed.map((item) => item.id)], rows);
    } else if (key === 'videos') {
      const rows = diff.changed.flatMap((item) => ((item as EpisodeVideo).clipIds ?? []).map((clipId, position) => ({
        id: randomUUID(), episode_video_id: item.id, video_clip_id: clipId, position, created_at: (item as EpisodeVideo).createdAt,
      })));
      relationRows(changes, 'episode_video_clips', 'episode_video_id', [...diff.removed, ...diff.changed.map((item) => item.id)], rows);
      const trackRows = diff.changed.flatMap((video) => ((video as EpisodeVideo).musicTracks ?? []).map((track) => ({ id: randomUUID(), episode_video_id: video.id, music_asset_id: track.musicId, order_index: track.orderIndex, volume: track.volume, start_seconds: track.startSeconds, end_seconds: track.endSeconds, output_start_seconds: track.outputStartSeconds, fade_in_seconds:track.fadeInSeconds, fade_out_seconds:track.fadeOutSeconds, created_at: (video as EpisodeVideo).createdAt })));
      relationRows(changes, 'episode_video_music_tracks', 'episode_video_id', [...diff.removed, ...diff.changed.map((item) => item.id)], trackRows);
      const styleRows = diff.changed.flatMap((item) => { const video = item as EpisodeVideo; return video.subtitleStyle ? [{ id: randomUUID(), episode_video_id: video.id, ...toSnake(video.subtitleStyle as unknown as DbRow), created_at: video.createdAt }] : []; });
      relationRows(changes, 'episode_video_subtitle_styles', 'episode_video_id', [...diff.removed, ...diff.changed.map((item) => item.id)], styleRows);
    }
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/apply_studio_changes`, {
    method: 'POST', headers: headers({ prefer: 'return=minimal' }), body: JSON.stringify({ p_changes: changes }),
  });
  if (!response.ok) throw new Error(`Could not commit Supabase studio changes (${response.status}): ${await response.text()}`);
}

export async function readData(): Promise<StudioData> {
  await mutationQueue;
  initialLoad ??= load();
  dataCache ??= await initialLoad;
  return structuredClone(dataCache);
}

export function updateData<T>(change: (data: StudioData) => T | Promise<T>): Promise<T> {
  const operation = mutationQueue.then(async () => {
    initialLoad ??= load();
    dataCache ??= await initialLoad;
    const before = structuredClone(dataCache);
    const after = structuredClone(before);
    const result = await change(after);
    await persist(before, after);
    dataCache = after;
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export const now = (): string => new Date().toISOString();
export const id = (): string => randomUUID();
