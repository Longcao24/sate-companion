import { Pressable, StyleSheet, Text, View } from "react-native";
import { FONT, R, S, TAP } from "../theme";

// The SATE app's bottom navigation.
//
// Three destinations, because the app has three and inventing a fourth to fill
// the bar would put something in the user's way that leads nowhere. There is no
// centre "record" button of the kind a recording app has: SATE reads what the
// hardware produced and cannot record anything, so that button would be a
// promise the app cannot keep.
//
// Devices are NOT a tab. Their status is on the dashboard, and pairing one is
// the control in the top-left — an errand, not a place. The bar is for moving
// between sections; that button is for doing something.
//
// The redesign replaces the icon+label pair with a pill that fills when active:
// at this size a filled shape reads as "you are here" from further away than a
// tinted glyph does, and it keeps the three labels on one baseline.

export type SateTab = "dashboard" | "reports" | "settings";

const ITEMS: Array<{ id: SateTab; label: string }> = [
  { id: "dashboard", label: "Home" },
  { id: "reports", label: "Reports" },
  { id: "settings", label: "Settings" },
];

export function SateNavBar({
  active,
  onSelect,
}: {
  active: SateTab;
  onSelect: (t: SateTab) => void;
}) {
  return (
    <View style={s.bar}>
      {ITEMS.map((it) => {
        const on = it.id === active;
        return (
          <Pressable
            key={it.id}
            onPress={() => onSelect(it.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={it.label}
            style={({ pressed }) => [s.item, pressed && { backgroundColor: "#F2F6F6" }]}
          >
            <View style={[s.chip, on && s.chipOn]}>
              <View style={[s.dot, { backgroundColor: on ? S.teal : S.faint }]} />
            </View>
            <Text style={[s.label, { color: on ? S.teal : S.faint }]}>{it.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: S.card,
    borderTopWidth: 1,
    borderTopColor: "#E4EAEA",
    paddingTop: 6,
    // Clears the gesture bar without a safe-area dependency.
    paddingBottom: 22,
    paddingHorizontal: 8,
  },
  item: {
    flex: 1,
    minHeight: TAP.primary,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderRadius: R.button,
  },
  chip: {
    width: 44,
    height: 26,
    borderRadius: R.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  chipOn: { backgroundColor: S.tealTint },
  dot: { width: 9, height: 9, borderRadius: 99 },
  label: { fontFamily: FONT.extra, fontSize: 11.5 },
});
