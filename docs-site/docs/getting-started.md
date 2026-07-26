---
title: Getting started
sidebar_position: 3
---

# Getting started

New here? This page orients you: the one idea that shapes the whole system, and the
fastest path through the docs for whatever you came to do. For *what each piece is*, see
the [Overview](/); for *how it all works*, see [Architecture](architecture).

<div class="badge-row">
<span class="sate-badge">ESP32-S3 recorder</span>
<span class="sate-badge">nRF52840 pendant</span>
<span class="sate-badge">iOS companion app</span>
<span class="sate-badge">React + Vite web app</span>
</div>

## The one idea

Audio flows from a device in someone's hand to a finished report on the web: captured on
hardware, synced to the cloud, transcribed and analysed by an AI model, then presented to
the clinician. Almost every design decision follows from a single guarantee.

:::tip[The guiding principle]
**A recording is never treated as safely delivered until the cloud has verifiably stored
it.** A device keeps its own copy of audio until storage is confirmed byte-for-byte, and
the long-running AI step lives in a process that can take as long as it needs — never on a
request that might time out mid-transcription.
:::

## Find your path

<div class="card-grid">
  <a class="doc-card" href="/architecture"><strong>Understand the system</strong><span>Data flow, transports, and why processing is asynchronous.</span></a>
  <a class="doc-card" href="/guides/recorder"><strong>Work on device firmware</strong><span>Recorder &amp; pendant internals, then how they're tested and released.</span></a>
  <a class="doc-card" href="/guides/backend"><strong>Work on the backend</strong><span>The async pipeline, the Device API, and the data model.</span></a>
  <a class="doc-card" href="/guides/mobile-app"><strong>Work on the apps</strong><span>The mobile bridge and the clinician web report.</span></a>
  <a class="doc-card" href="/operations/hardware-testing"><strong>Operate &amp; release</strong><span>Hardware testing, firmware releases, and the sate CLI.</span></a>
  <a class="doc-card" href="/known-issues"><strong>Check current status</strong><span>What's hardened, what's in progress, and known limitations.</span></a>
</div>

## Reading paths by task

| If you're… | Start with | Then read |
|---|---|---|
| **New to the project** | [Overview](/) → [Architecture](architecture) | The component guide for your area |
| **Building recorder / pendant firmware** | [Recorder](guides/recorder) · [Pendant](guides/pendant) | [Hardware testing](operations/hardware-testing) · [Firmware release](operations/firmware-release) |
| **Working on the backend or pipeline** | [Backend pipeline](guides/backend) | [Device API](reference/device-api) · [Data model](reference/data-model) |
| **Building the mobile or web app** | [Mobile app](guides/mobile-app) · [Web app](guides/web-app) | [BLE protocol](reference/ble-protocol) |
| **Operating or testing devices** | [Hardware testing](operations/hardware-testing) | [The sate CLI](reference/cli) · [Troubleshooting](operations/troubleshooting) |

## The parts at a glance

<div class="spec-grid">
<div class="spec-tile"><div class="k">Recorder</div><div class="v">ESP32-S3</div></div>
<div class="spec-tile"><div class="k">Pendant</div><div class="v">nRF52840</div></div>
<div class="spec-tile"><div class="k">Mobile app</div><div class="v">iOS</div></div>
<div class="spec-tile"><div class="k">Web app</div><div class="v">React + Vite</div></div>
<div class="spec-tile"><div class="k">Audio format</div><div class="v">16 kHz mono</div></div>
<div class="spec-tile"><div class="k">Sync</div><div class="v">Wi-Fi + BLE</div></div>
<div class="spec-tile"><div class="k">Backend</div><div class="v">Edge + container</div></div>
<div class="spec-tile"><div class="k">AI</div><div class="v">Async transcription</div></div>
</div>

Each of these is versioned and released independently. The [component guides](guides/recorder)
cover them one by one; the [Version log](changelog) tracks what changed in each release.
