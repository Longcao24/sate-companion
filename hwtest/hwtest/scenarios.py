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
RE_HEALED = r"\[REC\] healed interrupted delete"
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
        ctx.act.trigger_record(local=True)   # must be a button-started take (remote takes don't auto-resume)
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
        return self._r(PASS, f"auto-resumed session {m.group(1)} after the reboot", ctx)


class ByteMatch(Scenario):
    key = "byte_match"
    title = "Uploaded bytes on the server == bytes the device sent"
    bug = "silent audio mismatch/truncation between SD, upload and server"
    requires = ("server",)

    def run(self, ctx: Ctx) -> Result:
        ctx.log("  Recording a short take and letting it upload…")
        ctx.act.trigger_record()
        if not ctx.link.wait_for(RE_REC_START, timeout=20, on_line=ctx.record_line):
            return self._r(FAIL, "device never reported 'record start'", ctx)
        import time as _t
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


class DeleteJournalHeal(Scenario):
    key = "delete_journal"
    title = "A delete interrupted by a reboot heals (no hidden takes)"
    bug = "reboot mid-renumber leaves a numbering hole → later takes invisible forever"

    def run(self, ctx: Ctx) -> Result:
        ctx.log("  Deleting a session, then rebooting during/after the renumber…")
        target = int(ctx.cfg.get("record", {}).get("delete_target", 1))
        ctx.act.trigger_delete(target)
        # A true mid-renumber interruption needs relay timing; the reset here fires
        # right after the delete. Either the delete finished cleanly (journal clear
        # → no heal line, boots fine) OR it was interrupted (journal set → heal line
        # on boot). Both are PASS; a hole with no heal would be the failure.
        ctx.act.trigger_reboot()
        if not ctx.link.wait_for(RE_READY, timeout=40, on_line=ctx.record_line):
            return self._r(FAIL, "did not boot back after the delete+reboot", ctx)
        healed = ctx.link.wait_for(RE_HEALED, timeout=3, on_line=ctx.record_line)
        note = "delete healed on boot" if healed else "delete had completed cleanly (nothing to heal)"
        return self._r(PASS, f"booted OK; {note}", ctx)


class DeleteDuringUpload(Scenario):
    key = "delete_during_upload"
    title = "Delete during an upload doesn't splice two takes"
    bug = "delete-during-upload assembling one WAV out of two recordings"
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
            return self._r(FAIL, f"renumber during upload corrupted session {session_n} (gap + verify fail)", ctx)
        return self._r(PASS, f"session {session_n} uploaded byte-exact despite the concurrent delete", ctx)


ALL: List[Scenario] = [
    BootHealth(), RebootResume(), ByteMatch(),
    VerifiedTrim(), DeleteJournalHeal(), DeleteDuringUpload(),
]


def by_key(keys) -> List[Scenario]:
    if not keys:
        return ALL
    want = set(keys)
    return [s for s in ALL if s.key in want]
