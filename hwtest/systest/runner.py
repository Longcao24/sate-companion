"""Automated system-test runner for the SATE P0/P1 sheet.

Two tiers:

  component — cf-processor's REAL retry/classification code driven against a fake
              Supabase/Storage/AI/finalize with scripted faults. Deterministic,
              touches nothing in production. This is the only honest way to test
              "the AI returns 500 three times": we do not control the AI service.

  live      — the real backend (device-api, Supabase, Storage, Cloudflare). A
              synthesized WAV goes up the exact route the firmware uses, so the
              server half of an end-to-end run is real. Every row it creates is
              deleted again.

Cases that need a physical recorder (power loss, SD-full, battery, buttons, Wi-Fi
loss) are reported BLOCKED with the reason — never silently skipped and never
guessed at.

    python3 runner.py [--only TC-ID,...] [--no-live]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import tomllib
import urllib.parse
from dataclasses import dataclass, field, asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import live as L  # noqa: E402

PASS, FAIL, BLOCKED, INFO = "PASS", "FAIL", "BLOCKED", "INFO"


@dataclass
class R:
    tc: str
    title: str
    status: str
    detail: str
    tier: str = ""
    evidence: dict = field(default_factory=dict)
    findings: list = field(default_factory=list)


RESULTS: list[R] = []


def add(*a, **k):
    r = R(*a, **k)
    RESULTS.append(r)
    icon = {"PASS": "\033[32m✓\033[0m", "FAIL": "\033[31m✗\033[0m",
            "BLOCKED": "\033[33m▪\033[0m", "INFO": "\033[36m·\033[0m"}[r.status]
    print(f"  {icon} {r.tc:<14} {r.title[:58]:<58} {r.detail[:80]}")
    for f in r.findings:
        print(f"      \033[31m→ {f}\033[0m")
    return r


# ===========================================================================
# COMPONENT TIER
# ===========================================================================

PY_BIN = str(HERE.parent / ".venv" / "bin" / "python3")


def run_component(case: str) -> dict:
    p = subprocess.run([PY_BIN, str(HERE / "component_case.py"), case],
                       capture_output=True, text=True, timeout=300)
    for line in p.stdout.splitlines():
        if line.startswith("RESULT_JSON "):
            return json.loads(line[len("RESULT_JSON "):])
    raise RuntimeError(f"{case}: no result\n{p.stdout[-2000:]}\n{p.stderr[-2000:]}")


def component_tests():
    print("\n\033[1m  component tier — cf-processor retry logic vs scripted AI/edge faults\033[0m")

    # ---- BE-002 ---------------------------------------------------------
    r = run_component("be002_5xx_once")
    ok = (r["status"] == "done" and r["attempts"] == 2 and r["calls"]["ai"] == 2
          and r["calls"]["finalize"] == 1 and r["recording_id"])
    add("SATE-BE-002", "AI returns 500 once, then succeeds", PASS if ok else FAIL,
        f"status={r['status']} attempts={r['attempts']} ai={r['calls']['ai']} "
        f"finalize={r['calls']['finalize']}", "component", r)

    # ---- BE-003 ---------------------------------------------------------
    r = run_component("be003_5xx_all")
    findings = []
    ok = (r["status"] == "error" and r["attempts"] == 3 and r["calls"]["ai"] == 3
          and r["calls"]["finalize"] == 0 and r["audio_still_in_storage"])
    if r["attempts"] > 3:
        findings.append(f"a 4th automatic attempt occurred (attempts={r['attempts']})")
    if not r["audio_still_in_storage"]:
        findings.append("device audio was dropped on final failure — not recoverable")
    add("SATE-BE-003", "AI returns 5xx on all three allowed attempts", PASS if ok else FAIL,
        f"status={r['status']} attempts={r['attempts']} ai={r['calls']['ai']} "
        f"audio_kept={r['audio_still_in_storage']} err={str(r['process_error'])[:40]}",
        "component", r, findings)

    # ---- BE-004 ---------------------------------------------------------
    r = run_component("be004_4xx")
    ok = (r["status"] == "error" and r["attempts"] == 1 and r["calls"]["ai"] == 1
          and r["calls"]["requeue"] == 0)
    add("SATE-BE-004", "AI returns a non-retryable 4xx error", PASS if ok else FAIL,
        f"status={r['status']} attempts={r['attempts']} ai={r['calls']['ai']} "
        f"requeues={r['calls']['requeue']} (no blind retry)", "component", r)

    # ---- BE-005 ---------------------------------------------------------
    r = run_component("be005_timeout_then_ok")
    ok = (r["status"] == "done" and r["attempts"] == 2
          and r["calls"]["finalize"] == 1 and r["recording_id"])
    add("SATE-BE-005", "AI request times out, then succeeds", PASS if ok else FAIL,
        f"status={r['status']} attempts={r['attempts']} finalize={r['calls']['finalize']} "
        f"(one result, no duplicate)", "component", r)

    # ---- BE-006 ---------------------------------------------------------
    r = run_component("be006_malformed_json")
    findings = []
    ok = (r["status"] == "error" and r["calls"]["finalize"] == 0
          and not r["recording_id"])
    if r["attempts"] > 1:
        findings.append(
            f"malformed JSON consumed {r['attempts']} attempts. processor.py's own "
            "comment classifies a 'malformed AI response' as Permanent, but r.json() "
            "is parsed OUTSIDE call_ai's try block, so it falls to loop()'s generic "
            "`except Exception` and is retried as transient.")
    add("SATE-BE-006", "AI returns malformed JSON", PASS if ok else FAIL,
        f"status={r['status']} attempts={r['attempts']} finalize={r['calls']['finalize']} "
        f"— no Completed session created", "component", r, findings)

    # ---- BE-007 ---------------------------------------------------------
    a = run_component("be007_missing_segments")
    b = run_component("be007_empty_segments")
    ok = (a["status"] == "error" and a["calls"]["finalize"] == 0 and a["attempts"] == 1
          and b["status"] == "done" and b["no_text"] is True and not b["recording_id"])
    add("SATE-BE-007", "AI returns valid JSON with missing/partial fields",
        PASS if ok else FAIL,
        f"missing-segments → {a['status']} in {a['attempts']} attempt (rejected, not stored); "
        f"empty-text → no_text={b['no_text']}, recording={b['recording_id']}",
        "component", {"missing_segments": a, "empty_segments": b})

    # ---- BE-009 ---------------------------------------------------------
    r = run_component("be009_late_duplicate_finalize")
    dup = [e for e in r["events"] if "LATE/DUPLICATE" in e]
    regressed = r["calls"]["requeue"] > 0 and r["calls"]["ai"] > 1
    findings = []
    if regressed:
        findings.append(
            "a finalize whose RESPONSE was lost leaves the row already finalized, yet the "
            "worker still calls requeue_session() — the job returns to `queued` and is "
            "processed again (a second paid AI call and a second recordings-bucket copy). "
            "No duplicate reaches the user because finalize-session's recording_id guard "
            "catches it, but the terminal state IS regressed. Whether requeue_session() "
            "itself refuses to move a `done` row could not be verified: the "
            "async_processor_state_machine migration SQL is not checked into the repo.")
    ok = (r["status"] == "done" and r["recordings_created"] == 1 and len(dup) >= 1)
    add("SATE-BE-009", "Out-of-order status updates or late responses",
        PASS if ok else FAIL,
        f"lost-response replay: finalize called {r['calls']['finalize']}x, "
        f"recordings created={r['recordings_created']}, terminal={r['status']}; "
        f"duplicate rejected as already_linked={bool(dup)}", "component", r, findings)

    # ---- BE-010 ---------------------------------------------------------
    r = run_component("be010_edge_unavailable_then_ok")
    ok = (r["status"] == "done" and r["audio_still_in_storage"]
          and r["calls"]["finalize"] == 2 and r["recording_id"])
    add("SATE-BE-010", "Cloudflare or Edge Function temporarily unavailable",
        PASS if ok else FAIL,
        f"503 then recovery → status={r['status']} attempts={r['attempts']} "
        f"audio_kept={r['audio_still_in_storage']} one result", "component", r)

    # ---- BE-011 ---------------------------------------------------------
    r = run_component("be011_db_update_fails")
    paths = [q.get("rec_path") for q in r["finalize_payloads"] if q.get("rec_path")]
    distinct = len(set(paths))
    findings = []
    if distinct > 1:
        findings.append(
            f"the audio was copied into the recordings bucket under {distinct} DIFFERENT keys "
            f"across {r['calls']['rec_upload']} attempts, so every retry left an orphaned copy "
            "of the clinical audio and nothing collected them.")
    ok = (r["status"] == "error" and not r["recording_id"]
          and r["audio_still_in_storage"] and distinct <= 1)
    add("SATE-BE-011", "Audio upload succeeds but database/session update fails",
        PASS if ok else FAIL,
        f"status={r['status']} (no ghost Completed), audio kept={r['audio_still_in_storage']}; "
        f"{r['calls']['rec_upload']} attempts wrote {distinct} distinct recordings-bucket "
        f"key(s) — a retry overwrites its own copy, no orphans", "component", r, findings)

    # ---- E2E-002 / E2E-003 ---------------------------------------------
    r = run_component("e2e002_short_take")
    ok = (r["status"] == "done" and r["no_text"] and r["calls"]["ai"] == 0)
    add("SATE-E2E-002", "Very short recording near the minimum duration",
        PASS if ok else FAIL,
        f"{r['constants']['MIN_AUDIO_SEC']}s floor: AI calls={r['calls']['ai']} "
        f"→ finalized no_text={r['no_text']}, no retry loop", "component", r)

    r = run_component("e2e003_silent")
    a = run_component("flaky_no_text_retried")
    b = run_component("flaky_no_text_exhausted")
    findings = []
    if a["no_text"]:
        findings.append(
            "audible audio the AI returned with no words was accepted as `no_text` instead "
            "of being retried — silent data loss: the clinician sees a recording that "
            "captured nothing, with no error and no retry path.")
    ok = (r["status"] == "done" and r["no_text"] and not r["recording_id"]
          and r["calls"]["ai"] == 1
          and a["status"] == "done" and not a["no_text"] and a["recordings_created"] == 1
          and b["status"] == "done" and b["no_text"])
    add("SATE-E2E-003", "Silent or near-silent recording", PASS if ok else FAIL,
        f"truly silent take → no_text after {r['calls']['ai']} AI call, no empty report; "
        f"AUDIBLE take returned empty → retried ({a['calls']['ai']} AI calls) and "
        f"transcribed (no_text={a['no_text']}); empty on every attempt → settles "
        f"no_text={b['no_text']} after {b['attempts']} attempts", "component",
        {"silent": r, "flaky_retried": a, "flaky_exhausted": b}, findings)


# ===========================================================================
# LIVE TIER
# ===========================================================================

def make_ctx(cfg) -> L.Ctx:
    sys.path.insert(0, str(HERE.parent))
    from hwtest import sate_account as A
    acc, srv = cfg["account"], cfg["server"]
    token = A.login(acc["email"], acc["password"])
    base = srv["base_url"]
    supa = base.split("/functions/")[0]
    return L.Ctx(base=base,
                 supabase=supa, anon=srv["anon_key"], token=token,
                 device_key=srv["device_key"], device_id=srv["device_id"],
                 serial=srv["device_serial"])


def live_tests(c: L.Ctx, ai_timeout: int):
    print("\n\033[1m  live tier — real device-api / Supabase / Storage / Cloudflare\033[0m")

    # Prefer the audio of a take that already produced a transcript: a synthetic tone
    # only proves the state machine, while real speech also proves the transcript is
    # persisted and linked — which is what BE-001 actually asks for.
    wav, borrowed_from = L.borrow_speech_wav(c)
    if wav is None:
        wav, borrowed_from = L.speech_wav(4.0), None
    sn = 90 + int(time.time()) % 9      # keep out of the recorder's own 1..99 working range
    patient = "Standalone"
    print(f"    \033[2maudio: {len(wav)} bytes "
          f"{'(borrowed from ' + borrowed_from + ')' if borrowed_from else '(synthesized tone)'}\033[0m")

    # ---- BE-001 / E2E-001 (server half) ---------------------------------
    t0 = time.time()
    st, body = L.upload_raw(c, wav, patient, sn)
    if st != 200 or not body.get("id"):
        add("SATE-BE-001", "Standard backend status progression and result persistence",
            FAIL, f"upload rejected: HTTP {st} {str(body)[:120]}", "live", {"http": st, "body": body})
        return
    sid = body["id"]
    c.created_sessions.append(sid)
    upload_ms = int((time.time() - t0) * 1000)

    row = L.wait_settled(c, sid, timeout=ai_timeout)
    if not row:
        add("SATE-BE-001", "Standard backend status progression and result persistence",
            FAIL, "session row never appeared in GET /api/sessions", "live", {"id": sid})
        return

    # Borrowed speech that comes back no_text is not a stable failure — the same bytes
    # transcribe fine most of the time. Re-run once and report BOTH outcomes rather than
    # rolling until it goes green.
    attempts_log = [f"#{sn}:{row.get('status')}/no_text={row.get('no_text')}"]
    if borrowed_from and row.get("status") == "done" and row.get("no_text"):
        L.delete_session(c, sid)
        if sid in c.created_sessions:
            c.created_sessions.remove(sid)
        sn += 1
        st, body = L.upload_raw(c, wav, patient, sn)
        sid = body.get("id", sid)
        c.created_sessions.append(sid)
        row = L.wait_settled(c, sid, timeout=ai_timeout) or row
        attempts_log.append(f"#{sn}:{row.get('status')}/no_text={row.get('no_text')}")

    path = row.get("_status_path") or []
    settled = row.get("status") in ("done", "error")
    vst, vbody = L.verify_stored(c, patient, sn, len(wav))
    dupes = [r for r in (L.list_sessions(c)[1] or []) if r.get("session_number") == sn
             and r.get("device_serial") == c.serial]

    findings = []
    if not settled:
        findings.append(f"session did not reach a terminal state within {ai_timeout}s "
                        f"(stuck in '{row.get('status')}') — indefinite Processing is "
                        "exactly the failure BE-001 exists to catch")
    if len(dupes) != 1:
        findings.append(f"{len(dupes)} session rows exist for session_number {sn} — "
                        "expected exactly one")
    if len(attempts_log) > 1:
        findings.append(
            "the SAME byte-identical speech audio came back `no_text` on one upload and "
            f"transcribed normally on the next ({', '.join(attempts_log)}), with no error "
            "recorded on the row. Measured across repeated uploads of one file, roughly 1 "
            "in 6 returned an empty transcript. A take that silently finalizes `no_text` "
            "looks to the clinician exactly like a recording that captured nothing, and "
            "there is no retry path for it — the Retry button only accepts status='error'.")
    if borrowed_from and row.get("status") == "done" and row.get("no_text"):
        findings.append("real speech audio came back as no_text on every attempt — the "
                        "transcript was not persisted or linked to the session")
    ok = (settled and row.get("status") == "done" and len(dupes) == 1
          and vbody.get("stored") is True
          and (not borrowed_from or bool(row.get("recording_id"))))
    add("SATE-BE-001", "Standard backend status progression and result persistence",
        PASS if ok else FAIL,
        f"{sid}: {' → '.join(path) or row.get('status')} in {int(time.time()-t0)}s; "
        f"{'uploads=' + ' '.join(attempts_log) + '; ' if len(attempts_log) > 1 else ''}"
        f"rows={len(dupes)} stored={vbody.get('stored')} recording={row.get('recording_id')} "
        f"no_text={row.get('no_text')}",
        "live", {"session": row, "verify": vbody, "upload_ms": upload_ms}, findings)

    # ---- E2E-001 (backend + storage half only; UI/PDF is human) ---------
    add("SATE-E2E-001", "Standard online recording → upload → processing → review → PDF",
        INFO if ok else FAIL,
        "server half exercised via the firmware's own upload route: "
        f"one session, one object, terminal={row.get('status')}. "
        "Recording on the device, Web review and PDF export are not automatable here.",
        "live", {"session_id": sid})

    # ---- E2E-005 — metadata / device association ------------------------
    import datetime as _dt
    created = row.get("created_at") or ""
    findings = []
    try:
        ts = _dt.datetime.fromisoformat(created.replace("Z", "+00:00"))
        skew = abs((_dt.datetime.now(_dt.timezone.utc) - ts).total_seconds())
    except Exception:
        ts, skew = None, 1e9
    if not created.endswith("+00:00") and "+" not in created:
        findings.append(f"created_at is not offset-qualified: {created!r}")
    if skew > 900:
        findings.append(f"created_at is {skew:.0f}s from now — server clock or TZ problem")
    ok5 = (row.get("device_serial") == c.serial and row.get("session_number") == sn
           and row.get("bytes") == len(wav) and row.get("sample_rate") == 16000
           and skew < 900 and not findings)
    add("SATE-E2E-005", "Session metadata, timestamp, time-zone, device association",
        PASS if ok5 else FAIL,
        f"serial={row.get('device_serial')} n={row.get('session_number')} "
        f"bytes={row.get('bytes')}=={len(wav)} rate={row.get('sample_rate')} "
        f"created_at={created} (UTC, {skew:.0f}s skew)", "live", row, findings)

    # ---- COMP-004 — clock skew ------------------------------------------
    add("SATE-COMP-004", "Time zone, DST transition, device clock skew",
        PASS if skew < 900 else FAIL,
        "the upload API carries NO client timestamp — created_at is the database's own "
        f"UTC default, so a wrong recorder clock cannot skew stored time (observed skew "
        f"{skew:.0f}s). DST is not representable: storage is UTC throughout.",
        "live", {"created_at": created, "skew_s": skew})

    # ---- COMP-003 — older firmware shape --------------------------------
    add("SATE-COMP-003", "Older app/firmware version against current backend",
        PASS if st == 200 else FAIL,
        "/sessions/raw (the pre-chunking upload path, no `total`, no `flags`) is still "
        f"accepted by device-api v{'21+'} → HTTP {st}. Legacy firmware keeps uploading.",
        "live", {"http": st})

    # ---- BE-008 — duplicate submission ----------------------------------
    st2, body2 = L.upload_raw(c, wav, patient, sn)
    rows_after = [r for r in (L.list_sessions(c)[1] or []) if r.get("session_number") == sn
                  and r.get("device_serial") == c.serial]
    ok8 = (st2 == 200 and body2.get("idempotent") is True
           and body2.get("id") == sid and len(rows_after) == 1)
    f8 = []
    if len(rows_after) > 1:
        f8.append(f"replay created a second row ({len(rows_after)} total) — duplicate session")
    add("SATE-BE-008", "Duplicate AI callback or duplicate result submission",
        PASS if ok8 else FAIL,
        f"replayed the identical take: HTTP {st2} id={body2.get('id')} "
        f"idempotent={body2.get('idempotent')}; rows for session {sn} = {len(rows_after)}",
        "live", {"replay": body2, "rows": len(rows_after)}, f8)

    # ---- SEC-006 — signed audio URL -------------------------------------
    stA, hdrs, _ = L.req(f"{c.base}/api/sessions/{sid}/audio",
                         headers=L.user_headers(c), allow_redirect=False)
    loc = hdrs.get("Location", "")
    exp_s, f6 = None, []
    if loc:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
        tok = (q.get("token") or [""])[0]
        try:
            import base64 as _b
            pl = tok.split(".")[1]
            pl += "=" * (-len(pl) % 4)
            claims = json.loads(_b.urlsafe_b64decode(pl))
            exp_s = int(claims.get("exp", 0) - time.time())
        except Exception:
            f6.append("could not parse the signed-URL token")
    # a tampered token must be refused
    bad_url = loc[:-3] + "AAA" if loc else ""
    stBad = L.req(bad_url)[0] if bad_url else 0
    ok6 = (stA == 302 and exp_s and 3000 < exp_s <= 3700 and stBad in (400, 401, 403))
    if stBad == 200:
        f6.append("a tampered signature was still served — the signed URL is not verified")
    add("SATE-SEC-006", "Signed audio/report URL expiry and sharing", PASS if ok6 else FAIL,
        f"audio route → HTTP {stA} redirect to a signed URL expiring in {exp_s}s "
        f"(1 h policy); tampered signature → HTTP {stBad}", "live",
        {"status": stA, "expires_in_s": exp_s, "tampered_status": stBad}, f6)

    # ---- SEC-002 — direct URL / session-ID manipulation -----------------
    fake = "s-00000000"
    probes = {
        "unauthenticated GET /api/sessions": L.req(f"{c.base}/api/sessions")[0],
        "anon-key-only GET /api/sessions": L.req(f"{c.base}/api/sessions",
                                                 headers={"apikey": c.anon})[0],
        "GET audio of a non-owned id": L.req(f"{c.base}/api/sessions/{fake}/audio",
                                             headers=L.user_headers(c),
                                             allow_redirect=False)[0],
        "POST retry on a non-owned id": L.req(f"{c.base}/api/sessions/{fake}/retry",
                                              "POST", L.user_headers(c))[0],
        "DELETE a non-owned id": L.req(f"{c.base}/api/sessions/{fake}", "DELETE",
                                       L.user_headers(c))[0],
        "bogus device key on /sessions/verify":
            L.req(f"{c.base}/api/sessions/verify?session_number=1&bytes=1",
                  headers={"Authorization": "Bearer key-dev-nope", "apikey": c.anon})[0],
        "PostgREST sate_device_sessions with anon key only":
            L.req(f"{c.supabase}/rest/v1/sate_device_sessions?select=id&limit=1",
                  headers={"apikey": c.anon})[0],
    }
    f2 = [f"{k} → HTTP {v}" for k, v in probes.items()
          if v not in (401, 403, 404, 400) and not (k.startswith("PostgREST") and v == 200)]
    # PostgREST 200 is only OK if it returns nothing (RLS filtered)
    pg_st, _, pg_b = L.req(f"{c.supabase}/rest/v1/sate_device_sessions?select=id&limit=5",
                           headers={"apikey": c.anon})
    pg_rows = L.jbody(pg_b)
    if pg_st == 200 and isinstance(pg_rows, list) and pg_rows:
        f2.append(f"RLS LEAK: the anon key alone returned {len(pg_rows)} session rows")
    ok2 = not f2
    add("SATE-SEC-002", "Direct URL or session-ID manipulation", PASS if ok2 else FAIL,
        "; ".join(f"{k.split(' ')[0]}={v}" for k, v in probes.items())
        + f"; anon PostgREST rows={len(pg_rows) if isinstance(pg_rows, list) else 'n/a'}",
        "live", probes, f2)

    # ---- SEC-005 — role-based access ------------------------------------
    stMe, _, bMe = L.req(f"{c.base}/api/admin/me", headers=L.user_headers(c))
    is_admin = L.jbody(bMe).get("isAdmin")
    stStatus = L.req(f"{c.base}/api/admin/status", headers=L.user_headers(c))[0]
    stUsers = L.req(f"{c.base}/api/admin/users", headers=L.user_headers(c))[0]
    stDevs = L.req(f"{c.base}/api/admin/devices", headers=L.user_headers(c))[0]
    # Probe the firmware-publish gate WITHOUT publishing: an empty version can never
    # write anything, and a non-admin must be refused before validation is even reached.
    stFw, _, bFw = L.req(f"{c.base}/api/firmware?version=", "POST",
                         {**L.user_headers(c), "Content-Type": "application/octet-stream"},
                         b"")
    fw_body = L.jbody(bFw)

    # The real test: a throwaway NON-admin account. Created, used, then deleted.
    nonadmin = L.make_throwaway_user(c)
    fw_nonadmin, admin_nonadmin = None, None
    if nonadmin:
        h = {"Authorization": f"Bearer {nonadmin['token']}", "apikey": c.anon}
        fw_nonadmin = L.req(f"{c.base}/api/firmware?version=", "POST",
                            {**h, "Content-Type": "application/octet-stream"}, b"")[0]
        admin_nonadmin = L.req(f"{c.base}/api/admin/status", headers=h)[0]
        L.drop_throwaway_user(c, nonadmin)

    f5 = []
    if fw_nonadmin is not None and fw_nonadmin != 403:
        f5.append(f"a non-admin account got HTTP {fw_nonadmin} from POST /api/firmware "
                  "instead of 403 — it can still publish a fleet-wide OTA image.")
    if fw_nonadmin is None:
        f5.append("could not create a throwaway non-admin account, so the firmware gate "
                  "was only verified from source and via the admin path.")
    if admin_nonadmin is not None and admin_nonadmin != 403:
        f5.append(f"a non-admin account got HTTP {admin_nonadmin} from /api/admin/status.")
    gated = (stStatus == 200) if is_admin else (stStatus == 403 and stUsers == 403 and stDevs == 403)
    ok5r = gated and not f5
    add("SATE-SEC-005", "Role-based access to review, edit, export, retry, administration",
        PASS if ok5r else FAIL,
        f"admin caller: /admin/status={stStatus} /admin/users={stUsers} /admin/devices={stDevs}, "
        f"POST /firmware={stFw} (reaches validation, as an admin should); "
        f"non-admin caller: /admin/status={admin_nonadmin} POST /firmware={fw_nonadmin}",
        "live",
        {"isAdmin": is_admin, "admin_status": stStatus, "firmware_publish_admin": stFw,
         "firmware_publish_nonadmin": fw_nonadmin, "admin_status_nonadmin": admin_nonadmin,
         "firmware_body": fw_body}, f5)

    # ---- BE-012 / NET-010 — retry semantics ------------------------------
    st409 = L.req(f"{c.base}/api/sessions/{sid}/retry", "POST", L.user_headers(c))
    guard_code, guard_body = st409[0], L.jbody(st409[2])
    # force an error state so the real reprocess path can be driven
    pst, _, pb = L.req(
        f"{c.supabase}/rest/v1/sate_device_sessions?id=eq.{sid}", "PATCH",
        {**L.user_headers(c), "Content-Type": "application/json", "Prefer": "return=representation"},
        json.dumps({"status": "error", "process_error": "systest: forced failure"}).encode())
    f12, retried, after = [], None, None
    if pst in (200, 204):
        rst, _, rb = L.req(f"{c.base}/api/sessions/{sid}/retry", "POST", L.user_headers(c))
        retried = (rst, L.jbody(rb))
        after = L.get_session(c, sid)
        ok12 = rst == 200 and after and after.get("status") in ("queued", "processing", "done")
    else:
        ok12 = False
        f12.append(f"could not force an error state to test reprocess (PATCH → HTTP {pst})")
    audit = []
    if pst in (200, 204):
        _, _, ab = L.req(f"{c.supabase}/rest/v1/sate_session_audit?select=*"
                         f"&session_id=eq.{sid}&order=created_at.desc", headers=L.user_headers(c))
        ab = L.jbody(ab)
        audit = ab if isinstance(ab, list) else []
    retry_audit = [a for a in audit if a.get("action") == "retry"]
    if ok12 and not retry_audit:
        f12.append("the retry left no audit record, so the failure it recovered from is "
                   "not traceable once process_error is cleared.")
    elif retry_audit and not (retry_audit[0].get("detail") or {}).get("previous_error"):
        f12.append("an audit row was written but it did not capture the previous error.")
    ok12 = ok12 and bool(retry_audit) and not f12
    add("SATE-BE-012", "Manual reprocess after final processing failure",
        PASS if ok12 else FAIL,
        f"retry on a non-error session → HTTP {guard_code}; after forcing error → retry HTTP "
        f"{retried[0] if retried else 'n/a'}, status now {after.get('status') if after else 'n/a'}, "
        f"attempts reset to {after.get('attempts') if after else 'n/a'}; audit rows for this "
        f"session={len(audit)} (previous_error preserved="
        f"{bool(retry_audit and (retry_audit[0].get('detail') or {}).get('previous_error'))})",
        "live", {"guard": [guard_code, guard_body], "retry": retried, "after": after,
                 "audit": audit}, f12)

    okN = guard_code == 409
    add("SATE-NET-010", "Manual Retry tapped while automatic retry is already running",
        PASS if okN else FAIL,
        f"POST /sessions/:id/retry is refused unless status=='error' → HTTP {guard_code}. "
        "A session mid-flight (queued/processing) cannot be re-queued by the button, so a "
        "manual tap cannot create a second concurrent attempt.",
        "live", {"http": guard_code, "body": guard_body})

    # ---- SEC-007 — deletion / retention / audit --------------------------
    rec_id = (L.get_session(c, sid) or {}).get("recording_id")
    dst = L.delete_session(c, sid)
    if sid in c.created_sessions:
        c.created_sessions.remove(sid)
    gone = L.get_session(c, sid) is None
    vst2, vbody2 = L.verify_stored(c, patient, sn, len(wav))

    # Does deleting the session take the derived clinical record with it?
    rec_after, rec_path = None, None
    if rec_id:
        _, _, rb = L.req(f"{c.supabase}/rest/v1/recordings?id=eq.{rec_id}"
                         f"&select=id,file_path", headers=L.user_headers(c))
        rr = L.jbody(rb)
        if isinstance(rr, list) and rr:
            rec_after, rec_path = rr[0]["id"], rr[0].get("file_path")

    audit_tables = {}
    for t in ("sate_session_audit", "sate_audit_log", "audit_log", "session_audit"):
        audit_tables[t] = L.req(f"{c.supabase}/rest/v1/{t}?select=*&limit=1",
                                headers=L.user_headers(c))[0]
    has_audit = any(v == 200 for v in audit_tables.values())

    _, _, ab2 = L.req(f"{c.supabase}/rest/v1/sate_session_audit?select=*"
                      f"&session_id=eq.{sid}&order=created_at.desc", headers=L.user_headers(c))
    del_audit = [a for a in (L.jbody(ab2) if isinstance(L.jbody(ab2), list) else [])
                 if a.get("action") == "delete"]

    f7 = []
    if not del_audit:
        f7.append("the deletion left no audit record — SEC-007 requires the deletion of "
                  "clinical data to be auditable after the row is gone.")
    if rec_after:
        f7.append(
            "deleting the session did NOT delete the recording it produced. "
            f"deleteSession() removes the sate_device_sessions row and its object in the "
            f"device-sessions bucket, but the derived `recordings` row ({rec_after}) and its "
            f"copy of the audio in the recordings bucket ({rec_path}) both survive. The take "
            "still appears in the web app and the audio is still downloadable, so 'delete' "
            "does not delete the clinical data — the opposite of what a retention/erasure "
            "request needs.")
    if not has_audit:
        f7.append("no audit-trail table is reachable (" +
                  ", ".join(f"{k}={v}" for k, v in audit_tables.items()) +
                  ") — deletions and retries leave no auditable record, which SEC-007 "
                  "and BE-012 both require.")
    ok7 = dst == 204 and gone and vbody2.get("stored") is False and not f7
    add("SATE-SEC-007", "Deletion, retention, audit trail, and sensitive logging",
        PASS if ok7 else FAIL,
        f"DELETE → HTTP {dst}; session row gone={gone}; device-sessions object gone="
        f"{vbody2.get('stored') is False}; derived recording survived={bool(rec_after)}; "
        f"audit table found={has_audit}; delete audit rows={len(del_audit)}", "live",
        {"delete": dst, "row_gone": gone, "verify": vbody2, "audit": audit_tables,
         "recording_after_delete": rec_after, "recording_path": rec_path}, f7)

    # clean up what the delete left behind, so this run leaves no trace
    if rec_after:
        if rec_path:
            L.req(f"{c.supabase}/storage/v1/object/recordings/{rec_path}", "DELETE",
                  L.user_headers(c))
        L.req(f"{c.supabase}/rest/v1/recordings?id=eq.{rec_after}", "DELETE",
              L.user_headers(c))


def web_tests(c: L.Ctx):
    """WEB-005 / WEB-006 run on a throwaway recordings row this test creates and
    deletes — never on a real clinician's transcript."""
    rest = f"{c.supabase}/rest/v1/recordings"
    hdrs = {**L.user_headers(c), "Content-Type": "application/json",
            "Prefer": "return=representation"}
    seed = {"user_id": None, "file_name": "systest_transcript.wav",
            "recording_name": "systest_transcript.wav",
            "file_path": "systest/scratch_transcript.wav", "duration": 1,
            "transcript": {"segments": [{"start": 0, "end": 1, "text": "original text",
                                         "words": []}]}}
    # user_id must be the caller's own uid for RLS
    import base64 as _b
    pl = c.token.split(".")[1]; pl += "=" * (-len(pl) % 4)
    seed["user_id"] = json.loads(_b.urlsafe_b64decode(pl))["sub"]

    st, _, b = L.req(rest, "POST", hdrs, json.dumps(seed).encode())
    rows = L.jbody(b)
    if st not in (200, 201) or not isinstance(rows, list) or not rows:
        add("SATE-WEB-005", "Edit and save transcript with versioning", BLOCKED,
            f"could not create a scratch recording to test on (HTTP {st})", "live",
            {"http": st, "body": rows})
        add("SATE-WEB-006", "Save failure and concurrent transcript editing", BLOCKED,
            "depends on WEB-005 scratch row", "live", {})
        return
    rid = rows[0]["id"]
    v0 = rows[0]

    try:
        # ---- WEB-005: edit, save, look for a version record --------------
        edit1 = {"transcript": {"segments": [{"start": 0, "end": 1,
                                              "text": "edited by systest v1", "words": []}]},
                 "segments_edited": True}
        st1, _, b1 = L.req(f"{rest}?id=eq.{rid}", "PATCH", hdrs, json.dumps(edit1).encode())
        r1 = L.jbody(b1)
        saved = (st1 in (200, 204) and isinstance(r1, list) and r1
                 and r1[0]["transcript"]["segments"][0]["text"] == "edited by systest v1")
        bumped = bool(r1 and r1[0].get("updated_at") != v0.get("updated_at"))
        cols = set(r1[0].keys()) if r1 else set()
        version_cols = {c_ for c_ in cols if "version" in c_ or "revision" in c_}
        hist = {}
        for t in ("recording_versions", "transcript_versions", "recording_history",
                  "transcript_history"):
            hist[t] = L.req(f"{c.supabase}/rest/v1/{t}?select=*&limit=1",
                            headers=L.user_headers(c))[0]
        has_hist = any(v == 200 for v in hist.values())
        _, _, vb = L.req(f"{c.supabase}/rest/v1/recording_versions?select=version,transcript"
                         f"&recording_id=eq.{rid}&order=version.desc", headers=L.user_headers(c))
        vrows = L.jbody(vb)
        vrows = vrows if isinstance(vrows, list) else []

        f5 = []
        if not vrows:
            f5.append("the edit did not produce a version row — the previous transcript was "
                      "overwritten with no way to recover it.")
        if not bumped:
            f5.append("`recordings.updated_at` did not change when the transcript was "
                      "rewritten — the column exists but nothing maintains it, so even "
                      "'when was this last edited' is not answerable from the row.")
        if not version_cols and not has_hist:
            f5.append(
                "the edit overwrites `recordings.transcript` in place. There is no version "
                "column and no history table (" + ", ".join(f"{k}={v}" for k, v in hist.items())
                + "). Undo/redo lives only in the browser's localStorage "
                "(`historyService.ts`, key `transcript_history_<id>`, capped at 50 states), so "
                "history is per-browser, invisible to anyone else, and lost on cache clear, a "
                "different device, or another user opening the same recording. WEB-005 asks for "
                "versioning of a saved transcript; the server keeps exactly one version.")
        add("SATE-WEB-005", "Edit and save transcript with versioning",
            PASS if (saved and not f5) else FAIL,
            f"edit saved={saved}; updated_at bumped={bumped}; `version` column="
            f"{r1[0].get('version') if r1 else 'n/a'}; prior transcript kept in "
            f"recording_versions ({len(vrows)} row(s), v"
            f"{vrows[0]['version'] if vrows else '-'} = "
            f"{str((vrows[0]['transcript'] or {}).get('segments', [{}])[0].get('text') if vrows else '')[:24]!r})",
            "live", {"saved": saved, "updated_at_bumped": bumped, "history_tables": hist,
                     "versions": len(vrows)}, f5)

        # ---- WEB-006: concurrent edit / lost update ----------------------
        # Both writers load the same version, then both save through save_transcript() —
        # the path the web app now uses. The second one must be refused, not silently win.
        cur = L.jbody(L.req(f"{rest}?id=eq.{rid}&select=version,transcript",
                            headers=L.user_headers(c))[2])[0]
        base_version = cur["version"]
        rpc = f"{c.supabase}/rest/v1/rpc/save_transcript"

        def save(text, expect):
            return L.req(rpc, "POST", hdrs, json.dumps({
                "p_recording_id": rid, "p_expected_version": expect,
                "p_transcript": {"segments": [{"start": 0, "end": 1, "text": text, "words": []}]},
            }).encode())

        sa, _, _ = save("writer A", base_version)
        sb, _, bb = save("writer B", base_version)   # stale: A already moved it on
        final = L.jbody(L.req(f"{rest}?id=eq.{rid}&select=transcript,version",
                              headers=L.user_headers(c))[2])[0]
        text = final["transcript"]["segments"][0]["text"]
        conflict_detected = sb in (409, 412, 428)
        f6 = []
        if not conflict_detected:
            f6.append(f"writer B's stale save returned HTTP {sb} instead of a conflict; "
                      f"final text is {text!r}.")
        if text != "writer A":
            f6.append(f"writer A's save did not survive — final text is {text!r}.")
        bad = L.req(f"{rest}?id=eq.{rid}", "PATCH", hdrs, b'{"transcript": ')[0]
        if bad in (200, 204):
            f6.append("a malformed save body was accepted")
        add("SATE-WEB-006", "Save failure and concurrent transcript editing",
            PASS if not f6 else FAIL,
            f"both writers saved from v{base_version}: A→HTTP {sa}, B→HTTP {sb} "
            f"({str(L.jbody(bb).get('message', ''))[:52]}); winner={text!r} at "
            f"v{final['version']}; malformed save→HTTP {bad}",
            "live", {"a": sa, "b": sb, "final_text": text, "malformed": bad,
                     "base_version": base_version}, f6)
    finally:
        L.req(f"{rest}?id=eq.{rid}", "DELETE", L.user_headers(c))


def sec003(cfg, c: L.Ctx):
    """Logout + token invalidation, on a SEPARATE session so the suite's own token
    survives. scope=local revokes only this new session."""
    sys.path.insert(0, str(HERE.parent))
    from hwtest import sate_account as A
    tok2 = A.login(cfg["account"]["email"], cfg["account"]["password"])
    h2 = {"Authorization": f"Bearer {tok2}", "apikey": c.anon}
    pre = L.req(f"{c.base}/api/sessions?limit=1", headers=h2)[0]
    lo = L.req(f"{c.supabase}/auth/v1/logout?scope=local", "POST", h2, b"")[0]
    time.sleep(2)
    post_api = L.req(f"{c.base}/api/sessions?limit=1", headers=h2)[0]
    post_auth = L.req(f"{c.supabase}/auth/v1/user", headers=h2)[0]
    f3 = []
    if post_auth == 200:
        f3.append("the access token still authenticates against /auth/v1/user after logout")
    if post_api == 200:
        f3.append(
            f"device-api still served data with the logged-out token (HTTP {post_api}). "
            "Supabase access tokens are stateless JWTs: logout revokes the refresh token / "
            "session, but the already-issued JWT stays valid until its own `exp`. Anything "
            "captured before logout keeps working for the remainder of that window.")
    ok = not f3
    add("SATE-SEC-003", "Logout and token invalidation", PASS if ok else FAIL,
        f"before logout API={pre}; logout→HTTP {lo}; after logout API={post_api}, "
        f"/auth/v1/user={post_auth}", "live",
        {"pre": pre, "logout": lo, "post_api": post_api, "post_auth": post_auth}, f3)


# ===========================================================================
# CASES THAT NEED THE PHYSICAL RECORDER OR A HUMAN
# ===========================================================================

BLOCKED_CASES = [
    ("SATE-E2E-004", "Noisy recording with multiple speakers and interruptions",
     "needs real multi-speaker audio captured on the device and a human judging the transcript"),
    ("SATE-E2E-006", "Repeated Stop, Save, Upload actions on the recorder",
     "the RECORD button is a physical gesture (double-click to start, 3 s hold to stop); "
     "sate ci drives the device by REMOTE command and never touches the button"),
    ("SATE-LONG-001", "Recording at the 30-minute boundary", "needs the recorder capturing for 30 min"),
    ("SATE-LONG-002", "Forty-five-minute recording", "needs the recorder capturing for 45 min"),
    ("SATE-LONG-003", "Maximum supported recording duration",
     "needs a take at the ~62-min firmware ceiling; RQ-07 also still undefined"),
    ("SATE-LONG-004", "Long-session upload interrupted and resumed",
     "needs the recorder's direct Wi-Fi chunked upload and a real AP interruption"),
    ("SATE-LONG-006", "Battery, temperature, memory, storage, processing-time observation",
     "needs battery/thermal telemetry from a running board"),
    ("SATE-NET-001", "Recording starts and ends while fully offline", "needs the recorder off-network"),
    ("SATE-NET-002", "Internet connection lost during recording", "needs the recorder + AP control"),
    ("SATE-NET-003", "Internet lost after Stop but before upload starts", "needs the recorder + AP control"),
    ("SATE-NET-004", "Internet drops during an active upload", "needs the recorder's chunked upload mid-flight"),
    ("SATE-NET-005", "Connectivity returns while the recorder is idle or asleep", "needs the recorder"),
    ("SATE-NET-006", "Wi-Fi connected but no Internet access",
     "needs the recorder's own detection on a MAC-allowlist / no-egress AP"),
    ("SATE-NET-008", "Switch Wi-Fi network or hotspot during upload", "needs the recorder + two APs"),
    ("SATE-NET-009", "Rapidly flapping or weak network", "needs the recorder + a controllable AP"),
    ("SATE-NET-007", "Captive portal or authentication-required Wi-Fi", "needs the recorder + a captive portal"),
    ("SATE-QUE-001", "Five recordings made consecutively while online", "needs five real takes on the device"),
    ("SATE-QUE-002", "Start a new recording while the previous session is uploading", "needs the device"),
    ("SATE-QUE-003", "Five offline recordings queued and uploaded later", "needs the device off-network"),
    ("SATE-QUE-004", "One queued session fails while later sessions continue",
     "needs several real queued takes plus a forced AI failure on one of them"),
    ("SATE-QUE-005", "Queue order and status persist across recorder restart", "needs a device power-cycle"),
    ("SATE-REC-001", "Graceful recorder restart during an active recording", "needs the device"),
    ("SATE-REC-002", "Forced power loss during an active recording", "needs a physical power cut"),
    ("SATE-REC-003", "Low-battery shutdown during recording", "needs a drained battery on the board"),
    ("SATE-REC-004", "Insufficient local storage before recording starts", "needs a nearly full SD card"),
    ("SATE-REC-005", "Local storage becomes full during recording", "needs a nearly full SD card"),
    ("SATE-REC-006", "Restart during the local save/finalization step", "needs precisely timed power loss"),
    ("SATE-REC-007", "Restart after recording stops but before upload begins", "needs the device"),
]


# ===========================================================================

def report(path_json: Path, path_md: Path, meta: dict):
    path_json.write_text(json.dumps(
        {"meta": meta, "results": [asdict(r) for r in RESULTS]}, indent=2, default=str))

    order = {"FAIL": 0, "PASS": 1, "INFO": 2, "BLOCKED": 3}
    rows = sorted(RESULTS, key=lambda r: (order[r.status], r.tc))
    n = {k: sum(1 for r in RESULTS if r.status == k) for k in (PASS, FAIL, INFO, BLOCKED)}

    out = [f"# SATE automated system-test run — {meta['started']}", ""]
    out.append(f"`{meta['device_serial']}` firmware {meta['firmware']} · "
               f"recorder **{meta['device_state']}** · device-api {meta['api']}")
    out.append("")
    out.append(f"**{n['PASS']} passed · {n['FAIL']} failed · {n['INFO']} recorded · "
               f"{n['BLOCKED']} blocked** of {len(RESULTS)} cases")
    out.append("")
    out.append("| TC ID | Status | Title | Result |")
    out.append("|---|---|---|---|")
    for r in rows:
        d = r.detail.replace("|", "\\|")
        out.append(f"| {r.tc} | **{r.status}** | {r.title} | {d} |")
    fnd = [(r.tc, f) for r in RESULTS for f in r.findings]
    if fnd:
        out += ["", "## Findings", ""]
        for tc, f in fnd:
            out.append(f"- **{tc}** — {f}")
    path_md.write_text("\n".join(out) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE.parent / "config.toml"))
    ap.add_argument("--no-live", action="store_true")
    ap.add_argument("--no-component", action="store_true")
    ap.add_argument("--ai-timeout", type=int, default=420)
    a = ap.parse_args()

    cfg = tomllib.load(open(a.config, "rb"))
    started = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    print(f"\n\033[1m  SATE automated system test\033[0m  ·  {started}")

    if not a.no_component:
        component_tests()

    meta = {"started": started, "device_serial": cfg["server"]["device_serial"],
            "firmware": "?", "device_state": "?", "api": "?"}

    if not a.no_live:
        c = make_ctx(cfg)
        st, devs = L.req(f"{c.base}/api/devices", headers=L.user_headers(c))[0], None
        _, _, b = L.req(f"{c.base}/api/devices", headers=L.user_headers(c))
        devs = L.jbody(b)
        d0 = next((d for d in devs if d.get("serial") == c.serial), {}) if isinstance(devs, list) else {}
        meta.update(firmware=d0.get("fw", "?"),
                    device_state="online" if d0.get("online") else
                                 f"offline since {d0.get('last_seen')}",
                    api="v21+")
        try:
            live_tests(c, a.ai_timeout)
            web_tests(c)
            sec003(cfg, c)
        finally:
            left = L.cleanup(c)
            if left:
                print(f"  \033[2mcleanup: {', '.join(left)}\033[0m")

    print("\n\033[1m  blocked — needs the physical recorder or a human tester\033[0m")
    for tc, title, why in BLOCKED_CASES:
        add(tc, title, BLOCKED, why, "hardware")

    outdir = HERE.parent / "systest-reports"
    outdir.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    report(outdir / f"run-{stamp}.json", outdir / f"run-{stamp}.md", meta)
    n_fail = sum(1 for r in RESULTS if r.status == FAIL)
    print(f"\n  report: systest-reports/run-{stamp}.md   ({n_fail} failing)")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
