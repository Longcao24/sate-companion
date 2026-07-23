/**
 * Sona Pendant — XIAO nRF52840 Sense Plus — BLE Audio Streamer (food-intake)
 *
 * Streams the onboard PDM mic over BLE as raw 16-bit PCM @ 16 kHz mono.
 * The phone app forwards these windows to the inference server (AST model)
 * to detect food-intake events. IMU is intentionally NOT used — audio only.
 *
 * Build: Seeed nRF52 Boards core, board = "Seeed XIAO nRF52840 Sense Plus"
 *        (FQBN Seeeduino:nrf52:xiaonRF52840SensePlus)
 *
 * BLE protocol:
 *   Service   19B10000-E8F2-537E-4F6C-D104768A1214
 *   Audio     19B10001  NOTIFY  244 bytes = 122 int16 samples (16 kHz mono)
 *   Control   19B10002  WRITE   1 byte  0x01=start stream  0x00=stop
 *                                       0x02=find-me (LED flash ~5 s)
 *   Adv name  "SATE Pendant"  (also advertises the service UUID)
 *
 * Throughput notes (16 kHz*16bit = 256 kbps, tight for BLE):
 *   - configPrphBandwidth(BANDWIDTH_MAX): MTU 247 + big notify queue
 *   - 2M PHY requested on connect: doubles raw BLE rate
 *   - notify() is retried (data kept in ring buffer) so nothing drops
 *
 * Power management (battery: hours -> days):
 *   - NAP MODE: while streaming, if audio stays quiet for SLEEP_AFTER_MS the
 *     pendant naps — PDM off, no BLE notifies (radio idle). Every NAP_CHECK_MS
 *     it listens for NAP_LISTEN_MS; sound above WAKE_MEANABS resumes streaming
 *     instantly. The app keeps working: no packets while quiet, stream resumes
 *     on the next bite/word.
 *   - TX power 0 dBm (pendant is <2 m from the phone; +4 wastes radio power)
 *   - conn LED handled manually + dim duty cycles; idle loop sleeps via delay()
 *     (FreeRTOS tickless idle -> SoC sleep between events)
 */

#include <bluefruit.h>
#include <PDM.h>

// Pendant firmware version. First versioned release. Bump on every release and log
// it in the docs "Version log". NOTE: not yet exposed over BLE — the app can't read
// this until a version characteristic (or a DIS firmware-revision string) is added.
static const char *FIRMWARE_VERSION = "1.0.0";

#define SAMPLE_RATE   16000
#define MIC_GAIN      64           // PDM analog gain 0..80 (default 20). 64 = a bit louder than stock, still clean.
                                   // 70+ and/or digital gain clipped loud samples -> harsh "rè" buzz. Keep ≤~66.
#define DIGITAL_GAIN  6.0f         // makeup gain AFTER PDM. The raw mic is quiet ("nhỏ"); this lifts it.
                                   // Analog PDM gain is already near its clean ceiling (~66; 70+ clips in
                                   // the decimator = real buzz we can't undo), so loudness comes from here.
                                   // Peaks are SOFT-clipped (tanh knee), not hard-clipped, so loud bites
                                   // compress smoothly instead of squaring off into the harsh "rè" buzz.
#define PKT_SAMPLES   122          // 244 bytes = max notify @ MTU 247

// DC-blocking / rumble high-pass, one-pole:  y = x - x1 + R*y1
// PDM mics carry a DC bias + sub-bass handling rumble that muddies the raw PCM
// stream ("đục/boomy"). Removing it is the single biggest clarity win for raw
// audio — same effect Opus VOICE mode gives Omi, but free and lossless here.
// fc ≈ 60 Hz @ 16 kHz (R = 0.976). Speech fundamentals + chewing energy sit well
// above 60 Hz, so detection is unaffected; only the mud below it is cut.
#define HPF_R         0.976f

// ── Power / nap tuning ───────────────────────────────────────────────────────
#define SLEEP_AFTER_MS  30000      // this long below LOUD_MEANABS -> nap
#define NAP_CHECK_MS     2000      // while napping, listen this often
#define NAP_LISTEN_MS     180      // listen window per check (incl. ~60 ms mic settle)
#define NAP_SETTLE_MS      60      // discard mic settling at each nap check
#define WAKE_MEANABS     1400      // mean |sample| (int16) that counts as sound
#define LOUD_MEANABS     1400      // same threshold used while streaming
                                   // (scaled with DIGITAL_GAIN; stays above the gained noise floor)

// Ring buffer between PDM ISR (producer) and BLE loop (consumer).
#define RING_SIZE     8192         // power of 2; ~0.5 s cushion @ 16 kHz
#define RING_MASK     (RING_SIZE - 1)
static int16_t ring[RING_SIZE];
static volatile uint32_t ringHead = 0;   // written by PDM callback
static volatile uint32_t ringTail = 0;   // read by loop
static volatile uint32_t ringDropped = 0; // samples dropped on overrun (BLE stalled)
static short pdmTemp[512];                // PDM.read scratch
static volatile int32_t warmup = 0;       // samples to drop after PDM.begin (mic settling "pop")
static float hpfX1 = 0, hpfY1 = 0;        // DC-block high-pass state (reset per stream in micStart)

// ── Status LED (XIAO RGB, active-LOW: clear pin = ON) ────────────────────────
#define LED_RED   26   // P0.26 — streaming
#define LED_BLUE   6   // P0.06 — BLE: blink=advertising, solid(dim duty)=connected
static inline void redOn()   { NRF_P0->OUTCLR = (1UL << LED_RED); }
static inline void redOff()  { NRF_P0->OUTSET = (1UL << LED_RED); }
static inline void blueOn()  { NRF_P0->OUTCLR = (1UL << LED_BLUE); }
static inline void blueOff() { NRF_P0->OUTSET = (1UL << LED_BLUE); }

BLEService        audioSvc("19B10000-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic audioChr("19B10001-E8F2-537E-4F6C-D104768A1214");
BLECharacteristic ctrlChr ("19B10002-E8F2-537E-4F6C-D104768A1214");
BLEBas            batSvc;   // standard Battery Service 0x180F / 0x2A19 (%)
BLEDfu            bledfu;   // Adafruit/Nordic BLE OTA DFU service — lets the app push firmware over BLE

// ── Battery (XIAO nRF52840: VBAT on P0.31 behind 1M/510k divider, enabled by
//    pulling P0.14 low; LiPo 3.3 V empty .. 4.2 V full) ────────────────────────
#ifndef PIN_VBAT
#define PIN_VBAT        32   // P0.31 / AIN7
#endif
#ifndef VBAT_ENABLE
#define VBAT_ENABLE     14   // P0.14, LOW = divider connected
#endif

static uint8_t readBatteryPct() {
  digitalWrite(VBAT_ENABLE, LOW);
  delayMicroseconds(200);                    // divider settle
  analogReference(AR_INTERNAL_2_4);          // 2.4 V ref
  analogReadResolution(12);
  // nRF52 SAADC applies a new reference on the NEXT conversion, so the first
  // read after analogReference() is stale -> discard it, then average to cut
  // ADC noise. Without this the reported % was consistently off.
  (void)analogRead(PIN_VBAT);
  delayMicroseconds(20);
  uint32_t acc = 0;
  for (int i = 0; i < 16; i++) acc += analogRead(PIN_VBAT);
  uint32_t raw = acc / 16;
  digitalWrite(VBAT_ENABLE, HIGH);           // disconnect divider (saves ~4 µA)
  float v = raw * (2.4f / 4096.0f) * (1000.0f + 510.0f) / 510.0f;  // ≈ VBAT
  // LiPo discharge curve, piecewise linear (good enough for a UI gauge).
  float pct;
  if      (v >= 4.10f) pct = 100.0f;
  else if (v >= 3.90f) pct = 80.0f + (v - 3.90f) * 100.0f;   // 3.90-4.10 -> 80-100
  else if (v >= 3.70f) pct = 40.0f + (v - 3.70f) * 200.0f;   // 3.70-3.90 -> 40-80
  else if (v >= 3.50f) pct = 10.0f + (v - 3.50f) * 150.0f;   // 3.50-3.70 -> 10-40
  else if (v >= 3.30f) pct = (v - 3.30f) * 50.0f;            // 3.30-3.50 -> 0-10
  else                 pct = 0.0f;
  return (uint8_t)(pct + 0.5f);
}

// USB 5V present? The XIAO has no charge-status pin, but the nRF52840 detects
// VBUS directly. VBUS present == plugged in == charging (or topped off).
static inline bool usbPlugged() {
  return (NRF_POWER->USBREGSTATUS & POWER_USBREGSTATUS_VBUSDETECT_Msk) != 0;
}

// Publish battery over the standard Battery Service. The value is 0-100 (7
// bits); bit 7 (0x80) is our charging flag — the app masks it off for the %
// and uses it to show a charging indicator.
static void publishBattery() {
  uint8_t v = readBatteryPct() & 0x7F;
  if (usbPlugged()) v |= 0x80;
  batSvc.write(v);
}

volatile bool recording = false;   // phone pressed Start (master switch)
static bool napping = false;       // quiet too long -> radio+mic resting
static uint32_t lastLoudMs = 0;
static uint32_t lastNapCheckMs = 0;
static volatile uint32_t findMeUntil = 0;   // millis deadline for find-me LED flash

// ── PDM data callback (called from PDM IRQ) ──────────────────────────────────
void onPDMdata() {
  int bytes = PDM.available();
  if (bytes <= 0) return;
  if (bytes > (int)sizeof(pdmTemp)) bytes = sizeof(pdmTemp);
  PDM.read(pdmTemp, bytes);
  int n = bytes / 2;
  int i = 0;
  // Drop the mic's startup transient (DC settling thump) before storing.
  if (warmup > 0) {
    int drop = (n < warmup) ? n : warmup;
    warmup -= drop;
    i = drop;
  }
  uint32_t h = ringHead;
  uint32_t t = ringTail;            // snapshot the consumer position for the overrun guard
  float x1 = hpfX1, y1 = hpfY1;
  for (; i < n; i++) {
    // DC-block high-pass first (removes bias + rumble -> clearer), then gain.
    float x = (float)pdmTemp[i];
    float y = x - x1 + HPF_R * y1;
    x1 = x; y1 = y;
    // Makeup gain + tanh soft-clip: quiet parts get ~DIGITAL_GAIN× louder (tanh
    // is ~linear near 0), loud peaks bend smoothly toward ±full-scale instead of
    // hard-clipping. Output of tanh is (-1,1) so it can never exceed int16 range.
    float v = 32767.0f * tanhf((y * DIGITAL_GAIN) / 32767.0f);
    // Overrun guard: if the BLE consumer has stalled (notify() failing under a
    // sagging low-battery rail) and the ring is full, DROP the newest sample
    // instead of overwriting audio that hasn't been sent yet. This keeps the
    // already-queued stream contiguous — one clean gap when the link recovers,
    // not a mid-buffer corruption. The HPF state above keeps advancing so the
    // filter stays aligned with real time across the gap.
    if ((uint32_t)(h - t) >= RING_SIZE) { ringDropped++; continue; }
    ring[(h++) & RING_MASK] = (int16_t)v;
  }
  hpfX1 = x1; hpfY1 = y1;
  ringHead = h;
}

static void micStart(int32_t settleSamples) {
  ringHead = ringTail = 0;
  warmup = settleSamples;
  hpfX1 = hpfY1 = 0;               // fresh filter state each stream (no carried-over thump)
  PDM.setGain(MIC_GAIN);
  PDM.begin(1, SAMPLE_RATE);       // 1 channel (mono)
}

// ── BLE control: start / stop streaming ──────────────────────────────────────
void onCtrlWrite(uint16_t, BLECharacteristic*, uint8_t* data, uint16_t len) {
  if (len < 1) return;
  if (data[0] == 0x01 && !recording) {
    recording = true;
    napping = false;
    lastLoudMs = millis();
    micStart(SAMPLE_RATE / 7);     // drop ~140 ms of mic-settling samples (kills "bụp" pop)
  } else if (data[0] == 0x00 && recording) {
    recording = false;
    napping = false;
    PDM.end();
  } else if (data[0] == 0x02) {
    findMeUntil = millis() + 5000;   // "find me": flash LEDs for 5 s
  }
}

void onConnect(uint16_t handle) {
  BLEConnection* c = Bluefruit.Connection(handle);
  if (c) {
    c->requestPHY(BLE_GAP_PHY_2MBPS);       // double throughput if phone supports it
    c->requestMtuExchange(247);
    // 30 ms interval (was 7.5 ms). At 2M PHY + MTU 247 one connection event
    // still carries the ~4 packets/event the 16 kHz stream needs, but the radio
    // wakes ~4x less often -> big streaming-power saving. Ring buffer (0.5 s)
    // absorbs the extra latency; detection is unaffected.
    c->requestConnectionParameter(24);      // 24 * 1.25 ms = 30 ms
  }
}

void onDisconnect(uint16_t, uint8_t) {
  if (recording) { recording = false; napping = false; PDM.end(); }
}

// Mean |sample| of everything currently in the ring (and drain it).
static uint32_t drainMeanAbs() {
  uint32_t h = ringHead, t = ringTail;
  uint32_t n = h - t;
  if (n == 0) return 0;
  uint64_t acc = 0;
  for (uint32_t i = 0; i < n; i++) {
    int16_t v = ring[(t + i) & RING_MASK];
    acc += (v < 0) ? -v : v;
  }
  ringTail = h;
  return (uint32_t)(acc / n);
}

// ── Setup ────────────────────────────────────────────────────────────────────
void setup() {
  NRF_P0->DIRSET = (1UL << LED_RED) | (1UL << LED_BLUE);
  redOff(); blueOff();

  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);   // before begin(): MTU 247 + big queue
  Bluefruit.begin();
  // Run the SoC on the DC/DC regulator instead of the default LDO. Under the
  // streaming load (131 notify/s, 2M PHY, BANDWIDTH_MAX) the radio draws hard
  // current bursts; on the LDO those pull ~2x the peak current, sagging the rail.
  // On a low / high-internal-resistance LiPo that sag makes the SoC miss
  // connection events -> notify() fails -> audio packets drop. DC/DC ~halves the
  // peak draw, which is why the drops only showed up at low battery. Must go
  // through the SoftDevice API (it owns POWER); the XIAO nRF52840 populates the
  // required DC/DC inductors, so this is safe.
  sd_power_dcdc_mode_set(NRF_POWER_DCDC_ENABLE);
  Bluefruit.autoConnLed(false);   // we drive LEDs ourselves (saves ~1 mA)
  Bluefruit.setName("SATE Pendant");
  Bluefruit.setTxPower(0);        // 0 dBm plenty for on-body -> phone-in-hand
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  // OTA DFU service — add it FIRST (Adafruit requires this so its attribute
  // handle stays fixed across firmware versions). The board already ships the
  // Adafruit/Seeed DFU bootloader (0.6.2 + S140 7.3.0), so no bootloader swap is
  // needed: a phone connects to the running pendant, writes the DFU control
  // point, the board reboots into the bootloader, and the app streams the new
  // firmware over BLE. App side must speak the Nordic BLE DFU protocol.
  bledfu.begin();

  audioSvc.begin();

  audioChr.setProperties(CHR_PROPS_NOTIFY);
  audioChr.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  audioChr.setFixedLen(PKT_SAMPLES * 2);
  audioChr.begin();

  ctrlChr.setProperties(CHR_PROPS_WRITE);
  ctrlChr.setPermission(SECMODE_OPEN, SECMODE_OPEN);
  ctrlChr.setFixedLen(1);
  ctrlChr.setWriteCallback(onCtrlWrite);
  ctrlChr.begin();

  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, HIGH);
  batSvc.begin();
  publishBattery();

  PDM.onReceive(onPDMdata);

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(audioSvc);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);  // fast 20ms -> slow 152.5ms after 30s
  Bluefruit.Advertising.start(0);
}

// ── Loop ─────────────────────────────────────────────────────────────────────
void loop() {
  uint32_t now = millis();

  // Battery: refresh every 60 s (notifies subscribed phones automatically).
  static uint32_t lastBat = 0;
  static int8_t lastPlugged = -1;
  bool plugged = usbPlugged();
  if (now - lastBat >= 60000 || (int8_t)plugged != lastPlugged) {
    lastBat = now;
    lastPlugged = plugged;
    publishBattery();          // also fires instantly on plug/unplug
  }

  // Status LED (duty-cycled — solid LEDs burn ~1 mA each)
  static uint32_t lastBlink = 0;
  static bool blinkState = false;
  if (now < findMeUntil) {
    // find-me: loud alternating flash overrides everything
    bool ph = (now % 250) < 125;
    ph ? redOn() : redOff();
    ph ? blueOff() : blueOn();
  } else if (recording && !napping) {
    blueOff();
    // streaming: red at 10% duty (30 ms on / 270 ms off) instead of solid
    redOn(); if ((now % 300) > 30) redOff();
  } else if (napping) {
    redOff(); blueOff();
    if ((now % 5000) < 40) blueOn();   // alive blip every 5 s
  } else {
    redOff();
    if (Bluefruit.connected()) {
      // connected idle: blue blip every 3 s
      ((now % 3000) < 40) ? blueOn() : blueOff();
    } else if (now - lastBlink > 300) {
      lastBlink = now;
      blinkState = !blinkState;
      blinkState ? blueOn() : blueOff();
    }
  }

  if (!recording) { delay(20); return; }   // idle: FreeRTOS tickless -> SoC sleep

  // ── NAP MODE: quiet too long -> mic+radio rest, periodic listen ───────────
  if (napping) {
    if (now - lastNapCheckMs >= NAP_CHECK_MS) {
      lastNapCheckMs = now;
      micStart((SAMPLE_RATE * NAP_SETTLE_MS) / 1000);
      delay(NAP_LISTEN_MS);
      uint32_t level = drainMeanAbs();
      if (level >= WAKE_MEANABS) {
        // Sound! resume streaming (keep mic running, just clear the ring so
        // the stream starts clean).
        napping = false;
        lastLoudMs = now;
        ringHead = ringTail = 0;
      } else {
        PDM.end();                 // back to rest
      }
    }
    delay(10);
    return;
  }

  // ── Streaming: drain ring in 122-sample packets, track loudness ───────────
  static int16_t pkt[PKT_SAMPLES];
  while ((uint32_t)(ringHead - ringTail) >= PKT_SAMPLES) {
    uint32_t t = ringTail;
    uint32_t acc = 0;
    for (uint16_t i = 0; i < PKT_SAMPLES; i++) {
      int16_t v = ring[(t + i) & RING_MASK];
      pkt[i] = v;
      acc += (v < 0) ? -v : v;
    }
    if (audioChr.notify((uint8_t*)pkt, PKT_SAMPLES * 2)) {
      ringTail = t + PKT_SAMPLES;
      if (acc / PKT_SAMPLES >= LOUD_MEANABS) lastLoudMs = now;
    } else {
      break;                       // BLE queue full; send the rest next loop
    }
  }

  // Quiet for SLEEP_AFTER_MS -> nap (PDM off, no notifies, radio idles).
  if (now - lastLoudMs > SLEEP_AFTER_MS) {
    napping = true;
    lastNapCheckMs = 0;            // check immediately on first nap loop
    PDM.end();
  }
}
