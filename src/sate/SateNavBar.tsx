import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { FONT, R, S, TAP } from "../theme";
import { useBottomInset } from "../ui/insets";

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
// The active tab is a filled pill: at this size a filled shape reads as "you
// are here" from further away than a tinted glyph does, and it keeps the three
// labels on one baseline. The pill holds an ICON, not an abstract dot — three
// identical dots make the bar a row of lights that only the labels distinguish,
// so the shape that catches the eye first carries no information at all.

export type SateTab = "dashboard" | "reports" | "settings";

// `home` / `file-text` / `settings` are Feather's, already bundled for the
// report screen — no new font asset, and the same stroke weight as every other
// glyph in the app.
const ITEMS: Array<{ id: SateTab; label: string; icon: keyof typeof Feather.glyphMap }> = [
  { id: "dashboard", label: "Home", icon: "home" },
  { id: "reports", label: "Reports", icon: "file-text" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export function SateNavBar({
  active,
  onSelect,
}: {
  active: SateTab;
  onSelect: (t: SateTab) => void;
}) {
  // The bar is the bottom-most thing in the app, so it is the one that has to
  // clear the system navigation. 8dp of its own on top of whatever the phone
  // reserves: ~24dp for a gesture pill, ~48dp for three buttons.
  const padBottom = useBottomInset(8);
  return (
    <View style={[s.bar, { paddingBottom: padBottom }]}>
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
              <Feather name={it.icon} size={17} color={on ? S.teal : S.faint} />
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
    // paddingBottom comes from the safe-area inset at render — see the component.
    paddingHorizontal: 8,
  },
  item: {
    flex: 1,
    minHeight: TAP.primary,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    borderRadius: R.button,
  },
  chip: {
    width: 52,
    height: 28,
    borderRadius: R.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  chipOn: { backgroundColor: S.tealTint },
  label: { fontFamily: FONT.extra, fontSize: 11.5 },
});
