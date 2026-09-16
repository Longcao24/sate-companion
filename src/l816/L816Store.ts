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

export async function forgetL816(id: string): Promise<KnownL816[]> {
  const list = (await loadKnownL816s()).filter((d) => d.id !== id);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* best effort */
  }
  return list;
}
