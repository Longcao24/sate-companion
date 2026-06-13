import React, { useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SateApi } from "../api/sateApi";
import { FoundDevice, SateLink } from "../ble/SateBle";
import { GlassBackground } from "../components/ui";
import { ManagedDevice } from "../protocol";
import { D } from "../theme";

// The hardware-admin side of a recorder, kept off the main companion screen:
// rename, identity details, restart, and unlink. Reached via "Recorder
// settings" on Home so day-to-day recording never has to wade through it.

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function RecorderSettingsScreen({
  api,
  link,
  device,
  onClose,
  onUnlinked,
}: {
  api: SateApi;
  link: SateLink;
  device: ManagedDevice;
  onClose: () => void;
  onUnlinked: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [note, setNote] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const mounted = useRef(true);

  const setIf = (fn: () => void) => {
    if (mounted.current) fn();
  };

  const rename = async () => {
    try {
      await api.renameDevice(device.id, name.trim());
      setNote("Name saved");
    } catch (e: any) {
      setNote(e?.message ?? "Couldn't save the name");
    }
  };

  // Wi-Fi restart goes through the server; if it's off Wi-Fi we reach it
  // directly over Bluetooth instead.
  const findNearby = () =>
    new Promise<FoundDevice>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.stopScan();
        reject(new Error("Recorder not found nearby. Make sure it's powered on."));
      }, 12000);
      link.startScan((d) => {
        if (d.name === device.serial) {
          clearTimeout(timer);
          link.stopScan();
          resolve(d);
        }
      });
    });

  const restart = async () => {
    setRestarting(true);
    setNote(null);
    try {
      if (device.online) {
        await api.sendCommand(device.id, "reboot");
        setIf(() => setNote("Recorder is restarting"));
      } else {
        setIf(() => setNote("Looking for the recorder over Bluetooth…"));
        const ok = await link.requestPermissions();
        if (!ok) throw new Error("Bluetooth permission needed");
        const found = await findNearby();
        await link.connect(found.id);
        await link.sendCommand("reboot");
        setIf(() => setNote("Recorder is restarting (over Bluetooth)"));
      }
    } catch (e: any) {
      setIf(() => setNote(e?.message ?? "Restart failed"));
    } finally {
      await link.disconnect().catch(() => {});
      setIf(() => setRestarting(false));
    }
  };

  const unlink = () => {
    Alert.alert(
      "Unlink recorder",
      `Unlink "${device.name}" from your account? Sessions already in SATE are kept; you can pair it again any time.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlink",
          style: "destructive",
          onPress: async () => {
            mounted.current = false;
            await api.removeDevice(device.id).catch(() => {});
            onUnlinked();
          },
        },
      ]
    );
  };

  return (
    <View style={s.flex}>
      <GlassBackground />
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
        <StatusBar style="light" />
        <View style={s.header}>
          <Text style={s.h1}>Recorder settings</Text>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={s.close}>Done</Text>
          </Pressable>
        </View>

        {note && <Text style={s.note}>{note}</Text>}

        {/* name */}
        <Text style={s.sectionHdr}>Name</Text>
        <View style={s.panel}>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            autoCapitalize="sentences"
            autoCorrect={false}
            placeholder="Recorder name"
            placeholderTextColor={D.faint}
          />
          <Pressable style={s.saveBtn} onPress={rename} accessibilityRole="button">
            <Text style={s.saveTxt}>Save name</Text>
          </Pressable>
        </View>

        {/* identity */}
        <Text style={s.sectionHdr}>About this recorder</Text>
        <View style={s.panel}>
          <Detail k="Serial" v={device.serial} />
          <Detail k="Firmware" v={device.fw} />
          {device.ip ? <Detail k="IP address" v={device.ip} /> : null}
          <Detail k="Last seen" v={timeAgo(device.last_seen)} />
          <Detail
            k="Waiting to sync"
            v={`${device.pending_sessions} session(s)`}
          />
        </View>

        {/* maintenance */}
        <Text style={s.sectionHdr}>Maintenance</Text>
        <View style={s.panel}>
          <Pressable
            onPress={restart}
            disabled={restarting}
            accessibilityRole="button"
            style={({ pressed }) => [
              s.rowBtn,
              { opacity: restarting ? 0.6 : pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={s.rowBtnTxt}>
              {restarting ? "Restarting…" : "Restart recorder"}
            </Text>
            <Text style={s.rowBtnGlyph}>⏻</Text>
          </Pressable>
        </View>

        <Pressable style={s.unlinkBtn} onPress={unlink} accessibilityRole="button">
          <Text style={s.unlinkTxt}>Unlink from my account</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.detailRow}>
      <Text style={s.detailK}>{k}</Text>
      <Text style={s.detailV}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingTop: 56, paddingBottom: 48 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  h1: { color: D.ink, fontSize: 22, fontWeight: "800" },
  close: { color: D.sky, fontSize: 15, fontWeight: "600" },
  note: { color: D.sky, fontSize: 13, marginTop: 8 },

  sectionHdr: {
    color: D.ink,
    fontSize: 18,
    fontWeight: "800",
    marginTop: 18,
    marginBottom: 12,
  },
  panel: {
    backgroundColor: D.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    padding: 14,
  },
  input: {
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: D.ink,
    backgroundColor: D.tile,
    marginBottom: 12,
  },
  saveBtn: {
    backgroundColor: D.tile,
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  saveTxt: { color: D.ink, fontSize: 15, fontWeight: "700" },

  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  detailK: { color: D.sub, fontSize: 14 },
  detailV: { color: D.ink, fontSize: 14, fontWeight: "700" },

  rowBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  rowBtnTxt: { color: D.ink, fontSize: 15, fontWeight: "600" },
  rowBtnGlyph: { color: D.sub, fontSize: 18 },

  unlinkBtn: {
    backgroundColor: D.redBg,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 22,
  },
  unlinkTxt: { color: D.red, fontSize: 15, fontWeight: "700" },
});
