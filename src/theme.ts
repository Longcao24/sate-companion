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
