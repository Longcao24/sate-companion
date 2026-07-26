---
title: Known issues
sidebar_position: 7
---

# Known issues & current status

A single, cross-system view of what's working well, what's still being polished, and what
we've noted for later. It's written for a general reader who wants to understand the shape
of the product — not a line-by-line engineering log. Each component guide highlights the
items most relevant to it.

<div class="badge-row">
<span class="sate-badge warn">status snapshot</span>
<span class="sate-badge ok">core reliability hardened</span>
<span class="sate-badge bad">polish in progress</span>
<span class="sate-badge">security noted</span>
</div>

Our top priority across the whole system is simple: **never lose or mismatch a patient's
recording.** Most of the reliability work below serves that one goal, and the highest-risk
areas have been through repeated, deliberate hardening.

```mermaid
pie showData
  title Where things stand
  "Hardened / verified" : 12
  "Polish in progress" : 24
  "Security (noted for later)" : 6
```

## Data integrity — our highest priority

The worst outcome for a speech-therapy tool is to lose a session or attach the wrong audio
to the wrong patient. These are the safeguards we care about most, and they have received
the most attention.

:::tip[Recorder firmware — a major reliability pass shipped]
The recorder firmware went through an intensive adversarial review focused entirely on the
"could this lose or mix up a recording?" question, and the resulting hardening pass shipped
and was re-verified. The headline improvements:

- **Session numbers are never reshuffled.** Each recording keeps the number it was given,
  which removed an entire family of edge cases around deleting one session while another was
  in flight.
- **On-device audio is only reclaimed after the server confirms it.** A recording's local
  copy is never freed until the cloud has verified it is durably and completely stored;
  anything uncertain keeps the local copy and retries later.
- **Recordings survive a reboot.** A session that is interrupted by a power blip — whether
  it was started at the device or remotely — resumes into the same recording rather than
  ending early or disappearing.
- **Remote control stays reliable.** A device that is recording still answers heartbeat,
  remote stop, and remote reboot, so a session can always be ended cleanly.
- **Clearer diagnostics.** On-device status messages, boot-reason reporting, and a
  dead-microphone/silence check make problems visible instead of silent.
:::

| Area | Status | What it means |
|---|---|---|
| Delete during upload | <span class="sate-badge ok">hardened</span> | Deleting a recording while another is uploading no longer risks blending two sessions into one file. |
| Interrupted maintenance | <span class="sate-badge ok">hardened</span> | A reboot in the middle of a housekeeping step can no longer leave a recording stranded or invisible. |
| Auto-resume after reboot | <span class="sate-badge ok">hardened</span> | Recordings resume into the same session after an unexpected restart. |
| Remotely started sessions | <span class="sate-badge ok">hardened</span> | A remotely started recording that is interrupted is treated as resumable, just like one started at the device. |
| Stay on the air while recording | <span class="sate-badge ok">hardened</span> | A recording device keeps answering heartbeat, remote stop, and status so it can always be stopped cleanly. |
| Server-verified reclaim | <span class="sate-badge ok">hardened</span> | Local audio is freed only after the server confirms a byte-exact, durable copy exists. |
| Duplicate protection | <span class="sate-badge ok">hardened</span> | A lost acknowledgement no longer causes the same session to be stored — or processed — twice. |
| Pendant capture safety | <span class="sate-badge warn">in progress</span> | The wearable pendant currently holds a capture in memory only, so an app crash mid-record can lose it; on-device buffering and safer upload handling are being improved. |

## Recorder

The recorder is the dedicated ESP32-S3 device (16 MB flash / 8 MB PSRAM) that captures
16 kHz mono audio, stores it locally, and syncs it to the cloud over Wi-Fi.

| Area | Status | What it means |
|---|---|---|
| Verified-reclaim rollout | <span class="sate-badge ok">hardened</span> | The cloud endpoint that confirms durable storage is deployed and in use, so devices reliably reclaim space only after verification. Deployment state is now checked explicitly rather than assumed. |
| Remote stop for remote takes | <span class="sate-badge ok">hardened</span> | A remotely started recording can be stopped remotely rather than running to the maximum length. |
| Debug-cable reset caveat | <span class="sate-badge">note</span> | While a device is actively recording, a physical USB reset can't reboot it — the remote reboot command is the reliable path. Flashing new firmware is unaffected. |
| Occasional debug-port wedge | <span class="sate-badge warn">in progress</span> | After long bench sessions the USB debug port sometimes stops reporting logs even though the device keeps working normally over Wi-Fi. A physical unplug/replug restores the log view; the test tooling now detects and flags this. Root cause still open. |
| Leftover upload fragments | <span class="sate-badge warn">in progress</span> | Fragments from a long-abandoned upload can linger in cloud storage and cost space. A periodic cleanup sweep is planned. |
| On-device OTA rollback | <span class="sate-badge warn">in progress</span> | Firmware images are validated server-side before publishing; a device-side automatic rollback on a bad update is still to come. |
| Long-uptime timers | <span class="sate-badge warn">in progress</span> | A few internal timers need hardening for devices left running for many weeks continuously. |
| Patient-roster edge case | <span class="sate-badge">low</span> | A rare roster-full case is low priority in practice, since recordings are captured standalone and assigned to a patient later. |

## Pendant

The pendant is a small wearable (Nordic nRF52840) that streams raw audio over standard
Bluetooth to the mobile app, which packages it and sends it through the same upload
pipeline as the recorder.

| Area | Status | What it means |
|---|---|---|
| Disconnect awareness | <span class="sate-badge warn">in progress</span> | A dropped link can currently look like the pendant's normal low-power "nap," so disconnect detection is being improved. |
| Recovery buffering | <span class="sate-badge warn">in progress</span> | On link recovery the pendant can replay slightly stale audio; the buffering strategy is being refined. |
| Loudness / distortion | <span class="sate-badge warn">in progress</span> | Firmware and app both apply gain to the quiet microphone, and stacking them can distort; the two stages are being balanced. |
| Recording onset | <span class="sate-badge warn">in progress</span> | A small slice at the very start of a recording can be clipped by a startup drain and is being tightened. |

## Web app

The web app is where clinicians review recordings, edit transcripts, run speech analysis,
and manage patients and billing. It recently went through a deep review of the flows that
touch clinical data.

The clusters we're prioritizing, roughly in order:

- **Transcript editing fidelity.** Certain edit paths can regenerate word-level timings or
  mishandle annotations (filler words, mispronunciations, morpheme notes) rather than
  preserving the original analysis. Making edits fully non-destructive is the top item.
- **Right transcript on the right recording.** We're eliminating cases where stale
  in-memory results could attach the wrong transcript to a newly saved recording.
- **Unsaved-changes safety.** A failed save should always warn before navigating away; we're
  closing gaps where a failure could silently drop edits.
- **Editor focus and undo.** Keyboard undo should never act on content behind an open editor;
  we're scoping shortcuts correctly.
- **Correct audio under the transcript.** We're hardening audio-URL handling (including
  expiring playback links) so the player always matches the transcript on screen.

| Area | Status | What it means |
|---|---|---|
| Annotation clickability | <span class="sate-badge ok">fixed</span> | Annotation popups now position correctly and are reliably clickable. |
| First-undo behavior | <span class="sate-badge ok">fixed</span> | Undo no longer wipes a freshly loaded transcript. |
| Non-destructive edits | <span class="sate-badge warn">in progress</span> | Inline transcript edits should preserve all analysis annotations and timings, not reset them. |
| Analysis accuracy | <span class="sate-badge warn">in progress</span> | Several speech-analysis metrics are being refined so disfluencies, examiner speech, and punctuation don't skew the numbers. |
| Fast patient switching | <span class="sate-badge warn">in progress</span> | Rapidly switching patients should never briefly show one patient's data under another. |
| Billing display | <span class="sate-badge warn">in progress</span> | Billing dates and subscription state are being made to always reflect the true account status. |

## Backend

The backend spans a hosted database, an Device API for devices, and a long-running container
service that handles AI transcription and analysis asynchronously (a queue with retries, so
long recordings are never cut off by short serverless time limits).

| Area | Status | What it means |
|---|---|---|
| Single processing path | <span class="sate-badge warn">in progress</span> | Ensuring only the dedicated container processes a session, so a recording can never be transcribed twice. |
| Duplicate backstop | <span class="sate-badge warn">in progress</span> | Adding a database-level guard against duplicate sessions in addition to the application-level check. |
| Delete ordering | <span class="sate-badge warn">in progress</span> | Making delete remove the record and its audio in a safe order so a failure can't leave a dangling reference. |
| Processing portability | <span class="sate-badge warn">in progress</span> | Keeping the asynchronous, long-running design intact across hosting options rather than regressing to a synchronous one. |

## Security (noted, prioritized behind features)

These are real items we've catalogued. The team has chosen to prioritize product features
first, but they're tracked and will be addressed before general availability.

- **Firmware-publishing access** should be restricted to administrators (image validation is
  already in place; the admin-only gate still needs to be enforced).
- **Device authentication** should be strengthened so device identity and heartbeat can't be
  guessed or spoofed to read roster or patient information.
- **Secret handling** — ensuring sensitive keys are never committed and that mobile tokens are
  stored in the platform's secure keychain rather than general app storage.
- **Tenant isolation** — tightening a few data-access policies so records stay scoped to the
  right account.

## Cleared during review

Two suspected problems were investigated and confirmed to be non-issues — noted here so they
aren't re-raised:

- A suspected race when starting a recording turned out to be safe by design.
- A suspected case of the processing watchdog reclaiming an actively running job turned out to
  be prevented by an existing safeguard.
