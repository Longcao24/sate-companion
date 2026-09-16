import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { D } from "../theme";

// The SATE app's bottom navigation.
//
// Three destinations, because the app has three and inventing a fourth to fill
// the bar would put something in the user's way that leads nowhere. There is no
// centre "record" button of the kind a recording app has: SATE reads what the
// hardware produced and cannot record anything, so that button would be a
// promise the app cannot keep.
//
// Devices are NOT a tab. Their status is on the dashboard, and pairing one is
// the "+ Add device" control in the top-left — an errand, not a place. The bar
// is for moving between sections; that button is for doing something.

export type SateTab = "dashboard" | "reports" | "settings";

const ITEMS: Array<{ id: SateTab; icon: keyof typeof Feather.glyphMap; label: string }> = [
  { id: "dashboard", icon: "grid", label: "Dashboard" },
  { id: "reports", icon: "file-text", label: "Reports" },
  { id: "settings", icon: "settings", label: "Settings" },
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
            style={({ pressed }) => [s.item, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Feather name={it.icon} size={21} color={on ? D.sky : D.faint} />
            <Text style={[s.label, on && s.labelOn]}>{it.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: D.hero,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: D.line,
    paddingTop: 9,
    // Clears the gesture bar without a safe-area dependency.
    paddingBottom: 26,
  },
  item: { flex: 1, alignItems: "center", gap: 3 },
  label: { color: D.faint, fontSize: 11, fontWeight: "600" },
  labelOn: { color: D.sky },
});
