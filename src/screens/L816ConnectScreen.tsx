import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SateApi } from "../api/sateApi";
import { Feather } from "@expo/vector-icons";
import { Button, Card, GlassBackground, Muted, ProgressBar, Title } from "../components/ui";
import { Patient } from "../protocol";
import {
  L816FoundDevice,
  L816Link,
  L816SeenDevice,
  l816DisplayName,
  l816ModelOf,
} from "../l816/L816Link";
import { KnownL816 } from "../l816/L816Store";
import { L816Session, fmtDur, fmtTakeName } from "../l816/useL816Session";
import { APP as D } from "../theme";
import { useBottomInset } from "../ui/insets";

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
  onUnpaired,
  targetId,
}: {
  api: SateApi;
  l816: L816Link;
  /** The app-level session. This screen drives it; it does not own it. */
  session: L816Session;
  onClose: () => void;
  /** Called once connected, so Home can remember it and show it as a paired
   *  device on the next launch (no re-scanning). The MODEL goes with it: it is
   *  only knowable while the peripheral is advertising, and the serial derived
   *  from it is permanent. */
  onConnected?: (id: string, name: string, model: string) => void;
  /** The recorder was unpaired — here is the paired list that is left. */
  onUnpaired?: (list: KnownL816[]) => void;
  /** A known L816's BLE id — connect straight to it instead of scanning. Falls
   *  back to a scan if the direct connect fails (out of range / off). */
  targetId?: string;
}) {
  // Clears the system navigation bar — this build is edge-to-edge.
  const padBottom = useBottomInset(20);
  const [scanPhase, setScanPhase] = useState<ScanPhase>("init");
  const [scanError, setScanError] = useState<string | null>(null);
  const [patients, setPatients] = useState<Patient[]>([]);
  const { nearby: foundList, seen: seenList, bleState } = session;

  const { state, connectedId, connectedName, recording, resumed } = session;
  const busy = state === "busy";
  const connected = !!connectedId;

  // This screen does NOT scan. The session is the one scanner (see its
  // discovery section) and it is already running; all this screen does is ask
  // for a continuous scan while it is open instead of the duty-cycled one, and
  // render what comes back.
  useEffect(() => session.boostDiscovery(), [session.boostDiscovery]);

  const startScan = useCallback(() => setScanPhase("scan"), []);

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
        // 🛑 "Connected to SOMETHING" is not "connected to the one you asked
        // for". This used to be a bare `if (session.connectedId) return`, and
        // with two paired recorders — which this family now has, L816 and L815 —
        // tapping the L816 opened a screen titled L815 listing the L815's files,
        // silently, with no connect even attempted. That is worse than a
        // duplicate row in the device list: the user believes they are looking
        // at one recorder and are looking at another.
        if (session.connectedId && (!targetId || session.connectedId === targetId)) return;

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
      // Nothing to tear down: the scan belongs to the session, and leaving this
      // screen must NOT drop the link — that is the whole point of the session
      // living above it.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, l816, targetId]);

  const onPickDevice = useCallback(
    async (d: L816FoundDevice) => {
      try {
        await session.connect(d.id, d.model);
        onConnected?.(d.id, l816DisplayName(d.model), d.model);
      } catch {
        // The session already surfaced the reason; offer the list again.
        startScan();
      }
    },
    [session, startScan, onConnected, connectedName]
  );

  const onPickSeen = useCallback(
    (sd: L816SeenDevice) =>
      onPickDevice({
        id: sd.id,
        name: sd.name ?? "L816",
        rssi: sd.rssi,
        // Picked by hand out of the raw list, so the only clue to the model is
        // whatever it advertises — which may be nothing, and then it is the
        // family default.
        model: l816ModelOf(sd.name),
      }),
    [onPickDevice]
  );

  // Tell Home about a connection the SESSION made on its own (the retry loop, or
  // a reconnect at launch) — not just one picked here.
  useEffect(() => {
    if (connectedId) onConnected?.(connectedId, connectedName, session.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedId]);

  // Unpairing is not undoable from here — the recorder has to be found and
  // picked again — so it asks first. It is also not destructive to any
  // RECORDING: nothing is ever deleted from an L816, and the takes SATE already
  // has stay where they are. Say both, because "unpair" on a device that holds
  // the only copy of a session reads like it might throw them away.
  const confirmUnpair = useCallback(() => {
    setMenu(false);
    Alert.alert(
      `Unpair this ${connectedName}?`,
      "SATE will forget this recorder and stop connecting to it. Nothing is " +
        "deleted — the recordings on the device stay on the device, and the ones " +
        "already uploaded stay in SATE. You can pair it again at any time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unpair",
          style: "destructive",
          onPress: () => {
            session
              .unpair()
              .then((list) => onUnpaired?.(list))
              .catch(() => {})
              .finally(onClose);
          },
        },
      ]
    );
  }, [session, onUnpaired, onClose]);

  const scanningNow = !connected && state !== "connecting" && scanPhase === "scan";

  // How long we have been looking, in seconds. Drives the two things a scan
  // needs and had neither: an honest "still looking" instead of a frozen
  // "Scanning…", and a point at which to admit it is not working.
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!scanningNow) {
      setWaited(0);
      return;
    }
    const t = setInterval(() => setWaited((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [scanningNow]);

  // PAIR THE ONE RECORDER YOU FOUND, without making the user tap it.
  //
  // The screen used to present a scan as a menu: a list of results, and a second
  // list of every Bluetooth device in the room to pick from by MAC address if
  // the first one was empty. For a user with one recorder in their hand that is
  // a menu of one, plus a wall of hex — a choice where there is no decision.
  //
  // The 1.5 s settle is the part that matters. Picking on the FIRST sighting
  // would race a second recorder that is about to advertise, and silently pair
  // whichever one happened to be heard first. So: wait a moment, and auto-pair
  // ONLY when exactly one candidate is still the only candidate. Two or more and
  // the list is a real choice, so it is shown.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!scanningNow || autoPicked.current || foundList.length === 0) return;
    const t = setTimeout(() => {
      if (autoPicked.current || foundList.length !== 1) return;
      autoPicked.current = true;
      onPickDevice(foundList[0]);
    }, 1500);
    return () => clearTimeout(t);
  }, [scanningNow, foundList, onPickDevice]);

  // The raw list of everything the radio hears is a DIAGNOSTIC, not a device
  // picker, and it was the loudest thing on the screen. It stays — the L816 does
  // not reliably advertise its service UUID and its name can be a stale cached
  // one, so a manual pick really is the difference between "not supported" and
  // "tap the right row" — but it is now behind a question a stuck user would
  // actually ask, and only after the automatic path has had time to work.
  const [showDiag, setShowDiag] = useState(false);
  const [menu, setMenu] = useState(false);
  const stuck = scanningNow && waited >= 10 && foundList.length === 0;

  return (
    <View style={{ flex: 1 }}>
      <GlassBackground />
      <ScrollView contentContainerStyle={[s.container, { paddingBottom: padBottom }]}>
        {/* Back on the LEFT, gear in the RIGHT CORNER, name on its own line —
            the same shape as the device page, so the two screens do not teach
            two different places to look. It used to be "title … gear … Close",
            where the gear floated in the middle of the header (the Close label
            carried a wide minWidth to survive Android's Bold-text clipping, and
            the surplus was empty box) and read as a control belonging to the
            title rather than to the screen. */}
        <View style={s.header}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            {/* minWidth so Bold text cannot clip the last glyph. */}
            <Text style={s.back}>‹ Back</Text>
          </Pressable>
          {/* 🛑 Disconnect and Unpair live BEHIND this, not loose at the foot of
              the page. Both end the background link — the thing that makes a
              take recorded with the phone in a pocket reach SATE at all — and
              they sat one stray tap below a "Done" the user is aiming for. */}
          {connected && (
            <Pressable
              onPress={() => setMenu(true)}
              hitSlop={12}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Recorder settings"
              style={({ pressed }) => [s.gear, (pressed || busy) && { opacity: 0.45 }]}
            >
              <Feather name="settings" size={19} color={D.sub} />
            </Pressable>
          )}
        </View>

        {/* The CONNECTED unit's name, not the family's. The header said
            "SATE L816" over a card that said "SATE L815", which is the app
            disagreeing with itself about what is in the user's hand — and
            exactly what L816_DISPLAY_NAME exists to prevent. */}
        <Title>{connected ? connectedName : "SATE L816 / L815"}</Title>

        {!connected && state !== "connecting" && scanPhase === "init" && (
          <Muted>Preparing Bluetooth…</Muted>
        )}

        {scanningNow && (
          <Card>
            <Text style={s.sectionTitle}>
              {foundList.length === 0
                ? "Looking for your recorder…"
                : foundList.length === 1
                  ? "Found it — connecting…"
                  : "Which recorder is yours?"}
            </Text>
            {/* Short, because this card is read while someone is holding a
                recorder and waiting. The one-phone-at-a-time rule only matters
                once the search is visibly failing, and it is said there instead
                — see the "Can't find your recorder?" panel. */}
            <Muted>
              {foundList.length > 1
                ? "Pick the one in your hand."
                : "Turn it on and keep it close — it pairs by itself."}
            </Muted>

            {foundList.length === 0 ? (
              <View style={s.searching}>
                <ActivityIndicator color={D.sky} />
                <Text style={s.dim}>
                  {waited < 10
                    ? "Searching…"
                    : `Still searching — ${waited}s. Check the recorder is switched on.`}
                </Text>
              </View>
            ) : (
              foundList.map((d) => (
                <Pressable key={d.id} onPress={() => onPickDevice(d)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{l816DisplayName(d.model)}</Text>
                    <Text style={s.dim}>
                      {d.name} · {d.rssi} dBm
                    </Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))
            )}
          </Card>
        )}

        {/* Only once the automatic path has visibly failed. */}
        {stuck && !showDiag && (
          <Pressable onPress={() => setShowDiag(true)} hitSlop={8} accessibilityRole="button">
            <Text style={s.diagLink}>Can't find your recorder?</Text>
          </Pressable>
        )}

        {scanningNow && showDiag && (
          <Card>
            <Text style={s.sectionTitle}>Everything this phone can hear</Text>
            <Muted>
              Yours may be here unnamed. Look for “L81” or “L816 service” and tap it. If its
              own app is connected, close that first — the recorder talks to one phone at a time.
            </Muted>
            <Text style={[s.dim, { marginTop: 6 }]}>Bluetooth radio: {bleState}</Text>
            {seenList.length === 0 ? (
              <Text style={s.dim}>
                No Bluetooth at all — the radio is off, or Nearby devices permission was denied.
              </Text>
            ) : (
              seenList.map((sd) => (
                <Pressable key={sd.id} onPress={() => onPickSeen(sd)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>
                      {sd.name ?? "(unnamed device)"}
                      {sd.hasL816Service ? "  · L816 service" : ""}
                    </Text>
                    <Text style={s.dim}>
                      {sd.id} · {sd.rssi} dBm
                    </Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))
            )}
          </Card>
        )}

        {state === "connecting" && (
          <Card>
            <Text style={s.sectionTitle}>Connecting…</Text>
            <Muted>Syncing its clock…</Muted>
          </Card>
        )}

        {/* Unpairing has to work when the recorder is NOT reachable — a unit that
            is lost, broken or given away is exactly the one you want to unpair,
            and it will never connect again to offer the button. */}
        {!connected && targetId && (
          <Pressable onPress={confirmUnpair} hitSlop={8} accessibilityRole="button">
            <Text style={s.unpair}>Unpair this recorder</Text>
          </Pressable>
        )}

        {connected && state !== "error" && (
          <>
            <Card>
              <Text style={s.sectionTitle}>{connectedName}</Text>
              {/* ONE line. This card used to carry three paragraphs above the
                  timer — how the recorder stores audio, when it transfers, that
                  the link survives the screen — on a screen whose whole job is
                  one button. Explanation nobody asked for is what makes a user
                  stop reading the sentence that does matter, and the sentence
                  that matters here is the state: is it recording, and will a
                  take reach SATE without me. */}
              <Muted>
                {recording
                  ? resumed
                    ? "Already recording — the timer counts from now."
                    : "Recording. The take transfers when you stop."
                  : "Records on its own. Takes upload to SATE by themselves, even from another screen."}
              </Muted>

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
              <Muted>Blank saves as Standalone.</Muted>
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
                  ? `${session.pendingCount} still to upload — this happens on its own.`
                  : "All uploaded to SATE."}
              </Muted>
              {session.files.length === 0 ? (
                <Text style={s.dim}>No recordings on this {connectedName}.</Text>
              ) : (
                session.files.map((f) => {
                  const done = session.uploaded.has(f.name);
                  // Empty on the device — there is no audio in it. Still tappable,
                  // because a take that was merely still flushing when we asked
                  // becomes downloadable later and tapping it clears the note.
                  const empty = !done && session.unusable.has(f.name);
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
                      <Text
                        style={[
                          s.link,
                          done && { color: D.green },
                          empty && { color: D.faint },
                        ]}
                      >
                        {done ? "In SATE ✓" : empty ? "Empty" : "Upload"}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </Card>

            {/* Two different exits, and conflating them is how a user loses the
                background link by accident. "Done" leaves the screen with the
                recorder still connected; disconnecting is a deliberate act. */}
            {/* "Done" leaves the screen with the recorder still CONNECTED —
                that is the whole point of the background link. Ending it is a
                deliberate act and lives behind the gear. */}
            <Button title="Done" onPress={onClose} disabled={busy} />
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

      <Modal
        visible={menu}
        transparent
        animationType="fade"
        onRequestClose={() => setMenu(false)}
        statusBarTranslucent
      >
        <Pressable style={s.sheetBack} onPress={() => setMenu(false)}>
          <Pressable style={[s.sheet, { marginBottom: padBottom }]} onPress={() => {}}>
            <Text style={s.sheetTitle} numberOfLines={1}>
              {connectedName}
            </Text>
            <Pressable
              onPress={() => {
                setMenu(false);
                session.disconnect();
                onClose();
              }}
              accessibilityRole="button"
              style={({ pressed }) => [s.sheetRow, pressed && { opacity: 0.6 }]}
            >
              <Feather name="bluetooth" size={16} color={D.sub} />
              <Text style={s.sheetRowTxt} numberOfLines={1}>
                Disconnect — keep it paired
              </Text>
            </Pressable>
            <Pressable
              onPress={confirmUnpair}
              accessibilityRole="button"
              style={({ pressed }) => [s.sheetRow, pressed && { opacity: 0.6 }]}
            >
              <Feather name="trash-2" size={16} color={D.red} />
              <Text style={[s.sheetRowTxt, { color: D.red }]} numberOfLines={1}>
                Unpair this {connectedName}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setMenu(false)}
              accessibilityRole="button"
              style={({ pressed }) => [s.sheetRow, pressed && { opacity: 0.6 }]}
            >
              <Text style={[s.sheetRowTxt, { color: D.sub }]} numberOfLines={1}>
                Cancel
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { padding: 20, paddingTop: 64, gap: 16 },
  // No `gap` here. With `gap` + `justifyContent: space-between` + a flex:1
  // child, Yoga hands the flex child the free space BEFORE the gap is taken out,
  // and the last item overflows the row by exactly the gap — which rendered the
  // Close button as "Clos". The title wrapper's flex:1 already keeps the two
  // apart; the sibling screens have no gap either.
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: -4,
  },
  back: { color: D.sky, fontSize: 15, fontWeight: "700", minWidth: 72 },
  gear: { width: 40, height: 44, alignItems: "flex-end", justifyContent: "center" },
  sheetBack: {
    flex: 1,
    backgroundColor: "rgba(9, 24, 23, 0.4)",
    justifyContent: "flex-end",
    padding: 16,
  },
  sheet: {
    backgroundColor: D.panel,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: D.line,
    padding: 8,
  },
  sheetTitle: { color: D.faint, fontSize: 13, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10 },
  sheetRow: {
    minHeight: 50,
    borderRadius: 15,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  // minWidth, not a hugging box: Android's Bold-text setting draws the font
  // heavier than RN measured and clips the last glyph.
  sheetRowTxt: { color: D.ink, fontSize: 15, fontWeight: "700", minWidth: 200, textAlign: "center" },
  // 🛑 `minWidth` on the TEXT, and it is load-bearing. This label rendered as
  // "Clos" and no amount of flex fixing changed it, because the box was never
  // the problem — it was measured at 188px around a word that needs ~95.
  //
  // The cause is Android's **Bold text** accessibility setting
  // (`settings get secure font_weight_adjustment` → 300 on the test phone).
  // Android draws every font that much heavier than the metrics React Native
  // measured it with, so a Text whose content box is sized to its own measured
  // width loses its last glyph. It is invisible on a phone without the setting,
  // it is NOT a font-scale problem (font_scale was 1.0), and it will bite any
  // short label that hugs its own width — the other connect screens say "Close"
  // the same way and clip the same way on such a device.
  //
  // Giving the Text a minimum width wider than the word can ever need, and
  // right-aligning inside it, is a fix that does not depend on the measurement
  // being right.
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
  searching: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 18 },
  diagLink: {
    color: D.sub,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    paddingVertical: 10,
  },
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
  disconnect: { color: D.sub, fontSize: 14, fontWeight: "600", textAlign: "center", paddingVertical: 8 },
  unpair: { color: D.red, fontSize: 14, fontWeight: "700", textAlign: "center", paddingVertical: 8 },
});
