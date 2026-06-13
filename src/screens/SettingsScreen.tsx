import React from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Button, Card, Muted, Title } from "../components/ui";
import { useStore } from "../store";
import { C } from "../theme";

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const { settings, update, signOut } = useStore();

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Title>Settings</Title>
        <Pressable onPress={onClose}>
          <Text style={s.close}>Back</Text>
        </Pressable>
      </View>

      <Card>
        <Text style={s.section}>Account</Text>
        <Muted>{settings.user?.name}</Muted>
        <Muted>{settings.user?.email}</Muted>
        <Muted style={{ marginTop: 4 }}>
          Server: {settings.demoMode ? "demo (built-in)" : settings.serverUrl}
        </Muted>
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
            trackColor={{ true: C.sky, false: C.line }}
          />
        </View>
      </Card>

      <Card>
        <View style={s.rowBetween}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={s.section}>Demo mode</Text>
            <Muted>
              Uses a built-in pretend recorder and server. Turn off when you
              have real hardware and a server URL.
            </Muted>
          </View>
          <Switch
            value={settings.demoMode}
            onValueChange={(v) => update({ demoMode: v })}
            trackColor={{ true: C.sky, false: C.line }}
          />
        </View>
      </Card>

      <Button title="Sign out" kind="danger" onPress={signOut} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: 16, paddingTop: 56 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  close: { color: C.sky, fontSize: 14, fontWeight: "600" },
  section: { fontSize: 15, fontWeight: "700", color: C.ink, marginBottom: 4 },
  rowBetween: { flexDirection: "row", alignItems: "center" },
});
