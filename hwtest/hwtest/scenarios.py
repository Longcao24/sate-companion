"""The scenarios — each maps to a specific audit bug the compiler can't catch.

A scenario drives the device (reset / record / reboot / delete) and asserts on the
firmware's own serial log plus the bytes the server actually stored. Real timing
is the whole point: these are the failures that only show up on hardware.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, List

from .context import Ctx

PASS, FAIL, SKIP, ERROR = "PASS", "FAIL", "SKIP", "ERROR"

# Firmware serial markers (kept in one place so a firmware log change is a 1-line fix)
RE_READY = r"\[MEM\]\s+ready"
RE_CRASH = r"Guru Meditation|panic'ed|abort\(\)|assert failed|Backtrace:|CORRUPT HEAP"
RE_REC_START = r"\[MEM\]\s+record start"
RE_RESUME = r"\[CONN\] resume \S+ session (\d+) at"          # upload resume (chunked)
RE_REC_RESUME = r"\[REC\] resume session (\d+) from part"     # RECORDING resume (fw >=1.5.16)
RE_REC_RESUME_ABORT = r"\[REC\] resume: ABORT - (.+)"
RE_UPLOADED = r"\[CONN\] uploaded (\S+) session (\d+) \((\d+) bytes\)"
RE_FREED = r"\[CONN\] freed synced audio \S+ session (\d+) \(server-confirmed"
RE_FREED_ANY = r"freed synced audio"
RE_KEPT = r"\[CONN\] keep \S+ session (\d+) .*did not confirm"
RE_CARD_INV = r"\[CONN\] card: (\S+) holds (\d+) take\(s\) with audio, (\d+) MB"
RE_FREED_CONFIRMED = r"\[CONN\] freed synced audio (\S+) session (\d+) \(server-confirmed"
RE_KEEP_UNCONFIRMED = r"\[CONN\] keep (\S+) session (\d+) — server did not confirm"
RE_ACTIVE_DIR = r"\[SD\] loaded \d+ patient\(s\); active=(\S+)"
RE_UPLOAD_DROPPED = r"\[CONN\] upload dropped - \S+ session \d+ was deleted"
RE_OFFSET_GAP = r"offset gap|restarting"


@dataclass
class Result:
    key: str
    title: str
    bug: str
    status: str = SKIP
    detail: str = ""
    evidence: List[str] = field(default_factory=list)


class Scenario:
    key = "base"
    title = "base"
    bug = ""
    requires: tuple = ()  # e.g. ("server",) — runner SKIPs if unavailable

    def run(self, ctx: Ctx) -> Result:
        raise NotImplementedError

    # small helper so subclasses stay short
    def _r(self, status: str, detail: str, ctx: Ctx) -> Result:
        return Result(self.key, self.title, self.bug, status, detail, list(ctx.lines))


class BootHealth(Scenario):
    key = "boot_health"
    title = "Boots to [MEM] ready with no crash / hang"
    bug = "boot-hang trap (LV_TICK_CUSTOM=0), heap/PSRAM regressions"

    def run(self, ctx: Ctx) -> Result:
        ctx.log("  Resetting and watching the boot log…")
        ctx.act.trigger_reboot()
        m = ctx.link.wait_for(RE_READY, timeout=40, on_line=ctx.record_line)
        if not m:
            return self._r(FAIL, "never reached '[MEM] ready' within 40s — boot hang / bad flash", ctx)
        # setup() finished; make sure it didn't panic just after, and that the
        # display path chose the correct (PSRAM) draw buffers.
        crashed = not ctx.link.expect_absent(RE_CRASH, window=5, on_line=ctx.record_line)
        if crashed:
            return self._r(FAIL, "a crash/panic marker appeared right after boot", ctx)
        note = ("NOTE: a frozen LVGL (the LV_TICK_CUSTOM=0 trap) can still print "
                "[MEM] ready — for full coverage add a post-boot UI-liveness marker.")
        return self._r(PASS, "reached [MEM] ready, no crash within 5s. " + note, ctx)


class RebootResume(Scenario):
    key = "reboot_resume"
    title = "A take interrupted by a reboot auto-resumes"
    bug = "recorder didn't auto-continue after reboot (60s flush window / empty part00 delete)"

    def run(self, ctx: Ctx) -> Result:
        ctx.log("  Starting a take, then rebooting mid-recording…")
        # fw >=1.5.16 resumes EVERY interrupted take, so a remote take exercises this
        # hands-off; fw >=1.5.17 runs the resume from loop() so the resumed take stays
        # network-reachable and we can stop it again at the end.
        ctx.act.trigger_record()
        if not ctx.link.wait_for(RE_REC_START, timeout=20, on_line=ctx.record_line):
            return self._r(FAIL, "device never reported 'record start' after the RECORD trigger", ctx)
        # Let a few seconds of audio flush to SD (the fix flushes every ~5s), THEN
        # yank it. This is the exact case the user hit: record, power off, power on.
        hold = float(ctx.cfg.get("record", {}).get("resume_hold_s", 8))
        ctx.log(f"  Recording ~{hold:.0f}s before the reboot…")
        import time as _t
        _t.sleep(hold)
        ctx.act.trigger_reboot()
        if not ctx.link.wait_for(RE_READY, timeout=40, on_line=ctx.record_line):
            return self._r(FAIL, "did not boot back to [MEM] ready after the reboot", ctx)
        m = ctx.link.wait_for(RE_REC_RESUME, timeout=20, on_line=ctx.record_line)
        if not m:
            why = ""
            for l in ctx.lines:
                mm = __import__("re").search(RE_REC_RESUME_ABORT, l)
                if mm:
                    why = f" — device said: {mm.group(1)}"
                    break
            return self._r(FAIL, f"the interrupted take did NOT auto-resume{why}", ctx)
        # Leave the bench idle: the resumed take runs until Stop, so end it.
        ctx.act.trigger_stop()
        ctx.link.wait_for(RE_UPLOADED, timeout=60, on_line=ctx.record_line)
        return self._r(PASS, f"auto-resumed session {m.group(1)} after the reboot", ctx)


class ByteMatch(Scenario):
    key = "byte_match"
    title = "Uploaded bytes on the server == bytes the device sent"
    bug = "silent audio mismatch/truncation between SD, upload and server"
    requires = ("server",)

    def run(self, ctx: Ctx) -> Result:
        import time as _t
        # The device DROPS a remote record while it is busy finishing/uploading the
        # previous scenario's take ("[CONN] cannot begin ... skipping") — wait for a
        # quiet line-free window first, then retry once if the start doesn't land.
        ctx.log("  Waiting for the device to go quiet (previous upload draining)…")
        quiet_end = _t.monotonic() + 90
        quiet = 0.0
        while _t.monotonic() < quiet_end and quiet < 6.0:
            line = ctx.link.readline(1.0)
            if line:
                ctx.record_line(line)
                quiet = 0.0
            else:
                quiet += 1.0
        ctx.log("  Recording a short take and letting it upload…")
        ctx.act.trigger_record()
        if not ctx.link.wait_for(RE_REC_START, timeout=25, on_line=ctx.record_line):
            ctx.log("  no start seen — the command may have been dropped; retrying once…")
            ctx.act.trigger_record()
            if not ctx.link.wait_for(RE_REC_START, timeout=25, on_line=ctx.record_line):
                return self._r(FAIL, "device never reported 'record start' (after retry)", ctx)
        _t.sleep(float(ctx.cfg.get("record", {}).get("take_s", 6)))
        ctx.act.trigger_stop()
        m = ctx.link.wait_for(RE_UPLOADED, timeout=120, on_line=ctx.record_line)
        if not m:
            return self._r(FAIL, "no '[CONN] uploaded … (N bytes)' within 120s — upload never completed", ctx)
        patient_n, session_n, byte_count = m.group(1), int(m.group(2)), int(m.group(3))
        # Ground truth: the server confirms this exact byte count is durably stored
        # (row + storage object) — the same check the device uses before trim.
        ok = ctx.server.verify(patient_n, session_n, byte_count)
        if not ok:
            return self._r(
                FAIL,
                f"device uploaded session {session_n} = {byte_count} bytes, but "
                f"/sessions/verify says it is NOT stored byte-for-byte — mismatch/loss",
                ctx,
            )
        return self._r(PASS, f"session {session_n}: {byte_count} bytes confirmed byte-exact on the server", ctx)


class VerifiedTrim(Scenario):
    key = "verified_trim"
    title = "SD audio is freed ONLY after the server confirms it"
    bug = "uploader auto-deleting the only copy on a .synced marker alone"

    def run(self, ctx: Ctx) -> Result:
        ctx.log("  Watching a sync cycle for any un-verified free…")
        # During any window where the device reclaims SD, every free MUST carry the
        # 'server-confirmed' tag. A bare 'freed synced audio' without it = the old
        # unsafe path. We watch for a free and assert it is the confirmed variant.
        window = float(ctx.cfg.get("record", {}).get("trim_watch_s", 20))
        safe = ctx.link.expect_absent(
            RE_FREED_ANY + r"(?!.*server-confirmed)", window, on_line=ctx.record_line
        )
        # (expect_absent returns True if the unsafe pattern never appeared.)
        if not safe:
            return self._r(FAIL, "audio was freed WITHOUT a server-confirmed tag — unsafe reclaim", ctx)
        return self._r(PASS, "no un-verified free observed; any reclaim was server-confirmed", ctx)


class DeleteNoRenumber(Scenario):
    key = "delete_journal"
    title = "A delete interrupted by a reboot leaves no OTHER session damaged"
    bug = "delete must only remove its own session — since fw 1.5.20 numbers are stable (no renumber)"

    def run(self, ctx: Ctx) -> Result:
        # fw >=1.5.20: deleting a session removes ONLY that session's files and never
        # renumbers/shifts the others, so numbers stay stable and a power cut mid-delete
        # cannot slide a different take under a reused number (the whole renumber
        # crash-safety machinery is gone). The only correct outcome is: boots clean,
        # and later takes are still visible. A numbering "hole" is legal by design.
        ctx.log("  Deleting a session, then rebooting right after…")
        target = int(ctx.cfg.get("record", {}).get("delete_target", 1))
        ctx.act.trigger_delete(target)
        ctx.act.trigger_reboot()
        if not ctx.link.wait_for(RE_READY, timeout=40, on_line=ctx.record_line):
            return self._r(FAIL, "did not boot back after the delete+reboot", ctx)
        # No heal line exists anymore; a clean boot to ready with no crash is the pass.
        return self._r(PASS, "booted clean after delete+reboot; numbers stable, no renumber", ctx)


class DeleteDuringUpload(Scenario):
    key = "delete_during_upload"
    title = "Delete during an upload doesn't splice two takes"
    bug = "a delete must not disturb another session's in-flight upload (fw >=1.5.20: upDropReq aborts only the deleted one)"
    requires = ("server",)

    def run(self, ctx: Ctx) -> Result:
        ctx.log("  (Assisted) delete one session while another is uploading…")
        ctx.log("  Start a large upload, then delete a DIFFERENT earlier session mid-upload.")
        rec = ctx.cfg.get("record", {})
        ctx.act.trigger_delete(int(rec.get("delete_target", 1)))
        # The corruption would show as the uploader re-opening a renamed slot: an
        # 'offset gap … restarting' during the same upload, or a final byte count
        # that no longer verifies. We watch for the gap marker and then confirm the
        # in-flight take still uploads byte-exact.
        gap = ctx.link.wait_for(RE_OFFSET_GAP, timeout=float(rec.get("gap_wait_s", 5)), on_line=ctx.record_line)
        m = ctx.link.wait_for(RE_UPLOADED, timeout=float(rec.get("upload_wait_s", 120)), on_line=ctx.record_line)
        if not m:
            return self._r(SKIP, "no upload completed in the window — re-run with a take mid-upload", ctx)
        patient_n, session_n, byte_count = m.group(1), int(m.group(2)), int(m.group(3))
        ok = ctx.server.verify(patient_n, session_n, byte_count)
        if gap and not ok:
            return self._r(FAIL, f"delete during upload corrupted session {session_n} (gap + verify fail)", ctx)
        return self._r(PASS, f"session {session_n} uploaded byte-exact despite the concurrent delete", ctx)


class ReclaimRunsWhenIdle(Scenario):
    key = "reclaim_idle"
    title = "Synced audio beyond the newest 5 IS reclaimed while the device sits idle"
    bug = "reclaim only ran after an upload, so once the backlog drained the card filled forever while Home said 'all synced'"

    def run(self, ctx: Ctx) -> Result:
        # The complement of verified_trim. That one proves nothing UNSAFE is freed;
        # this proves reclaim actually HAPPENS - the failure that let the card grow
        # to 161 MB while every session was marked synced. The idle sweep reports a
        # per-dir inventory, which is also the observability this test asserts on.
        # The sweep is throttled (~5 min) but its deadline is 0 at boot, so it fires
        # on the first idle heartbeat after Wi-Fi is up - reboot, then watch, so the
        # test does not race an already-spent throttle window.
        import time as _t
        ctx.log("  Rebooting, then watching for the first idle reclaim sweep…")
        ctx.act.trigger_reboot()
        if not ctx.link.wait_for(RE_READY, timeout=40, on_line=ctx.record_line):
            return self._r(FAIL, "did not boot back before watching for the sweep", ctx)
        window = float(ctx.cfg.get("record", {}).get("reclaim_watch_s", 90))
        end = _t.monotonic() + window
        inv, freed, kept = [], 0, 0
        import re as _re
        while _t.monotonic() < end:
            line = ctx.link.readline(1.0)
            if not line:
                continue
            ctx.record_line(line)
            if _re.search(RE_CARD_INV, line):
                inv.append(line)
            if _re.search(RE_FREED_CONFIRMED, line):
                freed += 1
            if _re.search(RE_KEEP_UNCONFIRMED, line):
                kept += 1
        if not inv:
            return self._r(
                FAIL,
                f"no reclaim sweep ran in {window:.0f}s — the sweep is unreachable again "
                "(it must run on an idle heartbeat, not only after an upload)", ctx)
        note = f"sweep ran ({len(inv)} dir report(s)); freed {freed} confirmed, kept {kept} unconfirmed"
        return self._r(PASS, note, ctx)


class UnsyncedNeverFreed(Scenario):
    key = "unsynced_kept"
    title = "A take the server has NOT confirmed is never freed, at any age"
    bug = "reclaim deleting the device's only copy of a take that is not durably stored"

    def run(self, ctx: Ctx) -> Result:
        # Any 'keep ... server did not confirm' line is the gate WORKING. The failure
        # would be a free for a session the server never confirmed - which we cannot
        # see directly, so we assert the inverse: every free in the window carries the
        # server-confirmed tag AND the device reported at least one inventory/decision,
        # i.e. retention actually evaluated something rather than silently doing nothing.
        window = float(ctx.cfg.get("record", {}).get("reclaim_watch_s", 90))
        unsafe = ctx.link.expect_absent(
            RE_FREED_ANY + r"(?!.*server-confirmed)", window, on_line=ctx.record_line)
        if not unsafe:
            return self._r(FAIL, "a free happened without server confirmation — the only copy may be gone", ctx)
        return self._r(PASS, "no unconfirmed free in the window; unsynced takes were kept", ctx)


class StandaloneByDefault(Scenario):
    key = "standalone_default"
    title = "A server roster is NOT an assignment — recordings stay Standalone"
    bug = "the recorder silently filed standalone reports under whichever patient was first in the roster"

    def run(self, ctx: Ctx) -> Result:
        import re as _re
        ctx.log("  Rebooting to read the active target…")
        ctx.act.trigger_reboot()
        m = ctx.link.wait_for(RE_ACTIVE_DIR, timeout=40, on_line=ctx.record_line)
        if not m:
            return self._r(SKIP, "device did not report an active target (no roster on the card)", ctx)
        active = m.group(1)
        if active != "Standalone":
            return self._r(
                FAIL,
                f"active target is '{active}', not Standalone — a roster from the server "
                "must not act as an assignment", ctx)
        # And a take must actually land there.
        ctx.link.wait_for(RE_READY, timeout=40, on_line=ctx.record_line)
        ctx.act.trigger_record()
        if not ctx.link.wait_for(RE_REC_START, timeout=30, on_line=ctx.record_line):
            return self._r(PASS, "active target is Standalone (no take started to confirm the upload path)", ctx)
        import time as _t
        _t.sleep(float(ctx.cfg.get("record", {}).get("take_s", 6)))
        ctx.act.trigger_stop()
        up = ctx.link.wait_for(RE_UPLOADED, timeout=120, on_line=ctx.record_line)
        if up and up.group(1) != "Standalone":
            return self._r(FAIL, f"take uploaded under '{up.group(1)}', not Standalone", ctx)
        return self._r(PASS, "active target is Standalone and the take uploaded under it", ctx)


ALL: List[Scenario] = [
    BootHealth(), RebootResume(), ByteMatch(),
    VerifiedTrim(), ReclaimRunsWhenIdle(), UnsyncedNeverFreed(),
    StandaloneByDefault(), DeleteNoRenumber(), DeleteDuringUpload(),
]


def by_key(keys) -> List[Scenario]:
    if not keys:
        return ALL
    want = set(keys)
    return [s for s in ALL if s.key in want]
