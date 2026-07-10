import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Card, GlassBackground, Muted, Title } from "../components/ui";
import { PlaudLink } from "../plaud/PlaudLink";
import { D } from "../theme";

// Plaud device settings. Today it holds one thing — the UNBIND button — and
// that button is deliberately huge: unbinding is the recovery / hand-off path
// and users must be able to find it instantly.
//
// Correct unbind sequence (ACK-before-forget, see doc/08-plaud.md §safety):
//   1. Device must be CONNECTED (native layer refuses otherwise — a depair the
//      device never hears desyncs the binding and can freeze it).
//   2. User confirms via a destructive two-step dialog.
//   3. resetBinding(sn): sends depair → waits for the device's ACK → only then
//      clears the Keychain record. Any failure keeps the record for retry.
//   4. Disconnect. Device is now free for another account / the Plaud app.
export function PlaudSettingsScreen({
  plaud,
  sn,
  deviceName,
  onClose,
  onUnbound,
}: {
  plaud: PlaudLink;
  sn: string;
  deviceName: string;
  onClose: () => void;
  onUnbound: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const doUnbind = async () => {
    setBusy(true);
    setError(null);
    try {
      // Waits for the device's ACK; throws (record kept) on disconnect/timeout.
      await plaud.resetBinding(sn);
      await plaud.disconnect().catch(() => {});
      setDone(true);
    } catch (e: any) {
      setError(
        (e?.message ?? "Unbind failed") +
          "\n\nThe binding was NOT removed. Keep the device nearby and connected, then try again."
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmUnbind = () => {
    Alert.alert(
      "Unbind this Plaud?",
      `${deviceName} (SN ${sn}) will be released from your SATE account. ` +
        `Recordings already synced are safe on SATE. The device can then be ` +
        `paired to another account or the Plaud app.\n\nKeep the device next ` +
        `to your phone until unbinding finishes.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Unbind device", style: "destructive", onPress: doUnbind },
      ]
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <GlassBackground />
      <ScrollView contentContainerStyle={s.container}>
        <View style={s.header}>
          <Title>Plaud settings</Title>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={s.close}>Close</Text>
          </Pressable>
        </View>

        <Card>
          <Text style={s.devName}>{deviceName}</Text>
          <Text style={s.dim}>SN {sn}</Text>
        </Card>

        {done ? (
          <Card>
            <Text style={s.okTitle}>Device unbound ✓</Text>
            <Muted>
              The device confirmed the unbind and is now free to pair anywhere.
            </Muted>
            <Pressable onPress={onUnbound} style={s.doneBtn} accessibilityRole="button">
              <Text style={s.doneBtnTxt}>Back to home</Text>
            </Pressable>
          </Card>
        ) : (
          <>
            <Card>
              <Text style={s.dangerTitle}>Unbind device</Text>
              <Muted>
                Releases this Plaud from your account so it can be used with
                another account or the Plaud app. Requires the device connected
                and nearby — SATE waits for the device to confirm before
                forgetting it, so the device is never left half-unbound.
              </Muted>
            </Card>

            {/* THE button. Big on purpose — this is the recovery path. */}
            <Pressable
              onPress={confirmUnbind}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              style={({ pressed }) => [
                s.unbindBtn,
                { opacity: busy ? 0.5 : pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={s.unbindTxt}>
                {busy ? "Unbinding — keep device close…" : "UNBIND THIS PLAUD"}
              </Text>
            </Pressable>

            {error && (
              <Card>
                <Text style={s.errTitle}>Unbind failed</Text>
                <Muted>{error}</Muted>
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { padding: 20, paddingTop: 64, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  close: { color: D.sub, fontSize: 15 },
  devName: { color: D.ink, fontSize: 17, fontWeight: "600" },
  dim: { color: D.sub, fontSize: 13, marginTop: 2 },
  dangerTitle: { color: D.red, fontSize: 16, fontWeight: "700", marginBottom: 6 },
  okTitle: { color: D.green, fontSize: 16, fontWeight: "700", marginBottom: 6 },
  errTitle: { color: D.red, fontSize: 15, fontWeight: "600", marginBottom: 4 },
  unbindBtn: {
    backgroundColor: D.red,
    borderRadius: 18,
    paddingVertical: 24,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 76,
  },
  unbindTxt: { color: "#FFFFFF", fontSize: 19, fontWeight: "800", letterSpacing: 0.5 },
  doneBtn: {
    marginTop: 14,
    backgroundColor: D.sky,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  doneBtnTxt: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
