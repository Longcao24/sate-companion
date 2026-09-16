// Remembered L816 recorders. Same shape and same reasoning as PendantStore: the
// L816 is plain BLE with no binding and no lock concern, so a simple AsyncStorage
// list is enough. It lets Home show a paired L816 as a device row on every
// launch — the user reconnects with a tap instead of re-scanning, and an account
// that owns only an L816 never sees the "set up a recorder" empty state.
//
// Deliberately NOT a hardcoded address: the reference prototype fell back to one
// known MAC, which is fine for one bench unit and wrong for anyone else's.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "l816.known";

export interface KnownL816 {
  id: string; // BLE peripheral id (the MAC on Android)
  name: string;
}

export async function loadKnownL816s(): Promise<KnownL816[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as KnownL816[]) : [];
  } catch {
    return [];
  }
}

export async function rememberL816(id: string, name: string): Promise<KnownL816[]> {
  const list = [{ id, name }, ...(await loadKnownL816s()).filter((d) => d.id !== id)];
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
