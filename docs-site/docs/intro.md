---
title: Overview
sidebar_position: 1
slug: /
---

<div class="doc-hero">
  <img class="hero-wordmark" src="/img/sate-logo.png" alt="SATE" />
  <span class="eyebrow">Engineering documentation</span>
  <h1>SATE Companion</h1>
  <p>A speech-capture and analysis platform for speech-language pathologists — from a handheld recorder and a wearable pendant, through an async AI pipeline, to an interactive clinician report.</p>
  <div class="hero-actions">
    <a class="btn-primary" href="/getting-started">Get started</a>
    <a class="btn-secondary" href="/architecture">How it works</a>
  </div>
</div>

<div class="badge-row">
  <span class="sate-badge">Recorder · fw 1.5.18</span>
  <span class="sate-badge">Pendant · fw 1.0.0</span>
  <span class="sate-badge">device-api · v15</span>
  <span class="sate-badge ok"><span class="dot ok"></span> pipeline: async</span>
</div>

SATE Companion captures a patient's speech on a hardware device, uploads the audio to a
backend that transcribes and analyses it with an AI model, and presents the result to the
clinician as an interactive report they can edit and annotate.

This site is the **internal engineering reference**. Every claim is grounded in the source;
each component guide ends with a **Known issues / current status** section drawn from the
2026-07 audit.

## Start here

<div class="card-grid">
  <a class="doc-card" href="/getting-started"><strong>Getting started</strong><span>Toolchain, build, flash, and run each part end-to-end.</span></a>
  <a class="doc-card" href="/architecture"><strong>Architecture</strong><span>Data-flow diagrams, transports, and why processing is async.</span></a>
  <a class="doc-card" href="/known-issues"><strong>Known issues</strong><span>Current bugs and status from the latest audit.</span></a>
</div>

## Component guides

<div class="card-grid">
  <a class="doc-card" href="/guides/recorder"><strong>Recorder firmware</strong><span>ESP32-S3 handheld — the flagship device.</span></a>
  <a class="doc-card" href="/guides/pendant"><strong>Pendant firmware</strong><span>nRF52840 wearable BLE audio streamer.</span></a>
  <a class="doc-card" href="/guides/mobile-app"><strong>Mobile app</strong><span>Device bridge, Plaud integration, auto-sync.</span></a>
  <a class="doc-card" href="/guides/web-app"><strong>Web app</strong><span>Clinician report, transcript editing, annotations.</span></a>
  <a class="doc-card" href="/guides/backend"><strong>Backend pipeline</strong><span>Async AI: assemble → transcribe → analyse → store.</span></a>
  <a class="doc-card" href="/guides/plaud"><strong>Plaud integration</strong><span>Third-party recorder — device-lock sensitive.</span></a>
</div>

## The system at a glance

```mermaid
flowchart LR
  subgraph Capture
    REC["SATE Recorder<br/>ESP32-S3 · touchscreen + SD"]
    PEN["SATE Pendant<br/>nRF52840 · wearable"]
    PLA["Plaud<br/>3rd-party recorder"]
  end

  APP["Mobile app<br/>React Native / iOS"]

  subgraph Backend
    API["device-api<br/>Supabase edge fn"]
    STG[("Storage<br/>sessions · recordings")]
    PROC["cf-processor<br/>Cloudflare container"]
    AI["AI /process<br/>self-hosted CUDA"]
    DB[("Postgres<br/>sessions · recordings · patients")]
  end

  WEB["Web app<br/>clinician report"]

  REC -- "Wi-Fi HTTPS / BLE bridge" --> API
  PEN -- "BLE PCM stream" --> APP
  PLA -- "proprietary SDK" --> APP
  APP -- "HTTPS upload" --> API
  API --> STG
  API --> DB
  PROC -- "claim queued session" --> DB
  PROC --> STG
  PROC --> AI
  WEB --> DB
  WEB --> STG
```

## Components

| Component | Tech | Role | Guide |
|---|---|---|---|
| **SATE Recorder** | ESP32-S3, LVGL, SD_MMC | Handheld recorder: records to SD, uploads over Wi-Fi/BLE, OTA | [Recorder firmware](guides/recorder) |
| **SATE Pendant** | XIAO nRF52840, Bluefruit | Wearable: streams 16 kHz PCM over BLE to the app | [Pendant firmware](guides/pendant) |
| **Mobile app** | React Native / Expo (iOS) | Bridges devices → backend; Plaud integration; auto-sync | [Mobile app](guides/mobile-app) |
| **Web app** | React + Vite + Supabase | Clinician report: audio player, transcript editing, annotations, metrics | [Web app](guides/web-app) |
| **Backend** | Supabase edge fns + Cloudflare container | Async AI pipeline: assemble → transcribe → analyse → store | [Backend pipeline](guides/backend) |
| **Plaud** | proprietary iOS SDK | Third-party recorder integration (device-lock sensitive) | [Plaud integration](guides/plaud) |

## Connection methods (transports)

The system deliberately uses a **different transport per link** — each chosen for the
constraints of the device on either end.

| Link | Transport | Why |
|---|---|---|
| Recorder → backend | **Wi-Fi HTTPS** (chunked upload), **BLE bridge** when offline | The recorder has Wi-Fi; BLE is the fallback when there's no network |
| Pendant → app | **BLE** (244-byte PCM notifies) | Tiny wearable; no Wi-Fi, streams live to the phone |
| Plaud → app | **Proprietary BLE SDK** | Vendor SDK owns its own `CBCentralManager` |
| App → backend | **HTTPS** to `device-api` | Standard authenticated upload |
| Backend AI call | **Long-lived HTTP** from a container (never an edge fn) | The AI call exceeds serverless wall-clock limits |
| Firmware OTA | **HTTPS pull** of a `.bin` from Storage | Device pulls, not pushed |

See [Architecture](architecture) for the full data-flow, and each component guide for the
exact protocols and functions.
