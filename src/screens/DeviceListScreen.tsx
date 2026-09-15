import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Feather } from "@expo/vector-icons";
import { GlassBackground, Logo } from "../components/ui";
import { AddDeviceSheet } from "../components/AddDeviceSheet";
import { PlaudDeviceCard } from "../components/PlaudDeviceCard";
import { PendantDeviceCard } from "../components/PendantDeviceCard";
import { ManagedDevice } from "../protocol";
import { D } from "../theme";

// The account's devices, one row each, whatever family they are. The list is fed
// by ONE registry (useManagedDevices in App) that merges SATE recorders from the
// server with Plaud (Keychain) and pendants (AsyncStorage) — so this screen just
// renders rows and branches on `kind`. Tapping a row opens that device; a single
// "Add a device" button opens the picker for all three families.

export function DeviceListScreen({
  devices,
  loaded,
  fetchFailed,
  nearby,
  onRefresh,
  onOpenDevice,
  onOpenSettings,
  onOpenPreview,
  onAddSate,
  onAddPlaud,
  onAddPendant,
}: {
  devices: ManagedDevice[];
  loaded: boolean;
  fetchFailed: boolean;
  /** SATE serials heard over BLE right now (from the auto-sync scan). */
  nearby: Set<string>;
  onRefresh: () => void;
  onOpenDevice: (d: ManagedDevice) => void;
  onOpenSettings: () => void;
  onOpenPreview: () => void;
  onAddSate: () => void;
  // Undefined on a build that does not ship the family (see src/features.ts).
  onAddPlaud?: () => void;
  onAddPendant?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const picker = (
    <AddDeviceSheet
      visible={pickerOpen}
      onClose={() => setPickerOpen(false)}
      onPickSate={() => {
        setPickerOpen(false);
        onAddSate();
      }}
      onPickPlaud={
        onAddPlaud &&
        (() => {
          setPickerOpen(false);
          onAddPlaud();
        })
      }
      onPickPendant={
        onAddPendant &&
        (() => {
          setPickerOpen(false);
          onAddPendant();
        })
      }
    />
  );

  const header = (
    <View style={s.top}>
      <View style={s.brandRow}>
        <Logo size={32} />
        <Text style={s.brand}>SATE</Text>
      </View>
      <Pressable
        onPress={onOpenSettings}
        hitSlop={10}
        accessibilityRole="button"
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        <Text style={s.link}>Settings</Text>
      </Pressable>
    </View>
  );

  // First load: hold a blank dark screen rather than flash fake data.
  if (!loaded) {
    return (
      <View style={s.flex}>
        <GlassBackground />
        <StatusBar style="light" />
      </View>
    );
  }

  // Couldn't reach the server AND nothing is known locally. Don't pretend the
  // account has no devices — the recorder lives on the server and keeps recording.
  if (devices.length === 0 && fetchFailed) {
    return (
      <View style={s.flex}>
        <GlassBackground />
        <StatusBar style="light" />
        {header}
        <View style={s.empty}>
          <Text style={s.emptyTitle}>Can't reach SATE</Text>
          <Text style={s.emptySub}>
            We couldn't load your devices. Check your connection — your recorder
            stays online and keeps recording on its own.
          </Text>
          <Pressable
            onPress={onRefresh}
            accessibilityRole="button"
            style={({ pressed }) => [s.cta, { opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={s.ctaTxt}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Nothing paired anywhere yet → ONE button into the device picker.
  if (devices.length === 0) {
    return (
      <View style={s.flex}>
        <GlassBackground />
        <StatusBar style="light" />
        {header}
        <View style={s.empty}>
          <Text style={s.emptyTitle}>Connect your first device</Text>
          <Text style={s.emptySub}>
            SATE works with a recorder, a Plaud, or a pendant. Pick one to pair — it
            then records and uploads on its own, and this app is your window into it.
          </Text>
          <Pressable
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            style={({ pressed }) => [s.cta, { opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={s.ctaTxt}>Connect a device</Text>
          </Pressable>
          <Pressable onPress={onOpenPreview} hitSlop={8} accessibilityRole="button">
            <Text style={[s.link, { marginTop: 18 }]}>See how it works ›</Text>
          </Pressable>
        </View>
        {picker}
      </View>
    );
  }

  return (
    <View style={s.flex}>
      <GlassBackground />
      <StatusBar style="light" />
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
        <View style={s.headerBlock}>
          <View style={{ flex: 1 }}>
            <View style={s.brandRow}>
              <Logo size={32} />
              <Text style={s.brand}>SATE</Text>
            </View>
            <Text style={s.title}>Your devices</Text>
          </View>
          <Pressable
            onPress={onOpenSettings}
            hitSlop={10}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={s.link}>Settings</Text>
          </Pressable>
        </View>

        {devices.map((d) => (
          <DeviceRow
            key={d.id}
            device={d}
            nearby={nearby.has(d.serial)}
            onPress={() => onOpenDevice(d)}
          />
        ))}

        <Pressable
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          style={({ pressed }) => [s.addRow, { opacity: pressed ? 0.85 : 1 }]}
        >
          <Feather name="plus" size={18} color={D.sky} />
          <Text style={s.addTxt}>Add a device</Text>
        </Pressable>
      </ScrollView>
      {picker}
    </View>
  );
}

// One row, styled by device family.
function DeviceRow({
  device,
  nearby,
  onPress,
}: {
  device: ManagedDevice;
  nearby: boolean;
  onPress: () => void;
}) {
  const kind = device.kind ?? "sate";

  let glyph = (
    <View style={s.sateMini}>
      <Feather
        name={device.state === "recording" ? "radio" : device.online ? "wifi" : "wifi-off"}
        size={20}
        color={device.online ? D.sky : D.sub}
      />
    </View>
  );
  let sub = `SATE recorder · ${
    device.online ? "Online" : nearby ? "Nearby (Bluetooth)" : "Offline"
  }${device.pending_sessions > 0 ? ` · ${device.pending_sessions} pending` : ""}`;

  if (kind === "plaud") {
    glyph = <PlaudDeviceCard width={44} />;
    sub = "Paired Plaud · tap to open & sync";
  } else if (kind === "pendant") {
    glyph = <PendantDeviceCard width={44} />;
    sub = "Paired pendant · tap to connect & stream";
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [s.row, { opacity: pressed ? 0.9 : 1 }]}
    >
      {glyph}
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{device.name}</Text>
        <Text style={s.rowSub}>{sub}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={D.sub} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingTop: 56, paddingBottom: 48 },

  top: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 56,
  },
  headerBlock: { flexDirection: "row", alignItems: "flex-start", marginBottom: 18 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  brand: { color: D.sub, fontSize: 20, fontWeight: "800", letterSpacing: 3 },
  title: { color: D.ink, fontSize: 26, fontWeight: "800", marginTop: 2, letterSpacing: 0.3 },
  link: { color: D.sky, fontSize: 15, fontWeight: "600" },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: D.panel,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 12,
    marginBottom: 14,
  },
  rowTitle: { color: D.ink, fontSize: 15, fontWeight: "700" },
  rowSub: { color: D.sub, fontSize: 12, marginTop: 2 },
  sateMini: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: D.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    alignItems: "center",
    justifyContent: "center",
  },

  addRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    borderStyle: "dashed",
    paddingVertical: 14,
    marginTop: 2,
  },
  addTxt: { color: D.sky, fontSize: 15, fontWeight: "700" },

  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingBottom: 60,
  },
  emptyTitle: {
    color: D.ink,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
    marginBottom: 10,
  },
  emptySub: {
    color: D.sub,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 26,
  },
  cta: {
    backgroundColor: D.sky,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 40,
    alignSelf: "stretch",
    alignItems: "center",
  },
  ctaTxt: { color: "#FFFFFF", fontSize: 17, fontWeight: "800" },
});
