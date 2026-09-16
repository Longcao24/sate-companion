// Live pipeline map for the status site — the `sate pipeline` view, on the web.
//
// Why this exists: the animated map only existed in `hwtest/pipeline_view.py`,
// which is Tkinter and needs the CLI installed. This serves the same picture
// (and the same server truth) at /pipeline, so monitoring needs nothing but a
// browser. The Tk version could not be ported — it is redrawn here in SVG.
//
// AUTH: you sign in with your own SATE account, exactly like the web app. The
// browser holds the session; this Worker holds NO credentials and never sees
// your password — it serves static HTML and nothing else. Every read goes
// straight from your browser to Supabase / device-api with YOUR JWT, so RLS
// decides what you can see. Sign in as a clinician and you get that clinician's
// devices; there is no shared secret to leak and no admin key sitting in a
// Worker binding.
//
// (Earlier revision gated this with a URL key and logged the Worker in with a
// stored SATE_EMAIL/SATE_PASSWORD. That put the account password — the one that
// can publish fleet-wide OTA — in a Worker secret, and made the link itself the
// credential. Both are gone. If you re-add a server-side fetch here, do not
// reintroduce a stored account password.)
//
// All three upstreams send `access-control-allow-origin: *` (verified against
// auth, REST and device-api), which is what makes the browser-side design work.

const SUPA = 'https://zlgdpivcbmaodgokkdvz.supabase.co';
// The anon key is a PUBLIC client key — it already ships in the firmware, the
// mobile app and the web app. It grants nothing on its own; RLS + the user JWT do.
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0.x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ';

export function renderPipelinePage() {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>SATE — live pipeline</title>
<style>
  :root{--bg:#0f1417;--card:#161d22;--ink:#e7eeea;--dim:#8fa0a8;--hair:#243038;
        --ok:#3ba55d;--warn:#e0a23c;--bad:#e8695b;--accent:#4b9fea}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.6 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:26px 20px 60px}
  h1{font-size:21px;margin:0 0 2px}
  .sub{color:var(--dim);font-size:13px;margin-bottom:18px}
  .sub a{color:var(--accent);text-decoration:none}
  .card{background:var(--card);border:1px solid var(--hair);border-radius:12px;padding:16px;margin-bottom:16px}
  .maph{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
  .live{display:flex;align-items:center;gap:7px;color:var(--dim);font-size:12.5px}
  .beat{width:8px;height:8px;border-radius:50%;background:var(--ok);animation:b 2s infinite}
  @keyframes b{0%,100%{opacity:1}50%{opacity:.25}}
  .mapbox{overflow-x:auto}
  svg{display:block;width:100%;min-width:760px;height:auto}
  .nb{fill:#1b242a;stroke:#2c3941;stroke-width:1.4;rx:9}
  .nt{fill:#e7eeea;font:600 13px -apple-system,system-ui,sans-serif}
  .ns{fill:#8fa0a8;font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
  .el{fill:#7f8f98;font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace}
  .edge{stroke:#39474f;stroke-width:1.6;fill:none;stroke-dasharray:5 4}
  .edge.on{stroke:var(--accent);stroke-width:2.2;animation:dash 1s linear infinite}
  @keyframes dash{to{stroke-dashoffset:-18}}
  .grp{fill:none;stroke:#2f6f4a;stroke-width:1.5;rx:12}
  .gl{fill:#3ba55d;font:600 13px -apple-system,system-ui,sans-serif}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--dim);font-weight:600;font-size:11.5px;letter-spacing:.04em;
     text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--hair)}
  td{padding:7px 8px;border-bottom:1px solid #1c252b;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .note{color:var(--dim);font-size:12px;margin-top:8px}
  .err{color:var(--bad);font-size:12.5px;white-space:pre-wrap}
  .kv{display:flex;gap:22px;flex-wrap:wrap;color:var(--dim);font-size:13px}
  .kv b{color:var(--ink);font-weight:600}
  input{width:100%;padding:9px 11px;margin:4px 0 12px;background:#0f1417;color:var(--ink);
        border:1px solid var(--hair);border-radius:8px;font:14px ui-monospace,Menlo,monospace}
  button{padding:9px 16px;background:var(--accent);color:#fff;border:0;border-radius:8px;
         font:600 14px -apple-system,system-ui,sans-serif;cursor:pointer}
  button.ghost{background:transparent;color:var(--dim);border:1px solid var(--hair);font-weight:500;padding:5px 12px}
  label{font-size:12px;color:var(--dim)}
  #login{max-width:340px;margin:8vh auto}
  #dash{display:none}
  select{background:#0f1417;color:var(--ink);border:1px solid var(--hair);border-radius:8px;padding:5px 9px;font-size:13px}
</style></head><body><div class="wrap">

<div id="login">
  <h1>SATE — live pipeline</h1>
  <div class="sub">Sign in with your SATE account</div>
  <div class="card">
    <label>Email</label><input id="em" type="email" autocomplete="username">
    <label>Password</label><input id="pw" type="password" autocomplete="current-password">
    <button id="go">Sign in</button>
    <div class="err" id="lerr" style="margin-top:10px"></div>
    <div class="note">Your session stays in this browser tab. This site stores no credentials.</div>
  </div>
</div>

<div id="dash">
  <div class="maph">
    <div><h1>SATE — live pipeline</h1>
      <div class="sub">Server truth, polled every 3s · <a href="/">status page</a></div></div>
    <div style="display:flex;gap:10px;align-items:center">
      <select id="devsel"></select>
      <button class="ghost" id="out">Sign out</button>
    </div>
  </div>

  <div class="card">
    <div class="maph">
      <div class="kv" id="hdr"><span>loading…</span></div>
      <div class="live"><span class="beat" id="beat"></span><span id="stamp">—</span></div>
    </div>
    <div class="mapbox">
    <svg viewBox="0 0 1000 470" role="img" aria-label="SATE audio pipeline">
      <rect class="grp" x="378" y="26" width="258" height="352"/>
      <text class="gl" x="507" y="48" text-anchor="middle">Supabase</text>

      <path id="e_rec"  class="edge" d="M196,96 L392,96"/>
      <text class="el" x="212" y="88">Wi-Fi · chunked HTTPS</text>
      <path id="e_ble"  class="edge" d="M150,272 L236,286"/>
      <path id="e_pla"  class="edge" d="M150,344 L236,300"/>
      <path id="e_app"  class="edge" d="M292,278 L392,150"/>
      <path id="e_wav"  class="edge" d="M507,132 L507,168"/>
      <text class="el" x="516" y="154">WAV parts</text>
      <path id="e_row"  class="edge" d="M507,222 L507,258"/>
      <text class="el" x="516" y="244">row · queued</text>
      <path id="e_claim" class="edge" d="M624,268 L690,180"/>
      <text class="el" x="628" y="292">claim (SKIP LOCKED)</text>
      <path id="e_ai"   class="edge" d="M752,140 L866,140"/>
      <text class="el" x="762" y="130">audio (wait)</text>
      <path id="e_tr"   class="edge" d="M866,164 L752,164"/>
      <text class="el" x="762" y="182">transcript JSON</text>
      <path id="e_fin"  class="edge" d="M690,120 L624,100"/>
      <text class="el" x="628" y="86">finalize-session</text>
      <path id="e_web"  class="edge" d="M507,318 L507,392"/>
      <text class="el" x="516" y="360">reads</text>

      <rect class="nb" x="26" y="62" width="170" height="70"/>
      <circle id="d_recorder" cx="180" cy="76" r="5" fill="#3d4a52"/>
      <text class="nt" x="42" y="88">SATE Recorder</text>
      <text class="ns" x="42" y="106" id="t_recserial">—</text>
      <text class="ns" x="42" y="122" id="t_recstate">—</text>

      <rect class="nb" x="26" y="250" width="124" height="44"/>
      <text class="nt" x="38" y="270" style="fill:#8fa0a8">Pendant</text>
      <text class="ns" x="38" y="286">BLE · via app</text>
      <rect class="nb" x="26" y="322" width="124" height="44"/>
      <text class="nt" x="38" y="342" style="fill:#8fa0a8">Plaud</text>
      <text class="ns" x="38" y="358">BLE SDK · app</text>
      <circle class="nb" cx="264" cy="288" r="30"/>
      <text class="nt" x="264" y="285" text-anchor="middle" style="font-size:11px">Mobile</text>
      <text class="nt" x="264" y="298" text-anchor="middle" style="font-size:11px">app</text>

      <rect class="nb" x="398" y="70" width="218" height="62"/>
      <circle id="d_api" cx="600" cy="84" r="5" fill="#3d4a52"/>
      <text class="nt" x="414" y="96">device-api</text>
      <text class="ns" x="414" y="114">Edge Function · ingest</text>

      <rect class="nb" x="398" y="168" width="218" height="54"/>
      <circle id="d_storage" cx="600" cy="182" r="5" fill="#3d4a52"/>
      <text class="nt" x="414" y="192">Storage</text>
      <text class="ns" x="414" y="210">WAV objects</text>

      <rect class="nb" x="398" y="258" width="218" height="60"/>
      <circle id="d_db" cx="600" cy="272" r="5" fill="#3d4a52"/>
      <text class="nt" x="414" y="282">Postgres</text>
      <text class="ns" x="414" y="300">sate_device_sessions</text>

      <circle class="nb" cx="720" cy="152" r="34"/>
      <circle id="d_worker" cx="744" cy="128" r="5" fill="#3d4a52"/>
      <text class="nt" x="720" y="150" text-anchor="middle" style="font-size:10.5px">Cloudflare</text>
      <text class="ns" x="720" y="164" text-anchor="middle" style="font-size:9.5px">processor</text>

      <circle class="nb" cx="908" cy="152" r="40"/>
      <circle id="d_ai" cx="936" cy="126" r="5" fill="#3d4a52"/>
      <text class="nt" x="908" y="148" text-anchor="middle" style="font-size:11px">AI</text>
      <text class="ns" x="908" y="163" text-anchor="middle" style="font-size:9.5px">/process</text>

      <circle class="nb" cx="507" cy="422" r="32"/>
      <text class="nt" x="507" y="419" text-anchor="middle" style="font-size:10.5px">Web</text>
      <text class="nt" x="507" y="432" text-anchor="middle" style="font-size:10.5px">frontend</text>
    </svg>
    </div>
    <div class="note">Corner dot = tier health, probed live · green up · amber degraded · red down · grey no data.</div>
    <div class="note" id="notes"></div>
  </div>

  <div class="card">
    <div class="maph"><b style="font-size:14px">In flight</b></div>
    <div id="inflight" class="kv"><span>—</span></div>
  </div>

  <div class="card">
    <div class="maph"><b style="font-size:14px">Recent sessions</b></div>
    <table><thead><tr><th>#</th><th>Patient</th><th>Size</th><th>Status</th><th>Created</th><th>Detail</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" style="color:#8fa0a8">loading…</td></tr></tbody></table>
  </div>
</div>

<script>
var SUPA = ${JSON.stringify(SUPA)};
var ANON = ${JSON.stringify(ANON)};
var DEVAPI = SUPA + '/functions/v1/device-api';
var REST = SUPA + '/rest/v1/sate_device_sessions';
var SELECT = 'id,session_number,patient_id,bytes,status,created_at,processing_started_at,' +
             'processed_at,recording_id,process_error,attempts,device_serial,processed';
var COL = { ok:'#3ba55d', warn:'#e0a23c', down:'#e8695b', nodata:'#3d4a52' };
var SPILL = { done:['#3ba55d','done'], queued:['#e0a23c','queued'], processing:['#4b9fea','processing'],
              error:['#e8695b','error'], no_text:['#8fa0a8','no text'] };
var FLOW = { record:['e_rec'], upload:['e_rec','e_wav'], queue:['e_wav','e_row','e_claim'],
             process:['e_claim','e_ai','e_tr','e_fin'], idle:[] };
var el = function(id){ return document.getElementById(id); };
var mb = function(b){ return (b/1048576).toFixed(2) + ' MB'; };
var ago = function(t){ if(!t) return '—'; var s=(Date.now()-Date.parse(t))/1000;
  if(s<60) return Math.round(s)+'s ago'; if(s<3600) return Math.round(s/60)+'m ago';
  if(s<86400) return Math.round(s/3600)+'h ago'; return Math.round(s/86400)+'d ago'; };
var esc = function(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };

// ---- session (browser-held; sessionStorage dies with the tab) --------------
var S = {
  get at(){ return sessionStorage.getItem('sate_at') || ''; },
  get rt(){ return sessionStorage.getItem('sate_rt') || ''; },
  get exp(){ return +(sessionStorage.getItem('sate_exp') || 0); },
  save: function(j){
    sessionStorage.setItem('sate_at', j.access_token || '');
    sessionStorage.setItem('sate_rt', j.refresh_token || '');
    sessionStorage.setItem('sate_exp', String(j.expires_at || (Date.now()/1000 + (j.expires_in||3600))));
  },
  clear: function(){ ['sate_at','sate_rt','sate_exp'].forEach(function(k){ sessionStorage.removeItem(k); }); },
};

function authFetch(url, extra){
  var h = { apikey: ANON, Authorization: 'Bearer ' + S.at };
  if (extra) for (var k in extra) h[k] = extra[k];
  return fetch(url, { headers: h });
}

// Refresh a few minutes early so a dashboard left open overnight keeps working
// instead of silently going grey at the 1-hour mark.
async function ensureToken(){
  if (!S.at) return false;
  if (S.exp - 180 > Date.now()/1000) return true;
  if (!S.rt) return false;
  try {
    var r = await fetch(SUPA + '/auth/v1/token?grant_type=refresh_token', {
      method:'POST', headers:{ apikey: ANON, 'content-type':'application/json' },
      body: JSON.stringify({ refresh_token: S.rt }) });
    if (!r.ok) return false;
    S.save(await r.json());
    return true;
  } catch(e){ return false; }
}

async function login(){
  var em = el('em').value.trim(), pw = el('pw').value;
  if (!em || !pw){ el('lerr').textContent = 'enter your email and password'; return; }
  el('lerr').textContent = 'signing in…';
  try {
    var r = await fetch(SUPA + '/auth/v1/token?grant_type=password', {
      method:'POST', headers:{ apikey: ANON, 'content-type':'application/json' },
      body: JSON.stringify({ email: em, password: pw }) });
    var j = await r.json();
    if (!r.ok || !j.access_token){ el('lerr').textContent = j.error_description || j.msg || ('sign-in failed (' + r.status + ')'); return; }
    S.save(j); el('lerr').textContent = ''; start();
  } catch(e){ el('lerr').textContent = String(e && e.message || e); }
}

function showLogin(){ el('login').style.display=''; el('dash').style.display='none'; }
function start(){ el('login').style.display='none'; el('dash').style.display='block'; tick(); }

// A thrown fetch (offline / CORS / DNS) is NOT evidence a tier is down — it is
// evidence WE could not ask. Report that as 'nodata' (grey), never a false red.
async function probe(url, okCodes, headers){
  try { var r = await fetch(url, { headers: headers || {} });
        return okCodes.indexOf(r.status) >= 0 ? 'ok' : 'down'; }
  catch(e){ return 'nodata'; }
}

var picked = '';
async function tick(){
  if (!(await ensureToken())){ S.clear(); showLogin(); return; }
  var beat = el('beat');
  var devs, dbT, stT;
  try {
    var res = await Promise.all([
      authFetch(DEVAPI + '/api/devices').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
      probe(REST + '?select=id&limit=1', [200], { apikey: ANON, Authorization: 'Bearer ' + S.at }),
      probe(SUPA + '/storage/v1/object/public/firmware/_probe', [200,400,404], {}),
    ]);
    devs = res[0]; dbT = res[1]; stT = res[2];
  } catch(e){ beat.style.background = '#e8695b'; return setTimeout(tick, 3000); }

  if (devs === null){ // token rejected or API down
    if (!S.at){ showLogin(); return; }
    beat.style.background = '#e8695b';
  } else { beat.style.background = '#3ba55d'; }
  el('stamp').textContent = new Date().toLocaleTimeString();

  var list = Array.isArray(devs) ? devs : [];
  var sel = el('devsel');
  if (sel.options.length !== list.length){
    sel.innerHTML = list.map(function(d){ return '<option value="'+esc(d.serial)+'">'+esc(d.serial)+'</option>'; }).join('')
      || '<option>no devices</option>';
  }
  if (!picked && list.length) picked = list[0].serial;
  if (picked) sel.value = picked;
  var dev = null;
  for (var i=0;i<list.length;i++) if (list[i].serial === picked) dev = list[i];
  if (!dev) dev = list[0] || null;

  var tiers = { db: dbT, storage: stT, api: Array.isArray(devs) ? 'ok' : 'down',
                recorder: dev ? (dev.online ? 'ok' : 'down') : 'nodata' };

  var sessions = [], upload = null;
  if (dev){
    var rows = await authFetch(REST + '?select=' + SELECT + '&device_serial=eq.' +
      encodeURIComponent(dev.serial) + '&order=created_at.desc&limit=12')
      .then(function(r){ return r.ok ? r.json() : []; }).catch(function(){ return []; });
    if (Array.isArray(rows)) sessions = rows;
    upload = await authFetch(DEVAPI + '/api/sessions/upload-progress?device_serial=' +
      encodeURIComponent(dev.serial)).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  }

  // cf-processor + AI can only be inferred from the queue — see the note below.
  var now = Date.now();
  var stuck = sessions.filter(function(s){ return s.status === 'processing' && s.processing_started_at &&
    (now - Date.parse(s.processing_started_at)) > 45*60*1000; });
  var working = sessions.some(function(s){ return s.status === 'processing' || s.status === 'queued'; });
  tiers.worker = stuck.length ? 'down' : (working ? 'ok' : 'nodata');
  tiers.ai = stuck.length ? 'down' : (sessions.some(function(s){ return s.status === 'error'; }) ? 'warn' : (working ? 'ok' : 'nodata'));

  ['recorder','api','storage','db','worker','ai'].forEach(function(t){
    var c = el('d_' + t); if (c) c.setAttribute('fill', COL[tiers[t]] || COL.nodata); });

  el('t_recserial').textContent = dev ? dev.serial : 'no device claimed';
  el('t_recstate').textContent = dev ? ((dev.online?'online':'offline') + (dev.state ? (' · '+dev.state) : '')) : '—';
  el('t_recstate').setAttribute('fill', dev && dev.online ? '#3ba55d' : '#e8695b');
  el('hdr').innerHTML = dev
    ? '<span>device <b>'+esc(dev.serial)+'</b></span><span>fw <b>'+esc(dev.fw||'—')+'</b></span>'
      + '<span>battery <b>'+(dev.battery_pct==null?'—':dev.battery_pct+'%')+'</b></span>'
      + '<span>cell <b>'+(dev.battery_mv==null?'—':dev.battery_mv+' mV')+'</b></span>'
      + '<span>pending <b>'+(dev.pending_sessions==null?'—':dev.pending_sessions)+'</b></span>'
      + '<span>seen <b>'+ago(dev.last_seen)+'</b></span>'
    : '<span>no device claimed to this account</span>';

  var active = 'idle';
  if (dev && dev.state === 'recording') active = 'record';
  else if (upload && upload.uploading) active = 'upload';
  else if (sessions.some(function(s){ return s.status === 'queued'; })) active = 'queue';
  else if (sessions.some(function(s){ return s.status === 'processing'; })) active = 'process';
  var paths = document.querySelectorAll('.edge');
  for (var p=0;p<paths.length;p++) paths[p].classList.remove('on');
  (FLOW[active]||[]).forEach(function(id){ var e = el(id); if (e) e.classList.add('on'); });

  el('inflight').innerHTML = (upload && upload.uploading && upload.uploads && upload.uploads.length)
    ? upload.uploads.map(function(x){ return '<span>session <b>'+esc(x.session_number)+'</b></span>'
        + '<span>patient <b>'+esc(x.patient_id||'—')+'</b></span>'
        + '<span>parts <b>'+esc(x.parts)+'</b></span>'
        + '<span>uploaded <b>'+mb(x.bytes||0)+'</b></span>'; }).join('')
    : '<span>nothing uploading — the map stays neutral when idle</span>';

  el('rows').innerHTML = sessions.length ? sessions.map(function(s){
      var p = SPILL[s.status] || ['#8fa0a8', s.status || '—'];
      var detail = s.process_error ? '<span class="err">'+esc(s.process_error)+'</span>'
        : (s.recording_id ? 'recording ' + esc(String(s.recording_id).slice(0,8))
        : (s.attempts ? 'attempts ' + esc(s.attempts) : ''));
      return '<tr><td class="mono">'+esc(s.session_number)+'</td><td>'+esc(s.patient_id||'—')+'</td>'
        + '<td class="mono">'+mb(s.bytes||0)+'</td>'
        + '<td><span class="pill" style="color:'+p[0]+';background:'+p[0]+'22">'+esc(p[1])+'</span></td>'
        + '<td>'+ago(s.created_at)+'</td><td>'+detail+'</td></tr>';
    }).join('') : '<tr><td colspan="6" style="color:#8fa0a8">no sessions yet</td></tr>';

  var notes = ['cf-processor / AI dots are inferred from the queue — a Worker cannot probe its own Cloudflare account (error 1042).'];
  if (stuck.length) notes.unshift(stuck.length + ' session(s) stuck in processing past the 45-min watchdog');
  el('notes').textContent = notes.join(' · ');

  setTimeout(tick, 3000);
}

el('go').addEventListener('click', login);
el('pw').addEventListener('keydown', function(e){ if (e.key === 'Enter') login(); });
el('out').addEventListener('click', function(){ S.clear(); location.reload(); });
el('devsel').addEventListener('change', function(e){ picked = e.target.value; });
if (S.at) start(); else showLogin();
</script>
</div></body></html>`;
}
