// End-to-end protocol test: simulates the companion APP and the RECORDER
// talking to the mock server, covering the full v0.1 flow:
//   app login -> claim token -> device registers (as firmware would)
//   -> heartbeat/poll -> app sends remote commands -> device receives them
//   -> device uploads a session (Wi-Fi path) -> app bridge-uploads (BLE path)
//   -> rename -> remove.
// Run: node e2e-test.js   (expects server already on :4000, or starts one)

const BASE = process.env.SATE_URL || "http://127.0.0.1:4000";

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ok  - ${label}`);
  } else {
    failed++;
    console.log(`  FAIL - ${label}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

// A tiny valid WAV like the recorder produces (44-byte header + PCM).
function demoWavBase64() {
  const sr = 16000;
  const pcm = Buffer.alloc(sr); // 0.5 s of silence, 16-bit mono
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString("base64");
}

async function main() {
  console.log(`SATE e2e against ${BASE}\n`);

  // ---- 1. App: login (same SLP account as the web app) -------------------
  console.log("1. App sign-in");
  const login = await req("POST", "/api/auth/login", {
    body: { email: "slp@clinic.test", password: "x" },
  });
  assert(login.status === 200 && login.json.token, "login returns token");
  const appToken = login.json.token;

  // ---- 2. Unauthorized access is rejected --------------------------------
  console.log("2. Auth guard");
  const noAuth = await req("GET", "/api/devices");
  assert(noAuth.status === 401, "devices without token -> 401");

  // ---- 3. App: claim token for provisioning ------------------------------
  console.log("3. Claim token (app asks before BLE provisioning)");
  const claim = await req("POST", "/api/devices/claim-token", { token: appToken });
  assert(claim.status === 200 && claim.json.token?.startsWith("claim-"), "claim token issued");

  // ---- 4. Device: register (what firmware does after Wi-Fi provision) ----
  console.log("4. Device registers with claim token (unauthenticated route)");
  const serial = "SATE-E2E001";
  const reg = await req("POST", "/api/devices/register", {
    body: { serial, claim_token: claim.json.token, fw: "0.5.0" },
  });
  assert(reg.status === 200 && reg.json.device_id, "register -> device_id");
  assert(typeof reg.json.device_key === "string", "register -> device_key");
  const devId = reg.json.device_id;
  const devKey = reg.json.device_key;

  const reuse = await req("POST", "/api/devices/register", {
    body: { serial, claim_token: claim.json.token, fw: "0.5.0" },
  });
  assert(reuse.status === 403, "claim token is single-use");

  // ---- 5. App: device appears in the fleet -------------------------------
  console.log("5. App sees the new recorder");
  const list1 = await req("GET", "/api/devices", { token: appToken });
  const dev = list1.json.find((d) => d.id === devId);
  assert(!!dev, "device listed under the account");
  assert(dev?.online === true, "device shows online");

  // ---- 6. App queues commands; device polls them (firmware heartbeat) ----
  console.log("6. Remote control round-trip");
  for (const op of ["identify", "sync_now"]) {
    const q = await req("POST", `/api/devices/${devId}/commands`, {
      token: appToken,
      body: { op },
    });
    assert(q.status === 204, `app queues '${op}'`);
  }
  const poll = await req("GET", `/api/devices/${devId}/commands?pending=2`, { token: devKey });
  assert(poll.status === 200, "device polls with its device_key");
  assert(
    JSON.stringify(poll.json.commands) === JSON.stringify(["identify", "sync_now"]),
    "device receives queued commands in order"
  );
  const poll2 = await req("GET", `/api/devices/${devId}/commands?pending=2`, { token: devKey });
  assert(poll2.json.commands.length === 0, "commands are consumed once");

  const list2 = await req("GET", "/api/devices", { token: appToken });
  assert(
    list2.json.find((d) => d.id === devId)?.pending_sessions === 2,
    "heartbeat reports pending session count to the app"
  );

  // ---- 7. Device: patient list (reload_patients handler) -----------------
  console.log("7. Device pulls patients");
  const pats = await req("GET", "/api/patients", { token: devKey });
  assert(pats.status === 200 && Array.isArray(pats.json) && pats.json.length > 0,
         "patients list for the recorder");
  assert(!!pats.json[0].patient_id, "patient entries have patient_id");

  // ---- 8. Device: direct Wi-Fi session upload (firmware path) ------------
  console.log("8. Session upload - device over Wi-Fi");
  const up1 = await req("POST", "/api/sessions", {
    token: devKey,
    body: {
      device_serial: serial,
      patient_id: "PT-1001",
      session_number: 1,
      sample_rate: 16000,
      wav_base64: demoWavBase64(),
    },
  });
  assert(up1.status === 200 && up1.json.id, "device upload accepted");

  // ---- 9. App: BLE-bridge upload (app pulled the WAV over BLE) ------------
  console.log("9. Session upload - app BLE bridge");
  const up2 = await req("POST", "/api/sessions", {
    token: appToken,
    body: {
      device_serial: serial,
      patient_id: "PT-1002",
      session_number: 2,
      sample_rate: 16000,
      wav_base64: demoWavBase64(),
    },
  });
  assert(up2.status === 200 && up2.json.id, "bridge upload accepted");

  // ---- 10. App: rename + remove -------------------------------------------
  console.log("10. Rename / remove");
  const ren = await req("PATCH", `/api/devices/${devId}`, {
    token: appToken,
    body: { name: "Therapy Room 9" },
  });
  assert(ren.status === 204, "rename accepted");
  const list3 = await req("GET", "/api/devices", { token: appToken });
  assert(list3.json.find((d) => d.id === devId)?.name === "Therapy Room 9", "name updated");

  const del = await req("DELETE", `/api/devices/${devId}`, { token: appToken });
  assert(del.status === 204, "remove accepted");
  const list4 = await req("GET", "/api/devices", { token: appToken });
  assert(!list4.json.find((d) => d.id === devId), "device gone from fleet");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("e2e crashed:", e.message);
  process.exit(1);
});
