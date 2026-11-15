import { SRT_RULES } from './constants';
import type { TranscriptionSegment } from '@podcast/types';
import { pad } from './utils';

/**
 * `123.456` -> `00:02:03,456` (docs/15 §15.4).
 *
 * Rounds to the nearest millisecond first: `2.34 % 1` is `0.3399999...` in
 * IEEE-754, so truncating directly would emit `,339` instead of `,340`.
 */
export function toSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = (totalMs - ms) / 1000;
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** `00:02:03,456` -> `123.456`; inverse of toSrtTime, used by round-trip tests. */
export function fromSrtTime(value: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/**
 * Wrap text to lines of at most `maxChars`, never splitting a word.
 *
 * A single word wider than `maxChars` is allowed to overflow; the line budget
 * is applied by the cue renderer so text is never silently discarded.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  return lines;
}

function groupCueLines(lines: string[], maxLines: number): string[][] {
  const groups: string[][] = [];
  for (let index = 0; index < lines.length; index += maxLines) {
    groups.push(lines.slice(index, index + maxLines));
  }
  return groups;
}

/**
 * Merge very short segments with their neighbour so the subtitle does not flash
 * (docs/15 §15.3: "Merge segment < 1s liền nhau").
 */
export function mergeShortSegments(
  segments: TranscriptionSegment[],
  threshold = SRT_RULES.MERGE_THRESHOLD_S,
): TranscriptionSegment[] {
  if (segments.length === 0) return [];

  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const out: TranscriptionSegment[] = [];

  for (const segment of sorted) {
    const previous = out[out.length - 1];
    const duration = segment.end - segment.start;
    if (!previous) {
      out.push({ ...segment });
      continue;
    }
    const previousDuration = previous.end - previous.start;
    const tooShort = duration < threshold || previousDuration < threshold;

    if (tooShort && segment.end - previous.start <= SRT_RULES.MAX_CUE_DURATION_S) {
      previous.text = `${previous.text} ${segment.text}`.trim();
      previous.end = segment.end;
      continue;
    }
    out.push({ ...segment });
  }

  // A trailing cue that is still too short gets absorbed by its predecessor.
  const last = out[out.length - 1];
  if (out.length > 1 && last.end - last.start < threshold) {
    const previous = out[out.length - 2];
    if (last.end - previous.start <= SRT_RULES.MAX_CUE_DURATION_S) {
      previous.text = `${previous.text} ${last.text}`.trim();
      previous.end = last.end;
      out.pop();
    } else {
      last.end = last.start + threshold;
    }
  }

  return out;
}

/** Clamp cue durations into [MIN, MAX] without changing ordering. */
export function enforceCueDurations(
  segments: TranscriptionSegment[],
): TranscriptionSegment[] {
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    let end = segment.end;
    if (end - segment.start < SRT_RULES.MIN_CUE_DURATION_S) {
      end = segment.start + SRT_RULES.MIN_CUE_DURATION_S;
    }
    if (end - segment.start > SRT_RULES.MAX_CUE_DURATION_S) {
      end = segment.start + SRT_RULES.MAX_CUE_DURATION_S;
    }
    // Never overlap the following cue.
    if (next && end > next.start) end = next.start;
    if (end <= segment.start) end = segment.start + 0.5;
    return { ...segment, end };
  });
}

export interface SrtOptions {
  maxLinesPerCue?: number;
  maxCharsPerLine?: number;
  /** Skip the short-segment merge pass (useful for precise word timing tests). */
  skipMerge?: boolean;
}

/**
 * Render transcription segments as an SRT document.
 *
 * Rules from docs/15 §15.3: ≤2 lines, ≤42 chars/line, no mid-word splits,
 * 1s–7s cue duration, short segments merged.
 */
export function generateSrt(
  segments: TranscriptionSegment[],
  options: SrtOptions = {},
): string {
  const {
    maxLinesPerCue = SRT_RULES.MAX_LINES_PER_CUE,
    maxCharsPerLine = SRT_RULES.MAX_CHARS_PER_LINE,
    skipMerge = false,
  } = options;

  if (!Number.isInteger(maxLinesPerCue) || maxLinesPerCue < 1) {
    throw new RangeError('maxLinesPerCue must be a positive integer.');
  }
  if (!Number.isInteger(maxCharsPerLine) || maxCharsPerLine < 1) {
    throw new RangeError('maxCharsPerLine must be a positive integer.');
  }

  if (segments.length === 0) return '';

  const prepared = skipMerge
    ? segments.map((s) => ({ ...s }))
    : enforceCueDurations(mergeShortSegments(segments));

  const blocks: string[] = [];
  let sequence = 1;

  prepared.forEach((segment) => {
    const text = segment.text.trim();
    if (text === '') return;

    const groups = groupCueLines(wrapText(text, maxCharsPerLine, maxLinesPerCue), maxLinesPerCue);
    const totalCharacters = text.split(/\s+/).join(' ').length;
    let consumedCharacters = 0;
    const duration = segment.end - segment.start;

    groups.forEach((lines, index) => {
      const cueText = lines.join(' ');
      const cueWeight = cueText.length + (index < groups.length - 1 ? 1 : 0);
      const start = segment.start + duration * (consumedCharacters / totalCharacters);
      consumedCharacters += cueWeight;
      const end = index === groups.length - 1
        ? segment.end
        : segment.start + duration * (consumedCharacters / totalCharacters);
      blocks.push([
        String(sequence++),
        `${toSrtTime(start)} --> ${toSrtTime(end)}`,
        ...lines,
      ].join('\n'));
    });
  });

  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}

/** WebVTT equivalent, sharing the same cue preparation. */
export function generateVtt(segments: TranscriptionSegment[]): string {
  if (segments.length === 0) return 'WEBVTT\n';

  const prepared = enforceCueDurations(mergeShortSegments(segments));
  const toVttTime = (seconds: number) => toSrtTime(seconds).replace(',', '.');

  const blocks: string[] = [];
  let sequence = 1;
  prepared.forEach((segment) => {
    const text = segment.text.trim();
    if (!text) return;
    const groups = groupCueLines(
      wrapText(text, SRT_RULES.MAX_CHARS_PER_LINE, SRT_RULES.MAX_LINES_PER_CUE),
      SRT_RULES.MAX_LINES_PER_CUE,
    );
    const totalCharacters = text.split(/\s+/).join(' ').length;
    let consumedCharacters = 0;
    const duration = segment.end - segment.start;

    groups.forEach((lines, index) => {
      const cueText = lines.join(' ');
      const cueWeight = cueText.length + (index < groups.length - 1 ? 1 : 0);
      const start = segment.start + duration * (consumedCharacters / totalCharacters);
      consumedCharacters += cueWeight;
      const end = index === groups.length - 1
        ? segment.end
        : segment.start + duration * (consumedCharacters / totalCharacters);
      blocks.push([
        String(sequence++),
        `${toVttTime(start)} --> ${toVttTime(end)}`,
        ...lines,
      ].join('\n'));
    });
  });

  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** Parse an SRT document back into segments (round-trip / import support). */
export function parseSrt(content: string): TranscriptionSegment[] {
  const normalised = content.replace(/\r\n?/g, '\n').trim();
  if (normalised === '') return [];

  return normalised
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (lines.length < 2) return null;
      const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
      if (timeLineIndex === -1) return null;
      const [rawStart, rawEnd] = lines[timeLineIndex].split('-->').map((s) => s.trim());
      const text = lines.slice(timeLineIndex + 1).join('\n').trim();
      if (text === '') return null;
      return { start: fromSrtTime(rawStart), end: fromSrtTime(rawEnd), text };
    })
    .filter((s): s is TranscriptionSegment => s !== null);
}
