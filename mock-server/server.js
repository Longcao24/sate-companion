// SATE dev server implementing the companion-app + device API with real
// persistence: uploaded sessions are written to uploads/ as playable WAV
// files (+ .json metadata) and the device fleet survives restarts via
// data.json. Run: npm install && npm start   (listens on :4000)
// Point the app's Server URL (demo mode OFF) at http://<your-ip>:4000

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "20mb" }));

const DATA_FILE = path.join(__dirname, "data.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TOKEN = "dev-token";
// Accepted credentials: the app's account token, or a device key issued by
// /api/devices/register (which itself is unauthenticated - it is guarded by
// the one-time claim token in the body).
const auth = (req, res, next) => {
  const a = req.headers.authorization || "";
  if (req.path.startsWith("/api/auth") || req.path === "/api/devices/register") return next();
  if (a === `Bearer ${TOKEN}` || a.startsWith("Bearer key-dev-")) return next();
  res.status(401).json({ error: "unauthorized" });
};
app.use(auth);

let devices = [];
let claims = {};            // claim_token -> true
let commands = {};          // device_id -> [ops]
let sessions = [];
let patients = [
  { patient_id: "PT-1001", name: "Maya Nguyen", age: "7y 4m", session_type: "Articulation", clinician: "Dr. Taylor" },
  { patient_id: "PT-1002", name: "Ethan Brooks", age: "5y 9m", session_type: "Language Sample", clinician: "SLP Morgan" },
  { patient_id: "PT-1003", name: "Sophia Patel", age: "9y 1m", session_type: "Fluency", clinician: "SLP Rivera" },
];

// ---- persistence: fleet + sessions + patients survive restarts ------------
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  devices = saved.devices || [];
  sessions = saved.sessions || [];
  if (Array.isArray(saved.patients) && saved.patients.length) patients = saved.patients;
  devices.forEach((d) => (commands[d.id] ||= []));
  console.log(`loaded ${devices.length} device(s), ${sessions.length} session(s), ${patients.length} patient(s)`);
} catch {}

function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ devices, sessions, patients }, null, 2));
}

// The single dev account. A registering recorder is auto-assigned to this SLP.
const DEFAULT_SLP = { id: "u-1", name: "SLP Morgan" };

app.post("/api/auth/login", (req, res) => {
  res.json({ token: TOKEN, user: { ...DEFAULT_SLP, email: req.body.email } });
});

app.get("/api/devices", (_q, res) => res.json(devices));

app.post("/api/devices/claim-token", (_q, res) => {
  const t = "claim-" + Math.random().toString(36).slice(2, 10);
  // Remember which SLP minted the token so register() can bind the device.
  claims[t] = DEFAULT_SLP;
  res.json({ token: t });
});

// Called BY THE RECORDER over Wi-Fi after provisioning
app.post("/api/devices/register", (req, res) => {
  const { serial, claim_token, fw } = req.body;
  // A valid one-time claim token binds the recorder to the clinician's account.
  // In dev we also allow self-registration without one (e.g. the phone couldn't
  // reach the server to mint a token) so the board can still come online.
  let slp = DEFAULT_SLP;
  if (claim_token && claims[claim_token]) {
    slp = claims[claim_token];           // bound to the SLP who minted the token
    delete claims[claim_token];
  } else {
    console.log(`register: ${serial} self-registered without a valid claim token (dev) -> ${DEFAULT_SLP.name}`);
  }
  const id = "dev-" + serial.toLowerCase();
  devices = devices.filter((d) => d.id !== id);
  devices.push({
    id, name: serial, serial, fw, online: true,
    ip: req.ip, last_seen: new Date().toISOString(), pending_sessions: 0,
    state: "idle",                       // live activity (idle/recording/uploading)
    slp: slp.name, slp_id: slp.id,       // auto-assigned to the SLP
  });
  commands[id] = [];
  persist();
  res.json({ device_id: id, device_key: "key-" + id, slp: slp.name, slp_id: slp.id });
});

// Recorder heartbeat + command poll (device calls this every ~15 s)
app.get("/api/devices/:id/commands", (req, res) => {
  const d = devices.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).end();
  d.online = true;
  d.last_seen = new Date().toISOString();
  if (req.query.pending !== undefined) d.pending_sessions = Number(req.query.pending);
  if (req.query.state !== undefined) d.state = String(req.query.state); // live activity
  // active_patient is the patient the SLP typed in the app for the next remote
  // recording; the firmware reads it on a "record" op to tag the session.
  res.json({
    commands: (commands[d.id] || []).splice(0),
    active_patient: d.active_patient || null,
  });
});

app.post("/api/devices/:id/commands", (req, res) => {
  const { op, patient } = req.body;
  (commands[req.params.id] ||= []).push(op);
  // A "record" can carry the patient the SLP typed in the app: remember it as
  // the device's active patient and make sure it's in the roster so the next
  // captured session is tagged to them.
  if (patient && patient.patient_id) {
    const d = devices.find((x) => x.id === req.params.id);
    const full = {
      patient_id: String(patient.patient_id),
      name: patient.name || String(patient.patient_id),
      age: patient.age || "",
      session_type: patient.session_type || "",
      clinician: patient.clinician || (d && d.slp) || "",
    };
    if (d) d.active_patient = full;
    const i = patients.findIndex((p) => p.patient_id === full.patient_id);
    if (i >= 0) patients[i] = { ...patients[i], ...full };
    else patients.push(full);
    persist();
  }
  res.status(204).end();
});

app.patch("/api/devices/:id", (req, res) => {
  const d = devices.find((x) => x.id === req.params.id);
  if (d) d.name = req.body.name;
  persist();
  res.status(204).end();
});

app.delete("/api/devices/:id", (req, res) => {
  devices = devices.filter((x) => x.id !== req.params.id);
  persist();
  res.status(204).end();
});

// Optional ?slp=<name> filter so a recorder pulls only its SLP's roster
// (auto patient assignment). No param -> the whole clinic roster (back-compat).
app.get("/api/patients", (req, res) => {
  const slp = req.query.slp;
  if (!slp) return res.json(patients);
  res.json(patients.filter((p) => p.clinician === slp));
});

// Replace the clinic's patient list (curl or the SATE web app would call
// this). Recorders pick it up on their next reload_patients / reconnect.
app.put("/api/patients", (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: "expected an array" });
  patients = req.body;
  persist();
  res.status(204).end();
});

// Helper: persist one uploaded WAV + its metadata sidecar, return the id.
function storeSession(meta, wav) {
  const id = "s-" + (sessions.length + 1);
  const stem = `${meta.device_serial || "unknown"}_${meta.patient_id || "PT"}_session_${String(
    meta.session_number ?? 0
  ).padStart(4, "0")}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, `${stem}.wav`), wav);
  fs.writeFileSync(
    path.join(UPLOAD_DIR, `${stem}.json`),
    JSON.stringify({ id, ...meta, bytes: wav.length, at: new Date().toISOString() }, null, 2)
  );
  sessions.push({ id, ...meta, bytes: wav.length, file: `${stem}.wav`, at: new Date().toISOString() });
  persist();
  return { id, stem };
}

// Raw streaming upload: the recorder POSTs the WAV bytes straight from its SD
// card (Content-Type: audio/wav) with metadata in the query string. No base64,
// so the device never has to hold the whole file (+1.34x) in RAM - which blew
// past PSRAM on multi-minute recordings.
app.post("/api/sessions/raw", express.raw({ type: () => true, limit: "40mb" }), (req, res) => {
  const meta = {
    device_serial: req.query.device_serial || "unknown",
    patient_id: req.query.patient_id || "PT",
    session_number: Number(req.query.session_number || 0),
    sample_rate: Number(req.query.sample_rate || 16000),
  };
  const wav = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const { id, stem } = storeSession(meta, wav);
  console.log(`session uploaded (raw) -> uploads/${stem}.wav (${wav.length} bytes)`);
  res.json({ id });
});

// Session upload: the WAV is written to uploads/ as a real playable file
// with a .json metadata sidecar - same shape the recorder keeps on its SD.
app.post("/api/sessions", (req, res) => {
  const { wav_base64, ...meta } = req.body;
  const wav = Buffer.from(wav_base64 || "", "base64");
  const { id, stem } = storeSession(meta, wav);
  console.log(`session uploaded -> uploads/${stem}.wav (${wav.length} bytes)`);
  res.json({ id });
});

// Stream a session's WAV so the app can play it back. Auth still applies (the
// global auth middleware accepts the app token or a device key).
app.get("/api/sessions/:id/audio", (req, res) => {
  const s = sessions.find((x) => x.id === req.params.id);
  if (!s || !s.file) return res.status(404).json({ error: "not found" });
  const wavPath = path.join(UPLOAD_DIR, s.file);
  if (!fs.existsSync(wavPath)) return res.status(404).json({ error: "file gone" });
  res.setHeader("Content-Type", "audio/wav");
  res.sendFile(wavPath);
});

// List uploaded sessions, newest first. ?device=<serial> filters to one unit.
app.get("/api/sessions", (req, res) => {
  const serial = req.query.device;
  const list = serial ? sessions.filter((s) => s.device_serial === serial) : sessions;
  res.json([...list].reverse());
});

// mark devices offline if silent > 45 s
setInterval(() => {
  const cutoff = Date.now() - 45000;
  devices.forEach((d) => {
    if (Date.parse(d.last_seen) < cutoff) { d.online = false; d.state = "idle"; }
  });
}, 10000);

app.listen(4000, () => console.log("SATE mock server on :4000  (token: dev-token)"));
