import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SateApi } from "../api/sateApi";
import { Button, Card, GlassBackground, Muted, ProgressBar, Title } from "../components/ui";
import { Patient } from "../protocol";
import { L816FoundDevice, L816Link, L816SeenDevice } from "../l816/L816Link";
import { L816Session, fmtDur, fmtTakeName } from "../l816/useL816Session";
import { D } from "../theme";

// Connect-with-SATE-L816: find the recorder over BLE -> connect -> drive its record
// button from the phone -> pull the finished take off the device -> decode the
// ASC-VI frames to a WAV -> push it through the SAME upload path as everything
// else (api.uploadSession -> device-api -> AI -> recordings), device_serial
// `l816-<mac>`.
//
// 🛑 THIS SCREEN NO LONGER OWNS THE CONNECTION. The link, the device-event watch
// and the whole upload engine live in `useL816Session`, mounted once in App.tsx.
// They used to live here, and the screen's unmount cleanup disconnected — so the
// feature existed only while this screen was on top. Walk to Reports and the
// recorder was connected to nothing: a take started on the device was never
// noticed and nothing was uploaded, which is the one case the device exists for
// (it records with the phone in a pocket). See the header of useL816Session.ts.
//
// What is left here is what is only meaningful while the screen is open: asking
// for permissions, SCANNING, and the device picker. Everything else is rendered
// from the session.
//
// The DEVICE is a very different animal from the pendant, and the differences
// are the interesting part:
//
//   * The L816 records to its OWN storage, not to a live stream. Stopping is not
//     the end of the take — the transfer afterwards is, and it can take longer
//     than the recording did. So "Stop" and "uploaded" are separate states here.
//   * It keeps recording with the app closed or out of range, which is why
//     reconnecting can land straight in a recording state rather than idle.
//   * Everything already on the device is listed and downloadable, so a take
//     that failed to upload is never lost — it is still on the hardware.
//   * A TAKE RECORDED WHILE THE PHONE WAS AWAY MUST STILL COME BACK BY ITSELF:
//     most takes are made with nothing connected and produce no live event, so
//     the session diffs the device's file list against what has already been
//     sent and uploads the rest with no tap.

type ScanPhase = "init" | "scan" | "error";

export function L816ConnectScreen({
  api,
  l816,
  session,
  onClose,
  onConnected,
  targetId,
}: {
  api: SateApi;
  l816: L816Link;
  /** The app-level session. This screen drives it; it does not own it. */
  session: L816Session;
  onClose: () => void;
  /** Called once connected, so Home can remember it and show it as a paired
   *  device on the next launch (no re-scanning). */
  onConnected?: (id: string, name: string) => void;
  /** A known L816's BLE id — connect straight to it instead of scanning. Falls
   *  back to a scan if the direct connect fails (out of range / off). */
  targetId?: string;
}) {
  const [scanPhase, setScanPhase] = useState<ScanPhase>("init");
  const [scanError, setScanError] = useState<string | null>(null);
  const [found, setFound] = useState<Record<string, L816FoundDevice>>({});
  const [seen, setSeen] = useState<Record<string, L816SeenDevice>>({});
  const [bleState, setBleState] = useState<string>("starting…");
  const [patients, setPatients] = useState<Patient[]>([]);
  const scanning = useRef(false);

  const { state, connectedId, connectedName, recording, resumed } = session;
  const busy = state === "busy";
  const connected = !!connectedId;

  const startScan = useCallback(() => {
    if (scanning.current) return;
    setScanPhase("scan");
    scanning.current = true;
    l816.startScan(
      (d) => setFound((prev) => ({ ...prev, [d.id]: d })),
      (sd) => setSeen((prev) => ({ ...prev, [sd.id]: sd })),
      (st) => setBleState(st)
    );
  }, [l816]);

  const stopScan = useCallback(() => {
    if (!scanning.current) return;
    l816.stopScan();
    scanning.current = false;
  }, [l816]);

  // Permissions -> connect to a known unit, or scan. The session may ALREADY be
  // connected (it survives navigation now), in which case there is nothing to do
  // but render it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await l816.requestPermissions();
        api.listPatients().then((p) => !cancelled && setPatients(p)).catch(() => {});
        if (cancelled) return;
        if (session.connectedId) return;

        const target = targetId;
        if (target) {
          try {
            await session.connect(target);
            if (cancelled) return;
            return;
          } catch {
            if (cancelled) return;
            // Out of range or off — fall through to a scan.
          }
        }
        if (!cancelled) startScan();
      } catch (e: any) {
        if (!cancelled) {
          setScanError(e?.message ?? "Could not start Bluetooth");
          setScanPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      // Stop SCANNING only. Leaving this screen must NOT drop the link any more —
      // that is the whole point of the session living above it.
      stopScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, l816, targetId]);

  // Once connected there is nothing left to find.
  useEffect(() => {
    if (connected) stopScan();
  }, [connected, stopScan]);

  const onPickDevice = useCallback(
    async (d: L816FoundDevice) => {
      stopScan();
      try {
        await session.connect(d.id);
        onConnected?.(d.id, connectedName);
      } catch {
        // The session already surfaced the reason; offer the list again.
        startScan();
      }
    },
    [session, stopScan, startScan, onConnected, connectedName]
  );

  const onPickSeen = useCallback(
    (sd: L816SeenDevice) => onPickDevice({ id: sd.id, name: sd.name ?? "L816", rssi: sd.rssi }),
    [onPickDevice]
  );

  // Tell Home about a connection the SESSION made on its own (the retry loop, or
  // a reconnect at launch) — not just one picked here.
  useEffect(() => {
    if (connectedId) onConnected?.(connectedId, connectedName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedId]);

  const foundList = useMemo(() => Object.values(found), [found]);
  const seenList = useMemo(() => Object.values(seen).sort((a, b) => b.rssi - a.rssi), [seen]);
  const scanningNow = !connected && state !== "connecting" && scanPhase === "scan";

  return (
    <View style={{ flex: 1 }}>
      <GlassBackground />
      <ScrollView contentContainerStyle={s.container}>
        <View style={s.header}>
          {/* The title is long enough to push "Close" off the right edge, which
              rendered as "Clos". It shrinks; the exit does not. */}
          {/* Short on purpose. "Connect with SATE L816" ran into the Close
              button at the system font sizes people actually use, and the card
              below already names the device — the header does not need to. */}
          <View style={s.headerTitle}>
            <Title>SATE L816</Title>
          </View>
          {/* flexShrink on the PRESSABLE, not on its Text: the Pressable is the
              flex item, and with the default flexShrink:1 it squeezed its own
              label down to "Clos" at large system font sizes. */}
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            style={s.closeBtn}
          >
            <Text style={s.close}>Close</Text>
          </Pressable>
        </View>

        {!connected && state !== "connecting" && scanPhase === "init" && (
          <Muted>Preparing Bluetooth…</Muted>
        )}

        {scanningNow && (
          <Card>
            <Text style={s.sectionTitle}>Nearby SATE L816 recorders</Text>
            <Muted>
              Turn the SATE L816 on and keep it close. If its own app is connected, close
              that first — the recorder only talks to one phone at a time.
            </Muted>
            {foundList.length === 0 ? (
              <Text style={s.dim}>Scanning…</Text>
            ) : (
              foundList.map((d) => (
                <Pressable key={d.id} onPress={() => onPickDevice(d)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{d.name}</Text>
                    <Text style={s.dim}>
                      {d.id} · {d.rssi} dBm
                    </Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))
            )}
          </Card>
        )}

        {/* On-screen BLE diagnostics — the L816 does not always advertise its
            service UUID, and its name can be a stale cached one, so a manual pick
            is the difference between "not supported" and "tap the right row". */}
        {scanningNow && (
          <Card>
            <Text style={s.sectionTitle}>Bluetooth diagnostics</Text>
            <Text style={s.dim}>Radio: {bleState}</Text>
            <Muted>
              {seenList.length} device{seenList.length === 1 ? "" : "s"} seen nearby.
            </Muted>
            {seenList.length === 0 && (
              <Text style={s.dim}>
                Hearing NO Bluetooth at all — the radio is off or the Nearby devices
                permission was denied. Check Android Settings → Apps → SATE Companion →
                Permissions.
              </Text>
            )}
            {seenList.length > 0 && foundList.length === 0 && (
              <Text style={[s.dim, { marginTop: 4 }]}>
                No SATE L816 auto-detected. Tap yours below — look for a name starting
                “L816” (what the hardware advertises) or a row marked “L816 service ✓”.
              </Text>
            )}
            {seenList.length > 0 &&
              foundList.length === 0 &&
              seenList.map((sd) => (
                <Pressable key={sd.id} onPress={() => onPickSeen(sd)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>
                      {sd.name ?? "(no name)"}
                      {sd.hasL816Service ? "  · L816 service ✓" : ""}
                    </Text>
                    <Text style={s.dim}>
                      {sd.id} · {sd.rssi} dBm
                    </Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))}
          </Card>
        )}

        {state === "connecting" && (
          <Card>
            <Text style={s.sectionTitle}>Connecting…</Text>
            <Muted>Setting up the recorder and syncing its clock.</Muted>
          </Card>
        )}

        {connected && state !== "error" && (
          <>
            <Card>
              <Text style={s.sectionTitle}>{connectedName}</Text>
              <Muted>
                {recording
                  ? resumed
                    ? "This SATE L816 was already recording when we connected — it keeps " +
                      "going on its own. The timer below counts from now, not from the start."
                    : "Recording on the SATE L816. Audio is stored on the device and " +
                      "transferred when you stop."
                  : "Press record to start. The SATE L816 records on its own — the take is " +
                    "downloaded and uploaded to SATE when you stop."}
              </Muted>

              {/* The one thing a user cannot tell by looking at the phone: the
                  link is kept up after this screen closes, so a take made later
                  arrives by itself. Saying so is the difference between trusting
                  the device in a pocket and checking the app after every take. */}
              <Text style={s.keep}>
                Stays connected in the background — recordings you start on the device upload
                themselves, even from another screen.
              </Text>

              <Text style={s.dur}>{fmtDur(session.elapsedMs)}</Text>

              <Pressable
                onPress={session.toggleRecord}
                disabled={busy}
                accessibilityRole="button"
                style={({ pressed }) => [
                  s.recBtn,
                  {
                    backgroundColor: recording ? D.red : D.sky,
                    opacity: busy ? 0.5 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={s.recTxt}>
                  {recording ? "■  Stop & upload" : "●  Start recording"}
                </Text>
              </Pressable>

              {session.progress && (
                <View style={{ marginTop: 14 }}>
                  <Text style={s.progressTxt}>
                    {session.progress.message}
                    {session.progress.phase === "downloading"
                      ? ` · ${session.progress.percent}%`
                      : ""}
                  </Text>
                  {/* Only the download can be measured — one byte count against
                      another. Waiting, listing and decoding get the message and no
                      bar, rather than a bar creeping forward on a guess. */}
                  {session.progress.phase === "downloading" && (
                    <ProgressBar value={session.progress.percent / 100} />
                  )}
                </View>
              )}

              {session.status && <Text style={s.status}>{session.status}</Text>}
            </Card>

            {/* Optional — assign a patient now, or leave it and tag the recording
                later on the web report (it uploads as Standalone until then). */}
            <Card>
              <Text style={s.sectionTitle}>Assign to patient (optional)</Text>
              <Muted>Leave blank to sort it out later — it saves as Standalone.</Muted>
              <FlatList
                data={patients}
                scrollEnabled={false}
                keyExtractor={(p) => p.patient_id}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() =>
                      session.setPatientId(
                        session.patientId === item.patient_id ? null : item.patient_id
                      )
                    }
                    style={[s.patRow, session.patientId === item.patient_id && s.patRowOn]}
                  >
                    <Text style={s.rowName}>{item.patient_id}</Text>
                    <Text style={s.dim}>{item.name}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={<Text style={s.dim}>No patients yet.</Text>}
              />
            </Card>

            {/* Everything still on the device. This is the recovery path: a take
                whose upload failed is not lost, it is right here. */}
            <Card>
              <View style={s.rowBetween}>
                <Text style={s.sectionTitle}>On the device</Text>
                <Pressable onPress={session.refreshFiles} hitSlop={8} accessibilityRole="button">
                  <Text style={s.link}>Refresh</Text>
                </Pressable>
              </View>
              <Muted>
                {session.pendingCount > 0
                  ? `${session.pendingCount} recording${
                      session.pendingCount === 1 ? "" : "s"
                    } still to upload — this happens on its own while the device is connected.`
                  : "Everything here is already in SATE. Recordings made with the phone " +
                    "away upload themselves the next time it connects."}
              </Muted>
              {session.files.length === 0 ? (
                <Text style={s.dim}>No recordings on this SATE L816.</Text>
              ) : (
                session.files.map((f) => {
                  const done = session.uploaded.has(f.name);
                  return (
                    <Pressable
                      key={f.name}
                      onPress={() => session.uploadTake(f)}
                      disabled={busy || recording}
                      style={[s.row, (busy || recording) && { opacity: 0.4 }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={s.rowName}>{fmtTakeName(f.name)}</Text>
                        <Text style={s.dim}>{f.name}</Text>
                      </View>
                      {/* Already-sent takes stay listed and stay tappable: the
                          device keeps them, and re-uploading one is a legitimate
                          thing to want after a delete on the SATE side. */}
                      <Text style={[s.link, done && { color: D.green }]}>
                        {done ? "In SATE ✓" : "Upload"}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </Card>

            {/* Two different exits, and conflating them is how a user loses the
                background link by accident. "Done" leaves the screen with the
                recorder still connected; disconnecting is a deliberate act. */}
            <Button title="Done" onPress={onClose} disabled={busy} />
            <Pressable
              onPress={() => {
                session.disconnect();
                onClose();
              }}
              disabled={busy}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={[s.disconnect, busy && { opacity: 0.4 }]}>
                Disconnect this recorder
              </Text>
            </Pressable>
          </>
        )}

        {(state === "error" || scanPhase === "error") && (
          <Card>
            <Text style={[s.sectionTitle, { color: D.red }]}>Something went wrong</Text>
            <Muted>{session.error ?? scanError}</Muted>
            <Button
              title={connected ? "Back to the recorder" : "Close"}
              onPress={() => (connected ? session.clearError() : onClose())}
            />
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { padding: 20, paddingTop: 64, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  headerTitle: { flex: 1, flexShrink: 1 },
  closeBtn: { flexShrink: 0, flexGrow: 0 },
  close: { color: D.sub, fontSize: 15 },
  sectionTitle: { color: D.ink, fontSize: 16, fontWeight: "600", marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: D.line,
  },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  patRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: D.line,
    marginTop: 8,
  },
  patRowOn: { borderColor: D.sky, backgroundColor: D.skyBg },
  rowName: { color: D.ink, fontSize: 15, fontWeight: "500" },
  dim: { color: D.sub, fontSize: 13, marginTop: 2 },
  link: { color: D.sky, fontSize: 14, fontWeight: "600" },
  chev: { color: D.sub, fontSize: 22 },
  keep: { color: D.green, fontSize: 12, fontWeight: "600", marginTop: 8 },
  dur: { color: D.ink, fontSize: 34, fontWeight: "800", textAlign: "center", marginVertical: 10 },
  recBtn: {
    marginTop: 4,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  recTxt: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  progressTxt: { color: D.sub, fontSize: 13, marginBottom: 6 },
  status: { color: D.sky, fontSize: 13, fontWeight: "600", marginTop: 12 },
  disconnect: { color: D.red, fontSize: 14, fontWeight: "600", textAlign: "center", paddingVertical: 8 },
});
