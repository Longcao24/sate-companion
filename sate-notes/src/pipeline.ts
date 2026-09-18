// The notes pipeline: audio -> transcript -> summary. Full Workers AI, no GPU of our own.
//
// ⚠️ WHY THIS IS A WORKFLOW AND NOT A fetch() HANDLER.
// A long transcription cannot be awaited inside a serverless request. A Supabase edge
// function dies at ~150 s and a plain Worker at the ~100 s origin timeout — mid-fetch,
// BEFORE any catch block runs — so the job strands in `processing` with no error ever
// written. The clinical lane learned this expensively (a 32-minute take once sat stuck for
// 70 minutes: kill -> retry -> kill) and solved it with a long-lived container. Workflows
// are the Cloudflare-native answer to the same problem: durable execution, each step retried
// independently, no wall-clock ceiling. Do not "simplify" this back into the upload request.
//
// Cost shape, which drives the design (Workers AI list prices, 2026-09):
//   Whisper large-v3-turbo   $0.00051 / audio minute  -> 1 hour = $0.031   (~96% of the bill)
//   llama-3.1-8b-fp8-fast    $0.045/M in, $0.384/M out -> 1 hour ≈ $0.0013 (~4%)
// So the transcript is computed ONCE and stored; summaries are cheap, re-runnable, and keyed
// by (note, template, model) in their own table. Upgrading the summary model costs less than
// the ASR it rides on — never trade summary quality for money here.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './index';
import { newId, wavHeader } from './util';

export interface PipelineParams {
  noteId: string;
  /** Re-run the summary only, from the stored transcript. Skips ASR entirely. */
  summaryOnly?: boolean;
  /** Which summary shape to produce; see TEMPLATES. Defaults to 'meeting'. */
  template?: string;
  /** Override the summary model for this run. Must be a @cf/ model — see assertCloudflareModel. */
  model?: string;
}

/**
 * ⚠️ CLOUDFLARE-HOSTED MODELS ONLY. This is a product constraint, not a preference: the notes
 * lane runs entirely on Cloudflare and must not develop a dependency on a third-party
 * inference API — no key to rotate, no second vendor to be down, no data leaving the account.
 * Enforced here rather than only documented, because a model id is a config string and config
 * drifts. Every id must be `@cf/…`; anything else fails the job loudly instead of quietly
 * shipping audio somewhere else.
 */
export function assertCloudflareModel(model: string, what: string): string {
  if (!model || !model.startsWith('@cf/')) {
    throw new Error(`${what} must be a Cloudflare-hosted @cf/ model, got "${model}"`);
  }
  // ⚠️ The `@cf/` prefix is NO LONGER proof of "Cloudflare-hosted". The catalog now carries
  // partner routes that are billed and namespaced the same way but marked Third-party, and
  // some of them are speech models — `@cf/xai/grok-stt` is one. A prefix check would wave those
  // straight through and audio would leave the account, which is the exact thing this guard
  // exists to prevent. So the vendor is allowlisted explicitly: adding a model is a deliberate
  // edit here, with the Cloudflare-hosted label checked on its model page first.
  const vendor = model.slice('@cf/'.length).split('/')[0];
  if (!CF_HOSTED_VENDORS.has(vendor)) {
    throw new Error(
      `${what} "${model}" is not on the Cloudflare-hosted allowlist (vendor "${vendor}"). ` +
      'Third-party routes share the @cf/ namespace but send audio off the account — add the ' +
      'vendor to CF_HOSTED_VENDORS only after confirming the model page says Cloudflare-hosted.',
    );
  }
  return model;
}

/** Vendors whose @cf/ models are hosted ON Cloudflare infrastructure (checked per model page). */
const CF_HOSTED_VENDORS = new Set([
  'openai',    // whisper-*
  'deepgram',  // nova-3 (partner, but Cloudflare-hosted)
  'meta',      // llama-*
  'baai', 'google', 'mistral', 'qwen', 'microsoft', 'nvidia', 'zhipuai',
]);

export interface TemplateSection {
  key: string; title: string; hint: string;
  /** This section exists only to report what was said around the user's highlight presses. With
   *  no presses there is nothing for it to be ABOUT, so it is removed from the prompt entirely
   *  — a model asked for it anyway does not answer []; it picks three moments and calls them
   *  highlights, which reads to the user as "these are the bits you marked". */
  needsMarks?: boolean;
}
export interface TemplateDef {
  label: string;
  steer: string;
  /** The ONLY sections this template produces. Anything else the model returns is dropped. */
  sections: TemplateSection[];
  /** Time-based navigation only makes sense for a recording with distinct stretches. */
  chapters: boolean;
}

/**
 * Summary shapes.
 *
 * ⚠️ A template must change WHAT IS EXTRACTED, not just the tone. The first version of this
 * asked every template for the same six fields, so a lecture was still asked for "action
 * items" — and a model asked for a field the recording cannot support does not return []; it
 * INVENTS one. Every section below is a surface for that, which is why each template declares
 * exactly the sections it wants and `sanitise()` drops the rest.
 *
 * The smallest template is the safest: `tasks` has one section and almost nothing to fabricate.
 */
export const TEMPLATES: Record<string, TemplateDef> = {
  meeting: {
    label: 'Meeting',
    steer: 'This is a meeting or conversation. Focus on decisions, who owns them, and what happens next.',
    chapters: true,
    sections: [
      { key: 'bullets',    title: 'Key points',   hint: 'the substantive points actually made' },
      { key: 'actions',    title: 'Action items', hint: 'only a follow-up someone actually committed to or was asked to do' },
      { key: 'highlights', title: 'Highlights',   hint: 'what was said around the moments the user marked', needsMarks: true },
    ],
  },
  supervision: {
    label: 'Supervision / 1:1',
    steer: 'This is a supervision or one-to-one session. One person is reviewing another\'s work and giving feedback.',
    chapters: false,
    sections: [
      { key: 'reviewed', title: 'What was reviewed', hint: 'the cases, work or material actually gone over' },
      { key: 'feedback', title: 'Feedback',          hint: 'the guidance given, in the words it was given' },
      { key: 'agreed',   title: 'Agreed actions',    hint: 'only what was actually agreed to' },
      { key: 'next',     title: 'Next check-in',     hint: 'the next meeting or deadline, if one was named' },
    ],
  },
  interview: {
    label: 'Interview',
    steer: 'This is an interview. Preserve the interviewee\'s own words where they matter.',
    chapters: true,
    sections: [
      { key: 'qa',        title: 'Questions & answers', hint: 'one entry per question asked, with the substance of the answer' },
      { key: 'quotes',    title: 'Notable quotes',      hint: 'verbatim only — never paraphrase into this section' },
      { key: 'followups', title: 'Worth asking next',   hint: 'only a question the conversation itself left open' },
    ],
  },
  research: {
    label: 'Research / lab',
    steer: 'This is a research or lab discussion.',
    chapters: true,
    sections: [
      { key: 'hypotheses', title: 'Hypotheses',       hint: 'what was proposed or questioned' },
      { key: 'results',    title: 'Results discussed', hint: 'findings actually reported in the recording' },
      { key: 'blockers',   title: 'Blockers',          hint: 'what is stopping progress' },
      { key: 'nextsteps',  title: 'Next experiments',  hint: 'what was decided to try next' },
    ],
  },
  tasks: {
    label: 'Just the tasks',
    steer: 'Extract only what someone has to DO. Ignore everything else, however interesting.',
    chapters: false,
    sections: [
      { key: 'actions', title: 'Action items', hint: 'one per task, with the owner and the deadline if either was said' },
    ],
  },
  idea: {
    label: 'Thinking out loud',
    steer: 'This is someone thinking out loud. Keep the threads distinct and do not tidy away uncertainty.',
    chapters: false,
    sections: [
      { key: 'threads',   title: 'Threads',        hint: 'each distinct line of thought, in their own phrasing where it matters' },
      { key: 'questions', title: 'Open questions', hint: 'what they left unresolved' },
    ],
  },
};

export const DEFAULT_TEMPLATE = 'meeting';

/** 16 kHz mono s16le => 32000 bytes per second of audio. */
const BYTES_PER_SEC = 32000;
const WAV_HEADER = 44;
/** Above this many characters the transcript is summarised map-reduce style, not in one go. */
const MAX_SUMMARY_CHARS = 48000;
/** Shorter than this and the recording is treated as empty without ever calling the model. */
const MIN_AUDIO_SEC = 0.6;
/** Below this many words a transcript is a fragment, not a meeting: summarise it as one. */
const THIN_TRANSCRIPT_WORDS = 60;
/**
 * At or above this many words the recording is a full-length conversation and the summary is
 * expected to COVER it rather than compress it.
 *
 * The anti-padding rules exist because a model handed a thin transcript invents to fill the
 * shape it was asked for. They do not mean short is always right: a 36-minute, ~5,000-word
 * meeting came back as six bullets and two chapters, which is the opposite failure — most of
 * what was actually said simply never made it out. Both are the same mistake, a summary whose
 * length is decided by the template instead of by the recording, so the prompt now states which
 * of the two situations this is. Note what this instruction is careful NOT to be: it asks for
 * COVERAGE of what exists, never for a number of items. Asking for "8-15 bullets" is what
 * forces invention; asking for "every topic that was actually discussed" cannot.
 */
const LONG_TRANSCRIPT_WORDS = 700;

interface NoteRow {
  id: string; user_id: string; bytes: number; sample_rate: number;
  storage_key: string | null; flags: string | null; duration_s: number | null;
}

interface Seg { start: number; end: number; text: string; speaker?: number }

/** What one chunk heard. `overlap` is the re-heard tail of the PREVIOUS window: its text is a
 *  duplicate and is thrown away, but its speaker labels are the only bridge between two
 *  independently-diarized chunks. */
export interface ChunkResult { kept: Seg[]; overlap: Seg[] }

/**
 * Fire-and-forget from the upload request. The instance id is the note id, so a retried
 * final slice cannot start a second pipeline for the same recording.
 */
export function startPipeline(env: Env, ctx: ExecutionContext, noteId: string) {
  const p = env.PIPELINE.create({ id: noteId, params: { noteId } })
    .catch((e) => console.error(`[pipeline] create failed for ${noteId}`, e));
  // Without waitUntil the Worker may be killed the moment it responds, dropping the kick.
  try { ctx.waitUntil(p); } catch { /* best effort */ }
}

export class NotePipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const env = this.env;
    const noteId = event.payload.noteId;
    const template = event.payload.template || 'meeting';
    const model = assertCloudflareModel(event.payload.model || env.SUMMARY_MODEL, 'SUMMARY_MODEL');

    // Re-summarise only: the transcript already exists, so skip ASR entirely. This is the
    // cheap path (~4% of the cost of the original run) and the whole point of storing the
    // transcript separately from the summaries.
    if (event.payload.summaryOnly) {
      await step.do(`re-summarise (${template})`, async () => {
        const tr = await env.DB.prepare(`SELECT text, segments FROM transcripts WHERE note_id = ?`)
          .bind(noteId).first<{ text: string; segments: string | null }>();
        if (!tr?.text?.trim()) throw new Error(`note ${noteId} has no transcript to summarise`);
        // Re-summarising must see the same annotated transcript the first run did, or a
        // different template would silently lose the timestamps and the speakers.
        let segs: Seg[] = [];
        try { segs = tr.segments ? JSON.parse(tr.segments) : []; } catch { segs = []; }
        const annotated = segs.length ? promptTranscript(segs) : tr.text;
        const row = await env.DB.prepare(`SELECT flags, duration_s FROM notes WHERE id = ?`)
          .bind(noteId).first<{ flags: string | null; duration_s: number | null }>();
        const flags: number[] = row?.flags ? JSON.parse(row.flags) : [];
        const summary = await summarise(env, annotated, flags, template, model, row?.duration_s || 0);
        await env.DB.prepare(
          `INSERT INTO summaries (id, note_id, template, model, json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(note_id, template, model) DO UPDATE SET json = excluded.json`,
        ).bind(newId('sum'), noteId, template, model, JSON.stringify(summary)).run();
        // ⚠️ Do NOT rename the note for a non-default template. The title is the note's identity
        // in the list; letting whichever template you happened to view last rewrite it means
        // reading a recording a different way renames it, and the sidebar stops matching the
        // page. Only the default template — or a note that has no title yet — sets it.
        const isDefault = template === DEFAULT_TEMPLATE;
        await env.DB.prepare(
          `UPDATE notes SET status = 'done', error = NULL,
                            title = CASE WHEN ? OR title IS NULL OR title = '' THEN ? ELSE title END,
                            updated_at = ?
            WHERE id = ?`,
        ).bind(isDefault ? 1 : 0, summary.title || 'Untitled note', new Date().toISOString(), noteId).run();
      });
      return;
    }

    const note = await step.do('load note', async () => {
      const row = await env.DB.prepare(
        `SELECT id, user_id, bytes, sample_rate, storage_key, flags, duration_s FROM notes WHERE id = ?`,
      ).bind(noteId).first<NoteRow>();
      if (!row) throw new Error(`note ${noteId} not found`);
      if (!row.storage_key) throw new Error(`note ${noteId} has no audio`);
      await setStatus(env, noteId, 'transcribing');
      return row;
    });

    // Too short to contain speech — an accidental tap on the record button. Finish it here,
    // BEFORE the AI call.
    //
    // This guard is inherited, not invented: the clinical lane discovered that its AI service
    // returns 500 on a near-empty WAV, a 5xx is classified transient, and the job retry-looped
    // into a stuck error (a real ~32 ms take did exactly this). Whisper does something worse
    // than erroring — it HALLUCINATES. Handed a tone or a room hum it confidently returns
    // "Thank you." So a short take must never reach the model at all.
    if ((note.duration_s ?? 0) < MIN_AUDIO_SEC) {
      await step.do('finish too-short', async () => {
        await env.DB.prepare(
          `UPDATE notes SET status = 'done', title = 'Empty recording', updated_at = ? WHERE id = ?`,
        ).bind(new Date().toISOString(), noteId).run();
      });
      return;
    }

    // Already transcribed? SATE's clinical pipeline runs ASR on every device session, and
    // `ingest` seeds that transcript onto the note when the session has one. Transcribing it
    // again is the single most expensive thing this lane does (ASR ~96% of the bill) and it
    // buys nothing — worse, two independent ASR runs over one recording disagree in small
    // ways, and nobody should have to ask which of two transcripts of a clinical recording
    // is the real one.
    //
    // 🛑 This check is what makes the reuse real. `ingest` writing the row is not enough on
    // its own: without this the Workflow would transcribe the audio anyway and OVERWRITE the
    // seeded transcript, paying the whole bill and quietly discarding the clinical one.
    const seeded = await step.do('reuse clinical transcript', async () => {
      const row = await env.DB.prepare(
        `SELECT text, segments FROM transcripts WHERE note_id = ?`,
      ).bind(noteId).first<{ text: string; segments: string }>();
      if (!row?.text?.trim()) return null;
      await setStatus(env, noteId, 'summarizing');
      return { text: row.text, segments: JSON.parse(row.segments) as Seg[] };
    });

    const chunkSec = Number(env.CHUNK_SECONDS || 60);
    const overlapSec = Number(env.CHUNK_OVERLAP_SECONDS || 2);
    const audioLen = Math.max(0, note.bytes - WAV_HEADER);
    const totalSec = audioLen / BYTES_PER_SEC;
    const chunkCount = Math.max(1, Math.ceil(totalSec / chunkSec));

    // One step per chunk. A chunk that fails (a transient Workers AI error, say) is retried
    // on its own; the chunks that already succeeded are never re-run — and never re-billed.
    if (!seeded) {
      await step.do('record chunk count', async () => {
        await env.DB.prepare(`UPDATE notes SET chunks_total = ?, chunks_done = 0 WHERE id = ?`)
          .bind(chunkCount, noteId).run();
      });
    }

    const perChunk: ChunkResult[] = [];
    for (let i = 0; !seeded && i < chunkCount; i++) {
      const segs = await step.do(`transcribe chunk ${i + 1}/${chunkCount}`, async () => {
        const out = await transcribeChunk(env, note, i, chunkSec, overlapSec, totalSec);
        // Written inside the step so a retried chunk cannot advance the bar twice, and so the
        // count only moves when a chunk has actually been transcribed.
        await env.DB.prepare(`UPDATE notes SET chunks_done = ? WHERE id = ?`).bind(i + 1, noteId).run();
        return out;
      });
      perChunk.push(segs);
    }

    const transcript = seeded ?? await step.do('store transcript', async () => {
      // One global speaker numbering across chunks — see stitchSpeakers for why this cannot
      // just be the per-chunk labels.
      const segments = stitchSpeakers(perChunk);
      // `text` stays clean prose: it is what the note page renders. The speaker- and
      // time-annotated form is built for the model only, in promptTranscript().
      const text = segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
      await env.DB.prepare(
        `INSERT INTO transcripts (note_id, lang, text, segments) VALUES (?, ?, ?, ?)
         ON CONFLICT(note_id) DO UPDATE SET lang = excluded.lang, text = excluded.text,
                                            segments = excluded.segments`,
      ).bind(noteId, env.ASR_LANGUAGE || 'en', text, JSON.stringify(segments)).run();
      await setStatus(env, noteId, 'summarizing');
      return { text, segments };
    });

    // No speech at all — an accidental tap on the record button. Finish clean rather than
    // feeding an empty transcript to the model and storing a hallucinated summary. The
    // clinical lane hit exactly this (a ~32 ms take retry-looped into a stuck error).
    if (!transcript.text.trim()) {
      await step.do('finish empty', async () => {
        await env.DB.prepare(`UPDATE notes SET status = 'done', title = 'Empty recording', updated_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), noteId).run();
      });
      return;
    }

    await step.do('summarise', async () => {
      const flags: number[] = note.flags ? JSON.parse(note.flags) : [];
      const summary = await summarise(env, promptTranscript(transcript.segments), flags,
                                      template, model, note.duration_s || 0);
      await env.DB.prepare(
        `INSERT INTO summaries (id, note_id, template, model, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(note_id, template, model) DO UPDATE SET json = excluded.json`,
      ).bind(newId('sum'), noteId, template, model, JSON.stringify(summary)).run();
      await env.DB.prepare(`UPDATE notes SET status = 'done', title = ?, updated_at = ? WHERE id = ?`)
        .bind(summary.title || 'Untitled note', new Date().toISOString(), noteId).run();
    });
  }
}

async function setStatus(env: Env, noteId: string, status: string) {
  await env.DB.prepare(`UPDATE notes SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`)
    .bind(status, new Date().toISOString(), new Date().toISOString(), noteId).run();
}

/**
 * Transcribe chunk `i`, returning segments on the GLOBAL timeline.
 *
 * Two things here are easy to get wrong and both are silent:
 *
 *  1. The chunk is read with an OVERLAP at its front, because a hard cut lands mid-word and
 *     Whisper loses it. The overlap is then de-duplicated by keeping only the segments whose
 *     midpoint falls inside this chunk's own window — so the repeated audio at the seam is
 *     transcribed twice but written once.
 *  2. Whisper timestamps are relative to the audio it was handed. They MUST be offset by the
 *     chunk's start, or every chapter marker and every flag tick past the first minute is
 *     wrong. This is the bug you do not notice until someone clicks a timestamp.
 *
 * The audio is read from R2 by byte range and given a fresh 44-byte header, which is exact
 * for 16 kHz mono PCM: any byte offset that is frame-aligned is a valid cut. That would NOT
 * be true of a compressed format — do not reuse this for mp3/opus.
 */
async function transcribeChunk(
  env: Env, note: NoteRow, i: number, chunkSec: number, overlapSec: number, totalSec: number,
): Promise<ChunkResult> {
  const winStart = i * chunkSec;                       // this chunk's own window
  const winEnd = Math.min(totalSec, winStart + chunkSec);
  const readStart = Math.max(0, winStart - (i === 0 ? 0 : overlapSec));

  const align = (b: number) => b - (b % 2);            // 16-bit samples: never split one
  const byteStart = WAV_HEADER + align(Math.floor(readStart * BYTES_PER_SEC));
  const byteEnd = WAV_HEADER + align(Math.ceil(winEnd * BYTES_PER_SEC));
  const length = byteEnd - byteStart;
  if (length <= 0) return { kept: [], overlap: [] };

  const obj = await env.BUCKET.get(note.storage_key!, { range: { offset: byteStart, length } });
  if (!obj) throw new Error(`audio missing for ${note.id}`);
  const pcm = new Uint8Array(await obj.arrayBuffer());

  const wav = new Uint8Array(WAV_HEADER + pcm.length);
  wav.set(wavHeader(pcm.length, note.sample_rate || 16000), 0);
  wav.set(pcm, WAV_HEADER);

  const model = assertCloudflareModel(env.ASR_MODEL, 'ASR_MODEL');
  const language = env.ASR_LANGUAGE || 'en';
  const raw = isDeepgram(model)
    ? await transcribeDeepgram(env, model, wav, language, readStart, winStart, winEnd)
    : await transcribeWhisper(env, model, wav, language, readStart, winStart, winEnd);

  const kept: Seg[] = [];
  const overlap: Seg[] = [];
  for (const s of raw) {
    if (!s.text) continue;
    const mid = (s.start + s.end) / 2;
    // Keep only what belongs to this chunk's window; the overlap's duplicate lands in the
    // neighbour's window and is kept there.
    if (mid >= winStart && (mid < winEnd || winEnd >= totalSec)) kept.push(s);
    else if (mid < winStart) overlap.push(s);   // re-heard audio: speaker evidence, not text
  }
  return { kept, overlap };
}

function isDeepgram(model: string): boolean {
  return model.startsWith('@cf/deepgram/');
}

/**
 * Deepgram (nova-3). Verified against the live model rather than the published schema — the
 * schema's `words[]` declares only {word,start,end,confidence} and omits `speaker` entirely,
 * but a real diarize=true call returns `speaker`, `speaker_confidence`, `punctuated_word`, AND
 * a `results.utterances[]` array the schema does not mention at all.
 *
 * Prefer `utterances`: Deepgram has already grouped words into semantic units and tagged each
 * with one speaker, which is exactly the segment shape this pipeline wants. Rebuilding that
 * from `words[]` means re-deciding where an utterance ends, and getting it wrong splits a
 * sentence across two speakers.
 */
async function transcribeDeepgram(
  env: Env, model: string, wav: Uint8Array, language: string,
  base: number, winStart: number, winEnd: number,
): Promise<Seg[]> {
  const res = await env.AI.run(model as any, {
    // `body` MUST be a ReadableStream. Probed against the live model: a Uint8Array, an
    // ArrayBuffer and a plain number[] are all rejected with
    // "required properties at '/audio' are 'body,contentType'" — the validator does not see
    // the bytes as a value at all. Only a stream is accepted.
    audio: { body: new Response(wav).body, contentType: 'audio/wav' },
    diarize: true,
    punctuate: true,
    smart_format: true,
    utterances: true,
    language,
  }) as DeepgramResult;

  const utts = res?.results?.utterances;
  if (Array.isArray(utts) && utts.length) {
    return utts.map((u) => ({
      start: base + (Number(u.start) || 0),
      end: base + (Number(u.end) || 0),
      text: (u.transcript || '').trim(),
      speaker: Number.isFinite(u.speaker as number) ? Number(u.speaker) : undefined,
    }));
  }

  // No utterances came back: group the word stream on speaker changes. Same intent, coarser.
  const alt = res?.results?.channels?.[0]?.alternatives?.[0];
  const words = alt?.words;
  if (Array.isArray(words) && words.length) {
    const out: Seg[] = [];
    for (const w of words) {
      const spk = Number.isFinite(w.speaker as number) ? Number(w.speaker) : undefined;
      const token = (w.punctuated_word || w.word || '').trim();
      if (!token) continue;
      const last = out[out.length - 1];
      if (last && last.speaker === spk) {
        last.text += ' ' + token;
        last.end = base + (Number(w.end) || 0);
      } else {
        out.push({
          start: base + (Number(w.start) || 0),
          end: base + (Number(w.end) || 0),
          text: token, speaker: spk,
        });
      }
    }
    if (out.length) return out;
  }

  const flat = (alt?.transcript || '').trim();
  return flat ? [{ start: winStart, end: winEnd, text: flat }] : [];
}

/** Whisper and anything else that answers with {text, segments[]}. Kept so ASR_MODEL can be
 *  rolled back to whisper without a code change. */
async function transcribeWhisper(
  env: Env, model: string, wav: Uint8Array, language: string,
  base: number, winStart: number, winEnd: number,
): Promise<Seg[]> {
  const res = await env.AI.run(model as any, {
    audio: toBase64(wav),
    task: 'transcribe',
    language,
  }) as { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }> };

  return Array.isArray(res?.segments) && res.segments.length
    ? res.segments.map((s) => ({
        start: base + (Number(s.start) || 0),
        end: base + (Number(s.end) || 0),
        text: (s.text || '').trim(),
      }))
    // No per-segment timings came back: keep the chunk as one segment rather than inventing
    // timings that would look precise and be wrong.
    : [{ start: winStart, end: winEnd, text: (res?.text || '').trim() }];
}

interface DeepgramWord {
  word?: string; punctuated_word?: string;
  start?: number; end?: number; speaker?: number; speaker_confidence?: number;
}
interface DeepgramResult {
  results?: {
    utterances?: Array<{ start?: number; end?: number; transcript?: string; speaker?: number }>;
    channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: DeepgramWord[] }> }>;
  };
}

/**
 * Give every chunk's local speaker numbers one GLOBAL identity.
 *
 * Each chunk is diarized on its own, so its speakers are numbered from 0 with no memory of the
 * chunk before: chunk 1's "speaker 0" and chunk 2's "speaker 0" are not necessarily the same
 * person. Left unmapped, a 6-chunk meeting between two people renders as up to twelve speakers
 * and every attribution in the summary is a coin flip — worse than no speaker labels at all,
 * because a wrong name reads as a fact.
 *
 * The overlap window is the only evidence available: those seconds were transcribed TWICE, once
 * at the end of chunk i-1 and again at the start of chunk i, so a speaker heard in both is the
 * same voice. Match by how much time the two labels actually share, take the strongest match,
 * and let each global identity be claimed once per chunk.
 *
 * A local speaker who never talks during the overlap CANNOT be proved to be anyone already
 * known, so they get a fresh identity. That over-counts rather than mis-attributes, which is
 * the safe direction to be wrong in: "Speaker 3" duplicating "Speaker 1" is confusing, but
 * putting Speaker 1's words in Speaker 3's mouth is a lie.
 */
export function stitchSpeakers(chunks: ChunkResult[]): Seg[] {
  const out: Seg[] = [];
  let nextGlobal = 0;

  for (let i = 0; i < chunks.length; i++) {
    const { kept, overlap } = chunks[i];
    const local2global = new Map<number, number>();

    if (i > 0 && overlap.length) {
      // How much time does each (local, global) pair share in the overlap window?
      const shared = new Map<string, number>();
      for (const o of overlap) {
        if (o.speaker === undefined) continue;
        for (const prev of out) {
          if (prev.speaker === undefined) continue;
          const secs = Math.min(o.end, prev.end) - Math.max(o.start, prev.start);
          if (secs <= 0) continue;
          const k = `${o.speaker}:${prev.speaker}`;
          shared.set(k, (shared.get(k) || 0) + secs);
        }
      }
      // Strongest pairs first, and each side may only be claimed once.
      const pairs = [...shared.entries()]
        .map(([k, secs]) => {
          const [l, g] = k.split(':').map(Number);
          return { local: l, global: g, secs };
        })
        .sort((a, b) => b.secs - a.secs);
      const takenGlobals = new Set<number>();
      for (const pr of pairs) {
        if (local2global.has(pr.local) || takenGlobals.has(pr.global)) continue;
        local2global.set(pr.local, pr.global);
        takenGlobals.add(pr.global);
      }
    }

    for (const seg of kept) {
      let speaker: number | undefined;
      if (seg.speaker !== undefined) {
        if (!local2global.has(seg.speaker)) local2global.set(seg.speaker, nextGlobal++);
        speaker = local2global.get(seg.speaker);
      }
      out.push({ ...seg, speaker });
    }
    // Chunk 0 seeds the identities; keep the counter past anything it allocated.
    nextGlobal = Math.max(nextGlobal, ...[...local2global.values()].map((v) => v + 1), 0);
  }

  return out.sort((a, b) => a.start - b.start);
}

/**
 * The transcript as the MODEL sees it: one line per utterance, stamped with its time and, when
 * diarization gave us one, who said it.
 *
 * Two bugs are fixed by this and neither is visible without it:
 *
 * 1. The highlight button was dead weight. The prompt told the model "the user pressed
 *    highlight at 132 seconds" while handing it a wall of text with no timestamps anywhere —
 *    there was no way to act on that, so every mark the user pressed was silently ignored.
 * 2. "Who agreed to do this" was unanswerable, because the transcript was one anonymous stream.
 *
 * The stored `transcripts.text` stays clean prose: it is what the UI shows, and it is not this.
 */
export function promptTranscript(segments: Seg[]): string {
  const named = segments.some((s) => s.speaker !== undefined);
  return segments
    .filter((s) => s.text.trim())
    .map((s) => {
      const who = named && s.speaker !== undefined ? ` Speaker ${s.speaker + 1}:` : '';
      return `[${stampOf(s.start)}]${who} ${s.text.trim()}`;
    })
    .join('\n');
}

/**
 * One point. `sub` carries the sub-points that were actually spoken under it — real meeting
 * notes are two levels, and flattening them loses which detail belongs to which point.
 * Optional and gated hard in the prompt: nesting is another surface to fabricate on.
 */
export interface SummaryItem { text: string; sub?: string[] }
export interface SummarySection { key: string; title: string; items: SummaryItem[] }

/**
 * The stored summary. `sections` is generic so a new template needs no change to the reader —
 * it renders whatever sections come back, in order.
 */
export interface Summary {
  title: string;
  tldr: string;
  chapters: Array<{ at: number; title: string }>;
  sections: SummarySection[];
}

/**
 * Build the instruction for ONE template. The key list, and the description of each key, come
 * from the template itself — so a template can never be asked for a section it does not have,
 * which is the only reliable way to stop the model inventing one.
 */
function systemFor(t: TemplateDef): string {
  const keys = t.sections.map((x) => `"${x.key}":string[]`).join(',');
  const chapters = t.chapters ? ',"chapters":[{"at":number,"title":string}]' : '';
  const lines = t.sections.map((x) => `- ${x.key}: ${x.hint}. [] is a correct answer.`);
  lines.push('- Each item is either a plain string, or {"text":string,"sub":string[]} when the'
    + ' speaker genuinely made distinct sub-points under it. Do NOT invent sub-points to add'
    + ' depth — most items have none.');
  lines.push('- Where an item has a natural label, write it as "Label: what was said" — the'
    + ' label is shown in bold. Do not invent a label to decorate a plain sentence.');
  lines.push('- Say each thing ONCE. Do not restate the tldr as an item, and do not repeat the'
    + ' same point in two sections. Every item should carry something the reader does not'
    + ' already have — repetition is not detail, and it crowds out what was actually said.');
  if (t.chapters) {
    lines.push('- chapters: only for a recording long enough to have distinct stretches. "at" is'
      + ' seconds from the start and MUST be less than the recording length given below.'
      + ' A short recording has none: return []. On a long one, mark each point where the'
      + ' conversation genuinely moves to a new topic — on the order of one every few minutes —'
      + ' and never place one in the last minute, where it would point at nothing. Two markers'
      + ' is not navigation; either the topics are really there or the answer is [].');
  }
  return `You summarise voice recordings for a personal note-taking app.
${t.steer}
Reply with ONLY a JSON object, no prose and no code fences, using exactly these keys:
{"title":string,"tldr":string,${keys}${chapters}}

Each line is "[mm:ss] Speaker N: what was said". When speakers are labelled, attribute
decisions and commitments to the speaker who actually made them, and never guess a real name —
"Speaker 2" is the only name you have. A transcript with no Speaker labels came from a recording
diarization could not split: do not invent speakers for it.

THE TRANSCRIPT IS THE ONLY SOURCE. Report what was said and nothing else.
- Do not add advice, implications, or plausible-sounding items that were not spoken.
- Do not pad a list to make it look complete. FEWER IS CORRECT when little was said.
- NEVER write a placeholder as an item — no "none", "n/a", "none mentioned", "not discussed".
  An empty list is the correct way to say nothing was said. A placeholder is worse than
  nothing: it looks like a finding.
${lines.join('\n')}
- title: 3-6 words naming this specific recording. If it is a fragment with no clear topic, say
  so plainly (e.g. "Brief unclear exchange").
- tldr: what the recording was about and where it ended up. One sentence for a fragment; a
  short paragraph of three to five sentences for a full-length conversation. Scale it to how
  much was actually said, not to a fixed length.`;
}

/** mm:ss, shared by the annotated transcript and the highlight markers so they line up. */
function stampOf(sec: number): string {
  const x = Math.max(0, Math.round(sec));
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

/** The map step of map-reduce. Same refusal to invent as the final pass — see summarise(). */
const MAP_SYSTEM = `You are compressing ONE PART of a longer meeting transcript so it can be summarised later.

Each line is "[mm:ss] Speaker N: what was said". When speakers are labelled, attribute
decisions and commitments to the speaker who actually made them, and never guess a real name —
"Speaker 2" is the only name you have. A transcript with no Speaker labels came from a recording
diarization could not split: do not invent speakers for it.

THE TRANSCRIPT IS THE ONLY SOURCE. Report what was said and nothing else.
- Do not add advice, conclusions, or plausible-sounding detail that was not spoken.
- Do not pad. If little was said in this part, write little. Silence is a valid answer.
- Never write a placeholder like "none mentioned" or "not discussed".
- KEEP the [mm:ss] timestamps and any "Speaker N:" labels for anything you carry forward —
  a later step needs them to place highlights and to say who committed to what.
- Plain prose, no headings, no JSON, no commentary about the transcript itself.`;

/**
 * Split for the map step on a line boundary rather than mid-word.
 *
 * `text.slice(i, i + N)` cut wherever the character count landed, so a sentence — and now a
 * whole "[04:12] Speaker 2: ..." line — could be sheared in half, with the front of it summarised
 * in one part and the tail in another. Both halves then read as fragments.
 */
export function splitForMap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    // A single line longer than the budget still has to be cut somewhere; cut it alone.
    if (line.length >= maxChars) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + line.length + 1 > maxChars) { out.push(buf); buf = line; }
    else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out.length ? out : [text];
}

/** "about 36 minutes" — the model reasons about chapter spacing far better in minutes. */
function minutesOf(sec: number): string {
  const m = Math.round(sec / 60);
  return m < 1 ? 'under a minute' : `about ${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * How much detail this recording's summary should carry, stated as a fact about the recording.
 *
 * Three cases, because a fragment and a 36-minute meeting fail in opposite directions and the
 * old prompt only guarded one of them. ⚠️ The long branch asks for COVERAGE, never for a count:
 * "every distinct topic that was discussed" is checkable against the transcript, and a model
 * that runs out of real topics stops. "Produce 8-15 bullets" is the version that invents, and
 * it is the reason the fewer-is-correct rule exists — that rule is not relaxed here, it still
 * sits in the system prompt above this and applies to every item.
 */
function depthDirective(words: number): string {
  if (words < THIN_TRANSCRIPT_WORDS) {
    return ' This is a SHORT FRAGMENT: return at most two items per section, no chapters, and'
      + ' only what was explicitly stated.';
  }
  if (words < LONG_TRANSCRIPT_WORDS) return '';
  return ' This is a FULL-LENGTH conversation, so a handful of bullets would leave most of it'
    + ' out. Work through the recording in order and give every distinct topic that was actually'
    + ' discussed its own item. Keep the specifics that were spoken — names, numbers, dates,'
    + ' conditions, who committed to what, and the reason they gave — rather than collapsing'
    + ' them into one general sentence; several distinct points must not be merged into a single'
    + ' summary line. Being thorough here means covering what IS there. It is not permission to'
    + ' add: every rule above still applies, every item must still be something that was said,'
    + ' and a section the recording never touched is still [].';
}

/**
 * Output budget for the final summary, in tokens, scaled to how much was said.
 *
 * This was a flat 2000 for every recording — roughly 1,200 words of JSON. That is generous for
 * a 2-minute take and a hard ceiling on a 36-minute meeting: no prompt can produce a thorough
 * summary that does not fit in the response, and a reply cut off mid-JSON does not even parse,
 * so `parseSummary` falls back to prose and every section vanishes at once.
 *
 * The second term is why this takes the source length too: the transcript going in and the
 * summary coming out share ONE context window, and the summary models on the catalog are 24k
 * (llama-3.3-70b). Asking for 6000 output tokens on top of a 14k-token transcript is how you
 * get a truncated reply rather than an error, so the budget yields to the input.
 */
const SUMMARY_CONTEXT_TOKENS = 24000;

function summaryBudget(words: number, sourceChars: number): number {
  const wanted = Math.min(6000, Math.max(2000, Math.round(words * 1.2)));
  // ~3.5 chars per token is the usual rough rate for English prose; the slack covers the
  // system prompt and the fact that this is an estimate, not a tokeniser.
  const input = Math.ceil(sourceChars / 3.5) + 1200;
  return Math.max(1500, Math.min(wanted, SUMMARY_CONTEXT_TOKENS - input));
}

async function summarise(
  env: Env, text: string, flagsMs: number[], template: string, model: string, durationSec: number,
): Promise<Summary> {
  const base = TEMPLATES[template] || TEMPLATES[DEFAULT_TEMPLATE];

  // A section that reports on the user's highlight presses is removed when there were none.
  // Nothing on an L816 or a pendant can press that button, so on those recordings the section
  // was pure invention — the model picked three sentences it liked and filed them under
  // "Highlights", which says to the reader "these are the moments you marked".
  const t: TemplateDef = flagsMs.length
    ? base
    : { ...base, sections: base.sections.filter((x) => !x.needsMarks) };

  // The word count MUST come from the real transcript, before any reduction. It used to be
  // measured on `source` — which after map-reduce is the summaries, not the recording — so a
  // long meeting reported a few hundred words, and that false number drives both the SHORT
  // FRAGMENT branch below and the chapter gate in sanitise().
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  // Long recording: summarise in pieces, then summarise the summaries. Truncating instead
  // would silently drop the end of a meeting and look like a model that stopped paying
  // attention — a quality cliff with no error to point at.
  let source = text;
  if (text.length > MAX_SUMMARY_CHARS) {
    const pieces: string[] = [];
    for (const part of splitForMap(text, MAX_SUMMARY_CHARS)) {
      // ⚠️ The map step needs the SAME anti-fabrication rules as the final pass. It used to run
      // on a bare "Summarise this part of a transcript in plain prose." — no "transcript is the
      // only source", no "fewer is correct", nothing. Whatever it invented then became the only
      // source of truth for the reduce step, and sanitise() cannot catch a fabrication that is
      // already sitting in its input. So the longest recordings — the ones a user is least able
      // to check by ear — were the ones with no protection at all.
      // 1200 tokens is ~900 words out of a part that can be 48,000 characters in — a 40:1
      // squeeze, and everything it drops is gone before the summary step ever sees it.
      const piece = await complete(env, model, MAP_SYSTEM, part, 2400);
      pieces.push(typeof piece === 'string' ? piece : JSON.stringify(piece));
    }
    source = pieces.join('\n\n');
  }

  const marks = flagsMs.length
    ? `\nThe user pressed the highlight button at these moments: ${flagsMs.map((m) => stampOf(m / 1000)).join(', ')}.`
      + ' Those timestamps appear in the transcript above — treat what was said around them as important.'
    : '';
  // Telling the model the length is what stops chapters landing past the end of the audio —
  // it was inventing 0:30 and 0:50 sections for an 11-second clip because it had no idea how
  // long the recording was.
  const facts = `\nRECORDING LENGTH: ${Math.round(durationSec)} seconds (${minutesOf(durationSec)}).`
    + ` WORD COUNT: ${words}.`
    + depthDirective(words);
  const out = await complete(
    env, model, systemFor(t), `TRANSCRIPT:\n${source}${marks}${facts}`, summaryBudget(words, source.length), true,
  );
  return sanitise(parseSummary(out, t), t, durationSec, words, flagsMs.length > 0);
}

/**
 * One chat completion. Returns the model's `response` field RAW and untyped on purpose:
 * Workers AI does not guarantee it is a string — some models return an already-parsed object
 * when the reply is JSON. Assuming a string here threw `raw.replace is not a function`, the
 * Workflow retried it forever, and the note sat in `summarizing` with no error to point at.
 * Whatever comes back is normalised once, in parseSummary.
 */
async function complete(
  env: Env, model: string, system: string, user: string, maxTokens: number, json = false,
): Promise<unknown> {
  const res = await env.AI.run(assertCloudflareModel(model, 'summary model'), {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
    temperature: 0.2,
    // Ask the platform for JSON instead of only asking the model in the prompt. parseSummary
    // still does its three-way defensive parse: json mode is not offered by every model and a
    // small one can still wrap its answer, so this reduces the guessing rather than removing it.
    // The map step passes json=false on purpose — it wants prose, not an object.
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  } as any) as { response?: unknown };
  return res?.response ?? '';
}

/**
 * Parse the model's JSON defensively. A small instruct model wraps JSON in a code fence often
 * enough that a strict parse would fail on perfectly good output; and a note whose summary
 * failed to parse should still be readable rather than an error.
 */
export function parseSummary(raw: unknown, t: TemplateDef): Summary {
  const empty: Summary = { title: '', tldr: '', chapters: [], sections: [] };

  // Already an object: the model (or the platform) parsed the JSON for us.
  if (raw && typeof raw === 'object') return shape(raw as Record<string, any>, t);
  if (typeof raw !== 'string') {
    console.warn(`[pipeline] unexpected completion type: ${typeof raw}`);
    return empty;
  }

  const fenced = raw.replace(/^[\s\S]*?```(?:json)?/i, '').replace(/```[\s\S]*$/, '');
  for (const candidate of [raw, fenced, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    try {
      const o = JSON.parse(candidate.trim());
      if (o && typeof o === 'object') return shape(o, t);
    } catch { /* try the next shape */ }
  }
  // Nothing parsed: keep the model's words as the tl;dr rather than losing them. A note whose
  // summary failed to parse should still be readable, not an error. Take a title from those
  // words too — the caller's fallback is the literal string "Untitled note", and a list of
  // them is unusable once a user has more than one.
  const prose = raw.trim();
  const firstLine = (prose.split('\n').find((l) => l.trim()) || '').replace(/^[#\-*\s]+/, '').trim();
  const title = firstLine.split(/\s+/).slice(0, 6).join(' ').replace(/[.,;:]$/, '');
  return { ...empty, title, tldr: prose.slice(0, 1000) };
}

/** Coerce a parsed object into this template's contract. Keys it does not own are dropped. */
function shape(o: Record<string, any>, t: TemplateDef): Summary {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    title: String(o.title ?? ''),
    tldr: String(o.tldr ?? ''),
    chapters: t.chapters
      ? arr(o.chapters)
          .map((c: any) => ({ at: Number(c?.at) || 0, title: String(c?.title ?? '') }))
          .filter((c) => c.title)
      : [],
    sections: t.sections
      .map((sec) => ({
        key: sec.key,
        title: sec.title,
        items: arr(o[sec.key]).map(toItem).filter((it) => it.text),
      }))
      .filter((sec) => sec.items.length > 0),
  };
}

/** A model may answer with a plain string or an object; normalise both to one shape. */
function toItem(x: any): SummaryItem {
  if (typeof x === 'string') return { text: x.trim() };
  if (x && typeof x === 'object') {
    const text = String(x.text ?? x.point ?? x.title ?? x.item ?? '').trim();
    const sub = (Array.isArray(x.sub) ? x.sub : Array.isArray(x.details) ? x.details
      : Array.isArray(x.children) ? x.children : [])
      .map((y: any) => (typeof y === 'string' ? y : String(y?.text ?? ''))).map((y: string) => y.trim())
      .filter(Boolean);
    return sub.length ? { text, sub } : { text };
  }
  return { text: '' };
}

/**
 * Last line of defence against a padded summary.
 *
 * The prompt asks the model not to invent, and a bigger model invents less, but neither is a
 * guarantee — so the output is checked against facts we actually know. A chapter marker past
 * the end of the audio is the clearest tell there is: an 11-second clip came back with
 * sections at 0:30 and 0:50. Anything that cannot be true is dropped rather than shown.
 */
function sanitise(
  sum: Summary, t: TemplateDef, durationSec: number, words: number, hadMarks = true,
): Summary {
  const out: Summary = { ...sum };

  // A chapter has to point AT something you can go and listen to. `at < durationSec` was too
  // weak a test: a 35:50 recording came back with a chapter titled "Pilot Study and Next Steps"
  // at 35:50 — inside the audio by a rounding error and zero seconds long. So a marker must
  // leave real recording behind it, two markers closer together than a minute are the same
  // place, and a lone marker is not navigation at all (a single "0:00 Introduction" is a label
  // on the whole recording, which the title already is).
  const MIN_TAIL = 30;
  const MIN_GAP = 60;
  if (!t.chapters || durationSec < 60 || words < THIN_TRANSCRIPT_WORDS) {
    out.chapters = [];
  } else {
    const cutoff = durationSec - Math.min(MIN_TAIL, durationSec * 0.1);
    const kept: Array<{ at: number; title: string }> = [];
    for (const c of out.chapters
      .map((c) => ({ at: Number(c.at), title: String(c.title ?? '').trim() }))
      .filter((c) => Number.isFinite(c.at) && c.at >= 0 && c.at < cutoff && c.title)
      .sort((a, b) => a.at - b.at)) {
      if (kept.length && c.at - kept[kept.length - 1].at < MIN_GAP) continue;
      kept.push(c);
    }
    out.chapters = kept.length >= 2 ? kept : [];
  }

  // With no highlight presses there is nothing a "Highlights" section could be reporting, so
  // anything under one is invented. It is already dropped from the prompt; this is the floor,
  // for the case where a model answers with a key it was never asked for.
  if (!hadMarks) {
    out.sections = out.sections.filter(
      (sec) => !t.sections.some((x) => x.key === sec.key && x.needsMarks),
    );
  }

  // Strip placeholder items. Asked for a section the recording cannot fill, a model often
  // answers "none mentioned" instead of returning [] — which then renders as a bullet and
  // reads like a finding. The prompt forbids it; this is the floor.
  const PLACEHOLDER = /^\s*(none|n\/?a|not (mentioned|discussed|specified|stated|applicable)|none (mentioned|discussed|stated|given)|no .{0,24}(mentioned|discussed|given|stated))\s*\.?\s*$/i;
  const keep = (x: string) => x && !PLACEHOLDER.test(x);
  out.sections = out.sections
    .map((sec) => ({
      ...sec,
      items: sec.items
        .filter((it) => keep(it.text))
        .map((it) => (it.sub ? { ...it, sub: it.sub.filter(keep) } : it))
        .map((it) => (it.sub && it.sub.length ? it : { text: it.text })),
    }))
    .filter((sec) => sec.items.length > 0);

  // A fragment gets a fragment's summary. Trimming here rather than trusting the instruction
  // keeps the floor even when a model ignores it.
  if (words < THIN_TRANSCRIPT_WORDS) {
    out.sections = out.sections.map((sec) => ({ ...sec, items: sec.items.slice(0, 2) }));
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  // Chunked because String.fromCharCode(...bigArray) blows the argument limit at ~100k.
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}
