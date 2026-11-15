/**
 * Shared domain types for Podcast Studio.
 *
 * These mirror the database schema (docs/07) and API spec (docs/08) so that
 * frontend, API and workers all speak the same language.
 */

/* -------------------------------------------------------------------------- */
/* Enums / unions                                                             */
/* -------------------------------------------------------------------------- */

export const BATCH_STATUSES = [
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'PARTIAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const CHUNK_STATUSES = [
  'PENDING',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type ChunkStatus = (typeof CHUNK_STATUSES)[number];

export const COMPOSITION_STATUSES = ['DRAFT', 'MERGING', 'READY', 'FAILED'] as const;
export type CompositionStatus = (typeof COMPOSITION_STATUSES)[number];

export const TRANSCRIPTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

export const EPISODE_STATUSES = ['draft', 'generating', 'ready', 'archived'] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

export type AudioKind = 'chunk' | 'final';
export type ApplyTextNormalization = 'auto' | 'on' | 'off';

/* -------------------------------------------------------------------------- */
/* Script parsing (docs/10)                                                   */
/* -------------------------------------------------------------------------- */

export interface ScriptCharacter {
  /** lowercase slug used as the stable identity, e.g. "sarah" */
  key: string;
  /** display name as found in the script, e.g. "Sarah" */
  name: string;
}

export interface ScriptLine {
  /** 1-based sequence number within the script */
  sequence: number;
  /** character key (slug) */
  speaker: string;
  /** dialogue text, audio tags preserved verbatim */
  text: string;
}

export interface ParseWarning {
  code: ParseWarningCode;
  /** 1-based line number in the source text */
  line: number;
  raw: string;
  message: string;
}

export type ParseWarningCode =
  | 'UNPARSED_LINE'
  | 'DUPLICATE_CHARACTER'
  | 'EMPTY_TEXT'
  | 'LINE_HARD_CUT'
  | 'EMPTY_SCRIPT'
  | 'TRAILING_WHITESPACE';

export interface ParseResult {
  characters: ScriptCharacter[];
  lines: ScriptLine[];
  warnings: ParseWarning[];
  /** lines that did not match the `Speaker: text` pattern */
  unparsed: Array<{ line: number; raw: string }>;
}

/* -------------------------------------------------------------------------- */
/* ElevenLabs payload (docs/09)                                               */
/* -------------------------------------------------------------------------- */

export interface DialogueInput {
  text: string;
  voice_id: string;
}

export interface CreateDialogueRequest {
  inputs: DialogueInput[];
  model_id: string;
  language_code?: string;
  settings?: Record<string, unknown>;
  pronunciation_dictionary_locators?: unknown[];
  seed?: number | null;
  apply_text_normalization?: ApplyTextNormalization;
  output_format?: string;
}

export interface VoiceSegment {
  voiceId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  characterStartIndex: number;
  characterEndIndex: number;
  dialogueInputIndex: number;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
  description?: string;
}

export interface CreateDialogueResponse {
  audio: Buffer;
  mimeType: string;
}

export interface CreateDialogueWithTimestampsResponse {
  audio: Buffer;
  voiceSegments: VoiceSegment[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface ValidationIssue {
  code: string;
  message: string;
  chunkIndex?: number;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/* -------------------------------------------------------------------------- */
/* Chunking (docs/11)                                                         */
/* -------------------------------------------------------------------------- */

export interface ChunkedPayload {
  chunkIndex: number;
  startLine: number;
  endLine: number;
  characterCount: number;
  inputCount: number;
  uniqueVoiceCount: number;
  inputs: DialogueInput[];
  payload: CreateDialogueRequest;
  payloadHash: string;
}

/* -------------------------------------------------------------------------- */
/* Persistence entities (docs/07)                                             */
/* -------------------------------------------------------------------------- */

export interface Project {
  id: string;
  ownerId?: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Episode {
  id: string;
  projectId: string;
  title: string;
  languageCode: string;
  defaultModelId: string;
  status: EpisodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Script {
  id: string;
  episodeId: string;
  rawText: string;
  source: 'chatgpt' | 'manual' | 'import';
  version: number;
  createdAt: string;
}

export interface CharacterRecord extends ScriptCharacter {
  id: string;
  episodeId: string;
  createdAt: string;
}

export interface VoiceMapping {
  id: string;
  characterId: string;
  voiceId: string;
  voiceName: string | null;
  settings: Record<string, unknown> | null;
  createdAt: string;
}

export interface GenerationBatch {
  id: string;
  episodeId: string;
  scriptId: string;
  label: string;
  modelId: string;
  languageCode: string;
  settings: Record<string, unknown> | null;
  status: BatchStatus;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  /** Snapshot of the immutable generation settings used for this batch. */
  voiceMappings: Record<string, string>;
  applyTextNormalization: ApplyTextNormalization;
  seed: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GenerationChunk {
  id: string;
  batchId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  characterCount: number;
  inputCount: number;
  payload: CreateDialogueRequest;
  payloadHash: string;
  status: ChunkStatus;
  audioId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface AudioRecord {
  id: string;
  episodeId: string;
  chunkId: string | null;
  kind: AudioKind;
  storagePath: string;
  mimeType: string;
  durationSeconds: number | null;
  sizeBytes: number;
  outputFormat: string;
  metadata: Record<string, unknown> | null;
  label: string;
  deletedAt?: string | null;
  createdAt: string;
}

export interface Composition {
  id: string;
  episodeId: string;
  name: string;
  status: CompositionStatus;
  outputAudioId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompositionItem {
  id: string;
  compositionId: string;
  audioId: string;
  orderIndex: number;
  trimStartMs: number | null;
  trimEndMs: number | null;
  gapMs: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcription {
  id: string;
  audioId: string;
  languageCode: string | null;
  text: string;
  segments: TranscriptionSegment[];
  status: TranscriptionStatus;
  provider: string;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface Subtitle {
  id: string;
  transcriptionId: string;
  format: 'srt' | 'vtt';
  storagePath: string;
  content: string;
  createdAt: string;
}

export type VideoStatus = 'DRAFT' | 'PROCESSING' | 'READY' | 'FAILED';

export interface EpisodeVideo {
  id: string;
  episodeId: string;
  audioId: string;
  title: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  resolution?: 720 | 1080;
  status: VideoStatus;
  sourceMode?: 'elevenlabs' | 'uploaded' | 'cover' | 'ghost';
  ghostStyle?: string | null;
  transcriptionId?: string | null;
  prompt?: string | null;
  modelId?: string | null;
  generationId?: string | null;
  clipIds?: string[];
  subtitleId?: string | null;
  coverStoragePath?: string | null;
  storagePath: string | null;
  mimeType: 'video/mp4';
  sizeBytes: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  musicTracks?: Array<{ musicId: string; orderIndex: number; volume: number; startSeconds: number; endSeconds: number | null; outputStartSeconds: number; fadeInSeconds: number; fadeOutSeconds: number }>;
  voiceVolume?: number;
  subtitleStyle?: SubtitleStyle;
}

export type EpisodeEditTrack = 'typography' | 'sticker' | 'visual-effect' | 'sound-effect';
export interface EpisodeEditEvent {
  id: string;
  episodeVideoId: string;
  track: EpisodeEditTrack;
  startSeconds: number;
  endSeconds: number;
  text: string;
  animation: string;
  position: 'top' | 'center' | 'bottom';
  scale: number;
  opacity: number;
  volume: number;
  enabled: boolean;
  orderIndex: number;
  musicAssetId?: string | null;
  effect?: string | null;
  createdAt: string;
}

export interface SubtitleStyle {
  animation: 'karaoke' | 'word' | 'fade' | 'fade-out' | 'pop' | 'pop-out' | 'bounce' | 'typewriter' | 'word-reveal' | 'scale-punch' | 'slide' | 'shake' | 'elastic' | 'glitch' | 'rotation' | 'blur' | 'wave' | 'tracking' | 'stagger' | 'smooth' | 'edit';
  fontFamily: string; fontSize: number; fontWeight: 'regular' | 'medium' | 'bold' | 'extra-bold';
  textColor: string; highlightColor: string; alignment: 'left' | 'center' | 'right';
  position: 'top' | 'center' | 'bottom'; outlineColor: string; outlineWidth: number;
  backgroundColor: string; backgroundOpacity: number; shadow: number; lineSpacing: number; letterSpacing: number;
  preset?: 'tiktok' | 'cinematic' | 'meme' | 'minimal' | 'storytelling' | 'podcast' | 'energetic';
  intensity?: 'subtle' | 'balanced' | 'creative';
}

export interface MusicAsset {
  id: string; episodeId: string; name: string; storagePath: string; mimeType: string;
  format: 'mp3' | 'mp4'; sizeBytes: number; durationSeconds: number; status: 'READY' | 'FAILED';
  createdAt: string; errorMessage: string | null;
}

export interface VideoClip {
  id: string;
  episodeId: string;
  title: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* API transport shapes (docs/08)                                             */
/* -------------------------------------------------------------------------- */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: unknown;
  };
}

export interface BatchProgressEvent {
  type: 'chunk.updated' | 'batch.updated' | 'snapshot';
  batchId: string;
  chunkId?: string;
  chunkIndex?: number;
  status?: ChunkStatus;
  audioId?: string | null;
  errorMessage?: string | null;
  batchStatus?: BatchStatus;
  completedChunks?: number;
  failedChunks?: number;
  totalChunks?: number;
  at: string;
}
