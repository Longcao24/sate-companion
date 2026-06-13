import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SateApi } from "../api/sateApi";
import { Button, Card, Muted, Pill, ProgressBar, Title } from "../components/ui";
import { ManagedDevice } from "../protocol";
import { SyncActivity } from "../sync/AutoSync";
import { C } from "../theme";

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function DevicesScreen({
  api,
  activity,
  onOpenDevice,
  onAddDevice,
  onOpenSettings,
}: {
  api: SateApi;
  activity: SyncActivity;
  onOpenDevice: (d: ManagedDevice) => void;
  onAddDevice: () => void;
  onOpenSettings: () => void;
}) {
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setDevices(await api.listDevices());
    } catch {
      /* keep last known list; pull-to-refresh retries */
    }
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000); // auto-refresh fleet status
    return () => clearInterval(t);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Title>My recorders</Title>
        <Pressable onPress={onOpenSettings}>
          <Text style={s.gear}>Settings</Text>
        </Pressable>
      </View>

      <SyncBanner activity={activity} />

      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} />
        }
        ListEmptyComponent={
          <Card>
            <Text style={{ color: C.ink, fontSize: 15, marginBottom: 4 }}>
              No recorders yet
            </Text>
            <Muted>
              Tap "Set up a new recorder" and we'll find it over Bluetooth.
            </Muted>
          </Card>
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => onOpenDevice(item)}>
            <Card>
              <View style={s.row}>
                <Text style={s.devName}>{item.name}</Text>
                <Pill
                  text={item.online ? "ONLINE" : "OFFLINE"}
                  tone={item.online ? "ok" : "warn"}
                />
              </View>
              <Muted>
                {item.serial} - fw {item.fw} - seen {timeAgo(item.last_seen)}
              </Muted>
              {item.pending_sessions > 0 && (
                <Muted style={{ color: C.amber, marginTop: 4 }}>
                  {item.pending_sessions} session(s) waiting to sync
                </Muted>
              )}
            </Card>
          </Pressable>
        )}
      />

      <Button title="+  Set up a new recorder" onPress={onAddDevice} />
    </View>
  );
}

function SyncBanner({ activity }: { activity: SyncActivity }) {
  if (activity.phase === "idle") return null;

  let tone: "ok" | "warn" | "err" | "info" = "info";
  let text = "";
  switch (activity.phase) {
    case "scanning":
      text = "Auto-sync on - listening for nearby recorders";
      break;
    case "connecting":
      text = `Connecting to ${activity.deviceName}...`;
      break;
    case "pulling":
      text = `Receiving ${activity.sessionLabel} from ${activity.deviceName}`;
      break;
    case "uploading":
      text = `Uploading ${activity.sessionLabel} to SATE`;
      break;
    case "done":
      tone = "ok";
      text = `Synced ${activity.doneCount} session(s) from ${activity.deviceName}`;
      break;
    case "error":
      tone = "err";
      text = activity.msg ?? "Sync problem";
      break;
  }

  return (
    <View style={[s.banner, tone === "err" && { borderColor: C.red }]}>
      <Text style={s.bannerText}>{text}</Text>
      {activity.phase === "pulling" && (
        <ProgressBar value={activity.progress ?? 0} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: 16, paddingTop: 56 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  gear: { color: C.sky, fontSize: 14, fontWeight: "600" },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  devName: { fontSize: 16, fontWeight: "700", color: C.ink },
  banner: {
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.ice,
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  bannerText: { fontSize: 13, color: C.navy },
});
