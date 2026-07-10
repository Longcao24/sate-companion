// Remembered SATE Pendants. Unlike Plaud (whose binding MUST live in the iOS
// Keychain for device-lock safety) the pendant is plain BLE with no binding or
// lock concern, so a simple AsyncStorage list is enough. This lets Home show a
// paired pendant as a device row on every launch — the user reconnects with a
// tap instead of re-pairing, and never sees the "set up a recorder" empty state
// just because they own a pendant rather than a SATE recorder.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "pendant.known";

export interface KnownPendant {
  id: string; // BLE peripheral id (per-phone; fine for reconnect)
  name: string;
}

export async function loadKnownPendants(): Promise<KnownPendant[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as KnownPendant[]) : [];
  } catch {
    return [];
  }
}

export async function rememberPendant(id: string, name: string): Promise<KnownPendant[]> {
  const list = [{ id, name }, ...(await loadKnownPendants()).filter((d) => d.id !== id)];
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
  return list;
}

export async function forgetPendant(id: string): Promise<KnownPendant[]> {
  const list = (await loadKnownPendants()).filter((d) => d.id !== id);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
  return list;
}
