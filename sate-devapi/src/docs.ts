// Public API reference, served at /docs on the portal host.
//
// Kept in the Worker rather than the docs site so it can never drift from the code that
// implements it: the same deploy ships both.

/**
 * Runnable clients in the languages developers actually integrate from.
 *
 * Every sample does the identical thing — submit, poll with backoff, read — so a developer
 * can diff the one they know against the one they need. Each is self-contained with no
 * client library, because the API is deliberately plain HTTP and shipping an SDK per
 * language would be a bigger maintenance surface than the service itself.
 *
 * Written with no backticks and no ${'$'}{…} sequences so they survive being embedded in a
 * template literal verbatim.
 */
function samples(apiHost: string): string {
  const SAMPLES: Array<{ id: string; label: string; code: string }> = [
    {
      id: 'curl', label: 'cURL',
      code: `# 1. Submit
JOB=$(curl -s -X POST https://${apiHost}/v1/jobs \\
  -H "Authorization: Bearer $SATE_KEY" \\
  -F audio=@sample.wav \\
  -F view=full | jq -r .id)

# 2. Poll until it settles
while true; do
  BODY=$(curl -s https://${apiHost}/v1/jobs/$JOB -H "Authorization: Bearer $SATE_KEY")
  STATUS=$(echo "$BODY" | jq -r .status)
  [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ] && break
  sleep 3
done

# 3. Read
echo "$BODY" | jq -r '.transcript.text'
echo "$BODY" | jq '.report | {mluw, ndw, speakingRate}'`,
    },
    {
      id: 'python', label: 'Python',
      code: `import time
import requests

KEY = "sate_live_..."
BASE = "https://${apiHost}"
H = {"Authorization": "Bearer " + KEY}


def analyze(path, view="full"):
    with open(path, "rb") as f:
        r = requests.post(BASE + "/v1/jobs", headers=H,
                          files={"audio": f}, data={"view": view})
    r.raise_for_status()
    job_id = r.json()["id"]

    delay = 2.0
    while True:
        time.sleep(delay)
        delay = min(delay * 1.25, 10)   # back off: polling spends your own rate limit
        body = requests.get(BASE + "/v1/jobs/" + job_id, headers=H).json()
        if body["status"] in ("done", "error"):
            break

    if body["status"] == "error":
        raise RuntimeError(body["error"]["message"])
    return body


result = analyze("sample.wav")

if result.get("no_speech_detected"):
    print("no speech in this recording")
else:
    print(result["transcript"]["text"])
    print("MLUw", result["report"]["mluw"], "NDW", result["report"]["ndw"])`,
    },
    {
      id: 'node', label: 'Node / TypeScript',
      code: `import { readFile } from "node:fs/promises";

const KEY = process.env.SATE_KEY!;
const BASE = "https://${apiHost}";
const H = { Authorization: "Bearer " + KEY };

interface JobResult {
  id: string;
  status: "queued" | "processing" | "done" | "error";
  no_speech_detected?: boolean;
  error?: { code: string; message: string };
  transcript?: { text: string; segments: unknown[] };
  report?: { mluw: number; mlum: number; ndw: number; ntw: number; speakingRate: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function analyze(path: string, view = "full"): Promise<JobResult> {
  const form = new FormData();
  form.append("audio", new Blob([await readFile(path)], { type: "audio/wav" }), "sample.wav");
  form.append("view", view);

  const submit = await fetch(BASE + "/v1/jobs", { method: "POST", headers: H, body: form });
  if (!submit.ok) throw new Error((await submit.json() as any).error.message);
  const { id } = await submit.json() as { id: string };

  let delay = 2000;
  for (;;) {
    await sleep(delay);
    delay = Math.min(delay * 1.25, 10000);  // back off: polling spends your own rate limit
    const body = await (await fetch(BASE + "/v1/jobs/" + id, { headers: H })).json() as JobResult;
    if (body.status === "error") throw new Error(body.error!.message);
    if (body.status === "done") return body;
  }
}

const result = await analyze("sample.wav");
if (result.no_speech_detected) {
  console.log("no speech in this recording");
} else {
  console.log(result.transcript!.text);
  console.log("MLUw", result.report!.mluw, "NDW", result.report!.ndw);
}`,
    },
    {
      id: 'browser', label: 'Browser JS',
      code: `// Never put a live key in front-end code — it is readable by anyone who opens
// devtools. Proxy through your own backend and let IT hold the key. This sample shows
// the client half talking to your proxy at /api/analyze.

async function analyze(file) {
  const form = new FormData();
  form.append("audio", file);
  form.append("view", "full");

  const submit = await fetch("/api/analyze", { method: "POST", body: form });
  if (!submit.ok) throw new Error("submit failed");
  const { id } = await submit.json();

  let delay = 2000;
  for (;;) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.25, 10000);
    const body = await (await fetch("/api/analyze/" + id)).json();
    if (body.status === "error") throw new Error(body.error.message);
    if (body.status === "done") return body;
  }
}

document.querySelector("#file").addEventListener("change", async (e) => {
  const result = await analyze(e.target.files[0]);
  document.querySelector("#out").textContent = result.transcript.text;
});`,
    },
    {
      id: 'go', label: 'Go',
      code: `package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"time"
)

const base = "https://${apiHost}"

type result struct {
	ID     string \`json:"id"\`
	Status string \`json:"status"\`
	NoSpeech bool \`json:"no_speech_detected"\`
	Error  *struct {
		Code    string \`json:"code"\`
		Message string \`json:"message"\`
	} \`json:"error"\`
	Transcript *struct {
		Text string \`json:"text"\`
	} \`json:"transcript"\`
	Report *struct {
		MLUw float64 \`json:"mluw"\`
		NDW  int     \`json:"ndw"\`
	} \`json:"report"\`
}

func analyze(key, path string) (*result, error) {
	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	part, _ := mw.CreateFormFile("audio", "sample.wav")
	if _, err := io.Copy(part, f); err != nil {
		return nil, err
	}
	mw.WriteField("view", "full")
	mw.Close()

	req, _ := http.NewRequest("POST", base+"/v1/jobs", body)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	var job result
	json.NewDecoder(res.Body).Decode(&job)
	res.Body.Close()

	delay := 2 * time.Second
	for {
		time.Sleep(delay)
		if delay < 10*time.Second { // back off: polling spends your own rate limit
			delay = delay * 5 / 4
		}
		poll, _ := http.NewRequest("GET", base+"/v1/jobs/"+job.ID, nil)
		poll.Header.Set("Authorization", "Bearer "+key)
		r, err := http.DefaultClient.Do(poll)
		if err != nil {
			return nil, err
		}
		var out result
		json.NewDecoder(r.Body).Decode(&out)
		r.Body.Close()
		switch out.Status {
		case "error":
			return nil, fmt.Errorf("%s", out.Error.Message)
		case "done":
			return &out, nil
		}
	}
}

func main() {
	out, err := analyze(os.Getenv("SATE_KEY"), "sample.wav")
	if err != nil {
		panic(err)
	}
	if out.NoSpeech {
		fmt.Println("no speech in this recording")
		return
	}
	fmt.Println(out.Transcript.Text)
	fmt.Println("MLUw", out.Report.MLUw, "NDW", out.Report.NDW)
}`,
    },
    {
      id: 'php', label: 'PHP',
      code: `<?php
$key  = getenv('SATE_KEY');
$base = 'https://${apiHost}';

function call($url, $key, $post = null) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . $key],
    ]);
    if ($post !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $post);
    }
    $body = curl_exec($ch);
    curl_close($ch);
    return json_decode($body, true);
}

$job = call("$base/v1/jobs", $key, [
    'audio' => new CURLFile('sample.wav', 'audio/wav', 'sample.wav'),
    'view'  => 'full',
]);

if (isset($job['error'])) {
    throw new RuntimeException($job['error']['message']);
}

$delay = 2.0;
do {
    usleep((int)($delay * 1000000));
    $delay = min($delay * 1.25, 10);   // back off: polling spends your own rate limit
    $result = call("$base/v1/jobs/" . $job['id'], $key);
} while (!in_array($result['status'], ['done', 'error'], true));

if ($result['status'] === 'error') {
    throw new RuntimeException($result['error']['message']);
}

if (!empty($result['no_speech_detected'])) {
    echo "no speech in this recording\\n";
} else {
    echo $result['transcript']['text'], "\\n";
    echo 'MLUw ', $result['report']['mluw'], ' NDW ', $result['report']['ndw'], "\\n";
}`,
    },
    {
      id: 'java', label: 'Java',
      code: `import java.io.IOException;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.util.List;

// Uses only java.net.http (JDK 11+). JSON is read with your parser of choice; this sample
// keeps it to simple string extraction so it compiles with no dependencies.
public class SateClient {
    static final String BASE = "https://${apiHost}";
    static final HttpClient HTTP = HttpClient.newHttpClient();

    static String field(String json, String key) {
        int i = json.indexOf("\\"" + key + "\\"");
        if (i < 0) return null;
        int c = json.indexOf(':', i), q = json.indexOf('"', c + 1);
        return q < 0 ? null : json.substring(q + 1, json.indexOf('"', q + 1));
    }

    static String submit(String key, Path audio) throws Exception {
        String boundary = "----sate" + System.nanoTime();
        var head = ("--" + boundary + "\\r\\n"
            + "Content-Disposition: form-data; name=\\"audio\\"; filename=\\"sample.wav\\"\\r\\n"
            + "Content-Type: audio/wav\\r\\n\\r\\n").getBytes();
        var mid = ("\\r\\n--" + boundary + "\\r\\n"
            + "Content-Disposition: form-data; name=\\"view\\"\\r\\n\\r\\nfull\\r\\n"
            + "--" + boundary + "--\\r\\n").getBytes();

        var req = HttpRequest.newBuilder(URI.create(BASE + "/v1/jobs"))
            .header("Authorization", "Bearer " + key)
            .header("Content-Type", "multipart/form-data; boundary=" + boundary)
            .POST(HttpRequest.BodyPublishers.ofByteArrays(
                List.of(head, Files.readAllBytes(audio), mid)))
            .build();
        return field(HTTP.send(req, HttpResponse.BodyHandlers.ofString()).body(), "id");
    }

    public static void main(String[] args) throws Exception {
        String key = System.getenv("SATE_KEY");
        String id = submit(key, Path.of("sample.wav"));

        long delay = 2000;
        String body;
        for (;;) {
            Thread.sleep(delay);
            delay = Math.min(delay * 5 / 4, 10000);  // back off
            var poll = HttpRequest.newBuilder(URI.create(BASE + "/v1/jobs/" + id))
                .header("Authorization", "Bearer " + key).build();
            body = HTTP.send(poll, HttpResponse.BodyHandlers.ofString()).body();
            String status = field(body, "status");
            if ("done".equals(status) || "error".equals(status)) break;
        }

        if ("error".equals(field(body, "status"))) {
            throw new IOException(field(body, "message"));
        }
        System.out.println(field(body, "text"));
    }
}`,
    },
    {
      id: 'csharp', label: 'C#',
      code: `using System.Net.Http.Headers;
using System.Text.Json;

var key  = Environment.GetEnvironmentVariable("SATE_KEY")!;
var Base = "https://${apiHost}";

using var http = new HttpClient();
http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key);

// 1. Submit
using var form = new MultipartFormDataContent();
var audio = new ByteArrayContent(await File.ReadAllBytesAsync("sample.wav"));
audio.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
form.Add(audio, "audio", "sample.wav");
form.Add(new StringContent("full"), "view");

var submit = await http.PostAsync(Base + "/v1/jobs", form);
var job = JsonDocument.Parse(await submit.Content.ReadAsStringAsync()).RootElement;
if (job.TryGetProperty("error", out var subErr))
    throw new Exception(subErr.GetProperty("message").GetString());
var id = job.GetProperty("id").GetString();

// 2. Poll with backoff — polling spends your own rate limit
var delay = 2000;
JsonElement result;
while (true)
{
    await Task.Delay(delay);
    delay = Math.Min(delay * 5 / 4, 10000);
    var raw = await http.GetStringAsync(Base + "/v1/jobs/" + id);
    result = JsonDocument.Parse(raw).RootElement;
    var status = result.GetProperty("status").GetString();
    if (status is "done" or "error") break;
}

if (result.GetProperty("status").GetString() == "error")
    throw new Exception(result.GetProperty("error").GetProperty("message").GetString());

// 3. Read
if (result.TryGetProperty("no_speech_detected", out _))
{
    Console.WriteLine("no speech in this recording");
}
else
{
    Console.WriteLine(result.GetProperty("transcript").GetProperty("text").GetString());
    var report = result.GetProperty("report");
    Console.WriteLine($"MLUw {report.GetProperty("mluw")} NDW {report.GetProperty("ndw")}");
}`,
    },
    {
      id: 'ruby', label: 'Ruby',
      code: `require "json"
require "net/http"
require "uri"

KEY  = ENV.fetch("SATE_KEY")
BASE = "https://${apiHost}"

def analyze(path, view: "full")
  uri = URI("#{BASE}/v1/jobs")
  req = Net::HTTP::Post.new(uri)
  req["Authorization"] = "Bearer #{KEY}"
  req.set_form([
    ["audio", File.open(path), { filename: "sample.wav", content_type: "audio/wav" }],
    ["view", view],
  ], "multipart/form-data")

  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |h| h.request(req) }
  job = JSON.parse(res.body)
  raise job.dig("error", "message") if job["error"]

  delay = 2.0
  loop do
    sleep delay
    delay = [delay * 1.25, 10].min   # back off: polling spends your own rate limit

    poll = URI("#{BASE}/v1/jobs/#{job['id']}")
    get = Net::HTTP::Get.new(poll)
    get["Authorization"] = "Bearer #{KEY}"
    body = JSON.parse(
      Net::HTTP.start(poll.host, poll.port, use_ssl: true) { |h| h.request(get) }.body
    )

    raise body.dig("error", "message") if body["status"] == "error"
    return body if body["status"] == "done"
  end
end

result = analyze("sample.wav")

if result["no_speech_detected"]
  puts "no speech in this recording"
else
  puts result.dig("transcript", "text")
  puts "MLUw #{result.dig('report', 'mluw')} NDW #{result.dig('report', 'ndw')}"
end`,
    },
  ];

  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const tabs = SAMPLES.map((s, i) =>
    `<button class="lang" data-lang="${s.id}" aria-selected="${i === 0}"
       onclick="pickLang('${s.id}')">${s.label}</button>`).join('');

  const panes = SAMPLES.map((s, i) =>
    `<pre class="sample" data-lang="${s.id}"${i === 0 ? '' : ' hidden'}><code>${escape(s.code)}</code></pre>`).join('');

  return `<div class="langbar">${tabs}</div>${panes}
<script>
  // Remembering the choice matters: a developer reading top to bottom should not have to
  // re-pick their language at every sample block on the page.
  function pickLang(id) {
    document.querySelectorAll('.lang').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.lang === id));
    });
    document.querySelectorAll('.sample').forEach(function (p) {
      p.hidden = p.dataset.lang !== id;
    });
    try { localStorage.setItem('sate_lang', id); } catch (e) { /* private mode */ }
  }
  try {
    var saved = localStorage.getItem('sate_lang');
    if (saved && document.querySelector('.lang[data-lang="' + saved + '"]')) pickLang(saved);
  } catch (e) { /* private mode */ }
</script>`;
}

export function docsHtml(apiHost: string, portalHost: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SATE Developer API — Reference</title>
<style>
  /* Same tokens as the portal, which take them from the SATE web app. See src/ui.ts. */
  :root {
    --bg: #fafafa; --surface: #ffffff; --surface-2: #f9fafb;
    --line: #e5e7eb; --line-strong: #d1d5db;
    --text: #111827; --text-2: #374151; --muted: #4b5563; --subtle: #6b7280;
    --primary: #2563eb; --primary-soft: #eff6ff;
    --radius: 8px; --shadow-card: 0 1px 2px 0 rgba(0, 0, 0, .05);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    font-size: 15px; line-height: 1.65;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }
  a { color: var(--primary); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .topbar { background: var(--surface); border-bottom: 1px solid var(--line); padding: 14px 24px; }
  .topbar .inner { max-width: 880px; margin: 0 auto; display: flex; align-items: center;
                   justify-content: space-between; gap: 16px; }
  .wordmark { font-size: 22px; font-weight: 700; letter-spacing: -.02em; color: var(--text); }
  .wordmark span { display: block; font-size: 11px; font-weight: 500; color: var(--muted); margin-top: -2px; }

  .wrap { max-width: 880px; margin: 0 auto; padding: 34px 24px 80px; }
  h1 { font-size: 28px; font-weight: 600; letter-spacing: -.02em; margin-bottom: 6px; }
  h2 { font-size: 19px; font-weight: 600; margin: 40px 0 10px; padding-top: 18px;
       border-top: 1px solid var(--line); letter-spacing: -.01em; }
  h3 { font-size: 14px; margin: 24px 0 6px; font-family: ui-monospace, Menlo, monospace;
       color: var(--primary); font-weight: 600; }
  p { margin: 10px 0; }
  p.lead { color: var(--muted); font-size: 17px; margin: 0 0 8px; }
  ul, ol { margin: 10px 0 10px 22px; }

  pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius);
        padding: 15px; overflow-x: auto; font-size: 13px; line-height: 1.55; margin: 12px 0;
        color: var(--text-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: .92em; }
  p code, li code, td code { background: var(--surface-2); border: 1px solid var(--line);
                             padding: 1px 6px; border-radius: 5px; color: var(--text-2); }

  table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 14px;
          background: var(--surface); border: 1px solid var(--line);
          border-radius: var(--radius); box-shadow: var(--shadow-card); overflow: hidden; }
  th { text-align: left; color: var(--subtle); font-weight: 500; font-size: 11px; text-transform: uppercase;
       letter-spacing: .06em; padding: 9px 12px; border-bottom: 1px solid var(--line);
       background: var(--surface-2); }
  td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }

  .note { background: var(--primary-soft); border: 1px solid #bfdbfe; border-left: 3px solid var(--primary);
          border-radius: var(--radius); padding: 13px 16px; margin: 18px 0; font-size: 14px; }
  .muted { color: var(--muted); }

  .langbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 10px; }
  .langbar .lang {
    background: var(--surface); border: 1px solid var(--line-strong); color: var(--muted);
    padding: 6px 13px; border-radius: var(--radius); cursor: pointer; font: inherit; font-size: 13px;
    transition: background-color .12s, color .12s;
  }
  .langbar .lang:hover { color: var(--text); background: var(--surface-2); }
  .langbar .lang[aria-selected="true"] { background: var(--primary); border-color: var(--primary);
                                         color: #fff; font-weight: 500; }
  pre.sample { margin-top: 0; max-height: 640px; overflow: auto; }
  @media (max-width: 720px) { .wrap { padding: 24px 16px 56px; } }
</style>
</head>
<body>
<div class="topbar"><div class="inner">
  <div class="wordmark">SATE<span>Developer Platform</span></div>
  <a href="/">← Back to the portal</a>
</div></div>
<div class="wrap">

<h1>SATE Developer API</h1>
<p class="lead">Send audio. Get a transcript and a speech report. Base URL
<code>https://${apiHost}</code>.</p>

<h2>Authentication</h2>
<p>Every request carries an API key you create in the
<a href="https://${portalHost}">portal</a>:</p>
<pre>Authorization: Bearer sate_live_…</pre>
<p>Keys are shown once, at creation — only a hash is stored, so a lost key must be
revoked and replaced rather than recovered.</p>

<h2>Scopes and views</h2>
<p>A key carries scopes; a <em>view</em> is the shape of the result you ask for. Your
administrator decides which scopes you have.</p>
<table>
  <tr><th>View</th><th>Scope required</th><th>What you get</th></tr>
  <tr><td><code>transcript</code></td><td><code>transcript:read</code></td>
      <td>Speaker-attributed segments, per-word timings, plain text.</td></tr>
  <tr><td><code>report</code></td><td><code>report:read</code></td>
      <td>Counts and metrics only — no words at all.</td></tr>
  <tr><td><code>full</code></td><td>any</td>
      <td>Everything your scopes allow. Anything withheld is named in <code>omitted</code>.</td></tr>
</table>
<div class="note"><strong>Asking for more than you hold is not an error.</strong> A
report-only key requesting <code>view=full</code> gets its report, plus
<code>"omitted": ["transcript","annotations"]</code> — so you always know what was withheld
and why, rather than getting a bare 403.</div>

<h2>Submitting audio</h2>
<h3>POST /v1/jobs</h3>
<p>Multipart, with the file in a field named <code>audio</code>:</p>
<pre>curl -X POST https://${apiHost}/v1/jobs \\
  -H "Authorization: Bearer sate_live_…" \\
  -F audio=@sample.wav \\
  -F view=full \\
  -F 'metadata={"my_ref":"abc123"}'</pre>
<p>Or the raw bytes, which is often simpler from an embedded client:</p>
<pre>curl -X POST "https://${apiHost}/v1/jobs?view=transcript" \\
  -H "Authorization: Bearer sate_live_…" \\
  -H "Content-Type: audio/wav" \\
  --data-binary @sample.wav</pre>
<table>
  <tr><th>Field</th><th>Default</th><th>Meaning</th></tr>
  <tr><td><code>audio</code></td><td>required</td><td>The audio. 16 kHz mono WAV is the native format.</td></tr>
  <tr><td><code>view</code></td><td><code>full</code></td><td><code>full</code>, <code>transcript</code> or <code>report</code>.</td></tr>
  <tr><td><code>webhook_url</code></td><td>—</td><td>An <code>https://</code> URL we POST to when the job settles.</td></tr>
  <tr><td><code>metadata</code></td><td><code>{}</code></td><td>Opaque JSON, echoed back on every read.</td></tr>
  <tr><td><code>pause_threshold</code></td><td><code>0.25</code></td><td>Seconds of silence counted as a pause.</td></tr>
  <tr><td><code>language</code></td><td>auto</td><td>Language hint for the recogniser.</td></tr>
</table>

<div class="note"><strong>Processing is asynchronous, and cannot be otherwise.</strong>
Transcription runs on a GPU and a long file takes minutes; no HTTP request can be held
open that long without being killed mid-flight. <code>POST</code> answers <code>202</code>
immediately with a job id — then poll, or give us a webhook.</div>

<pre>202 Accepted
{
  "id": "6f1c…",
  "object": "job",
  "status": "queued",
  "view": "full",
  "poll_url": "https://${apiHost}/v1/jobs/6f1c…"
}</pre>

<h2>Reading results</h2>
<h3>GET /v1/jobs/{id}</h3>
<p>Poll this. While it is running you get the envelope with
<code>status: "queued" | "processing"</code> — a <code>200</code>, not an error, because
not-finished-yet is the expected state. Once <code>status</code> is <code>done</code>, the
result is included. Add <code>?view=</code> to read a different shape than you submitted.</p>
<pre>{
  "id": "6f1c…",
  "status": "done",
  "duration_sec": 92.4,
  "transcript": {
    "text": "we went to the park and um the dog ran away",
    "segments": [
      { "index": 0, "speaker": "Child", "start": 0.42, "end": 4.10,
        "text": "we went to the park",
        "words": [ { "index": 0, "word": "we", "start": 0.42, "end": 0.55 } ] }
    ]
  },
  "annotations": {
    "segments": [
      { "index": 0, "speaker": "Child",
        "pauses": [ { "index": 3, "duration": 1.2 } ],
        "fillerwords": [ { "index": 5, "content": "um" } ] }
    ]
  },
  "report": {
    "annotationCounts": { "pause": 4, "filler": 7, "repetition": 2, "mispronunciation": 0,
                          "morpheme": 5, "morpheme-omission": 1, "revision": 3,
                          "utterance-error": 0 },
    "totalAnnotations": 22, "totalWords": 168, "totalDuration": 92.4,
    "speakingRate": 109.1, "annotationRate": 13.1,
    "segmentCount": 24, "speakerCount": 2, "utteranceCount": 31,
    "ntw": 141, "ndw": 88, "mluw": 4.55, "mlum": 5.10, "numberOfPauses": 4
  }
}</pre>

<h3>The report fields</h3>
<table>
  <tr><th>Field</th><th>Meaning</th></tr>
  <tr><td><code>annotationCounts</code></td><td>How many of each annotation type were found.</td></tr>
  <tr><td><code>ntw</code> / <code>ndw</code></td><td>Number of total / different words, excluding mazes. NDW counts lemmas.</td></tr>
  <tr><td><code>mluw</code> / <code>mlum</code></td><td>Mean length of utterance, in words / in morphemes.</td></tr>
  <tr><td><code>speakingRate</code></td><td>Words per minute across the whole sample.</td></tr>
  <tr><td><code>annotationRate</code></td><td>Annotations per 100 words.</td></tr>
  <tr><td><code>utteranceCount</code></td><td>Utterances after splitting segments on terminal punctuation.</td></tr>
</table>
<p class="muted">"Maze" words — fillers, repeated and revised runs, bare punctuation — are
excluded from NTW, NDW and both MLU measures.</p>

<h3>Section endpoints</h3>
<p>When you only want one part, and want a hard <code>403</code> if you lack the scope
rather than a silent omission:</p>
<pre>GET /v1/jobs/{id}/transcript     # requires transcript:read
GET /v1/jobs/{id}/annotations    # requires annotations:read
GET /v1/jobs/{id}/report         # requires report:read</pre>

<h3>Other routes</h3>
<pre>GET    /v1/jobs?limit=20&amp;status=done   # your recent jobs
DELETE /v1/jobs/{id}                    # delete a job and its result now
GET    /v1/usage?days=30                # your consumption
GET    /v1/me                           # what this key can do</pre>

<h2>Text analysis</h2>
<p>Three synchronous endpoints analyse <em>text</em> you already have — no audio, no job, no
polling. They return immediately. All three take the <code>text:read</code> scope, accept
either <code>text/plain</code> or JSON, and use 0-based word indices.</p>
<table>
  <tr><th>Endpoint</th><th>Does</th></tr>
  <tr><td><code>POST /v1/cunit</code></td><td>Splits a transcript into C-units (communication units).</td></tr>
  <tr><td><code>POST /v1/maze</code></td><td>Marks mazes: filled pauses (FP), repetitions (RP), revisions (RV).</td></tr>
  <tr><td><code>POST /v1/morpheme</code></td><td>Marks inflectional morphemes (plural, past tense, progressive, …).</td></tr>
</table>
<pre>curl -X POST https://${apiHost}/v1/maze \\
  -H "Authorization: Bearer sate_live_…" \\
  -H "Content-Type: text/plain" \\
  --data "um the the dog uh runned"</pre>
<pre>{
  "input_type": "text",
  "words": ["um","the","the","dog","uh","runned"],
  "mazes": [
    { "index": 0, "word": "um",  "label": "FP", "type": "filled_pause" },
    { "index": 1, "word": "the", "label": "RP", "type": "repetition" },
    { "index": 4, "word": "uh",  "label": "FP", "type": "filled_pause" }
  ]
}</pre>
<p>They chain: feed the <code>cunits</code> array from <code>/v1/cunit</code> straight into
<code>/v1/maze</code> or <code>/v1/morpheme</code> as JSON to annotate each C-unit in one
call. The first request after an idle period is a little slower while the models load; the
rest are fast. These are text-only, so they produce no timestamps or pauses.</p>

<h2>Webhooks</h2>
<p>Pass <code>webhook_url</code> and we POST when the job settles. The payload carries no
result — fetch it over the authenticated API — so a guessed or leaked webhook URL reveals
nothing:</p>
<pre>{
  "event": "job.done",
  "job_id": "6f1c…",
  "status": "done",
  "metadata": { "my_ref": "abc123" },
  "result_url": "https://${apiHost}/v1/jobs/6f1c…"
}</pre>

<h2>Limits</h2>
<table>
  <tr><th>Limit</th><th>Behaviour</th></tr>
  <tr><td>Rate</td><td>Per key, per minute. Over it: <code>429</code> with <code>retry_after_seconds</code>.</td></tr>
  <tr><td>Audio quota</td><td>Audio minutes, monthly or lifetime depending on your account. Over it: <code>402</code>.</td></tr>
  <tr><td>Upload size</td><td>50 MB per file. Over it: <code>413</code>.</td></tr>
  <tr><td>Retention</td><td>Results are deleted after 30 days. Uploaded audio is deleted the moment the job finishes.</td></tr>
</table>

<h2>Errors</h2>
<p>Every failure has a stable <code>code</code>. Build retry logic on the code, not the message:</p>
<pre>{ "error": { "code": "quota_exceeded", "message": "Monthly quota of 120 audio minutes reached." } }</pre>
<table>
  <tr><th>Code</th><th>Status</th><th>Meaning</th></tr>
  <tr><td><code>unauthorized</code></td><td>401</td><td>Missing or invalid key.</td></tr>
  <tr><td><code>key_revoked</code></td><td>401</td><td>The key was revoked in the portal.</td></tr>
  <tr><td><code>account_inactive</code></td><td>403</td><td>The developer account is not active.</td></tr>
  <tr><td><code>api_locked</code></td><td>403</td><td>An administrator has locked API access. The message says why.</td></tr>
  <tr><td><code>insufficient_scope</code></td><td>403</td><td>Your key lacks the scope for that section.</td></tr>
  <tr><td><code>quota_exceeded</code></td><td>402</td><td>Audio quota reached.</td></tr>
  <tr><td><code>rate_limited</code></td><td>429</td><td>Too many requests this minute.</td></tr>
  <tr><td><code>audio_too_large</code></td><td>413</td><td>File over the size limit.</td></tr>
  <tr><td><code>not_found</code></td><td>404</td><td>No such job, or not yours.</td></tr>
</table>
<p>A job that fails processing is not an HTTP error: it comes back <code>200</code> with
<code>status: "error"</code> and an <code>error</code> object. Audio with no speech in it
comes back <code>done</code> with <code>"no_speech_detected": true</code> — that is a
result, not a failure.</p>

<h2>A complete client</h2>
<p>The same program in nine languages: submit a file, poll with backoff until it settles,
then print the transcript and two report figures. Each one is complete and runnable —
substitute your key and a WAV path.</p>
${samples(apiHost)}

<p class="muted" style="margin-top:40px">Questions? Contact your administrator through the
<a href="https://${portalHost}">developer portal</a>.</p>
</div></body></html>`;
}
