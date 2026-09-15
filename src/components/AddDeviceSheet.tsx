import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { PlaudDeviceCard } from "./PlaudDeviceCard";
import { PendantDeviceCard } from "./PendantDeviceCard";
import { D } from "../theme";

// The "Add a device" bottom sheet: one entry point for pairing any of the three
// device families (SATE recorder / Plaud / Pendant). Shared by the empty state
// and the device list so pairing always starts the same way.
export function AddDeviceSheet({
  visible,
  onClose,
  onPickSate,
  onPickPlaud,
  onPickPendant,
}: {
  visible: boolean;
  onClose: () => void;
  onPickSate: () => void;
  // Optional: a build that does not support the family passes nothing and the
  // row is not rendered at all, rather than being shown and then failing.
  onPickPlaud?: () => void;
  onPickPendant?: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={s.wrap}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.grip} />
          <Text style={s.title}>Add a device</Text>
          <Text style={s.sub}>Which one are you connecting?</Text>

          <Pressable
            onPress={onPickSate}
            accessibilityRole="button"
            style={({ pressed }) => [s.row, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={s.glyph}>
              <Feather name="cpu" size={24} color={D.sky} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>SATE recorder</Text>
              <Text style={s.rowSub}>Wi-Fi recorder · pairs over Bluetooth</Text>
            </View>
            <Feather name="chevron-right" size={20} color={D.sub} />
          </Pressable>

          {onPickPlaud && (
          <Pressable
            onPress={onPickPlaud}
            accessibilityRole="button"
            style={({ pressed }) => [s.row, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={s.glyph}>
              <PlaudDeviceCard width={40} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>Plaud</Text>
              <Text style={s.rowSub}>Plaud recorder · syncs its sessions in</Text>
            </View>
            <Feather name="chevron-right" size={20} color={D.sub} />
          </Pressable>
          )}

          {onPickPendant && (
          <Pressable
            onPress={onPickPendant}
            accessibilityRole="button"
            style={({ pressed }) => [s.row, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={s.glyph}>
              <PendantDeviceCard width={40} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>Pendant</Text>
              <Text style={s.rowSub}>Wearable · streams live audio over Bluetooth</Text>
            </View>
            <Feather name="chevron-right" size={20} color={D.sub} />
          </Pressable>
          )}

          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => [s.cancel, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={s.cancelTxt}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    backgroundColor: D.hero,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: D.line,
    padding: 20,
    paddingBottom: 34,
  },
  grip: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: D.line,
    alignSelf: "center",
    marginBottom: 14,
  },
  title: { color: D.ink, fontSize: 20, fontWeight: "800" },
  sub: { color: D.sub, fontSize: 14, marginTop: 4, marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: D.tile,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    padding: 12,
    marginTop: 12,
  },
  glyph: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: D.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  rowTitle: { color: D.ink, fontSize: 16, fontWeight: "800" },
  rowSub: { color: D.sub, fontSize: 12, marginTop: 3 },
  cancel: { paddingVertical: 12, alignItems: "center", marginTop: 8 },
  cancelTxt: { color: D.sub, fontSize: 15, fontWeight: "600" },
});
