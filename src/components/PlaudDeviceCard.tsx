import { View, Text, StyleSheet } from "react-native";
import { D } from "../theme";

// A lightweight likeness of the Plaud NotePro (dark fluted card, black top bar
// with the PLAUD wordmark + capture button) built from plain Views — the app
// doesn't bundle react-native-svg. Shown on the Plaud screen when a paired
// device is being reconnected, so the user sees "their Plaud", not a scan list.
export function PlaudDeviceCard({
  width = 168,
  recording = false,
}: {
  width?: number;
  recording?: boolean;
}) {
  const height = Math.round(width * (300 / 200));
  // Vertical flutes: alternating light/dark thin columns.
  const ribs = Array.from({ length: 9 });
  return (
    <View style={[s.body, { width, height }]}>
      {/* Fluted texture */}
      <View style={s.ribRow} pointerEvents="none">
        {ribs.map((_, i) => (
          <View key={i} style={[s.rib, i % 2 === 0 && s.ribLight]} />
        ))}
      </View>

      {/* Header bar */}
      <View style={s.header}>
        <View style={s.wordmark}>
          <Text style={s.word}>PL</Text>
          <View style={s.triA} />
          <Text style={s.word}>UD</Text>
        </View>
        <View style={[s.btnRing, recording && s.btnRingRec]}>
          <View style={[s.btnDot, recording && s.btnDotRec]} />
        </View>
      </View>

      {/* Rotated PLAUD near the bottom-left */}
      <Text style={s.footMark}>PLAUD</Text>
    </View>
  );
}

const s = StyleSheet.create({
  body: {
    borderRadius: 22,
    backgroundColor: "#2c2f34",
    overflow: "hidden",
    justifyContent: "flex-start",
  },
  ribRow: {
    ...StyleSheet.absoluteFillObject,
    top: 54,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 6,
  },
  rib: { flex: 1, marginHorizontal: 1.5, backgroundColor: "#26282c" },
  ribLight: { backgroundColor: "#3c4046" },
  header: {
    height: 54,
    backgroundColor: "#1b1c1f",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  wordmark: { flexDirection: "row", alignItems: "center" },
  word: { color: "#ececed", fontSize: 15, fontWeight: "800", letterSpacing: 1.5 },
  triA: {
    width: 0,
    height: 0,
    marginHorizontal: 1,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 12,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: "#ececed",
  },
  btnRing: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: "#4c4f55",
    alignItems: "center",
    justifyContent: "center",
  },
  btnRingRec: { borderColor: D.red },
  btnDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#2c2f34" },
  btnDotRec: { backgroundColor: D.red },
  footMark: {
    position: "absolute",
    left: -8,
    bottom: 42,
    color: "#5a5d63",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 2,
    transform: [{ rotate: "-90deg" }],
  },
});
