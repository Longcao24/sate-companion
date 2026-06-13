import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SateApi } from "../api/sateApi";
import { FoundDevice, ProvisionProgress, SateLink } from "../ble/SateBle";
import {
  Button,
  Card,
  Field,
  GlassBackground,
  Muted,
  Pill,
  Title,
} from "../components/ui";
import { WifiNetwork } from "../protocol";
import { useStore } from "../store";
import { D } from "../theme";

// Flow: find the recorder over BLE -> the "creds" screen lets you EITHER tap a
// nearby network (the board scans in the background) OR just type the SSID and
// go. The SSID field + Send button are usable immediately, so you never have to
// wait for the scan; tapping a scanned network simply fills the field for you.
type Step = "scan" | "creds" | "provisioning" | "done" | "failed";

// Mesh / band-steering APs advertise one SSID from several radios, so the
// board's scan returns duplicates. Keep the strongest per name.
function dedupeNetworks(nets: WifiNetwork[]): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const n of nets) {
    const prev = best.get(n.ssid);
    if (!prev || n.rssi > prev.rssi) best.set(n.ssid, n);
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi);
}

export function ProvisionScreen({
  api,
  link,
  onClose,
}: {
  api: SateApi;
  link: SateLink;
  onClose: () => void;
}) {
  const { settings } = useStore();
  const [step, setStep] = useState<Step>("scan");
  const [found, setFound] = useState<FoundDevice[]>([]);
  const [chosen, setChosen] = useState<FoundDevice | null>(null);
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [name, setName] = useState("Therapy Room");
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ProvisionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // step 1: scan for unprovisioned recorders
  useEffect(() => {
    if (step !== "scan") return;
    let active = true;
    link.requestPermissions().then((ok) => {
      if (!ok) {
        setError("Bluetooth permission is needed to find the recorder.");
        return;
      }
      try {
        link.startScan((d) => {
          if (!active || !d.unprovisioned) return;
          setFound((prev) =>
            prev.some((x) => x.id === d.id) ? prev : [...prev, d]
          );
        });
      } catch (e: any) {
        if (active) setError(e?.message ?? "Bluetooth unavailable");
      }
    });
    return () => {
      active = false;
      link.stopScan();
    };
  }, [step, link]);

  // Board-side Wi-Fi scan. Runs in the background on the creds screen; the
  // screen is fully usable (type + Send) whether or not this ever returns.
  const runWifiScan = async () => {
    setScanning(true);
    try {
      setNetworks(dedupeNetworks(await link.scanWifi()));
    } catch {
      /* leave the list empty - typing still works */
    } finally {
      setScanning(false);
    }
  };

  const pickDevice = async (d: FoundDevice) => {
    setChosen(d);
    setError(null);
    try {
      await link.connect(d.id);
      setStep("creds");
      runWifiScan(); // populate the pick-list in the background
    } catch (e: any) {
      setError(e?.message ?? "Could not connect to the recorder");
      setStep("scan");
    }
  };

  const startProvision = async () => {
    setStep("provisioning");
    setError(null);
    // The claim token binds the recorder to the signed-in clinician, but it is
    // NOT needed for the board to join Wi-Fi. Fetch it best-effort: if the phone
    // can't reach the server, still push SSID + password over BLE so the board
    // connects. The board self-registers over its own Wi-Fi afterwards.
    let claimToken = "";
    try {
      claimToken = await api.claimToken();
    } catch {
      // server unreachable from the phone - proceed with Wi-Fi-only setup
    }
    try {
      const final = await link.provision(
        {
          ssid: ssid.trim(),
          pass,
          server: settings.serverUrl,
          claim_token: claimToken,
        },
        setProgress
      );
      if (final.state === "registered") {
        // The board registers itself with the server over Wi-Fi; it shows up in
        // the fleet on the next GET /api/devices poll.
        setStep("done");
      } else {
        setError(final.msg ?? "Setup failed");
        setStep("failed");
      }
    } catch (e: any) {
      setError(e?.message ?? "Setup failed");
      setStep("failed");
    } finally {
      link.disconnect().catch(() => {});
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.wrap}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <GlassBackground />
      <View style={s.header}>
        <Title>Set up a recorder</Title>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Text style={s.close}>Close</Text>
        </Pressable>
      </View>

      {error && <Text style={s.error}>{error}</Text>}

      {step === "scan" && (
        <>
          <Muted style={{ marginBottom: 10 }}>
            Plug in the recorder. New recorders appear here automatically.
          </Muted>
          <FlatList
            data={found}
            keyExtractor={(d) => d.id}
            ListEmptyComponent={<Muted>Looking for recorders nearby...</Muted>}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => pickDevice(item)}
                accessibilityRole="button"
                style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
              >
                <Card>
                  <View style={s.row}>
                    <Text style={s.devName}>{item.name}</Text>
                    <Pill text="NEW" tone="info" />
                  </View>
                  <Muted>Signal {item.rssi} dBm - tap to set up</Muted>
                </Card>
              </Pressable>
            )}
          />
        </>
      )}

      {step === "creds" && (
        <ScrollView keyboardShouldPersistTaps="handled">
          <Card>
            <Muted style={{ marginBottom: 8, color: D.amber }}>
              2.4 GHz Wi-Fi only (not 5 GHz). Tap a network below, or type the
              name - it is case-sensitive.
            </Muted>

            <View style={s.netHead}>
              <Muted>Nearby networks</Muted>
              {scanning ? (
                <ActivityIndicator color={D.sky} size="small" />
              ) : (
                <Pressable
                  onPress={runWifiScan}
                  hitSlop={10}
                  accessibilityRole="button"
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                >
                  <Text style={s.link}>Rescan</Text>
                </Pressable>
              )}
            </View>
            {networks.length > 0 && (
              <View style={s.netList}>
                {networks.map((n, i) => {
                  const active = n.ssid === ssid;
                  return (
                    <Pressable
                      key={`${n.ssid}-${i}`}
                      onPress={() => setSsid(n.ssid)}
                      accessibilityRole="button"
                      style={[s.netRow, active && s.netRowActive]}
                    >
                      <Text style={[s.netName, active && { color: D.sky }]}>
                        {n.ssid}
                      </Text>
                      <Muted>{n.rssi} dBm</Muted>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {!scanning && networks.length === 0 && (
              <Muted style={{ marginBottom: 10 }}>
                None found yet - just type the name below.
              </Muted>
            )}

            <Field
              label="Network name (SSID)"
              value={ssid}
              onChangeText={setSsid}
              autoCapitalize="none"
              placeholder="e.g. Clinic-2.4G"
            />
            <Field
              label="Wi-Fi password"
              value={pass}
              onChangeText={setPass}
              secure
            />
            <Field
              label="Recorder name"
              value={name}
              onChangeText={setName}
              autoCapitalize="sentences"
            />
            <Button
              title="Send to recorder"
              onPress={startProvision}
              disabled={!ssid.trim()}
            />
          </Card>
        </ScrollView>
      )}

      {step === "provisioning" && (
        <Card>
          <StepLine done={!!progress} label="Sending Wi-Fi details" />
          <StepLine
            done={["wifi_ok", "registering", "registered"].includes(
              progress?.state ?? ""
            )}
            label={`Joining "${ssid}"${progress?.ip ? ` - ${progress.ip}` : ""}`}
          />
          <StepLine
            done={["registering", "registered"].includes(progress?.state ?? "")}
            label="Registering to your SATE account"
          />
          <StepLine
            done={progress?.state === "registered"}
            label="Finished"
          />
        </Card>
      )}

      {step === "done" && (
        <Card>
          <Pill text="READY" tone="ok" />
          <Text style={[s.devName, { marginTop: 8 }]}>
            {name} is connected
          </Text>
          <Muted style={{ marginTop: 4 }}>
            The recorder is on Wi-Fi and saved to your account. It will now
            upload sessions to SATE by itself.
          </Muted>
          <Button title="Done" onPress={onClose} />
        </Card>
      )}

      {step === "failed" && (
        <Card>
          <Pill text="FAILED" tone="err" />
          <Muted style={{ marginTop: 8 }}>
            {error ?? "Something went wrong. Please try again."}
          </Muted>
          <Button title="Try Wi-Fi again" onPress={() => setStep("creds")} />
          <Pressable
            onPress={() => setStep("scan")}
            hitSlop={10}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[s.link, { marginTop: 12 }]}>
              Start over (find recorder)
            </Text>
          </Pressable>
        </Card>
      )}
    </KeyboardAvoidingView>
  );
}

function StepLine({ done, label }: { done: boolean; label: string }) {
  return (
    <View style={s.stepLine}>
      <Text style={{ color: done ? D.green : D.sub, width: 22, fontSize: 15 }}>
        {done ? "✓" : "○"}
      </Text>
      <Text style={{ color: done ? D.ink : D.sub, fontSize: 14 }}>{label}</Text>
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
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  devName: { fontSize: 16, fontWeight: "700", color: D.ink },
  error: { color: D.red, marginBottom: 8 },
  link: { color: D.sky, fontSize: 14, fontWeight: "600", textAlign: "center" },
  stepLine: { flexDirection: "row", alignItems: "center", marginVertical: 6 },
  netHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  netList: { marginBottom: 12 },
  netRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: D.line,
    marginBottom: 6,
  },
  netRowActive: { borderColor: D.sky, backgroundColor: D.skyBg },
  netName: { fontSize: 15, fontWeight: "600", color: D.ink },
});
