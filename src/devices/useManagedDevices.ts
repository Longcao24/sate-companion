// Unified device registry (mobile). The account's devices come from three very
// different places — SATE recorders from the server, Plaud from the iOS Keychain,
// pendants from AsyncStorage — and the UI shouldn't care. This hook merges all
// three into ONE `ManagedDevice[]` (each tagged with `kind`), the mobile mirror
// of the web app's `deriveExternalDevices` (DeviceProvider.tsx). Screens read one
// list and branch on `kind`; adding a device family is a change in one place.

import { useCallback, useEffect, useRef, useState } from "react";
import { SateApi } from "../api/sateApi";
import { PlaudLink } from "../plaud/PlaudLink";
import { KnownPendant } from "../pendant/PendantStore";
import { ManagedDevice } from "../protocol";

// Synthesize a passive device row from a locally-remembered external device
// (Plaud / pendant). We don't have server telemetry for these, so online/pending
// default to "unknown-ish" — the row is a launcher into that device's screen.
function synth(
  kind: "plaud" | "pendant",
  serial: string,
  name: string
): ManagedDevice {
  return {
    id: `${kind}:${serial}`,
    name,
    serial,
    fw: kind === "plaud" ? "Plaud" : "Pendant",
    online: false,
    last_seen: "",
    pending_sessions: 0,
    kind,
  };
}

export interface DeviceRegistry {
  devices: ManagedDevice[];
  loaded: boolean;
  fetchFailed: boolean; // last server fetch failed (auth/network)
  refresh: () => Promise<void>;
}

export function useManagedDevices(
  api: SateApi,
  plaud: PlaudLink,
  knownPendants: KnownPendant[]
): DeviceRegistry {
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const mounted = useRef(true);

  // The locally-known external devices don't depend on the network, so they're
  // always present even when the server can't be reached.
  const externals = useCallback((): ManagedDevice[] => {
    const plaudRows = plaud
      .knownDevices()
      .map((p) => synth("plaud", p.sn, p.name));
    const pendantRows = knownPendants.map((p) =>
      synth("pendant", p.id, p.name)
    );
    return [...plaudRows, ...pendantRows];
  }, [plaud, knownPendants]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listDevices();
      if (!mounted.current) return;
      const sate = list.map((d) => ({ ...d, kind: d.kind ?? ("sate" as const) }));
      setDevices([...sate, ...externals()]);
      setLoaded(true);
      setFetchFailed(false);
    } catch {
      if (!mounted.current) return;
      // Server unreachable: still surface the locally-known Plaud/pendants so a
      // user who owns only those never sees an empty/error wall.
      setDevices(externals());
      setLoaded(true);
      setFetchFailed(true);
    }
  }, [api, externals]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  return { devices, loaded, fetchFailed, refresh };
}
