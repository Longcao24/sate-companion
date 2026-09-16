// The reader — one self-contained HTML document served by the Worker.
//
// No CDN, no build step, no framework. Same trade the developer portal makes
// (sate-devapi/src/ui.ts): the page is small, it must work with no network beyond this
// Worker, and a Worker serves a string with zero cold-start cost.
//
// ── Visual language ────────────────────────────────────────────────────────────
// Colours are NOT chosen here. Every one is a token from ../../design-system/tokens.json,
// the audited SATE palette, so this lane reads as the same product as the clinical app:
//   surface  white cards on #fafafa, 1px #e5e7eb borders, shadow-sm
//   primary  blue-600 (#2563eb) — the button, the active row, the playhead
//   type     the app's -apple-system / Segoe UI stack, gray-900 headings, gray-600 muted
// Do not hand-pick a colour in this file. Change tokens.json and mirror it here.

export function readerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SATE Notes</title>
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
  input,button{font:inherit}
  input{border:1px solid var(--line-strong);border-radius:var(--r-md);padding:6px 10px;
    background:var(--surface);color:var(--text);min-width:0}
  input:focus{outline:2px solid var(--primary-soft);border-color:var(--primary)}
  button{border:1px solid var(--primary);background:var(--primary);color:#fff;
    border-radius:var(--r-md);padding:6px 14px;cursor:pointer}
  button:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
  button.ghost{background:var(--surface);color:var(--text-2);border-color:var(--line-strong)}
  button.ghost:hover{background:var(--sunken)}

  main{display:grid;grid-template-columns:320px 1fr;gap:20px;padding:20px;
    max-width:1180px;margin:0 auto;align-items:start}
  @media (max-width:860px){main{grid-template-columns:1fr}}

  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
    box-shadow:var(--shadow-sm)}
  .card h2{margin:0;padding:12px 16px;border-bottom:1px solid var(--line);
    font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .pad{padding:16px}

  .note{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);
    padding:12px 16px;cursor:pointer;color:inherit;border-radius:0}
  .note:hover{background:var(--sunken)}
  .note.on{background:var(--primary-soft);box-shadow:inset 3px 0 0 var(--primary)}
  .note .t{font-weight:550;margin-bottom:2px}
  .note .m{font-size:12px;color:var(--subtle);display:flex;gap:8px;flex-wrap:wrap}

  .pill{display:inline-block;padding:1px 8px;border-radius:var(--r-full);font-size:11px;
    font-weight:600;border:1px solid transparent}
  .pill.done{background:var(--ok-soft);color:var(--ok-text);border-color:#bbf7d0}
  .pill.work{background:var(--warn-soft);color:var(--warn-text);border-color:#fde68a}
  .pill.err {background:var(--bad-soft);color:var(--bad-text);border-color:#fecaca}

  .player{display:flex;align-items:center;gap:12px;margin-bottom:6px}
  .bar{position:relative;flex:1;height:8px;background:var(--muted-bg);border-radius:var(--r-full);cursor:pointer}
  .fill{position:absolute;inset:0 auto 0 0;background:var(--primary);border-radius:var(--r-full);width:0}
  .tick{position:absolute;top:-4px;width:2px;height:16px;background:var(--warn);border-radius:1px}
  .time{font-variant-numeric:tabular-nums;color:var(--subtle);font-size:12px;min-width:88px;text-align:right}
  .play{width:38px;height:38px;border-radius:var(--r-full);display:grid;place-items:center;padding:0;flex:0 0 auto}

  h1{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}
  .sub{color:var(--subtle);font-size:12px;margin-bottom:16px}
  .tldr{background:var(--primary-soft);border:1px solid var(--primary-border);
    border-radius:var(--r-md);padding:12px 14px;color:var(--text-2);margin-bottom:16px}
  .sect{margin-bottom:18px}
  .sect h3{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;
    letter-spacing:.04em;margin:0 0 8px}
  ul{margin:0;padding-left:20px;color:var(--text-2)}
  li{margin-bottom:4px}
  .chip{display:inline-block;background:var(--sunken);border:1px solid var(--line);
    border-radius:var(--r-full);padding:3px 11px;margin:0 6px 6px 0;cursor:pointer;
    font-size:12px;color:var(--text-2)}
  .chip:hover{background:var(--primary-soft);border-color:var(--primary-border);color:var(--primary)}
  .chip b{font-variant-numeric:tabular-nums;color:var(--subtle);font-weight:600;margin-right:6px}

  .seg{padding:3px 6px;border-radius:var(--r-sm);cursor:pointer;color:var(--text-2)}
  .seg:hover{background:var(--sunken)}
  .seg.on{background:var(--primary-soft);color:var(--text)}
  .seg b{color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums;
    margin-right:8px;font-weight:500}
  .empty{color:var(--subtle);padding:28px 16px;text-align:center}
  .err{background:var(--bad-soft);border:1px solid #fecaca;color:var(--bad-text);
    border-radius:var(--r-md);padding:10px 12px;margin:0 0 12px}
</style>
</head>
<body>
<header>
  <div class="brand">SATE <span>Notes</span></div>
  <a class="tab on" href="/">Reader</a>
  <a class="tab" href="/console">Console</a>
  <div class="spacer"></div>
  <input id="uid" placeholder="user_id" size="14">
  <input id="key" placeholder="admin key" type="password" size="14">
  <button id="load">Load</button>
</header>

<main>
  <section class="card">
    <h2>Recordings</h2>
    <div id="list"><div class="empty">Enter a user id and key, then Load.</div></div>
  </section>
  <section class="card pad" id="detail">
    <div class="empty">Pick a recording.</div>
  </section>
</main>

<audio id="audio"></audio>
<script>
const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

const S = { uid: '', key: '', notes: [], open: null, segs: [], poll: 0, rows: new Map(), media: null };

// Remembered per browser so a demo does not mean retyping a key every reload. This is a
// convenience only — it is not a session, and the key still gates every request.
try {
  S.uid = localStorage.getItem('sate.notes.uid') || '';
  S.key = localStorage.getItem('sate.notes.key') || '';
} catch {}
$('#uid').value = S.uid; $('#key').value = S.key;

const api = async (path) => {
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + S.key } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
  return r.json();
};

$('#load').onclick = () => {
  S.uid = $('#uid').value.trim(); S.key = $('#key').value.trim();
  try { localStorage.setItem('sate.notes.uid', S.uid); localStorage.setItem('sate.notes.key', S.key); } catch {}
  loadList();
};

async function loadList() {
  const box = $('#list');
  if (!box.querySelector('.note')) S.rows.clear();   // first paint, or an error wiped the list
  try {
    S.notes = await api('/api/notes?user_id=' + encodeURIComponent(S.uid));
  } catch (e) {
    S.rows.clear(); box.replaceChildren(el('div', 'err', e.message)); return;
  }
  if (!S.notes.length) { box.replaceChildren(el('div', 'empty', 'No recordings yet. Press record.')); return; }

  // ⚠️ UPDATE IN PLACE, do not rebuild.
  //
  // This used to replaceChildren() on every refresh. While any recording is still processing
  // the list refreshes every 4 s, so the row you were reaching for was destroyed and rebuilt
  // under the cursor and roughly every other click did nothing at all — the worst kind of
  // bug to hit in a demo, because it looks like the click "just didn't take". Rows are keyed
  // by note id: only their text changes on a refresh, and the DOM node you clicked is the
  // same one that was there a moment ago.
  const seen = new Set();
  for (const n of S.notes) {
    seen.add(n.id);
    let row = S.rows.get(n.id);
    if (!row) {
      const b = el('button', 'note');
      const t = el('div', 't');
      const m = el('div', 'm');
      const pill = el('span', 'pill');
      const meta = el('span');
      m.append(pill, el('span', null, n.folder_id), meta);
      b.append(t, m);
      b.onclick = () => open(n.id);
      box.appendChild(b);
      row = { b, t, pill, meta };
      S.rows.set(n.id, row);
    }
    row.t.textContent = n.title || (n.status === 'done' ? 'Untitled' : 'Processing…');
    row.pill.className = 'pill ' + (n.status === 'done' ? 'done' : n.status === 'error' ? 'err' : 'work');
    row.pill.textContent = n.status;
    row.meta.textContent = mmss(n.duration_s) + '  ' + new Date(n.created_at).toLocaleString();
    row.b.classList.toggle('on', n.id === S.open);
  }
  // Drop rows for notes that are gone.
  for (const [id, row] of S.rows) {
    if (!seen.has(id)) { row.b.remove(); S.rows.delete(id); }
  }
  if (box.firstElementChild && box.firstElementChild.className === 'empty') box.firstElementChild.remove();

  // A recording still moving through the pipeline: check back until it settles. This is the
  // only reason the page polls at all.
  if (S.notes.some((n) => n.status !== 'done' && n.status !== 'error')) {
    clearTimeout(S.poll);
    S.poll = setTimeout(() => { loadList(); if (S.open) open(S.open, true); }, 4000);
  }
}

async function open(id, quiet) {
  S.open = id;
  for (const [rid, row] of S.rows) row.b.classList.toggle('on', rid === id);
  const d = $('#detail');
  let n;
  try { n = await api('/api/notes/' + id); }
  catch (e) { d.replaceChildren(el('div', 'err', e.message)); return; }

  const audio = $('#audio');
  // ⚠️ Compare the NOTE, not the URL.
  //
  // audio_url carries a freshly signed token on every fetch, so the string differs each time
  // even for the same recording. Comparing URLs therefore re-ran load() on every 4 s poll,
  // which aborted playback ("The play() request was interrupted by a new load request"),
  // reset the playhead to 0:00, and threw out of open() before the page was even rendered —
  // which looked like the note simply refusing to open.
  if (S.media !== n.id) { S.media = n.id; audio.src = n.audio_url; audio.load(); }

  d.replaceChildren();
  d.appendChild(el('h1', null, n.title || 'Untitled recording'));
  d.appendChild(el('div', 'sub',
    n.device_serial + ' · ' + n.folder_id + ' · session ' + n.session_number + ' · ' + mmss(n.duration_s)));

  if (n.status === 'error') d.appendChild(el('div', 'err', n.error || 'processing failed'));

  // ---- player -------------------------------------------------------------------------
  const wrap = el('div', 'player');
  const play = el('button', 'play', '▶');
  const bar = el('div', 'bar');
  const fill = el('div', 'fill');
  bar.appendChild(fill);
  // The flag button's ms offsets, drawn on the scrubber. This is the one thing the hardware
  // gives that a phone does not: a physical "mark this moment" while it happens.
  for (const ms of (n.flags || [])) {
    if (!n.duration_s) break;
    const t = el('div', 'tick');
    t.style.left = Math.min(100, (ms / 1000 / n.duration_s) * 100) + '%';
    t.title = 'flagged at ' + mmss(ms / 1000);
    bar.appendChild(t);
  }
  const time = el('div', 'time', '0:00 / ' + mmss(n.duration_s));
  wrap.append(play, bar, time);
  d.appendChild(wrap);

  const safePlay = () => { const p = audio.play(); if (p && p.catch) p.catch(() => {}); };
  play.onclick = () => { audio.paused ? safePlay() : audio.pause(); };
  audio.onplay = () => { play.textContent = '❚❚'; };
  audio.onpause = () => { play.textContent = '▶'; };
  bar.onclick = (e) => {
    const r = bar.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * (n.duration_s || 0);
  };

  // ---- summary ------------------------------------------------------------------------
  const sum = n.summary && n.summary.json;
  if (sum) {
    if (sum.tldr) d.appendChild(el('div', 'tldr', sum.tldr));
    section(d, 'Key points', sum.bullets, (x) => el('li', null, x), 'ul');
    section(d, 'Action items', sum.actions, (x) => el('li', null, x), 'ul');
    section(d, 'Highlights', sum.highlights, (x) => el('li', null, x), 'ul');
    if (sum.chapters && sum.chapters.length) {
      const s = el('div', 'sect'); s.appendChild(el('h3', null, 'Chapters'));
      for (const c of sum.chapters) {
        const chip = el('div', 'chip');
        chip.appendChild(el('b', null, mmss(c.at)));
        chip.appendChild(document.createTextNode(c.title));
        chip.onclick = () => { audio.currentTime = c.at; safePlay(); };
        s.appendChild(chip);
      }
      d.appendChild(s);
    }
  } else if (n.status !== 'error') {
    d.appendChild(el('div', 'empty', 'Transcribing and summarising…'));
  }

  // ---- transcript ---------------------------------------------------------------------
  S.segs = (n.transcript && n.transcript.segments) || [];
  if (S.segs.length) {
    const s = el('div', 'sect'); s.appendChild(el('h3', null, 'Transcript'));
    S.segs.forEach((g, i) => {
      const p = el('div', 'seg');
      p.dataset.i = String(i);
      p.appendChild(el('b', null, mmss(g.start)));
      p.appendChild(document.createTextNode(g.text));
      p.onclick = () => { audio.currentTime = g.start; safePlay(); };
      s.appendChild(p);
    });
    d.appendChild(s);
  }

  audio.ontimeupdate = () => {
    const t = audio.currentTime;
    fill.style.width = Math.min(100, (t / (n.duration_s || 1)) * 100) + '%';
    time.textContent = mmss(t) + ' / ' + mmss(n.duration_s);
    // Follow along: the segment under the playhead is the one whose window contains it.
    const cur = S.segs.findIndex((g) => t >= g.start && t < g.end);
    document.querySelectorAll('.seg').forEach((p) => {
      p.classList.toggle('on', Number(p.dataset.i) === cur);
    });
  };
}

function section(root, title, items, make, tag) {
  if (!items || !items.length) return;
  const s = el('div', 'sect');
  s.appendChild(el('h3', null, title));
  const box = el(tag);
  for (const x of items) box.appendChild(make(x));
  s.appendChild(box);
  root.appendChild(s);
}

// The console links to /#<noteId>; opening that link should land on the recording itself
// rather than on "Pick a recording".
async function boot() {
  if (!S.uid || !S.key) return;
  await loadList();
  const id = location.hash.slice(1);
  if (id) open(id);
}
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id) open(id);
});
boot();
</script>
</body>
</html>`;
}
