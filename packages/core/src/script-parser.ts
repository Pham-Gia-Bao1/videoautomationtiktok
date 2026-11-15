import { SCRIPT_PATTERNS } from './constants';
import { AppError, ERROR_CODES } from './errors';
import type { ParseResult, ParseWarning, ScriptCharacter, ScriptLine } from '@podcast/types';

function speakerKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '_')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export interface ParseOptions {
  /**
   * When true, consecutive lines from the same speaker are joined into one
   * turn. Useful when ChatGPT emits a paragraph per sentence.
   */
  mergeAdjacent?: boolean;
  /**
   * When false (default) an unterminated line inside a multi-line block is
   * treated as a continuation of the previous turn rather than a warning.
   */
  continueUnparsedLines?: boolean;
}

/** Split raw text into logical lines, normalising CRLF and trimming edges. */
function toLogicalLines(rawText: string): string[] {
  return rawText.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Unescape `Name\:` -> `Name:`. The parser pattern refuses to treat a
 * backslash-escaped colon as a separator (docs/10 §10.4).
 */
function unescapeSpeaker(speaker: string): string {
  return speaker.replace(/\\:/g, ':').replace(/\\([\\])/g, '$1').trim();
}

/**
 * Collapse internal newlines inside a dialogue block into single spaces so the
 * resulting payload text is a single line (docs/10 §10.4).
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Parse a raw dialogue script into characters + ordered lines.
 *
 * Grammar (docs/10 §10.1):
 *   - `^Speaker: text$` starts a new turn.
 *   - Blank lines are skipped as separators.
 *   - A non-matching line following a turn is appended to that turn's text.
 *   - A non-matching line with no preceding turn is reported in `unparsed`.
 */
export function parseScript(rawText: string, options: ParseOptions = {}): ParseResult {
  const { mergeAdjacent = false, continueUnparsedLines = true } = options;
  const warnings: ParseWarning[] = [];
  const unparsed: Array<{ line: number; raw: string }> = [];
  const characters = new Map<string, ScriptCharacter>();
  const lines: ScriptLine[] = [];

  if (!rawText || rawText.trim().length === 0) {
    warnings.push({
      code: 'EMPTY_SCRIPT',
      line: 0,
      raw: '',
      message: 'Script is empty.',
    });
    return { characters: [], lines: [], warnings, unparsed };
  }

  const source = toLogicalLines(rawText);

  for (let i = 0; i < source.length; i++) {
    const raw = source[i];
    const lineNumber = i + 1;
    const trimmed = raw.trim();

    if (trimmed === '') continue;

    const match = SCRIPT_PATTERNS.SPEAKER_LINE.exec(trimmed);

    if (!match?.groups) {
      const previous = lines[lines.length - 1];
      if (continueUnparsedLines && previous && !isBlankBetween(source, i)) {
        previous.text = collapseWhitespace(`${previous.text} ${trimmed}`);
        warnings.push({
          code: 'UNPARSED_LINE',
          line: lineNumber,
          raw,
          message: `Line did not match 'Speaker: text'; appended to ${previous.speaker}.`,
        });
        continue;
      }

      unparsed.push({ line: lineNumber, raw });
      warnings.push({
        code: 'UNPARSED_LINE',
        line: lineNumber,
        raw,
        message: "Line did not match the 'Speaker: text' pattern and was skipped.",
      });
      continue;
    }

    const name = unescapeSpeaker(match.groups.speaker);
    const text = collapseWhitespace(match.groups.text ?? '');

    // The regex accepts any non-colon run as a candidate speaker, so reject
    // names containing characters that cannot be a speaker label. This keeps
    // prose like "Wait, really: no." from being mistaken for a turn.
    if (name === '' || name.length > 64 || !SCRIPT_PATTERNS.SPEAKER_ALLOWED.test(name)) {
      unparsed.push({ line: lineNumber, raw });
      warnings.push({
        code: 'UNPARSED_LINE',
        line: lineNumber,
        raw,
        message: "Line did not match the 'Speaker: text' pattern and was skipped.",
      });
      continue;
    }

    const key = speakerKey(name);

    if (key === '') {
      unparsed.push({ line: lineNumber, raw });
      warnings.push({
        code: 'UNPARSED_LINE',
        line: lineNumber,
        raw,
        message: 'Speaker name normalised to an empty key and was skipped.',
      });
      continue;
    }

    if (!characters.has(key)) {
      characters.set(key, { key, name });
    } else if (characters.get(key)!.name !== name) {
      // Two spellings of the same speaker ("SARAH" / "Sarah") collapse to one
      // character key; warn so the user can confirm it is intentional.
      warnings.push({
        code: 'DUPLICATE_CHARACTER',
        line: lineNumber,
        raw,
        message: `Speaker '${name}' merged with existing character key '${key}'.`,
      });
    }

    if (text === '') {
      warnings.push({
        code: 'EMPTY_TEXT',
        line: lineNumber,
        raw,
        message: `Speaker '${name}' has no dialogue text.`,
      });
      continue;
    }

    const previous = lines[lines.length - 1];
    if (mergeAdjacent && previous && previous.speaker === key) {
      previous.text = collapseWhitespace(`${previous.text} ${text}`);
      continue;
    }

    lines.push({ sequence: lines.length + 1, speaker: key, text });
  }

  return {
    characters: Array.from(characters.values()),
    lines,
    warnings,
    unparsed,
  };
}

/** True when only blank lines separate index `i` from the previous content. */
function isBlankBetween(source: string[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    if (source[j].trim() !== '') return false;
    return true;
  }
  return true;
}

/**
 * Strict variant used by API endpoints: throws instead of returning an empty
 * result so the caller can answer 400 VALIDATION_FAILED.
 */
export function parseScriptOrThrow(rawText: string, options: ParseOptions = {}): ParseResult {
  const result = parseScript(rawText, options);
  if (result.lines.length === 0) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Script contains no parseable dialogue lines. Use the "Speaker: text" format.',
      400,
    );
  }
  return result;
}

/** Names that share a slug with another name are listed for UI display. */
export function findAmbiguousSpeakerKeys(result: ParseResult): string[] {
  const byKey = new Map<string, Set<string>>();
  for (const line of result.lines) {
    const set = byKey.get(line.speaker) ?? new Set<string>();
    set.add(line.speaker);
    byKey.set(line.speaker, set);
  }
  return result.warnings
    .filter((w) => w.code === 'DUPLICATE_CHARACTER')
    .map((w) => w.raw);
}
