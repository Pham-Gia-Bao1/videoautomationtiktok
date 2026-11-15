import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  Transcription,
  VideoClip,
  VoiceMapping,
} from '@podcast/types';
import { resolveProjectPath } from './paths';

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
}

const emptyData = (): StudioData => ({
  projects: [],
  episodes: [],
  scripts: [],
  characters: [],
  voiceMappings: [],
  batches: [],
  chunks: [],
  audios: [],
  compositions: [],
  compositionItems: [],
  transcriptions: [],
  subtitles: [],
  videos: [],
  videoClips: [],
});

const dataDirectory = process.env.DATA_DIR
  ? resolveProjectPath(process.env.DATA_DIR)
  : join(__dirname, '..', 'data');
const storePath = join(dataDirectory, 'studio.json');
let mutationQueue: Promise<unknown> = Promise.resolve();

async function load(): Promise<StudioData> {
  try {
    const parsed: Partial<StudioData> = JSON.parse(await readFile(storePath, 'utf8'));
    return { ...emptyData(), ...parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyData();
    throw error;
  }
}

export async function readData(): Promise<StudioData> {
  await mutationQueue;
  return load();
}

export function updateData<T>(change: (data: StudioData) => T | Promise<T>): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const data = await load();
    const result = await change(data);
    await mkdir(dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
    await rename(temporaryPath, storePath);
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export const now = (): string => new Date().toISOString();
export const id = (): string => randomUUID();
