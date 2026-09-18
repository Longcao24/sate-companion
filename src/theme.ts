import { IS_SATE_APP } from "./sate/variant";

// SATE brand tokens - identical palette to the recorder firmware so the
// phone app and the device read as one product family.

export const C = {
  bg: "#FFFFFF",
  ink: "#111827",
  slate: "#6B7280",
  sky: "#0284C7",
  navy: "#075985",
  ice: "#E0F2FE",
  mist: "#F8FAFC",
  line: "#E2E8F0",
  green: "#059669",
  greenBg: "#D1FAE5",
  red: "#DC2626",
  redBg: "#FEE2E2",
  amber: "#B45309",
  amberBg: "#FEF3C7",
};

export const radius = { card: 14, button: 12, pill: 11, chip: 8 };

// Dark "device dashboard" palette (Bambu-style) - used by the Device detail
// screen so a single recorder reads like a premium connected-hardware console.
export const D = {
  bg: "#0B0E13", // app background, near-black
  hero: "#10141B", // hero panel base
  panel: "#15191F", // card surface
  tile: "#1C212A", // elevated tile / control
  line: "#262C36", // hairline borders
  ink: "#F3F4F6", // primary text
  sub: "#9AA3AF", // secondary text
  faint: "#6B7280", // tertiary text
  sky: "#3B9EFF",
  green: "#22C55E",
  greenBg: "rgba(34,197,94,0.14)",
  red: "#EF4444",
  redBg: "rgba(239,68,68,0.15)",
  amber: "#F59E0B",
  amberBg: "rgba(245,158,11,0.15)",
  skyBg: "rgba(59,158,255,0.15)", // info tint / sky-filled surfaces
  chip: "rgba(8,11,16,0.78)", // floating chip over hero
};


// ---------------------------------------------------------------------------
// S — the SATE app's palette (the 2026-09 redesign).
//
// A THIRD palette, deliberately, rather than a rewrite of `D`. `D` is the dark
// device-console look and SATE Companion's recorder screen still wears it; if
// this had been a redesign of `D` in place, restyling the reading app would have
// silently restyled hardware screens in the other app that nobody asked to
// change.
//
// Light, warm-neutral, one teal accent. Status lives in five fixed triples
// (dot / tint / ink) so a pill's colour always means the same thing — green is
// done, blue is working, amber wants attention, red failed, grey is idle — and
// a screen cannot invent a sixth meaning.
export const S = {
  // surfaces
  bg: "#F5F8F8",       // app background
  card: "#FFFFFF",     // card surface
  tile: "#F7FAF9",     // inset tile inside a card (metrics, stats)
  sunken: "#EAEFEF",   // segmented-control track
  line: "#E6ECEC",     // card border
  hair: "#F2F6F5",     // divider inside a card
  dash: "#D6E0DF",     // dashed empty-state border

  // text
  ink: "#12211F",      // primary
  sub: "#5D6B6A",      // secondary — body copy
  mute: "#6B7877",     // tertiary — labels, captions
  faint: "#8B9897",    // quaternary — timestamps, version strings
  ghost: "#A3AEAE",    // chevrons, transcript timings

  // accent
  teal: "#0E7B85",
  tealDeep: "#0A666F", // pressed / hover
  tealTint: "#DCEAEA", // avatar + soft accent fills

  // the five status triples
  okDot: "#1D8A4F",  okBg: "#E7F4EC",  okInk: "#14663A",
  goDot: "#1E6FD9",  goBg: "#E8F0FC",  goInk: "#1A5CB3",
  warnDot: "#D07800", warnBg: "#FDF3E6", warnInk: "#7A4300", warnLine: "#F0D8B2", warnSolid: "#B35C00",
  badDot: "#C0392B", badBg: "#FDECEA", badInk: "#9A2418", badLine: "#F0D5D1",
  idleDot: "#8B9897", idleBg: "#EEF1F1", idleInk: "#4D5A59",
};

/** Corner radii, one scale. Cards are the roundest thing on screen. */
export const R = { card: 22, panel: 20, tile: 15, button: 14, chip: 13, pill: 999 };

/** Minimum tap targets. Nothing interactive goes below `tap`. */
export const TAP = { tap: 44, button: 50, primary: 56 };

/** Manrope, with a real fallback stack: the app must stay legible for the frame
 *  or two before the font file is ready, and if it never loads. */
export const FONT = {
  regular: "Manrope_400Regular",
  medium: "Manrope_500Medium",
  semi: "Manrope_600SemiBold",
  bold: "Manrope_700Bold",
  extra: "Manrope_800ExtraBold",
};

// ---------------------------------------------------------------------------
// The palette a SHARED screen should use.
//
// `LoginScreen` and `SettingsScreen` are rendered by BOTH apps. Restyling them
// for the SATE redesign would have dragged SATE Companion into a light theme
// nobody asked to change; leaving them dark would have put a black screen inside
// a white app. So they read this instead: the same key names either way, the
// right look in each app.
//
// 🛑 Keys here are the DARK palette's names, because that is what those screens
// already use — the point is that they keep compiling untouched apart from the
// import. Do not add a key that only one side can honour.
export const APP = IS_SATE_APP
  ? {
      bg: S.bg,
      hero: S.card,
      panel: S.card,
      tile: S.tile,
      line: S.line,
      ink: S.ink,
      sub: S.sub,
      faint: S.mute,
      sky: S.teal,
      skyBg: S.tealTint,
      green: S.okDot,
      greenBg: S.okBg,
      red: S.badInk,
      redBg: S.badBg,
      amber: S.warnInk,
      amberBg: S.warnBg,
      chip: S.sunken,
    }
  : D;
