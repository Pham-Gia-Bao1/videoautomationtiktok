/** Local generation limits and defaults; see docs/09-elevenlabs-integration.md. */
export const ELEVENLABS_LIMITS = {
  /** Maximum dialogue characters processed as one local generation chunk. */
  MAX_CHARS_PER_REQUEST: 2000,
  DEFAULT_MODEL_ID: 'eleven_v3',
  DEFAULT_OUTPUT_FORMAT: 'mp3_44100_128',
} as const;

/**
 * Models accepted by the text-to-speech endpoint used for each dialogue line.
 */
export const ALLOWED_MODEL_IDS = ['eleven_v3', 'eleven_v3_conversational', 'eleven_multilingual_v2'] as const;

export const ALLOWED_LANGUAGE_CODES = [
  'en', 'vi', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'it', 'pt', 'ru',
  'ar', 'hi', 'nl', 'pl', 'tr', 'sv', 'id', 'fil', 'uk',
] as const;

export const ALLOWED_OUTPUT_FORMATS = [
  'mp3_44100_128',
  'mp3_44100_192',
  'mp3_22050_32',
  'mp3_44100_64',
] as const;

export const ALLOWED_TEXT_NORMALIZATION = ['auto', 'on', 'off'] as const;

/** SRT authoring rules. See docs/15-speech-to-text-srt.md §15.3 */
export const SRT_RULES = {
  MAX_LINES_PER_CUE: 2,
  MAX_CHARS_PER_LINE: 42,
  MIN_CUE_DURATION_S: 1,
  MAX_CUE_DURATION_S: 7,
  /** Segments shorter than this are merged into a neighbour. */
  MERGE_THRESHOLD_S: 1,
} as const;

/** FFmpeg / merge pipeline. See docs/14-ffmpeg-merge-pipeline.md */
export const MERGE_RULES = {
  FFMPEG_TIMEOUT_MS: 5 * 60 * 1000,
  MAX_GAP_MS: 10_000,
  DEFAULT_SILENCE_SAMPLE_RATE: 44100,
} as const;

/** Retry policy. See docs/18-error-handling-retry.md §18.2 */
export const RETRY_POLICY = {
  MAX_ATTEMPTS: 3,
  BASE_BACKOFF_MS: 3000,
  MAX_RETRY_COUNT: 5,
} as const;

/** Script parsing. See docs/10-script-parser-payload-mapper.md §10.1 */
export const SCRIPT_PATTERNS = {
  /**
   * `Speaker: text`.
   *
   * The speaker part is `(?:\\.|[^:\\])+?` — either an escaped character
   * (so `Time\: Lord` keeps its literal colon) or any ordinary non-colon
   * character. Because non-colon characters are allowed verbatim, names with
   * diacritics (`Renée`, `Nguyễn`) and punctuation (`Dr. Smith`, `O'Brien`)
   * all match. Laziness (`+?`) keeps the terminator at the *first* unescaped
   * colon.
   */
  SPEAKER_LINE: /^(?<speaker>(?:\\.|[^:\\])+?)\s*:\s*(?<text>.*)$/,
  AUDIO_TAG_BRACKETED: /\[[^\]\n]{1,60}\]/g,
  AUDIO_TAG_PAREN: /\([^)\n]{1,60}\)/g,
  /**
   * Characters permitted in a speaker name once escapes are resolved. A colon
   * is allowed here because only an *escaped* colon can reach this point.
   */
  SPEAKER_ALLOWED: /^[\p{L}\p{N} _\-'.:]+$/u,
} as const;
