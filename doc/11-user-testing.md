# 11 — User testing guide (recorder)

A plain-language guide for testing the SATE **handheld recorder** the way a real user does.
No technical knowledge needed — follow the steps and check that what you see matches.

Scope of this version:
- **Recorder only** (no pendant).
- On the web app you only need to **read the transcript** and **export a PDF**.
- The important part is the **robustness cases**: turning the recorder off and on **while
  recording** and **while uploading**, to confirm nothing is lost and uploading continues on
  its own.

> Engineering/QA version with system internals: [10-manual-testing.md](10-manual-testing.md).

## How to use this

For each test:
- **What this checks** — why it matters.
- **Do this** — the steps.
- **You should see** — the passing result.
- Mark **Pass ▢ / Fail ▢** and add a note if anything looks off (a screenshot helps).

Tips:
- Use a **test patient** and a **spare recorder** — not a real client's device or data.
- "Turn off and on" = power the recorder off and back on (or briefly remove power). Wait for it
  to come back to the READY screen before continuing.
- For the recordings to appear on the web, the recorder must be **on Wi-Fi**.

---

## Part A — Basic flow

### 1. Record a session
**What this checks:** the recorder captures a session and it reaches your account.

**Do this:**
1. Turn on the recorder and wait for **READY**.
2. Press **record**, talk (or play a sample) for ~20–30 seconds.
3. Press the button again to **stop**.
4. Leave it on Wi-Fi for a minute or two.

**You should see:** it shows recording while you talk, returns to READY on stop, then shows
**synced**. The recording appears in the web app shortly after.

Pass ▢ Fail ▢ — notes: __________

### 2. Read the transcript on the web app
**What this checks:** the finished recording opens with a readable transcript.

**Do this:**
1. In the web app, open your recordings and click the one you just made.
2. Read the transcript; press play to spot-check it matches the audio.

**You should see:** the transcript is there, readable, split by speaker, and lines up with the
audio. (It can take a couple of minutes after recording to be ready.)

Pass ▢ Fail ▢ — notes: __________

### 3. Export a PDF
**What this checks:** you can produce a PDF to save or share.

**Do this:**
1. With the recording open, click **SATE Report**.
2. Click **Export PDF** and save the file, then open it.

**You should see:** a tidy PDF report opens and looks the same as the on-screen preview.

Pass ▢ Fail ▢ — notes: __________

---

## Part B — Robustness (the key tests)

### 4. Turn off and on WHILE recording
**What this checks:** if the recorder loses power or restarts in the middle of a recording, it
**resumes the same recording** and nothing already recorded is lost.

**Do this:**
1. Press **record** and talk for ~20 seconds.
2. **Turn the recorder off and back on** while it is still recording.
3. Wait for it to come back; if it resumes recording, keep talking another ~20 seconds.
4. Press **stop**. Let it sync.
5. Open the recording on the web app.

**You should see:**
- After restarting, the recorder picks the recording back up on its own (same session) —
  it does **not** start a blank new one or throw the take away.
- The finished recording contains the audio from **before and after** the restart, as **one**
  recording (not split in two, nothing missing).

Pass ▢ Fail ▢ — notes: __________

### 5. Turn off and on WHILE uploading
**What this checks:** if the recorder restarts while a recording is uploading, it **keeps
uploading on its own** and finishes — no lost recording, no duplicate.

**Do this:**
1. Record a **longer** take (~1–2 minutes) so uploading takes a little while, then **stop**.
2. While it is uploading / syncing, **turn the recorder off and back on**.
3. Leave it on Wi-Fi and wait.
4. Open the web app.

**You should see:**
- After restarting, the recorder **automatically resumes uploading** (you don't have to press
  anything) and reaches **synced**.
- The recording shows up on the web **complete** (full length) and **only once** (not
  duplicated, not cut short).

Pass ▢ Fail ▢ — notes: __________

### 6. Record with Wi-Fi off, then turn Wi-Fi on
**What this checks:** a recording made with no internet is kept safely and **uploads by itself**
once Wi-Fi is back.

**Do this:**
1. Take the recorder off Wi-Fi (turn off the router/hotspot or move out of range).
2. Record a ~30-second take and **stop**. Confirm it is kept on the device (it should show as
   not yet synced).
3. Bring Wi-Fi back and leave the recorder on.
4. Open the web app.

**You should see:** the recording waits on the device while offline, then **uploads
automatically** when Wi-Fi returns, and appears on the web — complete and once.

Pass ▢ Fail ▢ — notes: __________

### 7. Several recordings in a row
**What this checks:** back-to-back recordings all upload and none are lost or mixed up.

**Do this:**
1. Make **3 short recordings**, stopping between each.
2. Leave the recorder on Wi-Fi.
3. Open the web app.

**You should see:** all **3** recordings appear, each with its own transcript, in the right
order, none missing or merged.

Pass ▢ Fail ▢ — notes: __________

---

## If something goes wrong

Not necessarily failures — what to do:

- **A recording hasn't appeared:** give it a couple of minutes; make sure the recorder screen
  says **synced** and it's on Wi-Fi.
- **Very short / empty recording:** if you tapped record and stopped almost immediately, it's
  fine for the web to show "No text in audio" — that's expected.
- **Anything unexpected** (recording split, duplicated, cut short, or didn't resume): note what
  you did, when you turned it off/on, and what you saw — a photo of the screen helps a lot.

---

## Quick run-through

1. Record → read the transcript on the web (§1–2).
2. Export a PDF (§3).
3. Turn off/on **while recording** — it resumes as one recording (§4).
4. Turn off/on **while uploading** — it finishes uploading on its own (§5).

Note the date you tested and mark each Pass/Fail.
