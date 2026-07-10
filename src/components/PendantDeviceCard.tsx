import { View, StyleSheet } from "react-native";

// A likeness of the SATE Pendant (Sona/Nuna): a smooth white pebble on a black
// necklace cord, built from plain Views (parallels PlaudDeviceCard). Shown on the
// Pendant screen / Home so the user sees "their pendant", not a generic icon.
export function PendantDeviceCard({ width = 150 }: { width?: number }) {
  const bodyW = Math.round(width * 0.92);
  const bodyH = Math.round(width * 0.78);
  const height = Math.round(width * 1.18);
  return (
    <View style={{ width, height, alignItems: "center", justifyContent: "flex-end" }}>
      {/* Necklace cord — two strands rising from the lanyard hole */}
      <View style={[s.cord, { height: height * 0.42, left: width * 0.36, transform: [{ rotate: "-24deg" }] }]} />
      <View style={[s.cord, { height: height * 0.42, right: width * 0.36, transform: [{ rotate: "24deg" }] }]} />

      {/* Pendant body (white pebble) */}
      <View
        style={[
          s.body,
          { width: bodyW, height: bodyH, borderRadius: bodyH / 2 },
        ]}
      >
        {/* top-left sheen */}
        <View style={[s.sheen, { width: bodyW * 0.4, height: bodyH * 0.28 }]} />
        {/* lanyard hole */}
        <View style={s.hole} />
        {/* mic hole */}
        <View style={s.mic} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  cord: {
    position: "absolute",
    top: 0,
    width: 3,
    backgroundColor: "#161618",
    borderRadius: 2,
  },
  body: {
    backgroundColor: "#f5f6f8",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#cfd2d8",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    // soft lift
    shadowColor: "#0b0c0e",
    shadowOpacity: 0.25,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  sheen: {
    position: "absolute",
    top: "16%",
    left: "14%",
    backgroundColor: "#ffffff",
    borderRadius: 999,
    opacity: 0.7,
  },
  hole: {
    width: 9,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#3a3c42",
    borderWidth: 1.5,
    borderColor: "#dfe1e5",
  },
  mic: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#b3b7bf" },
});
