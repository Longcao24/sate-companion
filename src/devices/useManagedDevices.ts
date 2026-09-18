// Unified device registry (mobile). The account's devices come from four very
// different places — SATE recorders from the server, Plaud from the iOS Keychain,
// pendants and L816s from AsyncStorage — and the UI shouldn't care. This hook
// merges them into ONE `ManagedDevice[]` (each tagged with `kind`), the mobile mirror
// of the web app's `deriveExternalDevices` (DeviceProvider.tsx). Screens read one
// list and branch on `kind`; adding a device family is a change in one place.

import { useCallback, useEffect, useRef, useState } from "react";
import { SateApi } from "../api/sateApi";
import { PlaudLink } from "../plaud/PlaudLink";
import { KnownPendant } from "../pendant/PendantStore";
import { KnownL816 } from "../l816/L816Store";
import { L816_DISPLAY_NAME, l816DisplayName } from "../l816/L816Link";
import { ManagedDevice } from "../protocol";

// Synthesize a passive device row from a locally-remembered external device
// (Plaud / pendant / L816). We don't have server telemetry for these, so
// online/pending default to "unknown-ish" — the row is a launcher into that
// device's screen.
const FAMILY_LABEL: Record<"plaud" | "pendant" | "l816", string> = {
  plaud: "Plaud",
  pendant: "Pendant",
  l816: L816_DISPLAY_NAME,
};

function synth(
  kind: "plaud" | "pendant" | "l816",
  serial: string,
  name: string,
  /** Overrides the family label — an L815 and an L816 are one family with one
   *  `kind`, and only this string tells them apart on screen. */
  label?: string
): ManagedDevice {
  return {
    id: `${kind}:${serial}`,
    name,
    serial,
    fw: label ?? FAMILY_LABEL[kind],
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
  knownPendants: KnownPendant[],
  knownL816s: KnownL816[],
  /** Only poll while signed in — otherwise every tick 401s on the login screen. */
  enabled: boolean
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
    const l816Rows = knownL816s.map((d) =>
      synth("l816", d.id, d.name, l816DisplayName(d.model))
    );
    const rows = [...plaudRows, ...pendantRows, ...l816Rows];
    // 🛑 One row per device id. The paired stores already dedup on write, so a
    // repeat here means something upstream is wrong — and two identical-looking
    // rows is exactly the report "the same device can be paired twice". Render
    // it once rather than showing the user a duplicate they cannot act on.
    const seen = new Set<string>();
    return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }, [plaud, knownPendants, knownL816s]);

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
      // Server unreachable: still surface the locally-known Plaud/pendant/L816 so
      // a user who owns only those never sees an empty/error wall.
      setDevices(externals());
      setLoaded(true);
      setFetchFailed(true);
    }
  }, [api, externals]);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [refresh, enabled]);

  return { devices, loaded, fetchFailed, refresh };
}
