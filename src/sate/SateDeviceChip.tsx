import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { L816DeviceCard } from "../components/L816DeviceCard";
import { PendantDeviceCard } from "../components/PendantDeviceCard";
import { PlaudDeviceCard } from "../components/PlaudDeviceCard";
import { ManagedDevice } from "../protocol";
import { D } from "../theme";

// The top-left control on Dashboard and Reports.
//
// With no device paired it is "+ Add device" — the one errand a new account has.
// Once a device exists it becomes that device, drawn, with its battery beside it:
// at that point "add" is no longer what the user wants from this corner, and the
// thing they actually glance for is whether the recorder is charged.
//
// 🛑 THE BATTERY BAR IS ONLY DRAWN WHEN THE BATTERY IS KNOWN. `battery_pct`
// reaches the server in the SATE recorder's heartbeat; an L816, a Pendant and a
// Plaud have no Wi-Fi and send no heartbeat, so for those it is simply absent.
// Drawing an empty or guessed bar for them would say "flat" about a device that
// may be full — and a clinician deciding whether to take it to a session would
// act on that. No reading, no bar.

function Glyph({ kind, width }: { kind: string; width: number }) {
  if (kind === "l816") return <L816DeviceCard width={width} />;
  if (kind === "pendant") return <PendantDeviceCard width={width} />;
  if (kind === "plaud") return <PlaudDeviceCard width={width} />;
  return <Feather name="cpu" size={18} color={D.sky} />;
}

function BatteryBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  // Red only when it is genuinely a problem — a bar that turns red at 40% trains
  // people to ignore it by the time it matters.
  const color = clamped <= 15 ? D.red : clamped <= 30 ? D.amber : D.green;
  return (
    <View style={s.batWrap} accessibilityLabel={`Battery ${clamped} percent`}>
      <View style={s.batCap} />
      <View style={s.batBody}>
        <View style={[s.batFill, { height: `${clamped}%`, backgroundColor: color }]} />
      </View>
      <Text style={[s.batTxt, { color }]}>{clamped}%</Text>
    </View>
  );
}

export function SateDeviceChip({
  devices,
  onPress,
}: {
  devices: ManagedDevice[];
  onPress: () => void;
}) {
  // The device whose battery is worth showing: prefer one that actually reports
  // a level, otherwise just the first paired one.
  const withBattery = devices.find((d) => typeof d.battery_pct === "number");
  const device = withBattery ?? devices[0];

  if (!device) {
    return (
      <Pressable
        onPress={onPress}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Add device"
        style={({ pressed }) => [s.addBtn, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Feather name="plus-circle" size={20} color={D.ink} />
        <Text style={s.addTxt}>Add device</Text>
      </Pressable>
    );
  }

  const kind = device.kind ?? "sate";
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={`${device.name}${
        typeof device.battery_pct === "number" ? `, battery ${device.battery_pct}%` : ""
      }`}
      style={({ pressed }) => [s.chip, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={s.glyph}>
        <Glyph kind={kind} width={kind === "sate" ? 18 : 22} />
      </View>
      <View style={{ maxWidth: 120 }}>
        <Text style={s.chipName} numberOfLines={1}>
          {device.name}
        </Text>
        {typeof device.battery_pct !== "number" && (
          <Text style={s.chipSub} numberOfLines={1}>
            {kind === "sate" ? (device.online ? "Online" : "Offline") : "Paired"}
          </Text>
        )}
      </View>
      {typeof device.battery_pct === "number" && <BatteryBar pct={device.battery_pct} />}
    </Pressable>
  );
}

const s = StyleSheet.create({
  addBtn: { flexDirection: "row", alignItems: "center", gap: 8 },
  addTxt: { color: D.ink, fontSize: 16, fontWeight: "700" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    backgroundColor: D.tile,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    paddingLeft: 8,
    paddingRight: 12,
    paddingVertical: 6,
  },
  glyph: {
    width: 30,
    height: 30,
    borderRadius: 999,
    backgroundColor: D.panel,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  chipName: { color: D.ink, fontSize: 14, fontWeight: "700" },
  chipSub: { color: D.faint, fontSize: 11, marginTop: 1 },
  // Vertical battery: a little cap on top of a body that fills from the bottom.
  batWrap: { alignItems: "center", gap: 2 },
  batCap: { width: 6, height: 2, borderRadius: 1, backgroundColor: D.faint },
  batBody: {
    width: 12,
    height: 22,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: D.faint,
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  batFill: { width: "100%" },
  batTxt: { fontSize: 9, fontWeight: "700" },
});
