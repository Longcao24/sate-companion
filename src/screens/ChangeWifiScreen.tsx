// ChangeWifiScreen — move an already-claimed recorder to a new Wi-Fi network,
// WITHOUT re-setup (keeps the account). Same scan → choose → password wizard as
// onboarding (WifiSteps); the only difference is how we reach the device (arm it
// into BLE pairing mode if it's online) and the submit op (change_wifi).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SateApi } from "../api/sateApi";
import { FoundDevice, ProvisionProgress, SateLink } from "../ble/SateBle";
import { Button, Card, GlassBackground, Muted, Title } from "../components/ui";
import { WifiSteps } from "../components/WifiSteps";
import { ManagedDevice } from "../protocol";
import { D } from "../theme";

type Phase = "connecting" | "wifi" | "error";

export function ChangeWifiScreen({
  api,
  link,
  device,
  onClose,
}: {
  api: SateApi;
  link: SateLink;
  device: ManagedDevice;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [note, setNote] = useState("Reaching the recorder…");
  const [error, setError] = useState<string | null>(null);
  // Track whether we're BLE-connected and whether the change actually succeeded,
  // so backing out can tell the board to leave pairing mode (cancel_wifi) right
  // away instead of waiting for its timeout.
  const connected = useRef(false);
  const succeeded = useRef(false);

  // Find this recorder over BLE by serial; keeps scanning the whole window.
  const findNearby = (timeoutMs: number) =>
    new Promise<FoundDevice>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.stopScan();
        reject(new Error("Couldn’t find the recorder over Bluetooth. Keep it powered on and close to the phone."));
      }, timeoutMs);
      link.startScan((d) => {
        if (d.name === device.serial) {
          clearTimeout(timer);
          link.stopScan();
          resolve(d);
        }
      });
    });

  // Arm (if online) + connect over BLE. Online recorders aren't advertising, so
  // we ask the server to drop it into pairing mode, then scan until it appears.
  const arm = useCallback(async () => {
    setPhase("connecting");
    setError(null);
    try {
      const ok = await link.requestPermissions();
      if (!ok) throw new Error("Bluetooth permission is needed.");
      let online = false;
      if (device.online) {
        setNote("Putting the recorder in Wi-Fi setup mode… (about 15 sec)");
        await api.sendCommand(device.id, "wifi_change").catch(() => {});
        online = true;
      }
      setNote("Looking for the recorder over Bluetooth…");
      const found = await findNearby(online ? 30000 : 14000);
      setNote("Connecting…");
      await link.connect(found.id);
      connected.current = true;
      setPhase("wifi");
    } catch (e: any) {
      setError(e?.message ?? "Couldn’t reach the recorder");
      setPhase("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, link, device.id, device.online, device.serial]);

  useEffect(() => {
    arm();
    return () => {
      link.stopScan();
      // Unmounted (Android back / swipe) mid-flow: tell the board to leave
      // pairing mode before we drop the link, so it returns to its main page now.
      if (connected.current && !succeeded.current) {
        link.sendCommand("cancel_wifi").catch(() => {});
      }
      link.disconnect().catch(() => {});
    };
  }, [arm, link]);

  const changeSubmit = async (
    ssid: string,
    pass: string,
    onProgress: (p: ProvisionProgress) => void
  ) => {
    const final = await link.changeWifi({ ssid, pass }, onProgress);
    if (final.state === "wifi_saved") succeeded.current = true;
    return final;
  };

  // Header "Close": if we connected but didn't change anything, signal the board
  // to cancel pairing mode immediately (no 3-min wait), then leave.
  const close = async () => {
    if (connected.current && !succeeded.current) {
      try {
        await link.sendCommand("cancel_wifi");
      } catch {
        /* board may have already dropped — its own disconnect handler cancels too */
      }
    }
    await link.disconnect().catch(() => {});
    onClose();
  };

  return (
    <KeyboardAvoidingView
      style={s.wrap}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <GlassBackground />
      <View style={s.header}>
        <Title>Change Wi-Fi</Title>
        <Pressable onPress={close} hitSlop={10}>
          <Text style={s.close}>Close</Text>
        </Pressable>
      </View>

      <Muted style={{ marginBottom: 12 }}>
        {device.name} ({device.serial}) stays linked to your account — no need to
        set it up again. Keep it nearby.
      </Muted>

      {phase === "connecting" && (
        <Card>
          <View style={s.center}>
            <Text style={s.note}>{note}</Text>
            <Muted style={{ marginTop: 6, textAlign: "center" }}>
              Keep the recorder powered on and close to your phone.
            </Muted>
          </View>
        </Card>
      )}

      {phase === "error" && (
        <Card>
          <Text style={s.errTitle}>Couldn’t reach the recorder</Text>
          <Muted style={{ marginTop: 6 }}>{error}</Muted>
          <View style={{ marginTop: 16 }}>
            <Button title="Try again" onPress={arm} />
          </View>
        </Card>
      )}

      {phase === "wifi" && (
        <WifiSteps
          link={link}
          onSubmit={changeSubmit}
          successState="wifi_saved"
          submitLabel="Update Wi-Fi"
          doneTitle="Wi-Fi updated"
          doneBody="The recorder joined the new network and is back online — still linked to your account."
          onDone={close}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: D.bg, padding: 16, paddingTop: 56 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  close: { color: D.sky, fontSize: 14, fontWeight: "600" },
  center: { alignItems: "center", paddingVertical: 22 },
  note: { color: D.ink, fontSize: 16, fontWeight: "700", textAlign: "center" },
  errTitle: { color: D.ink, fontSize: 18, fontWeight: "800" },
});
