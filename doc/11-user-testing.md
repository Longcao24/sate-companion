# 11 — User testing guide

A plain-language guide for testing SATE the way a **real user** (a speech-language
pathologist) uses it. You don't need any technical knowledge — just follow the steps and
check that what you see matches. This is about the experience and the results, not how the
system works underneath.

> For the engineering/QA version (with system internals), see [10-manual-testing.md](10-manual-testing.md).

## How to use this

Go through the tests in order — they follow a real session from start to finish. For each one:

- **What this checks** — why it matters to you.
- **Do this** — the steps to follow.
- **You should see** — what a passing result looks like.
- Mark **Pass ▢ / Fail ▢** and jot a note if anything looks off (a screenshot helps).

Tips:
- Use a **test patient** and a **spare recorder** — don't test on a real client's device or data.
- If something doesn't work, note exactly what you clicked and what happened — that's the most useful thing for the team.

---

## 1. Sign in

**What this checks:** you can get into your account.

**Do this:**
1. Open the SATE web app.
2. Enter your email and password and sign in.

**You should see:** your home screen with your recordings and patients. Signing out and back in works too.

Pass ▢ Fail ▢ — notes: __________

---

## 2. Record a session on the device

**What this checks:** the handheld recorder captures a session and it turns up in your account.

**Do this:**
1. Turn on the recorder and wait for it to say **READY**.
2. Press the **record** button and talk (or play a sample) for about 20–30 seconds.
3. Press the button again to **stop**.
4. Leave the device on Wi-Fi for a minute or two.

**You should see:** the screen shows it's recording while you talk, returns to READY when you stop, and then shows that everything is **synced**. Shortly after, the new recording appears in the web app.

Pass ▢ Fail ▢ — notes: __________

---

## 3. Mark an important moment (flag)

**What this checks:** the flag button marks a moment you can jump back to later.

**Do this:**
1. Start a recording.
2. Press the **flag** button at a moment you want to remember.
3. Stop, let it sync, and open the recording in the web app.

**You should see:** a small marker on the playback bar at about the spot you flagged, so you can click straight to it.

Pass ▢ Fail ▢ — notes: __________

---

## 4. Record with the pendant or phone

**What this checks:** the wearable pendant (or phone capture) also produces a recording.

**Do this:**
1. In the phone app, connect to the pendant.
2. Start capture, talk for ~10 seconds, stop.
3. Use **Find me** to make the pendant flash, and check its battery shows.

**You should see:** the audio comes through and becomes a recording just like the handheld; Find-me flashes the pendant; battery looks sensible. A short quiet gap while connected is normal.

Pass ▢ Fail ▢ — notes: __________

---

## 5. Find and open your recording

**What this checks:** you can find a finished recording and open it.

**Do this:**
1. In the web app, go to your recordings.
2. Open the one you just made.

**You should see:** the recording opens with the audio player and the written transcript. It may take a couple of minutes after recording for the transcript to be ready.

Pass ▢ Fail ▢ — notes: __________

---

## 6. Listen and read along

**What this checks:** playback and the transcript line up and are usable.

**Do this:**
1. Press play and follow the transcript.
2. Click a flag marker on the bar (if you set one).

**You should see:** the audio plays clearly, the transcript is readable and split by speaker, and clicking a marker jumps to that moment.

Pass ▢ Fail ▢ — notes: __________

---

## 7. Fix the transcript

**What this checks:** you can correct the transcript and your changes stick.

**Do this:**
1. Click **Edit**.
2. Fix a word or change who's speaking.
3. Use **Undo** and **Redo** to check they work.
4. Click **Save**, then refresh the page.

**You should see:** undo/redo behave as expected; after saving and refreshing, your correction is still there. If you try to leave with unsaved changes, it warns you.

Pass ▢ Fail ▢ — notes: __________

---

## 8. Compare to typical norms

**What this checks:** you can compare a child's sample against typical peers, and the app remembers your settings so you don't re-type them.

**Do this:**
1. Open a recording and go to the **Analysis** tab.
2. Under **Sample Details**, enter the child's **Year** (age), and optionally **Month** and **± Range**.
3. Click **Compare to norms**.
4. Close and reopen the same recording's Analysis tab.
5. Change the age and click **Compare to norms** again.

**You should see:**
- The comparison appears — bars showing how the child compares to the typical average, with the sample size and age range. **It should not say "Failed to fetch."**
- When you reopen it, your settings **and** the comparison are still there — you don't have to run it again.
- Changing the age and re-running updates the result, and the new settings are remembered.

Pass ▢ Fail ▢ — notes: __________

---

## 9. Create the report and save it

**What this checks:** you can generate the clinical report and save it as a PDF and a Word document to share.

**Do this:**
1. Open a recording and click **SATE Report**.
2. Read through the report preview — transcript, metrics, the language assessment, limitations, and summary.
3. Enter the **Patient age** (for example `6;0`).
4. Click **Export PDF** and save the file. Open it.
5. Click **Export Word** and open the downloaded document.
6. Close the report and open it again for the same recording.

**You should see:**
- The report looks complete and tidy, with all its sections.
- The PDF looks the same as the preview (colored bars, tables).
- The Word document opens and is editable (the bars may look a little simpler in Word).
- When you reopen the report, the **patient age you typed is still there**.

Pass ▢ Fail ▢ — notes: __________

---

## 10. Manage a patient and see progress

**What this checks:** you can keep patients organized and see change over time.

**Do this:**
1. Create a test patient.
2. Attach a recording to that patient.
3. Open the patient and go to **Analytics**.

**You should see:** the patient saves, the recording links to them, and the progress chart shows a metric over their sessions with a trend (you need at least two sessions for a trend line).

Pass ▢ Fail ▢ — notes: __________

---

## 11. Export the transcript (SALT)

**What this checks:** you can export the transcript in the SALT format for other tools.

**Do this:**
1. On a recording, click **Export SALT**.
2. Fill in the header details and download the file.

**You should see:** a file downloads and, when opened, contains the header lines followed by the coded transcript.

Pass ▢ Fail ▢ — notes: __________

---

## If something goes wrong

These aren't failures of your test — just what to do:

- **A recording doesn't appear:** give it a couple of minutes to process; make sure the device finished syncing (screen says "synced").
- **Very short / empty recording:** if you tapped record and stopped almost immediately, it's fine for it to show "No text in audio" — that's expected, not an error.
- **"Compare to norms" won't load:** try again shortly; if it keeps failing, tell the team (it may be a temporary connection issue on our side).
- **Anything unexpected:** note what you did, what you expected, and what happened — a screenshot is ideal.

---

## Quick run-through (about 10 minutes)

If you only have a few minutes, do these in order:

1. Sign in (§1).
2. Open a recording, play it, read the transcript (§5–6).
3. Compare to norms — it loads and is remembered (§8).
4. Create the report, set the age, save as PDF and Word, reopen (§9).
5. Export SALT (§11).

Note the date you tested and mark each Pass/Fail.
