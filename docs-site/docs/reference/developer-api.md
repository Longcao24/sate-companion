---
title: Developer API
sidebar_position: 2
---

# Developer API

The **SATE Developer API** lets you build on the same speech pipeline that powers SATE:
**send audio, get back a transcript and a speech report.**

<div class="badge-row"><span class="sate-badge">Public API</span><span class="sate-badge">API-key auth</span><span class="sate-badge">async jobs</span><span class="sate-badge">transcript + report</span></div>

:::tip[Start here]
**Portal — request access, create keys, view usage:** <https://developers-sate.long-cao.dev>
**Full API reference (endpoints, examples, a complete client):** <https://developers-sate.long-cao.dev/docs>
**API base URL:** `https://api-sate.long-cao.dev`
:::

## How it relates to the rest of SATE

This is **not** the [Device API](./device-api.md). They are separate services with separate
audiences, and it is worth being precise about which one you want:

| | Device API | Developer API |
|---|---|---|
| **Who calls it** | SATE recorders, the SATE apps, fleet operators | Any third-party application |
| **Auth** | Device key or a signed-in SATE user | An API key you create in the portal |
| **Concerned with** | Devices, patients, clinical sessions, firmware | Audio in, transcript and report out |
| **Access** | Internal to the SATE product | Open to approved developers |

The Developer API **shares no data with the clinical app** — by design, not by omission.
There is no patient, no clinician, no device, and no SATE account anywhere in it. The only
thing the two have in common is the AI transcription service underneath, and even that is
reached through a priority gate, so a developer's batch can never make a clinician's
recording wait.

## Getting access

1. Register in the [portal](https://developers-sate.long-cao.dev). New accounts land as
   *pending* until an administrator approves them.
2. Create an API key. **The key is shown once, at creation** — only a hash is stored, so a
   lost key must be revoked and replaced, never recovered.
3. Send every request with it:

```
Authorization: Bearer sate_live_…
```

## Submitting audio

Jobs are **asynchronous**: you submit audio, get a job id back immediately, and collect the
result when it settles. Transcription takes far longer than any sensible HTTP request, so
the API never makes you hold a connection open waiting for it.

```bash
curl -X POST https://api-sate.long-cao.dev/v1/jobs \
  -H "Authorization: Bearer sate_live_…" \
  -F audio=@sample.wav \
  -F view=full
```

Then either poll `GET /v1/jobs/{id}`, or pass a `webhook_url` and be told when it settles.
The webhook payload deliberately carries **no result** — you fetch that over the
authenticated API — so a leaked or guessed webhook URL reveals nothing.

## Scopes and views

A key carries **scopes**; a **view** is the shape of the result you ask for. The AI runs once
regardless of which view you request, so widening a key's scopes later retroactively unlocks
richer views of jobs that were already processed.

| View | Scope required | What you get |
|---|---|---|
| `transcript` | `transcript:read` | Speaker-attributed segments, per-word timings, plain text |
| `report` | `report:read` | Counts and metrics only — no words at all |
| `full` | any | Everything your scopes allow; anything withheld is named in `omitted` |

:::note[Asking for more than you hold is not an error]
A report-only key requesting `view=full` gets its report plus
`"omitted": ["transcript","annotations"]` — so you always learn what was withheld and why,
instead of a bare `403`. Use the section endpoints (`/v1/jobs/{id}/transcript`) when you
*want* a hard failure on a missing scope.
:::

## What the report contains

The report is computed by the same code as the first-party clinical product, so your numbers
match SATE's: annotation counts (pause, filler, repetition, mispronunciation, morpheme,
morpheme-omission, revision, utterance-error), plus NTW, NDW, MLUw, MLUm, speaking rate, and
annotation rate.

## Endpoints at a glance

| Endpoint | Purpose |
|---|---|
| `POST /v1/jobs` | Submit audio (multipart, or raw bytes) |
| `GET /v1/jobs/{id}` | Read a result in the requested view |
| `GET /v1/jobs/{id}/transcript` · `/annotations` · `/report` | One section, hard `403` without the scope |
| `GET /v1/jobs` | Your recent jobs |
| `DELETE /v1/jobs/{id}` | Delete a job and its result now |
| `GET /v1/usage` | Your consumption |
| `GET /v1/me` | What this key can do |

Full request and response shapes, the report field reference, and a complete working client
are in the [API reference](https://developers-sate.long-cao.dev/docs).

## Limits and retention

| Limit | Behaviour |
|---|---|
| **Rate** | Per key, per minute. Over it: `429` with `retry_after_seconds` |
| **Audio quota** | Monthly or lifetime, depending on your account. Over it: `402` |
| **Upload size** | 50 MB per file (~26 min of 16 kHz mono WAV). Over it: `413` |
| **Retention** | Results deleted after 30 days. **Uploaded audio is deleted the moment the job finishes** |

## Errors

Every failure carries a stable machine-readable `code`. **Build retry logic on the code, not
the message** — messages are written for humans and may change.

```json
{ "error": { "code": "quota_exceeded", "message": "Monthly quota of 120 audio minutes reached." } }
```

| Code | Status | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or invalid key |
| `key_revoked` | 401 | The key was revoked in the portal |
| `account_inactive` | 403 | The developer account is not active |
| `api_locked` | 403 | An administrator locked API access; the message says why |
| `insufficient_scope` | 403 | The key lacks the scope for that section |
| `quota_exceeded` | 402 | Audio quota reached |
| `rate_limited` | 429 | Too many requests this minute |
| `audio_too_large` | 413 | File over the size limit |
