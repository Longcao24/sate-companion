# Design brief — SATE Companion mobile app

*Paste everything below the line into Claude Design (or any design tool/agent). It is
written to be self-contained: someone who has never seen this repo should be able to act on
it. Update it when the app changes — a stale brief produces a redesign of an app that no
longer exists.*

---

## The ask

Redesign the **SATE Companion** mobile app (iOS + Android, React Native / Expo) to be
markedly easier for a non-technical clinician to use. I want a coherent visual and
interaction system plus concrete screen designs — not a theme swap.

Work from the reality below. Where you think the current structure is wrong, say so and
show the better structure; don't silently preserve it.

---

## 1. Who uses this, and the one thing that matters

The user is a **speech-language pathologist (SLP)** — a clinician, not a technologist. They
work with patients (often children) on language samples, and their attention during a
session belongs to the patient, not to a phone.

Two thirds of the use is one moment: **start a recording, and later confirm it arrived.**
Everything else — pairing hardware, Wi-Fi setup, firmware, settings — is done rarely,
usually once, often while flustered because something isn't working.

Design implication: the app has two very different modes of use, and today they're mixed
together in one flat list of screens. A redesign should make the everyday path feel like
almost nothing, and make the rare-but-stressful path feel guided.

**The recording is clinical data and it is often irreplaceable.** Anything that can lose,
hide, or misrepresent a recording is the worst possible failure. Language about uploads,
errors and deletion must be precise — never cheerfully vague.

---

## 2. What the product actually is

A phone app that manages recording hardware and shows what the recordings became.

Four families of hardware, which behave **genuinely differently** — this is the central
design problem, not an implementation detail:

| Family | What it is | How it records | How audio reaches the server |
|---|---|---|---|
| **SATE Recorder** | ESP32-S3 device with its own screen, battery and Wi-Fi | Its own buttons, or remotely from the app | **By itself over Wi-Fi.** The phone is a window, not a pipe |
| **SATE Pendant** | Wearable, nRF52840 | Streams live audio to the phone while connected | Through the phone, live |
| **SATE L816** | Handheld, records to its own storage | Its own button, or from the app | Through the phone, transferred *after* the take ends |
| **Plaud** | Third-party recorder | On the device | Through the phone, synced afterwards |

The consequences a design has to carry honestly:

- A **SATE Recorder works with the phone switched off.** "Offline" means *the recorder*
  can't reach Wi-Fi — it does **not** mean it stopped recording.
- The **Pendant** must stay connected for the whole take. A silent gap is normal (it naps).
- The **L816** finishes recording and *then* transfers, and the transfer can take longer
  than the recording did. "Stopped" and "uploaded" are different states.
- The **L816 and Pendant keep recording even if the app closes or walks out of range.**
- Processing is **asynchronous**: after upload, an AI pipeline transcribes and analyses.
  That takes minutes and can fail and be retried. A recording is not "done" at upload.

Platform gating (a build ships only some families): Plaud and Pendant are **iOS-only**,
L816 is **Android-only**. So the same app shows a different set of hardware depending on
the phone. The design must not look broken when a family is absent.

---

## 3. Every screen today

Flat state machine in `App.tsx` — **no navigation library**, no tab bar, no back stack.
Each screen is full-screen with its own "Close" affordance. 12 destinations:

1. **Login** — email + password, or a QR code scanned from the web app.
2. **Device list (home)** — every paired device, one row each; "Add a device" opens a
   bottom sheet to pick a family. Empty state invites the first pairing.
3. **Recorder detail** — one SATE recorder: live status, big Record button, one-tap Sync,
   and its recent sessions with processing state. *762 lines — the biggest screen.*
4. **Recorder settings** — rename, identity, restart, unlink, change Wi-Fi.
5. **Provision** — first-time recorder setup: find over Bluetooth → pick Wi-Fi → password.
6. **Change Wi-Fi** — same wizard, for an already-claimed recorder.
7. **Pendant connect** — scan → connect → live record → auto-upload; battery; "find me" LED.
8. **Plaud connect** — connect → list the device's recordings → pull each one in.
9. **Plaud settings** — essentially one giant UNBIND button (it's a recovery path).
10. **L816 connect** — scan → connect → record/stop → download → upload; plus the device's
    own on-board file list as a recovery path.
11. **Report** — a processed recording: transcript + analysis, same data the web app shows.
    On first open it asks the clinician to name it and pick a protocol.
12. **Settings** / **Device preview** — account; and a hardware-free simulation of the
    recorder's own screen so someone can see how the device behaves before holding one.

---

## 4. What's wrong with it now (my read — challenge it)

- **No information architecture.** Twelve peer screens and a flat state machine. There's no
  persistent navigation, no sense of "where am I", and the everyday path (record → check it
  arrived) has the same weight as "change the recorder's Wi-Fi password".
- **Four connect screens that do the same job four ways.** Pendant, Plaud and L816 each
  reimplement scan → connect → record → upload with different words, different layouts and
  different status vocabulary. A user with two device types learns the app twice.
- **Diagnostics are in the user's face.** The connect screens show raw Bluetooth debug —
  every peripheral heard, dBm values, MAC addresses, adapter state. Invaluable when
  something's broken; noise the other 95% of the time. It should be reachable, not resident.
- **State is described in engineer's words.** "queued", "processing", "no_text", raw error
  strings. A clinician needs to know: is my recording safe, is it ready, do I do anything?
- **No feedback shape for slow things.** Some operations take seconds (connect), some
  minutes (transfer, AI processing). They currently look alike.
- **The empty state is a dead end** when a user has hardware the build doesn't support.
- **Everything is a dark console.** Handsome, but undifferentiated: a clinical report and a
  Bluetooth scan get identical visual treatment.

---

## 5. Constraints that are not negotiable

- **React Native (Expo), no UI kit.** Plain `View`/`Text`/`Pressable`/`StyleSheet` and a
  small local `ui.tsx`. Hand-drawn device likenesses are built from Views/SVG. Any design
  must be buildable this way — no CSS grid, no web-only tricks, no heavy component library.
- **Dark palette exists and is decent** — keep it as the base unless you can argue better.
  Tokens: bg `#0B0E13`, panel `#15191F`, tile `#1C212A`, hairline `#262C36`, ink `#F3F4F6`,
  secondary `#9AA3AF`, accent `#3B9EFF`, green `#22C55E`, red `#EF4444`, amber `#F59E0B`.
- **One device can be connected at a time.** The Bluetooth radio is arbitrated; opening one
  device's screen disconnects another. The design must make that feel intentional.
- **Some states genuinely can't be measured.** A file transfer has a real percentage; AI
  processing does not. Do not invent a progress bar for something we can't measure — an
  indeterminate state must be designed, not faked.
- **Destructive actions are real.** Unlinking a recorder, unbinding a Plaud, deleting a
  session. They need weight, and their copy needs to say exactly what survives.

---

## 6. What I want back

1. **An IA proposal.** What's the top-level structure? Does this need tabs? What is the one
   screen a user lands on, and what's one tap away vs. buried?
2. **One unified "device" pattern** that covers all four families honestly — same layout,
   same status vocabulary, differences shown where they're real. Include how an
   *unsupported-on-this-platform* family is handled.
3. **A status vocabulary in plain clinical English**, mapped to the real underlying states:
   connected / recording / transferring / uploaded / processing / ready / needs attention.
   One word per state, used identically everywhere.
4. **High-fidelity screens** for: home/device list, a device detail mid-recording, a
   transfer in progress, a processed report, and first-time pairing.
5. **The rare-but-stressful flow designed properly**: first-time setup and "it's not
   connecting". Where do diagnostics live so they're findable but not resident?
6. **A component inventory** — buttons, cards, list rows, status pills, progress, sheets,
   empty states, destructive confirmations — with the tokens to build them.
7. **Motion and feedback notes**: what a 2-second wait looks like vs. a 5-minute one.

Call out anything in §4 you disagree with, and anything in §2 that you think the current
design is lying about. Being wrong in the direction of "this recording is fine" is the one
failure mode this product cannot have.
