// Automatic BLE bridge sync.
// While the app is open (and autoSync is on), this engine quietly scans for
// SATE Recorders advertising "needs sync" (i.e. they have pending sessions
// and no Wi-Fi), connects, pulls each session, uploads it to the server
// over the phone's connection, and tells the device to mark it synced.
//
// iOS/Android note: v0.1 auto-sync runs while the app is foregrounded.
// True background BLE sync is a v0.2 item (needs background modes + care).

import { useEffect, useRef, useState } from "react";
import { SateApi } from "../api/sateApi";
import { FoundDevice, SateLink } from "../ble/SateBle";

export interface SyncActivity {
  phase: "idle" | "scanning" | "connecting" | "pulling" | "uploading" | "done" | "error";
  deviceName?: string;
  sessionLabel?: string; // e.g. "session 3 of PT-1001"
  progress?: number; // 0..1 for the current file
  doneCount?: number;
  msg?: string;
}

export function useAutoSync(
  enabled: boolean,
  link: SateLink,
  api: SateApi,
  signedIn: boolean
) {
  const [activity, setActivity] = useState<SyncActivity>({ phase: "idle" });
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled || !signedIn) {
      setActivity({ phase: "idle" });
      return;
    }

    let cancelled = false;
    setActivity({ phase: "scanning" });

    const onFound = async (d: FoundDevice) => {
      if (cancelled || busy.current || !d.needsSync || d.pending === 0) return;
      busy.current = true;
      link.stopScan();

      try {
        setActivity({ phase: "connecting", deviceName: d.name });
        await link.connect(d.id);

        const sessions = await link.listSessions();
        let done = 0;

        for (const s of sessions) {
          if (cancelled) break;
          const label = `session ${s.n} - ${s.patient_id}`;

          setActivity({
            phase: "pulling",
            deviceName: d.name,
            sessionLabel: label,
            progress: 0,
            doneCount: done,
          });
          const file = await link.pullSession(s.n, (rx, total) =>
            setActivity((a) => ({
              ...a,
              phase: "pulling",
              progress: total ? rx / total : 0,
            }))
          );

          setActivity({
            phase: "uploading",
            deviceName: d.name,
            sessionLabel: label,
            doneCount: done,
          });
          await api.uploadSession({
            device_serial: d.name,
            patient_id: file.meta.patient_id,
            session_number: file.meta.session_number ?? s.n,
            sample_rate: file.meta.sample_rate ?? 16000,
            wav_base64: file.wavBase64,
          });

          await link.markSynced(s.n); // only after the server confirmed
          done++;
        }

        setActivity({ phase: "done", deviceName: d.name, doneCount: done });
      } catch (e: any) {
        setActivity({ phase: "error", msg: e?.message ?? "Sync failed" });
      } finally {
        await link.disconnect().catch(() => {});
        busy.current = false;
        if (!cancelled) {
          // brief pause so the banner is readable, then resume scanning
          setTimeout(() => {
            if (cancelled) return;
            setActivity({ phase: "scanning" });
            link.startScan(onFound);
          }, 3500);
        }
      }
    };

    link.requestPermissions().then((ok) => {
      if (cancelled) return;
      if (!ok) {
        setActivity({ phase: "error", msg: "Bluetooth permission needed" });
        return;
      }
      try {
        link.startScan(onFound);
      } catch (e: any) {
        setActivity({ phase: "error", msg: e?.message ?? "Bluetooth unavailable" });
      }
    });

    return () => {
      cancelled = true;
      link.stopScan();
      link.disconnect().catch(() => {});
    };
  }, [enabled, signedIn, link, api]);

  return activity;
}
