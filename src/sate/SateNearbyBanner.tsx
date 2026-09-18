import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { L816DeviceCard } from "../components/L816DeviceCard";
import { l816DisplayName } from "../l816/L816Link";
import { L816Session } from "../l816/useL816Session";
import { FONT, R, S } from "../theme";

// "There is a recorder in the room."
//
// The app already knew this — the session scans for one — but the only way to
// act on it was to guess it was there, open the devices page and go looking
// behind Add a device. A user holding a recorder that the phone can already hear
// should not have to go and find it.
//
// Three rules keep it from becoming noise, and each is the difference between a
// helpful offer and a banner people learn to ignore:
//
//   * It appears ONLY when there is something to do — a recorder in range and no
//     live connection. A paired recorder that is connected shows nothing here,
//     because the answer to "is it working?" is already on the device row.
//   * It says which action it is. Pairing a new recorder and picking a
//     connection back up after walking out of range are different things to the
//     person reading it, even though they are one call underneath.
//   * It never appears mid-transfer. The session state covers that, and a
//     "Connect" button during an upload is an invitation to break the upload.

export function SateNearbyBanner({ session }: { session: L816Session }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const d = session.nearby[0];

  if (!d || session.connectedId || session.state === "connecting" || session.state === "busy") {
    return null;
  }

  const more = session.nearby.length - 1;

  return (
    <Pressable
      onPress={() => {
        setBusy(true);
        setFailed(null);
        session
          .connect(d.id, d.model)
          // 🛑 NEVER swallow this. It used to be `.catch(() => {})`, so a connect
          // that failed — the recorder held by its own app, out of range by the
          // time the tap landed, a handshake that timed out — left the banner
          // exactly as it was. The button looked broken rather than the attempt
          // looking failed, which is the difference between "try again" and
          // "this app does not work".
          .catch((e) => setFailed(e?.message ?? "Could not connect"))
          .finally(() => setBusy(false));
      }}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`Connect to ${session.connectedName} nearby`}
      style={({ pressed }) => [s.wrap, { opacity: pressed || busy ? 0.7 : 1 }]}
    >
      <View style={s.glyph}>
        <L816DeviceCard width={22} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.title}>{l816DisplayName(d.model)} is nearby</Text>
        <Text style={[s.sub, failed && s.subFail]} numberOfLines={2}>
          {failed
            ? `${failed} — tap to try again`
            : more > 0
              ? `${more + 1} in range · tap to connect to the closest`
              : "Tap to connect — recordings upload themselves once it is"}
        </Text>
      </View>
      {busy ? <ActivityIndicator color={S.teal} /> : <Text style={s.cta}>Connect</Text>}
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: S.tealTint,
    borderRadius: R.panel,
    borderWidth: 1,
    borderColor: S.teal,
    padding: 12,
    marginBottom: 14,
  },
  glyph: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: S.card,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  title: { color: S.ink, fontSize: 15, fontFamily: FONT.extra },
  sub: { color: S.sub, fontSize: 12, marginTop: 3, fontFamily: FONT.regular },
  subFail: { color: S.warnInk },
  // A generous box: Android's Bold text setting clips a label sized to its own
  // measured width (see the pairing screen's `close` style).
  cta: { color: S.teal, fontSize: 15, fontFamily: FONT.extra, minWidth: 86, textAlign: "right" },
});
