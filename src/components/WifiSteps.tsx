// WifiSteps — the shared "scan → choose a network → type the password" wizard
// used by BOTH first-time setup and Change-Wi-Fi. Assumes the recorder is ALREADY
// connected over BLE; the caller supplies how to submit the chosen credentials
// (provision vs change_wifi). The recorder's radio is 2.4 GHz-only, so every
// network it returns is already a 2.4 GHz network.

import { ReactNode, useEffect, useState } from "react";
import { Feather } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SateLink, ProvisionProgress } from "../ble/SateBle";
import { ProvisionState, WifiNetwork } from "../protocol";
import { Button, Card, Field, Muted, Pill } from "./ui";
import { D } from "../theme";

type Step = "scan" | "pick" | "password" | "progress" | "done" | "failed";

function dedupe(nets: WifiNetwork[]): WifiNetwork[] {
  const best = new Map<string, WifiNetwork>();
  for (const n of nets) {
    const prev = best.get(n.ssid);
    if (n.ssid && (!prev || n.rssi > prev.rssi)) best.set(n.ssid, n);
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi);
}

function bars(rssi: number): string {
  if (rssi >= -55) return "▂▄▆█";
  if (rssi >= -67) return "▂▄▆";
  if (rssi >= -78) return "▂▄";
  return "▂";
}

export function WifiSteps({
  link,
  onSubmit,
  successState,
  submitLabel,
  doneTitle,
  doneBody,
  onDone,
}: {
  link: SateLink;
  onSubmit: (
    ssid: string,
    pass: string,
    onProgress: (p: ProvisionProgress) => void
  ) => Promise<ProvisionProgress>;
  successState: ProvisionState;
  submitLabel: string;
  doneTitle: string;
  doneBody: string;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>("scan");
  const [nets, setNets] = useState<WifiNetwork[]>([]);
  const [ssid, setSsid] = useState("");
  const [manual, setManual] = useState(false);
  const [pass, setPass] = useState("");
  const [progress, setProgress] = useState<ProvisionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    setStep("scan");
    setError(null);
    try {
      const found = await link.scanWifi();
      setNets(dedupe(found));
    } catch {
      setNets([]);
    } finally {
      setStep("pick");
    }
  };

  // Auto-scan the moment the wizard opens (recorder already connected).
  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (network: string) => {
    setSsid(network);
    setManual(false);
    setPass("");
    setStep("password");
  };

  const typeManually = () => {
    setSsid("");
    setManual(true);
    setPass("");
    setStep("password");
  };

  const submit = async () => {
    if (!ssid.trim()) return;
    setStep("progress");
    setError(null);
    setProgress(null);
    try {
      const final = await onSubmit(ssid.trim(), pass, setProgress);
      if (final.state === successState) setStep("done");
      else {
        setError(final.msg ?? "Couldn’t join that network");
        setStep("failed");
      }
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
      setStep("failed");
    }
  };

  // ----- scan -----
  if (step === "scan") {
    return (
      <Card>
        <View style={s.center}>
          <ActivityIndicator color={D.sky} size="large" />
          <Text style={s.scanText}>Scanning for Wi-Fi networks…</Text>
          <Muted style={{ textAlign: "center", marginTop: 4 }}>
            Reading the 2.4 GHz networks the recorder can see
          </Muted>
        </View>
      </Card>
    );
  }

  // ----- pick a network -----
  if (step === "pick") {
    return (
      <ScrollView keyboardShouldPersistTaps="handled">
        <Card>
          <View style={s.headRow}>
            <Text style={s.cardTitle}>Choose a network</Text>
            <Pressable onPress={scan} hitSlop={10}>
              <Text style={s.link}>Rescan</Text>
            </Pressable>
          </View>
          <Muted style={{ marginBottom: 12 }}>
            2.4 GHz only — that’s all the recorder can join (5 GHz won’t appear).
          </Muted>

          {nets.length === 0 && (
            <Muted style={{ marginBottom: 12 }}>
              No networks found. Rescan, or enter the name yourself below.
            </Muted>
          )}

          {nets.map((n, i) => (
            <Pressable
              key={`${n.ssid}-${i}`}
              onPress={() => choose(n.ssid)}
              style={({ pressed }) => [s.netRow, { opacity: pressed ? 0.7 : 1 }]}
            >
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={s.netName} numberOfLines={1}>
                  {n.ssid}
                </Text>
                <Muted>{n.sec === "open" ? "Open" : "Password protected"}</Muted>
              </View>
              <Text style={s.netBars}>{bars(n.rssi)}</Text>
            </Pressable>
          ))}

          <Pressable onPress={typeManually} style={s.manualRow}>
            <Text style={s.manualTxt}>＋ Enter network name manually</Text>
          </Pressable>
        </Card>
      </ScrollView>
    );
  }

  // ----- password -----
  if (step === "password") {
    return (
      <ScrollView keyboardShouldPersistTaps="handled">
        <Card>
          <Pressable onPress={() => setStep("pick")} hitSlop={8}>
            <Text style={s.link}>‹ Back to networks</Text>
          </Pressable>
          <Text style={[s.cardTitle, { marginTop: 12 }]}>
            {manual ? "Enter your network" : ssid}
          </Text>
          {manual && (
            <Field
              label="Network name (SSID)"
              value={ssid}
              onChangeText={setSsid}
              autoCapitalize="none"
              placeholder="e.g. Clinic-2.4G"
              autoFocus
            />
          )}
          <Field
            label="Wi-Fi password"
            value={pass}
            onChangeText={setPass}
            secure
            placeholder="Leave blank for an open network"
            autoFocus={!manual}
          />
          <Button title={submitLabel} onPress={submit} disabled={!ssid.trim()} />
        </Card>
      </ScrollView>
    );
  }

  // ----- progress -----
  if (step === "progress") {
    const st = progress?.state;
    return (
      <Card>
        <Step done={!!progress} label={`Sending Wi-Fi details for “${ssid}”`} />
        <Step
          done={["wifi_ok", "registering", "registered", "wifi_saved"].includes(st ?? "")}
          label={`Joining “${ssid}”${progress?.ip ? ` · ${progress.ip}` : ""}`}
        />
        <Step
          done={["registered", "wifi_saved"].includes(st ?? "")}
          label="Saving to the recorder"
        />
        <View style={{ marginTop: 10 }}>
          <ActivityIndicator color={D.sky} />
        </View>
      </Card>
    );
  }

  // ----- done -----
  if (step === "done") {
    return (
      <Card>
        <Pill text="DONE" tone="ok" />
        <Text style={[s.cardTitle, { marginTop: 10 }]}>{doneTitle}</Text>
        <Muted style={{ marginTop: 4 }}>{doneBody}</Muted>
        <View style={{ marginTop: 16 }}>
          <Button title="Finish" onPress={onDone} />
        </View>
      </Card>
    );
  }

  // ----- failed -----
  return (
    <Card>
      <Pill text="FAILED" tone="err" />
      <Muted style={{ marginTop: 10 }}>
        {error ?? "Something went wrong. Try again."}
      </Muted>
      <View style={{ marginTop: 16, gap: 10 }}>
        <Button title="Try again" onPress={() => setStep("password")} />
        <Button title="Pick another network" kind="secondary" onPress={scan} />
      </View>
    </Card>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <View style={s.stepLine}>
      <View style={{ width: 22 }}>
        <Feather
          name={done ? "check-circle" : "circle"}
          size={15}
          color={done ? D.green : D.sub}
        />
      </View>
      <Text style={{ color: done ? D.ink : D.sub, fontSize: 14, flex: 1 }}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  center: { alignItems: "center", paddingVertical: 22 },
  scanText: { color: D.ink, fontSize: 16, fontWeight: "700", marginTop: 14 },
  headRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  cardTitle: { color: D.ink, fontSize: 18, fontWeight: "800" },
  link: { color: D.sky, fontSize: 14, fontWeight: "700" },
  netRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: D.line,
  },
  netName: { color: D.ink, fontSize: 16, fontWeight: "600" },
  netBars: { color: D.sky, fontSize: 16, letterSpacing: 1 },
  manualRow: { paddingVertical: 14, marginTop: 4 },
  manualTxt: { color: D.sky, fontSize: 15, fontWeight: "700" },
  stepLine: { flexDirection: "row", alignItems: "center", marginVertical: 6 },
});
