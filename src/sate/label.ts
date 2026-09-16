import { Recording } from "../protocol";

// What a recording is CALLED, in ONE place.
//
// The web app learned this the hard way: the same take was `device_SATE-443EAC_s13.wav`
// in the report header, `R-S13` in the sidebar and `Session 13` on the devices page,
// and with four names for one thing you cannot tell whether two screens are showing
// you the same recording. This app had already started down that road — the reports
// list formatted the name and the dashboard printed the raw file name beside it.
//
// `recordings.recording_name` is auto-filled with the FILE name, so it is not evidence
// a human named the take. This works on the string alone: nobody types
// `device_SATE-443EAC_s13.wav`, so matching the pattern IS the proof it was generated.
// Anything that does not match is a person's name and is returned untouched.

const DEVICE_FILE = /^device_(SATE|pendant|plaud|l816)[^_]*_s(\d+)/i;
const PREFIX: Record<string, string> = { sate: "R", pendant: "P", plaud: "PL", l816: "L" };

export function recordingLabel(r: Recording): string {
  const raw = (r.recording_name || "").trim();
  const m = raw.match(DEVICE_FILE);
  if (!m) return raw || "Untitled recording";
  const p = PREFIX[m[1].toLowerCase()] ?? "R";
  const n = Number(m[2]);
  // The recorder numbers takes 1..99; the pendant, Plaud and the L816 put a UNIX
  // TIMESTAMP there, and thirteen digits is not a name.
  return n >= 1_000_000_000
    ? `${p}-${new Date(n * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : `${p}-S${n}`;
}
