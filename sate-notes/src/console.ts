// The operator console — devices, folders, notes. One self-contained HTML document.
//
// Same trade as the reader (src/ui.ts): no CDN, no build step, no framework, and every colour
// is a token from ../../design-system/tokens.json so the notes lane reads as the same product
// as the clinical app. Do not hand-pick a colour here.
//
// This is the SERVER-SIDE half of the lane: the reader answers "what did I record?", this
// answers "what is the fleet doing, and what should it do next?".

export function consoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SATE Notes · Console</title>
<style>
  :root {
    --bg:#fafafa; --surface:#ffffff; --sunken:#f9fafb; --muted-bg:#f3f4f6;
    --line:#e5e7eb; --line-strong:#d1d5db;
    --text:#111827; --text-2:#374151; --muted:#4b5563; --subtle:#6b7280; --faint:#9ca3af;
    --primary:#2563eb; --primary-hover:#1d4ed8; --primary-soft:#eff6ff; --primary-border:#bfdbfe;
    --ok:#16a34a; --ok-soft:#f0fdf4; --ok-text:#15803d;
    --warn:#d97706; --warn-soft:#fffbeb; --warn-text:#b45309;
    --bad:#dc2626; --bad-soft:#fef2f2; --bad-text:#b91c1c;
    --r-sm:4px; --r-md:6px; --r-lg:8px; --r-full:9999px;
    --shadow-sm:0 1px 2px 0 rgba(0,0,0,.05);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  header{background:var(--surface);border-bottom:1px solid var(--line);padding:12px 20px;
    display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:5}
  .brand{font-weight:650;letter-spacing:-.01em}
  .brand span{color:var(--subtle);font-weight:450}
  .tab{padding:5px 12px;border-radius:var(--r-full);color:var(--muted);text-decoration:none;font-weight:500}
  .tab.on{background:var(--primary-soft);color:var(--primary)}
  .tab:hover{background:var(--sunken)}
  .spacer{flex:1}
  input,select,button{font:inherit}
  input,select{border:1px solid var(--line-strong);border-radius:var(--r-md);padding:6px 10px;
    background:var(--surface);color:var(--text);min-width:0}
  input:focus,select:focus{outline:2px solid var(--primary-soft);border-color:var(--primary)}
  button{border:1px solid var(--primary);background:var(--primary);color:#fff;
    border-radius:var(--r-md);padding:6px 12px;cursor:pointer}
  button:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
  button.ghost{background:var(--surface);color:var(--text-2);border-color:var(--line-strong)}
  button.ghost:hover{background:var(--sunken)}
  button.danger{background:var(--surface);color:var(--bad-text);border-color:#fecaca}
  button.danger:hover{background:var(--bad-soft)}
  button:disabled{opacity:.5;cursor:not-allowed}

  main{max-width:1180px;margin:0 auto;padding:20px;display:grid;gap:20px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
    box-shadow:var(--shadow-sm);overflow:hidden}
  .card h2{margin:0;padding:12px 16px;border-bottom:1px solid var(--line);
    font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;
    display:flex;align-items:center;gap:10px}
  .card h2 .spacer{flex:1}
  .pad{padding:16px}

  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--subtle);
    font-weight:600;padding:8px 16px;background:var(--sunken);border-bottom:1px solid var(--line)}
  td{padding:10px 16px;border-bottom:1px solid var(--line);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  td.actions{text-align:right;white-space:nowrap}
  td.actions button{margin-left:6px}
  .mono{font-variant-numeric:tabular-nums;color:var(--muted)}

  .pill{display:inline-block;padding:1px 8px;border-radius:var(--r-full);font-size:11px;
    font-weight:600;border:1px solid transparent}
  .pill.done{background:var(--ok-soft);color:var(--ok-text);border-color:#bbf7d0}
  .pill.work{background:var(--warn-soft);color:var(--warn-text);border-color:#fde68a}
  .pill.err {background:var(--bad-soft);color:var(--bad-text);border-color:#fecaca}
  .pill.off {background:var(--muted-bg);color:var(--subtle);border-color:var(--line)}

  .row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
  .row input{flex:1}
  .empty{color:var(--subtle);padding:24px 16px;text-align:center}
  .note{background:var(--primary-soft);border:1px solid var(--primary-border);color:var(--text-2);
    border-radius:var(--r-md);padding:10px 12px;font-size:13px}
  .err{background:var(--bad-soft);border:1px solid #fecaca;color:var(--bad-text);
    border-radius:var(--r-md);padding:10px 12px;margin:0 0 12px}
  code{background:var(--sunken);border:1px solid var(--line);border-radius:var(--r-sm);
    padding:1px 5px;font-size:12px;color:var(--text-2)}
</style>
</head>
<body>
<header>
  <div class="brand">SATE <span>Notes</span></div>
  <a class="tab" href="/">Reader</a>
  <a class="tab on" href="/console">Console</a>
  <div class="spacer"></div>
  <input id="uid" placeholder="user_id" size="14">
  <input id="key" placeholder="admin key" type="password" size="14">
  <button id="load">Load</button>
</header>

<main>
  <div id="banner"></div>

  <section class="card">
    <h2>Devices<div class="spacer"></div><span id="models" class="mono" style="text-transform:none;font-weight:400"></span></h2>
    <div id="devices"><div class="empty">Enter a user id and key, then Load.</div></div>
  </section>

  <section class="card">
    <h2>Folders<div class="spacer"></div><button class="ghost" id="addFolder">Add</button><button id="saveFolders">Save &amp; push</button></h2>
    <div class="pad">
      <div id="folders"></div>
      <div class="note">These are the entries the recorder shows on its Home screen and stamps on every
        take. Saving pushes a <code>reload_patients</code> to every device on the account.</div>
    </div>
  </section>

  <section class="card">
    <h2>Recordings</h2>
    <div id="notes"><div class="empty">—</div></div>
  </section>
</main>

<script>
const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
};

const S = { uid: '', key: '', templates: ['meeting'], poll: 0 };
try { S.uid = localStorage.getItem('sate.notes.uid') || ''; S.key = localStorage.getItem('sate.notes.key') || ''; } catch {}
$('#uid').value = S.uid; $('#key').value = S.key;

const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + S.key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
  return r.status === 204 ? null : r.json();
};

const fail = (e) => { $('#banner').replaceChildren(el('div', 'err', e.message)); };
const clearFail = () => $('#banner').replaceChildren();

$('#load').onclick = () => {
  S.uid = $('#uid').value.trim(); S.key = $('#key').value.trim();
  try { localStorage.setItem('sate.notes.uid', S.uid); localStorage.setItem('sate.notes.key', S.key); } catch {}
  refresh();
};

async function refresh() {
  clearFail();
  try {
    const m = await api('/admin/models');
    S.templates = m.templates;
    $('#models').textContent = m.asr.replace('@cf/', '') + '  ·  ' + m.summary.replace('@cf/', '');
  } catch (e) { fail(e); return; }
  await Promise.all([loadDevices(), loadFolders(), loadNotes()]);
  // Devices go offline after 45 s of silence and notes move through the pipeline, so the
  // console is only useful if it keeps up on its own.
  clearTimeout(S.poll);
  S.poll = setTimeout(refresh, 8000);
}

async function loadDevices() {
  const box = $('#devices');
  let ds;
  try { ds = await api('/admin/devices'); } catch (e) { fail(e); return; }
  if (!ds.length) { box.replaceChildren(el('div', 'empty', 'No device has been claimed yet.')); return; }

  const t = el('table');
  const head = el('tr');
  for (const h of ['Device', 'State', 'Firmware', 'Battery', 'Last seen', '']) head.appendChild(el('th', null, h));
  t.appendChild(head);

  for (const d of ds) {
    const tr = el('tr');
    tr.appendChild(el('td', null, d.serial));
    const st = el('td');
    st.appendChild(el('span', 'pill ' + (d.online ? (d.state === 'recording' ? 'work' : 'done') : 'off'),
      d.online ? d.state : 'offline'));
    tr.appendChild(st);
    tr.appendChild(el('td', 'mono', d.fw || '—'));
    tr.appendChild(el('td', 'mono', d.battery_pct != null ? d.battery_pct + '%' : '—'));
    tr.appendChild(el('td', 'mono', ago(d.last_seen)));

    const act = el('td', 'actions');
    for (const [label, op, cls] of [
      ['Record', 'record', 'ghost'], ['Stop', 'stop', 'ghost'],
      ['Sync', 'sync_now', 'ghost'], ['Reboot', 'reboot', 'ghost'],
    ]) {
      const b = el('button', cls, label);
      b.disabled = !d.online;
      b.onclick = async () => {
        b.disabled = true;
        try { await api('/admin/devices/' + d.id + '/commands', { method: 'POST', body: JSON.stringify({ op }) }); }
        catch (e) { fail(e); }
        refresh();
      };
      act.appendChild(b);
    }
    tr.appendChild(act);
    t.appendChild(tr);
  }
  box.replaceChildren(t);
}

async function loadFolders() {
  if (!S.uid) return;
  let fs;
  try { fs = await api('/admin/folders?user_id=' + encodeURIComponent(S.uid)); } catch (e) { fail(e); return; }
  const box = $('#folders');
  if (box.dataset.dirty === '1') return;   // don't stomp on what the operator is typing
  box.replaceChildren(...fs.map(rowFor));
  if (!fs.length) box.appendChild(rowFor({ folder_id: 'notes', name: 'Voice Notes' }));
}

function rowFor(f) {
  const r = el('div', 'row');
  const id = el('input'); id.value = f.folder_id; id.placeholder = 'folder_id (A-Z a-z 0-9 _ -)'; id.dataset.k = 'id';
  const nm = el('input'); nm.value = f.name || ''; nm.placeholder = 'name shown on the device'; nm.dataset.k = 'name';
  const rm = el('button', 'danger', 'Remove');
  const dirty = () => { $('#folders').dataset.dirty = '1'; };
  id.oninput = dirty; nm.oninput = dirty;
  rm.onclick = () => { r.remove(); dirty(); };
  r.append(id, nm, rm);
  return r;
}

$('#addFolder').onclick = () => {
  $('#folders').appendChild(rowFor({ folder_id: '', name: '' }));
  $('#folders').dataset.dirty = '1';
};

$('#saveFolders').onclick = async () => {
  const folders = [...$('#folders').querySelectorAll('.row')].map((r) => ({
    folder_id: r.querySelector('[data-k=id]').value.trim(),
    name: r.querySelector('[data-k=name]').value.trim(),
  })).filter((f) => f.folder_id);
  try {
    await api('/admin/folders', { method: 'PUT', body: JSON.stringify({ user_id: S.uid, folders }) });
    // Push it to the fleet: without this the card lists the new roster and the device's Home
    // screen still shows the old one until its next reboot.
    const ds = await api('/admin/devices');
    for (const d of ds) {
      await api('/admin/devices/' + d.id + '/commands', { method: 'POST', body: JSON.stringify({ op: 'reload_patients' }) });
    }
    $('#folders').dataset.dirty = '0';
    clearFail();
    refresh();
  } catch (e) { fail(e); }
};

async function loadNotes() {
  if (!S.uid) return;
  const box = $('#notes');
  let ns;
  try { ns = await api('/api/notes?user_id=' + encodeURIComponent(S.uid)); } catch (e) { fail(e); return; }
  if (!ns.length) { box.replaceChildren(el('div', 'empty', 'No recordings yet.')); return; }

  const t = el('table');
  const head = el('tr');
  for (const h of ['Title', 'Folder', 'Length', 'Status', 'When', '']) head.appendChild(el('th', null, h));
  t.appendChild(head);

  for (const n of ns) {
    const tr = el('tr');
    const a = el('a', null, n.title || (n.status === 'done' ? 'Untitled' : 'Processing…'));
    a.href = '/#' + n.id; a.style.color = 'var(--primary)'; a.style.textDecoration = 'none';
    const td0 = el('td'); td0.appendChild(a); tr.appendChild(td0);
    tr.appendChild(el('td', null, n.folder_id));
    tr.appendChild(el('td', 'mono', mmss(n.duration_s)));
    const st = el('td');
    st.appendChild(el('span', 'pill ' + (n.status === 'done' ? 'done' : n.status === 'error' ? 'err' : 'work'), n.status));
    if (n.error) st.appendChild(el('div', null, n.error));
    tr.appendChild(st);
    tr.appendChild(el('td', 'mono', ago(n.created_at)));

    const act = el('td', 'actions');
    const sel = el('select');
    for (const tpl of S.templates) sel.appendChild(el('option', null, tpl));
    sel.title = 'Summary template';
    const re = el('button', 'ghost', 'Re-summarise');
    re.title = 'Re-runs the summary from the stored transcript — never re-transcribes';
    re.onclick = async () => {
      re.disabled = true;
      try { await api('/admin/notes/' + n.id + '/summarize', { method: 'POST', body: JSON.stringify({ template: sel.value }) }); clearFail(); }
      catch (e) { fail(e); }
      refresh();
    };
    const rt = el('button', 'ghost', 'Retry');
    rt.title = 'Re-runs the FULL pipeline, including transcription';
    rt.onclick = async () => {
      rt.disabled = true;
      try { await api('/admin/notes/' + n.id + '/retry', { method: 'POST' }); clearFail(); }
      catch (e) { fail(e); }
      refresh();
    };
    const dl = el('button', 'danger', 'Delete');
    dl.onclick = async () => {
      // Deleting removes the only server-side copy of the audio; the recorder may already
      // have freed its own after the verify handshake.
      if (!window.confirm('Delete "' + (n.title || n.id) + '" and its audio? This cannot be undone.')) return;
      dl.disabled = true;
      try { await api('/admin/notes/' + n.id, { method: 'DELETE' }); clearFail(); }
      catch (e) { fail(e); }
      refresh();
    };
    act.append(sel, re, rt, dl);
    tr.appendChild(act);
    t.appendChild(tr);
  }
  box.replaceChildren(t);
}

if (S.uid && S.key) refresh();
</script>
</body>
</html>`;
}
