"""Run ONE component case in its own process and print a JSON verdict.

Isolation matters: cf-processor reads its config into module globals at import time,
and its loop() never returns. A subprocess per case means each case gets its own env
(AI_READ_TIMEOUT_S, MAX_ATTEMPTS) and a clean exit.

    python3 component_case.py be003_5xx_all
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "cf-processor"))

import fakes  # noqa: E402

SPEECH = fakes.transcript()

# name -> (plan factory, settle timeout, env overrides)
CASES = {
    # BE-002 — AI 500 once, then succeeds
    "be002_5xx_once": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"status": 500}, {"json": SPEECH}]), 60, {}),

    # BE-003 — AI 5xx on every allowed attempt
    "be003_5xx_all": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"status": 503}]), 90, {}),

    # BE-004 — AI returns a non-retryable 4xx
    "be004_4xx": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"status": 400}]), 45, {}),

    # BE-005 — AI request times out, then succeeds
    "be005_timeout_then_ok": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"sleep": 6}, {"json": SPEECH}]), 90, {"AI_READ_TIMEOUT_S": "2"}),

    # BE-006 — AI returns malformed JSON
    "be006_malformed_json": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"raw": "<html>502 Bad Gateway</html>"}]), 90, {}),

    # BE-007a — valid JSON, required `segments` key missing
    "be007_missing_segments": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"json": {"language": "en"}}]), 45, {}),

    # BE-007b — valid JSON, segments present but every field empty
    "be007_empty_segments": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"json": fakes.EMPTY_TRANSCRIPT}]), 45, {}),

    # BE-009 — a finalize whose RESPONSE is lost: the write landed, the worker
    # retries, and a duplicate/late finalize hits an already-done session.
    "be009_late_duplicate_finalize": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"json": SPEECH}],
        finalize_script=[{"status": 500, "apply": True}, {"status": 200}]), 90, {}),

    # BE-010 — the finalize edge is temporarily unavailable (503), then recovers
    "be010_edge_unavailable_then_ok": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"json": SPEECH}],
        finalize_script=[{"status": 503}, {"status": 200}]), 90, {}),

    # BE-011 — audio copy into the recordings bucket succeeds, the DB write fails
    "be011_db_update_fails": (lambda: fakes.Plan(
        fakes.make_wav(3, tone=True),
        [{"json": SPEECH}],
        finalize_script=[{"status": 500}]), 90, {}),

    # E2E-002 — a take below the minimum duration
    "e2e002_short_take": (lambda: fakes.Plan(
        fakes.make_wav(0.03, tone=True),
        [{"status": 500}]), 45, {}),

    # E2E-003 — a silent take: the AI answers, but with no words. Genuinely silent audio
    # (all zeros) must be accepted as no_text on the first attempt, never retried.
    "e2e003_silent": (lambda: fakes.Plan(
        fakes.make_wav(4),
        [{"json": fakes.EMPTY_TRANSCRIPT}]), 45, {}),

    # AUDIBLE audio that the AI returns with no words: a flaky response, not a silent
    # take. Must be retried; the retry transcribes normally.
    "flaky_no_text_retried": (lambda: fakes.Plan(
        fakes.make_wav(4, tone=True),
        [{"json": fakes.EMPTY_TRANSCRIPT}, {"json": SPEECH}]), 60, {}),

    # ...and if every attempt comes back empty, it settles as no_text rather than
    # looping forever.
    "flaky_no_text_exhausted": (lambda: fakes.Plan(
        fakes.make_wav(4, tone=True),
        [{"json": fakes.EMPTY_TRANSCRIPT}]), 90, {}),
}


def main():
    name = sys.argv[1]
    factory, settle_timeout, env = CASES[name]
    plan = factory()

    srv, base = fakes.start(plan)

    os.environ.update({
        "SUPABASE_URL": base,
        "SUPABASE_SERVICE_KEY": "svc-test",
        "AI_PROCESS_URL": base + "/ai/process",
        "FINALIZE_URL": base + "/finalize",
        "POLL_INTERVAL": "1",
        "MAX_ATTEMPTS": "3",
        "STUCK_MINUTES": "45",
        **env,
    })

    from app import processor  # imported AFTER env is set

    t = threading.Thread(target=processor.loop, daemon=True)
    t.start()

    deadline = time.time() + settle_timeout
    while time.time() < deadline and not plan.settled():
        time.sleep(0.2)
    # let any duplicate/late traffic land
    time.sleep(1.5)

    s = plan.session
    out = {
        "case": name,
        "settled": plan.settled(),
        "status": s["status"],
        "attempts": s["attempts"],
        "no_text": s["no_text"],
        "recording_id": s["recording_id"],
        "process_error": s["process_error"],
        "calls": plan.calls,
        "finalize_payloads": plan.finalize_payloads,
        "audio_still_in_storage": not plan.audio_deleted,
        "recordings_created": plan.recordings_created,
        "events": plan.events,
        "constants": {
            "MAX_ATTEMPTS": processor.MAX_ATTEMPTS,
            "MIN_AUDIO_SEC": processor.MIN_AUDIO_SEC,
            "AI_READ_TIMEOUT_S": processor.AI_READ_TIMEOUT_S,
        },
    }
    print("RESULT_JSON " + json.dumps(out), flush=True)
    sys.stdout.flush()
    srv.shutdown()
    os._exit(0)


if __name__ == "__main__":
    main()
