// Result projections — the three tiers.
//
// One pipeline produces one stored result; the tier a developer sees is a projection of
// it, gated by the scopes on their key. Building it this way means:
//   - the AI runs once no matter which tier was bought,
//   - widening a key's scopes later retroactively unlocks richer views of old jobs,
//   - a narrow key never receives a byte of the detail it did not pay for.
//
//   full        transcript + annotation detail + report        (all three scopes)
//   transcript  segments, speakers, word timings, plain text   (transcript:read)
//   report      counts and metrics only, no words at all       (report:read)

import { Scope } from './auth';

export type View = 'full' | 'transcript' | 'report';

/** Annotation arrays the AI attaches per segment. Everything else in a segment is transcript. */
const ANNOTATION_FIELDS = [
  'pauses',
  'fillerwords',
  'repetitions',
  'revisions',
  'revision',
  'mispronunciation',
  'morphemes',
  'morpheme_omissions',
  'utterance-error',
] as const;

function segmentText(segment: any): string {
  if (typeof segment.text === 'string' && segment.text.trim()) return segment.text.trim();
  return (segment.words || []).map((w: any) => w.word).join(' ').trim();
}

/** Transcript view of one segment: who spoke, when, what — no annotation detail. */
function transcriptSegment(segment: any, index: number) {
  return {
    index,
    speaker: segment.speaker ?? null,
    start: segment.start ?? null,
    end: segment.end ?? null,
    text: segmentText(segment),
    words: (segment.words || []).map((w: any, i: number) => ({
      index: w.index ?? i,
      word: w.word,
      start: w.start ?? null,
      end: w.end ?? null,
    })),
  };
}

/** Annotation view of one segment: only the marked-up detail, keyed back by segment index. */
function annotationSegment(segment: any, index: number) {
  const out: Record<string, unknown> = { index, speaker: segment.speaker ?? null };
  let any = false;
  for (const field of ANNOTATION_FIELDS) {
    const v = (segment as any)[field];
    if (Array.isArray(v) && v.length > 0) {
      out[field] = v;
      any = true;
    }
  }
  return any ? out : null;
}

export interface ProjectOptions {
  view: View;
  scopes: string[];
  transcript: any | null;
  report: any | null;
  noText: boolean;
}

/**
 * Build the response body for a finished job.
 *
 * A view the key lacks the scope for is omitted and named in `omitted`, rather than 403'd —
 * a developer with a report-only key asking for `view=full` should still get their report,
 * plus a clear statement of what was withheld and why.
 */
export function projectResult(opts: ProjectOptions): { result: Record<string, unknown>; omitted: string[] } {
  const { view, scopes, transcript, report, noText } = opts;
  const has = (s: Scope) => scopes.includes(s);
  const segments: any[] = transcript?.segments || [];

  const wantTranscript = view === 'full' || view === 'transcript';
  const wantAnnotations = view === 'full';
  const wantReport = view === 'full' || view === 'report';

  const result: Record<string, unknown> = {};
  const omitted: string[] = [];

  if (wantTranscript) {
    if (has('transcript:read')) {
      const projected = segments.map(transcriptSegment);
      result.transcript = {
        text: projected.map((s) => s.text).filter(Boolean).join(' '),
        segments: projected,
      };
    } else {
      omitted.push('transcript');
    }
  }

  if (wantAnnotations) {
    if (has('annotations:read')) {
      result.annotations = {
        segments: segments.map(annotationSegment).filter(Boolean),
      };
    } else {
      omitted.push('annotations');
    }
  }

  if (wantReport) {
    if (has('report:read')) {
      result.report = report ?? null;
    } else {
      omitted.push('report');
    }
  }

  // A take with no speech is a legitimate outcome, not an error. Say so explicitly so a
  // caller does not read empty arrays as a failed transcription.
  if (noText) result.no_speech_detected = true;

  return { result, omitted };
}

/** The `report` view standing alone, used by GET /v1/jobs/:id/report. */
export function reportOnly(report: any | null) {
  return report ?? null;
}
