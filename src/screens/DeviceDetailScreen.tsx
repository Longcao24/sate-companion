import React, { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SateApi } from "../api/sateApi";
import { FoundDevice, SateLink } from "../ble/SateBle";
import { Button, Card, Field, Muted, Pill, Title } from "../components/ui";
import { BleCommand, ManagedDevice, RemoteCommand } from "../protocol";
import { C } from "../theme";

export function DeviceDetailScreen({
  api,
  link,
  device,
  onClose,
}: {
  api: SateApi;
  link: SateLink;
  device: ManagedDevice;
  onClose: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [busyCmd, setBusyCmd] = useState<RemoteCommand | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      link.stopScan();
      link.disconnect().catch(() => {});
    };
  }, [link]);

  const setIf = (fn: () => void) => {
    if (mounted.current) fn();
  };

  // ---- Wi-Fi path: command goes through the server -----------------------
  const command = async (op: RemoteCommand, okMsg: string) => {
    setBusyCmd(op);
    setNote(null);
    try {
      await api.sendCommand(device.id, op);
      setIf(() => setNote(okMsg));
    } catch (e: any) {
      setIf(() => setNote(e?.message ?? "Command failed"));
    } finally {
      setIf(() => setBusyCmd(null));
    }
  };

  // ---- BLE path: device is off Wi-Fi but nearby ---------------------------
  const findNearby = () =>
    new Promise<FoundDevice>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.stopScan();
        reject(
          new Error(
            "Recorder not found nearby. Make sure it is powered on and within Bluetooth range."
          )
        );
      }, 12000);
      link.startScan((d) => {
        if (d.name === device.serial) {
          clearTimeout(timer);
          link.stopScan();
          resolve(d);
        }
      });
    });

  const bleCommand = async (op: BleCommand, okMsg: string) => {
    setBusyCmd(op);
    setNote("Searching for the recorder over Bluetooth...");
    try {
      const ok = await link.requestPermissions();
      if (!ok) throw new Error("Bluetooth permission needed");
      const found = await findNearby();
      setIf(() => setNote("Connecting..."));
      await link.connect(found.id);
      await link.sendCommand(op);
      setIf(() => setNote(`${okMsg} (sent over Bluetooth)`));
    } catch (e: any) {
      setIf(() => setNote(e?.message ?? "Bluetooth command failed"));
    } finally {
      await link.disconnect().catch(() => {});
      setIf(() => setBusyCmd(null));
    }
  };

  const rename = async () => {
    try {
      await api.renameDevice(device.id, name.trim());
      setNote("Name saved");
    } catch (e: any) {
      setNote(e?.message ?? "Rename failed");
    }
  };

  const remove = () => {
    Alert.alert(
      "Remove recorder",
      `Remove "${device.name}" from your account? Recordings already on the SATE dashboard are kept.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await api.removeDevice(device.id).catch(() => {});
            onClose();
          },
        },
      ]
    );
  };

  const online = device.online;

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Title>{device.name}</Title>
        <Pressable onPress={onClose}>
          <Text style={s.close}>Back</Text>
        </Pressable>
      </View>

      <Card>
        <View style={s.row}>
          <Muted>Status</Muted>
          <Pill
            text={online ? "ONLINE (Wi-Fi)" : "OFFLINE"}
            tone={online ? "ok" : "warn"}
          />
        </View>
        <View style={s.row}>
          <Muted>Serial</Muted>
          <Text style={s.val}>{device.serial}</Text>
        </View>
        <View style={s.row}>
          <Muted>Firmware</Muted>
          <Text style={s.val}>{device.fw}</Text>
        </View>
        {device.ip && (
          <View style={s.row}>
            <Muted>IP address</Muted>
            <Text style={s.val}>{device.ip}</Text>
          </View>
        )}
        <View style={s.row}>
          <Muted>Waiting to sync</Muted>
          <Text style={s.val}>{device.pending_sessions} session(s)</Text>
        </View>
        {!online && (
          <Muted style={{ marginTop: 6, color: C.amber }}>
            Recorder is off Wi-Fi. If it's nearby, auto-sync will pick it up
            over Bluetooth - and Identify / Restart below will reach it
            directly over Bluetooth too.
          </Muted>
        )}
      </Card>

      <Card>
        <Text style={s.section}>Remote control</Text>
        <Muted style={{ marginBottom: 4 }}>
          {online
            ? "Commands reach the recorder over Wi-Fi."
            : "No Wi-Fi - Identify and Restart are sent directly over Bluetooth when the recorder is nearby."}
        </Muted>
        <Button
          title="Sync sessions now"
          onPress={() => command("sync_now", "Recorder is syncing now")}
          loading={busyCmd === "sync_now"}
          disabled={!online}
        />
        <Button
          title="Reload patient list"
          kind="secondary"
          onPress={() => command("reload_patients", "Patient list refreshed")}
          loading={busyCmd === "reload_patients"}
          disabled={!online}
        />
        <Button
          title="Identify (beep + flash)"
          kind="secondary"
          onPress={() =>
            online
              ? command("identify", "Look for the flashing recorder")
              : bleCommand("identify", "Look for the flashing recorder")
          }
          loading={busyCmd === "identify"}
        />
        <Button
          title="Restart recorder"
          kind="secondary"
          onPress={() =>
            online
              ? command("reboot", "Recorder is restarting")
              : bleCommand("reboot", "Recorder is restarting")
          }
          loading={busyCmd === "reboot"}
        />
        {note && <Muted style={{ marginTop: 8, color: C.navy }}>{note}</Muted>}
      </Card>

      <Card>
        <Text style={s.section}>Name</Text>
        <Field label="Recorder name" value={name} onChangeText={setName} autoCapitalize="sentences" />
        <Button title="Save name" kind="secondary" onPress={rename} />
      </Card>

      <Button title="Remove from my account" kind="danger" onPress={remove} />
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
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginVertical: 4,
    alignItems: "center",
  },
  val: { color: C.ink, fontSize: 14, fontWeight: "600" },
  section: { fontSize: 15, fontWeight: "700", color: C.ink, marginBottom: 6 },
});
