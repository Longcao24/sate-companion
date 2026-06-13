import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { MockApi, SateApi } from "../api/sateApi";
import { FoundDevice, ProvisionProgress, SateLink } from "../ble/SateBle";
import { Button, Card, Field, Muted, Pill, Title } from "../components/ui";
import { WifiNetwork } from "../protocol";
import { useStore } from "../store";
import { C } from "../theme";

type Step = "scan" | "wifi" | "creds" | "provisioning" | "done" | "failed";

// Multiple access points can share an SSID (e.g. mesh / band-steering), so the
// recorder's scan returns the same name more than once. Keep the strongest one
// so each network shows a single, stable row.
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
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const [manual, setManual] = useState(false);
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [name, setName] = useState("Therapy Room");
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

  // Ask the recorder to scan Wi-Fi. Never leaves the UI dead-ended: a thrown
  // timeout or an empty result both land on the "no networks" state (Rescan +
  // manual entry), and the BLE connection stays open so the user can retry
  // without starting over.
  const runWifiScan = async () => {
    setScanning(true);
    setScanFailed(false);
    setError(null);
    try {
      const nets = dedupeNetworks(await link.scanWifi());
      setNetworks(nets);
      setScanFailed(nets.length === 0);
    } catch {
      setNetworks([]);
      setScanFailed(true);
    } finally {
      setScanning(false);
    }
  };

  const pickDevice = async (d: FoundDevice) => {
    setChosen(d);
    setError(null);
    try {
      await link.connect(d.id);
      setStep("wifi");
      runWifiScan();
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
          ssid,
          pass,
          server: settings.serverUrl,
          claim_token: claimToken,
        },
        setProgress
      );
      if (final.state === "registered") {
        if (settings.demoMode) MockApi.addClaimed("SATE-7C3A09", name);
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
    <View style={s.wrap}>
      <View style={s.header}>
        <Title>Set up a recorder</Title>
        <Pressable onPress={onClose}>
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
              <Pressable onPress={() => pickDevice(item)}>
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

      {step === "wifi" && manual && (
        <Card>
          <Muted style={{ marginBottom: 10 }}>
            Type the exact Wi-Fi network name (case-sensitive):
          </Muted>
          <Field
            label="Network name (SSID)"
            value={ssid}
            onChangeText={setSsid}
            autoCapitalize="none"
          />
          <Button
            title="Next"
            onPress={() => ssid.trim() && setStep("creds")}
          />
          <Pressable onPress={() => setManual(false)}>
            <Text style={[s.link, { marginTop: 12 }]}>
              Back to scanned networks
            </Text>
          </Pressable>
        </Card>
      )}

      {step === "wifi" && !manual && (
        <>
          <Muted style={{ marginBottom: 10 }}>
            Pick the Wi-Fi network the recorder should use:
          </Muted>

          {scanning ? (
            <View style={s.center}>
              <ActivityIndicator color={C.sky} />
              <Muted style={{ marginTop: 10 }}>
                Recorder is scanning Wi-Fi...
              </Muted>
            </View>
          ) : networks.length === 0 ? (
            <View style={s.center}>
              <Muted style={{ textAlign: "center" }}>
                {scanFailed
                  ? "No networks found. The recorder only sees 2.4 GHz Wi-Fi. Move it closer to the router and rescan, or enter the network by hand."
                  : "No networks yet."}
              </Muted>
              <Button title="Rescan" onPress={runWifiScan} />
            </View>
          ) : (
            <FlatList
              data={networks}
              keyExtractor={(n, i) => `${n.ssid}-${i}`}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => {
                    setSsid(item.ssid);
                    setStep("creds");
                  }}
                >
                  <Card>
                    <View style={s.row}>
                      <Text style={s.devName}>{item.ssid}</Text>
                      <Muted>{item.rssi} dBm</Muted>
                    </View>
                  </Card>
                </Pressable>
              )}
              ListFooterComponent={
                <Pressable onPress={runWifiScan} disabled={scanning}>
                  <Text style={[s.link, { marginTop: 14 }]}>Rescan</Text>
                </Pressable>
              }
            />
          )}

          <Pressable onPress={() => setManual(true)}>
            <Text style={[s.link, { marginTop: 16 }]}>
              Network not listed? Enter it manually
            </Text>
          </Pressable>
        </>
      )}

      {step === "creds" && (
        <Card>
          <Muted style={{ marginBottom: 10 }}>Network: {ssid}</Muted>
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
          <Button title="Connect recorder" onPress={startProvision} />
        </Card>
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
          <Button title="Try again" onPress={() => setStep("scan")} />
        </Card>
      )}
    </View>
  );
}

function StepLine({ done, label }: { done: boolean; label: string }) {
  return (
    <View style={s.stepLine}>
      <Text style={{ color: done ? C.green : C.slate, width: 22, fontSize: 15 }}>
        {done ? "\u2713" : "\u25CB"}
      </Text>
      <Text style={{ color: done ? C.ink : C.slate, fontSize: 14 }}>{label}</Text>
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
    alignItems: "center",
  },
  devName: { fontSize: 16, fontWeight: "700", color: C.ink },
  error: { color: C.red, marginBottom: 8 },
  center: { alignItems: "center", paddingVertical: 24 },
  link: { color: C.sky, fontSize: 14, fontWeight: "600", textAlign: "center" },
  stepLine: { flexDirection: "row", alignItems: "center", marginVertical: 6 },
});
