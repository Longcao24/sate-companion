# Auditing this system — what actually finds bugs, and what doesn't

Written after three consecutive adversarial audit rounds on the recorder firmware
(2026-07-23) that found 55, then 13, then 17 confirmed defects — where **round 2 and
round 3 kept finding defects that the previous round's own FIXES had introduced.**
Everything below is a lesson paid for in real bugs on a real device.

## 1. The blind spot that cost the most: reachability, not correctness

Two full audits read `trimPatientSyncedAudio()`, agreed it was correct, and moved on.
It *was* correct. It was also called from exactly **one** place — the upload-success
path — so once the upload backlog drained, reclaim never ran again. The SD card filled
to 161 MB while the screen said "all synced".

Then the fix for that reintroduced the same trap with a different gate
(`pendCount == 0`), which one permanently-unsendable session pins false forever.

**So for every guard, cleanup, recovery, or reclaim path, ask three questions —
the third is the one everybody skips:**

1. What does this function do?
2. Who calls it, and under what conditions?
3. **When is it NEVER called?**

A guard that cannot be reached in a plausible steady state is as broken as one that
computes the wrong answer, and it is far harder to see, because the code reads fine.
Concretely, audit: every `*Req`/`*Due` flag (set somewhere, consumed where — and is that
consumer itself reachable?), every early-return, every path behind an event that may
never arrive (no upload, no Wi-Fi, no app connected, no button press, no take).

Round 3's dedicated "reachability lens" — an agent whose whole job was building the
call graph and hunting never-called paths — found several defects the topic-based
lenses missed. **Give it its own agent; it will not happen as a side effect.**

## 2. An audit verifies code against a stated intent — so a wrong intent verifies clean

The single biggest miss was not the audit's fault. The user asked for *"keep only the 5
newest recordings"*. The fix mandate I wrote said *"keep the 5 newest **per patient**"*.
Agents implemented and verified that faithfully, and a stale patient dir pinned 31 MB
forever. Every verifier passed it, because it matched the spec it was given.

**No verifier flags "correct code, wrong requirement."** Before spending an audit:
re-read the user's own words, quote them into the mandate verbatim, and if the mandate
paraphrases them, treat the paraphrase as the most likely bug in the whole run.

## 3. Static audit does not observe a running system

What finally located the retention bug was not code review — it was
`sd used=161/29581 MB` from a `DIAG` dump, and then a per-directory inventory line that
made the card's real contents visible:

```
[CONN] card: demo holds 5 take(s) with audio, 2 MB
[CONN] card: Standalone holds 5 take(s) with audio, 31 MB   <- the answer
```

Static audit and runtime observation are different instruments. When a user reports a
symptom ("the card is still full", "it says all synced"), **go look at the device
first**; audit the code second. And if the device cannot tell you what it holds, that
missing observability is itself the first bug to fix.

## 4. Always re-audit AFTER a fix campaign — the fixes are the newest, least-reviewed code

- Round 2 found 2 criticals introduced by round 1's fixes.
- Round 3 found 4 more introduced by round 2's, including one that **bricked recording
  permanently after 99 takes**.

New code written under time pressure to fix known bugs is exactly where the next bug
lives. Point the re-audit *hardest* at the diff, and say so in the mandate. A fix
campaign is not done when it compiles and the suite passes; it is done when it has been
audited as fresh code.

## 5. Verify-gating is what makes a destructive fix survivable

Several of these bugs *did* fire in production paths — the reclaim ran with the wrong
retention floor, and once reclaimed the entire card. **Nothing was lost**, because every
delete path is gated on `verifySessionStored()`: byte-exact server confirmation before
the device frees its only copy.

The lesson generalises: when a subsystem can destroy user data, put the proof obligation
*at the deletion site*, not in the caller's logic. Then a bug in the caller costs you
correctness, not data. Every audit finding in the reclaim path was a behaviour bug
precisely because the gate held.

Corollary for fail-safes: **"unknown" must mean "keep everything", never "keep nothing."**
One cut of the retention code treated an unknown live directory as keep-0 and reclaimed
every directory. Default the safe direction explicitly; do not let it fall out of a
zero-initialised variable.

## 6. Identity: a byte count is not an identity

Retention proved "the server has this take" with `(patient, session_number, bytes)`.
With numbers reused after delete, and remote takes recorded for an exact duration
(so byte counts collide deterministically), that tuple can match a *different* take —
and free the only local copy of the new one. Found by round 2, mitigated by keeping a
per-directory NVS high-water so a deleted number is not recycled before the 99 wrap.

**The real fix is a per-take identity** (a random take id written at record time, sent
with the final chunk and with verify, compared server-side). It needs a server column,
so it is still open. If you touch this path, do that properly rather than adding another
heuristic on top.

## 7. Deleting the machinery beats making the machinery crash-safe

The user's call — *never renumber sessions; allocate monotonically and wrap at 99* —
removed more critical bugs in one stroke than any fix: renumber-under-a-live-upload
splicing two takes into one server WAV, the trash tap that deleted the wrong recording
after a shift, the 65 s guard shorter than the net task's critical section, and the
power-cut-mid-renumber slot reuse. Along with them went the NVS journal,
`recoverInterruptedDelete()`, `compactPatientDir()` and `renameSessionFiles()`.

Before hardening a complex mechanism, ask whether the product actually needs it.
Deleted code has no bugs. (See the memory note `no-renumber-sessions`.)

**But** watch the second-order effects: no-renumber made numbers a finite resource, and
`.synced` tombstones then exhausted all 99 slots, permanently killing RECORD after 99
lifetime takes on a standalone unit. Every simplification moves the failure somewhere —
find where before shipping it.

## 8. Practical shape of an audit run that works here

- **Scenario lenses, not file lenses.** Twelve real-usage scenarios (power loss at each
  point, SD faults, Wi-Fi loss mid-upload, button abuse, 62-minute take, remote-command
  races, OTA, `millis()` wrap, BLE, battery/audio, state machine) found far more than any
  by-file split, because a bug lives in a *path*, not a file.
- **Feed measured artifacts, not guesses.** Giving agents the real ELF symbol ranking and
  real serial heap numbers turned "maybe move some buffers" into a ranked list with byte
  counts. Build with `--build-path`, then `xtensa-esp32s3-elf-nm --size-sort -S` filtered
  to the internal-DRAM address range.
- **One adversarial verifier per finding, defaulting to `real=false`.** Roughly a fifth
  of raw findings get refuted, and several verdicts corrected the finding's severity or
  its stated mechanism — those corrections were often more useful than the finding.
- **Fix in sequential compile-gated phases when the defects share files.** Two files held
  all 55 firmware defects, so parallel agents would have collided; six sequential phases,
  each compiling before the next, worked cleanly.
- **Then gate on hardware** (`sate ci`), not just on the compiler.

## 9. Things that are true about this codebase specifically

- The two firmware files are big and interdependent: parallel edits need worktrees or
  sequencing. Webapp defects, by contrast, spread over ~20 files and parallelised well
  (11 disjoint groups).
- `noUnusedLocals` in the web build fails on a merely-unused variable — a fix that
  compiles in isolation can still break the deploy.
- The device's own log is the best oracle available. Every diagnostic added during these
  rounds (`[BOOT] reset=…`, the `DIAG` dump, the per-dir card inventory, the
  `[REC] resume: …` branches) paid for itself within the same session.
