import React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Button, Card, GlassBackground, Muted, Title } from "../components/ui";
import { useStore } from "../store";
import { APP as D } from "../theme";
import { useBottomInset } from "../ui/insets";

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const { settings, update, signOut } = useStore();
  // Sign out is the last child of a plain View, so on an edge-to-edge phone the
  // system nav bar sits on top of it.
  const padBottom = useBottomInset(16);

  return (
    <View style={[s.wrap, { paddingBottom: padBottom }]}>
      <GlassBackground />
      <View style={s.header}>
        <Title>Settings</Title>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Text style={s.close}>Back</Text>
        </Pressable>
      </View>

      <Card>
        <Text style={s.section}>Account</Text>
        <Muted>{settings.user?.name}</Muted>
        <Muted>{settings.user?.email}</Muted>
      </Card>

      <Card>
        <View style={s.rowBetween}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={s.section}>Auto-sync over Bluetooth</Text>
            <Muted>
              While this app is open, recorders with no Wi-Fi are synced to
              SATE automatically through your phone.
            </Muted>
          </View>
          <Switch
            value={settings.autoSync}
            onValueChange={(v) => update({ autoSync: v })}
            trackColor={{ true: D.sky, false: D.line }}
            thumbColor="#FFFFFF"
          />
        </View>
      </Card>

      <Button title="Sign out" kind="danger" onPress={signOut} />
    </View>
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
  section: { fontSize: 15, fontWeight: "700", color: D.ink, marginBottom: 4 },
  rowBetween: { flexDirection: "row", alignItems: "center" },
});
