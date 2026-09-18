// Remembered L816 recorders. Same shape and same reasoning as PendantStore: the
// L816 is plain BLE with no binding and no lock concern, so a simple AsyncStorage
// list is enough. It lets Home show a paired L816 as a device row on every
// launch — the user reconnects with a tap instead of re-scanning, and an account
// that owns only an L816 never sees the "set up a recorder" empty state.
//
// Deliberately NOT a hardcoded address: the reference prototype fell back to one
// known MAC, which is fine for one bench unit and wrong for anyone else's.

import AsyncStorage from "@react-native-async-storage/async-storage";
// One-way: L816Link knows nothing about this file, so there is no cycle.
import { l816ModelOf, l816Serial } from "./L816Link";

const KEY = "l816.known";

export interface KnownL816 {
  id: string; // BLE peripheral id (the MAC on Android)
  name: string;
  /** Which model this unit is. OPTIONAL because pairings remembered by a build
   *  before L815 support have none — and `l816Serial` treats a missing model as
   *  the family default, which is what those units already are. Never guess it
   *  from anything but the device itself: the serial is permanent. */
  model?: string;
}

export async function loadKnownL816s(): Promise<KnownL816[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as KnownL816[]) : [];
  } catch {
    return [];
  }
}

export async function rememberL816(
  id: string,
  name: string,
  model?: string
): Promise<KnownL816[]> {
  const all = await loadKnownL816s();
  const prev = all.find((d) => d.id === id);
  // 🛑 Heal a pairing whose `id` is a SERIAL rather than a BLE peripheral id.
  //
  // One was found in the wild: `l816-8470D00F660E` where `84:70:D0:0F:66:0E`
  // belongs. `connect()` can never succeed on it, so the entry is a row the user
  // can tap for ever with nothing happening — and pairing the same unit properly
  // just ADDS a second row beside it, which is what "the same device is paired
  // twice" actually was. `l816Serial(id, model)` recomputes exactly that string,
  // so the stale row can be recognised and dropped the moment the real one
  // arrives. The takes it uploaded are unaffected: they are keyed by the serial,
  // which is what this string is.
  const staleSerialKey = l816Serial(id, l816ModelOf(model ?? prev?.model));
  // Never let a re-pair DOWNGRADE a known model to undefined: the unit would
  // silently start uploading under the family-default serial instead of its own.
  const list = [
    { id, name, model: model ?? prev?.model },
    ...all.filter((d) => d.id !== id && d.id !== staleSerialKey),
  ];
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
  return list;
}

// ---------------------------------------------------------------- uploaded

// Which takes have already been sent to SATE, per device, keyed by the DEVICE'S
// OWN FILE NAME (`NN_yyyyMMddHHmmss`).
//
// Why the file name and not the server's `session_number`: `takeTimestamp()`
// CLAMPS an absurd clock back to "now" — and this hardware really does produce
// them (`01_20821119193921`, year 2082). A clamped session_number is whatever the
// clock said at upload time and cannot be recomputed from the name afterwards, so
// asking the server "have I uploaded this one?" would answer no forever and
// re-upload that take on every single connect. The device's own file name is the
// only identity that is stable.
//
// This is a local cache, not the source of truth: losing it costs a duplicate
// upload, which `storeSessionRecord` then dedups server-side for every take whose
// clock was sane. Losing a RECORDING is the failure that matters, and this
// mechanism can only ever cause the harmless one.

const UP_KEY = "l816.uploaded";

type UploadedMap = Record<string, string[]>;

async function loadMap(): Promise<UploadedMap> {
  try {
    const raw = await AsyncStorage.getItem(UP_KEY);
    return raw ? (JSON.parse(raw) as UploadedMap) : {};
  } catch {
    return {};
  }
}

/** File names already uploaded to SATE from this device. */
export async function loadUploaded(deviceId: string): Promise<Set<string>> {
  return new Set((await loadMap())[deviceId] ?? []);
}

export async function markUploaded(deviceId: string, name: string): Promise<void> {
  try {
    const map = await loadMap();
    const list = map[deviceId] ?? [];
    if (!list.includes(name)) {
      // Bounded: a device holds ~4000 hours of audio, but a name is 17 bytes and
      // the list only grows with real takes. Cap it anyway so a pathological
      // device cannot grow this without limit.
      map[deviceId] = [...list, name].slice(-500);
      await AsyncStorage.setItem(UP_KEY, JSON.stringify(map));
    }
  } catch {
    /* best effort — a lost mark costs a duplicate upload, never a lost take */
  }
}

export async function forgetL816(id: string): Promise<KnownL816[]> {
  const list = (await loadKnownL816s()).filter((d) => d.id !== id);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
  return list;
}

// ---------------------------------------------------------------- unusable

// Takes this device offers that CANNOT be downloaded, per device, keyed by the
// same file name as `uploaded`.
//
// 🛑 This is NOT "uploaded" and must never be merged with it. A take recorded
// here is still on the recorder and is NOT in SATE — writing it into the
// uploaded map would tell the user their recording is safe when it is not, which
// is the one lie this whole subsystem exists to avoid.
//
// What lands here: a take the device ACKs with a size that cannot be audio —
// `0` bytes, or a size that is not whole 82-byte ASC frames. The device really
// does produce them (a record button pressed and released instantly). Before
// this existed, one such file failed the download, `sweepOnce` stopped at the
// first failure, and the four perfectly good takes behind it were never sent —
// on every connect, forever, with an error banner each time.
//
// Remembering it is what stops that retry loop. It is only ever a local note: if
// the device later reports a real size for the same name (it was still flushing),
// nothing here prevents the upload — the sweep clears the note first.

const BAD_KEY = "l816.unusable";

async function loadBadMap(): Promise<UploadedMap> {
  try {
    const raw = await AsyncStorage.getItem(BAD_KEY);
    return raw ? (JSON.parse(raw) as UploadedMap) : {};
  } catch {
    return {};
  }
}

/** File names this device could not hand over. Still ON the device. */
export async function loadUnusable(deviceId: string): Promise<Set<string>> {
  return new Set((await loadBadMap())[deviceId] ?? []);
}

export async function markUnusable(deviceId: string, name: string): Promise<void> {
  try {
    const map = await loadBadMap();
    const list = map[deviceId] ?? [];
    if (!list.includes(name)) {
      map[deviceId] = [...list, name].slice(-500);
      await AsyncStorage.setItem(BAD_KEY, JSON.stringify(map));
    }
  } catch {
    /* best effort — a lost mark costs one retry, never a lost take */
  }
}

/** Forget the note, so the take is attempted again (the manual Upload button). */
export async function clearUnusable(deviceId: string, name: string): Promise<void> {
  try {
    const map = await loadBadMap();
    const list = map[deviceId] ?? [];
    if (list.includes(name)) {
      map[deviceId] = list.filter((n) => n !== name);
      await AsyncStorage.setItem(BAD_KEY, JSON.stringify(map));
    }
  } catch {
    /* best effort */
  }
}
