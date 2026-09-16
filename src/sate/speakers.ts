import { Recording, TranscriptSegment } from "../protocol";

// Renaming a speaker — the ONLY edit the SATE app allows.
//
// Everything else in a report is produced by the clinical pipeline and is
// read-only here: the words, the timings, the analysis, the error counts. This
// module exists so that rule is enforced by the code rather than by whichever
// screen happens to call it.
//
// WHERE THE NAME LIVES: there is no separate "speaker names" store, and adding
// one would have been wrong. The web app's transcript editor already renames a
// speaker by rewriting `segment.speaker` on every segment that carries it, and
// that field IS the display name. Mobile does exactly the same thing, so a name
// typed on the phone is the same name the web app and the SATE report show.

/** One speaker as it appears in a transcript, with how much they said. */
export interface SpeakerRow {
  /** The current value of `segment.speaker` — both the id and the display name. */
  id: string;
  segments: number;
  /** Seconds of speech, for ordering: the main speaker should be first. */
  seconds: number;
}

/** Distinct speakers in a transcript, most-talkative first. */
export function speakersOf(segments: TranscriptSegment[] | undefined): SpeakerRow[] {
  const by = new Map<string, SpeakerRow>();
  for (const s of segments ?? []) {
    const id = (s.speaker ?? "").trim();
    // A segment with no speaker cannot be renamed and must not invent a row.
    if (!id) continue;
    const row = by.get(id) ?? { id, segments: 0, seconds: 0 };
    row.segments += 1;
    row.seconds += Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0));
    by.set(id, row);
  }
  return [...by.values()].sort((a, b) => b.seconds - a.seconds);
}

/** What a name must satisfy before it is allowed to replace a speaker id. */
export function checkName(
  next: string,
  current: string,
  all: SpeakerRow[]
): { ok: true; name: string } | { ok: false; why: string } {
  const name = next.trim();
  if (!name) return { ok: false, why: "Enter a name." };
  if (name === current) return { ok: false, why: "That is already the name." };
  // Two speakers sharing one name would MERGE them everywhere the transcript is
  // read — including the analysis, which counts speakers. That is not a rename,
  // it is a data change the user did not ask for, so it is refused rather than
  // quietly performed.
  if (all.some((s) => s.id !== current && s.id === name)) {
    return { ok: false, why: `Another speaker is already called "${name}".` };
  }
  if (name.length > 60) return { ok: false, why: "That name is too long." };
  return { ok: true, name };
}

/**
 * A copy of the transcript with ONE speaker renamed and nothing else touched.
 *
 * Every segment is returned as the same object unless its speaker matches, and
 * a matching segment is spread so only `speaker` differs. Rebuilding segments
 * field-by-field would silently drop anything this app does not know about —
 * `words`, `text_clean`, and whatever the pipeline adds next — and the save
 * would erase it from the server copy.
 */
export function renameSpeaker(
  recording: Recording,
  from: string,
  to: string
): { transcript: Record<string, unknown>; changed: number } {
  const t = (recording.transcript ?? {}) as { segments?: TranscriptSegment[] } & Record<
    string,
    unknown
  >;
  let changed = 0;
  const segments = (t.segments ?? []).map((s) => {
    if ((s.speaker ?? "") !== from) return s;
    changed += 1;
    return { ...s, speaker: to };
  });
  // Spread the transcript too: `filename` and anything else on it survives.
  return { transcript: { ...t, segments }, changed };
}
