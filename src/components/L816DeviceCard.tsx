import { View, StyleSheet, Text } from "react-native";

// A likeness of the SATE L816: a slim black stick recorder with a small screen, a
// speaker grille and a red record key — built from plain Views, the same way
// PlaudDeviceCard and PendantDeviceCard are. Shown on the L816 screen, in the
// "Add a device" sheet and on Home so a user with three kinds of hardware can
// tell at a glance which row is which, instead of reading three identical icons.
export function L816DeviceCard({ width = 150 }: { width?: number }) {
  const bodyW = Math.round(width * 0.42);
  const height = Math.round(width * 1.1);
  const screenW = Math.round(bodyW * 0.72);

  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "center" }}>
      <View style={[s.body, { width: bodyW, height, borderRadius: Math.round(bodyW * 0.22) }]}>
        {/* speaker grille */}
        <View style={s.grille}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[s.slot, { width: screenW * 0.6 }]} />
          ))}
        </View>

        {/* Screen. Says `L816`, NOT "SATE L816": this is a likeness of the object
            in the user's hand, and the point of drawing it is that they can match
            the picture to the thing. The product name belongs in the label next to
            the card, not printed on a drawing of someone else's hardware. */}
        <View style={[s.screen, { width: screenW, height: Math.round(height * 0.2) }]}>
          <Text style={s.screenTxt}>L816</Text>
        </View>

        {/* record key */}
        <View style={[s.key, { width: Math.round(bodyW * 0.42), height: Math.round(bodyW * 0.42) }]}>
          <View style={s.dot} />
        </View>

        {/* mic port */}
        <View style={s.micPort} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  body: {
    backgroundColor: "#15171B",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#31353D",
    alignItems: "center",
    paddingVertical: 10,
    justifyContent: "space-between",
  },
  grille: { alignItems: "center", gap: 3, marginTop: 2 },
  slot: { height: 2, borderRadius: 1, backgroundColor: "#2B2F36" },
  screen: {
    backgroundColor: "#0A1622",
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#1E3348",
    alignItems: "center",
    justifyContent: "center",
  },
  screenTxt: { color: "#4FB0FF", fontSize: 8, fontWeight: "700", letterSpacing: 1 },
  key: {
    borderRadius: 999,
    backgroundColor: "#22262D",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#383D46",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#E5484D" },
  micPort: { width: 8, height: 3, borderRadius: 2, backgroundColor: "#2B2F36", marginBottom: 2 },
});
