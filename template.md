# Meeting note templates

Every template the notes lane can produce, what each one extracts, and the rules that keep
them honest. Source of truth: `TEMPLATES` in `sate-notes/src/pipeline.ts` — if this file and
that constant disagree, the constant wins.

Pick a template when generating a note, or re-summarise an existing one with a different
template. **Re-summarising never re-transcribes**: the transcript is stored once and
summaries live in their own table keyed by `(note, template, model)`, so trying a second
template costs one cheap LLM call instead of the whole ASR bill.

---

## The one rule behind all of them

**A template changes WHAT IS EXTRACTED, not just the tone.**

The first version gave every template the same six fields, so a lecture was still asked for
"action items" — and a model asked for a field the recording cannot fill **does not return an
empty list, it invents one**. Every section below is a surface to fabricate on.

So each template declares exactly the sections it owns, and `sanitise()` drops every key the
template does not own. **The smallest template is the safest** — `tasks` has one section and
almost nothing to make up.

---

## `meeting` — Meeting *(default)*

> A meeting or conversation. Focus on decisions, who owns them, and what happens next.

| Section | What goes in it |
|---|---|
| **Key points** | the substantive points actually made |
| **Action items** | only a follow-up someone actually committed to or was asked to do |
| **Highlights** | what was said around the moments the user marked |

**Chapters: yes.** Time-based navigation.

Notes: *Highlights* is driven by the flag markers — the physical flag button on a SATE
recorder, or a tap on a Plaud. No marks, no highlights; it will not invent them. This is also
the **only** template allowed to set the note's title (see below).

---

## `supervision` — Supervision / 1:1

> A supervision or one-to-one session. One person is reviewing another's work and giving
> feedback.

| Section | What goes in it |
|---|---|
| **What was reviewed** | the cases, work or material actually gone over |
| **Feedback** | the guidance given, in the words it was given |
| **Agreed actions** | only what was actually agreed to |
| **Next check-in** | the next meeting or deadline, if one was named |

**Chapters: no.** A 1:1 is one continuous stretch; chapter marks would be arbitrary.

---

## `interview` — Interview

> An interview. Preserve the interviewee's own words where they matter.

| Section | What goes in it |
|---|---|
| **Questions & answers** | one entry per question asked, with the substance of the answer |
| **Notable quotes** | **verbatim only** — never paraphrased into this section |
| **Worth asking next** | only a question the conversation itself left open |

**Chapters: yes.**

Notes: *Notable quotes* is the section with the least tolerance for drift. A paraphrase
presented as a quote is a fabrication with a person's name attached to it.

---

## `research` — Research / lab

> A research or lab discussion.

| Section | What goes in it |
|---|---|
| **Hypotheses** | what was proposed or questioned |
| **Results discussed** | findings actually reported in the recording |
| **Blockers** | what is stopping progress |
| **Next experiments** | what was decided to try next |

**Chapters: yes.**

---

## `tasks` — Just the tasks

> Extract only what someone has to DO. Ignore everything else, however interesting.

| Section | What goes in it |
|---|---|
| **Action items** | one per task, with the owner and the deadline if either was said |

**Chapters: no.**

Notes: **the safest template there is.** One section, no room for invention. Reach for it
when the recording is long or rambling and you only want the commitments out of it.

---

## `idea` — Thinking out loud

> Someone thinking out loud. Keep the threads distinct and do not tidy away uncertainty.

| Section | What goes in it |
|---|---|
| **Threads** | each distinct line of thought, in their own phrasing where it matters |
| **Open questions** | what they left unresolved |

**Chapters: no.**

Notes: "do not tidy away uncertainty" is the point. A summariser's instinct is to resolve
half-formed thinking into confident statements, which loses exactly what the recording was
for.

---

## What every note carries, whatever the template

| Field | Meaning |
|---|---|
| `title` | The note's name in the list |
| `tldr` | One-paragraph summary |
| `chapters[]` | `{ at, title }` — only for templates with `chapters: true` |
| `sections[]` | Only the sections the chosen template declares |

Items inside a section may carry `sub` (spoken sub-points) and a bold `"Label: text"`
lead-in. Both are **gated hard in the prompt**, because nesting and labels are two more
surfaces to fabricate on. A short recording legitimately has neither — that is not a bug.

**Only the default template (`meeting`) may set `notes.title`.** The title is the note's
identity in the list; letting whichever template you last viewed rewrite it means reading a
recording a different way renames it, and the sidebar stops matching the page.

---

## The guardrails

These apply to every template and are the reason the output can be trusted:

- **Fewer is correct.** The prompt says so explicitly. Asking for "3–8 bullets" *forces*
  invention — an 11-second clip of four half-sentences once produced 9 key points, 3 action
  items, and chapters at 0:30 and 0:50, past the end of the audio.
- **The model is told the recording's real length and word count**, measured on the
  **original** transcript — not on the reduced text a long recording gets mapped down to.
- **`sanitise()` drops what cannot be true**, including chapters past the end of the audio and
  any section the template does not own. A prompt is guidance; this is the guarantee.
- **Placeholder items are stripped.** Asked for a section it cannot fill, a model writes
  "none mentioned" rather than an empty list — which renders as a bullet and reads like a
  finding. Forbidden in the prompt *and* filtered after, because the prompt is not enough.
- **The map step of a long recording gets the same anti-fabrication rules as the final pass.**
  Whatever it invents becomes the only input the reduce step sees, and `sanitise()` cannot
  catch a fabrication already sitting in its input. The longest recordings — the ones nobody
  can check by ear — would otherwise have the least protection.
- **A recording the clinical pipeline marked `no_text` is never offered a note**, and a
  too-short take is refused before the model is ever called.

---

## Cost

ASR has historically been ~96% of the bill and the summary ~4%. That is why:

- the transcript is stored **once**;
- re-summarising with a different template or a bigger model is nearly free;
- and a note generated from a recording SATE has **already transcribed** should reuse that
  transcript rather than paying for ASR twice.
