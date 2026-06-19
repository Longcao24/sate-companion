import { useEffect, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SateApi, makeApi, refreshSession } from "../api/sateApi";
import { FoundDevice, ProvisionProgress, SateLink } from "../ble/SateBle";
import { Card, GlassBackground, Muted, Pill, Title } from "../components/ui";
import { WifiSteps } from "../components/WifiSteps";
import { useStore } from "../store";
import { D } from "../theme";

// Two phases: (1) find the recorder over Bluetooth, then (2) the shared
// scan → choose network → password wizard (WifiSteps) which provisions it.
type Phase = "find" | "wifi";

export function ProvisionScreen({
  api,
  link,
  onClose,
}: {
  api: SateApi;
  link: SateLink;
  onClose: () => void;
}) {
  const { settings, update } = useStore();
  const [phase, setPhase] = useState<Phase>("find");
  const [found, setFound] = useState<FoundDevice[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // phase 1: scan for unprovisioned recorders over BLE
  useEffect(() => {
    if (phase !== "find") return;
    let active = true;
    link.requestPermissions().then((ok) => {
      if (!ok) {
        setError("Bluetooth permission is needed to find the recorder.");
        return;
      }
      try {
        link.startScan((d) => {
          if (!active || !d.unprovisioned) return;
          setFound((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d]));
        });
      } catch (e: any) {
        if (active) setError(e?.message ?? "Bluetooth unavailable");
      }
    });
    return () => {
      active = false;
      link.stopScan();
    };
  }, [phase, link]);

  const pickDevice = async (d: FoundDevice) => {
    setConnecting(d.id);
    setError(null);
    try {
      await link.connect(d.id);
      setPhase("wifi");
    } catch (e: any) {
      setError(e?.message ?? "Could not connect to the recorder");
    } finally {
      setConnecting(null);
    }
  };

  // Submit handler for the wizard: mint a claim token (binds the recorder to this
  // SLP account) then push Wi-Fi creds over BLE; the board joins + self-registers.
  const provisionSubmit = async (
    ssid: string,
    pass: string,
    onProgress: (p: ProvisionProgress) => void
  ): Promise<ProvisionProgress> => {
    let activeApi: SateApi = api;
    if (
      settings.refreshToken &&
      (!settings.tokenExpiresAt || Date.now() > settings.tokenExpiresAt - 60000)
    ) {
      try {
        const sess = await refreshSession(settings.refreshToken);
        update({
          token: sess.token,
          refreshToken: sess.refreshToken,
          tokenExpiresAt: sess.expiresAt,
        });
        activeApi = makeApi(settings.serverUrl, sess.token);
      } catch {
        /* surfaced below if claimToken then fails */
      }
    }

    const needsClaim = settings.serverUrl.includes("supabase.co");
    let claimToken = "";
    try {
      claimToken = await activeApi.claimToken();
    } catch {
      if (needsClaim) {
        return {
          state: "error",
          msg: "Your session expired. Sign out and sign in again, then retry.",
        };
      }
    }

    return link.provision(
      { ssid, pass, server: settings.serverUrl, claim_token: claimToken },
      onProgress
    );
  };

  const close = () => {
    link.disconnect().catch(() => {});
    onClose();
  };

  return (
    <KeyboardAvoidingView
      style={s.wrap}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <GlassBackground />
      <View style={s.header}>
        <Title>Set up a recorder</Title>
        <Pressable onPress={close} hitSlop={10}>
          <Text style={s.close}>Close</Text>
        </Pressable>
      </View>

      {error && <Text style={s.error}>{error}</Text>}

      {phase === "find" && (
        <>
          <Muted style={{ marginBottom: 10 }}>
            Plug in the recorder. New recorders appear here automatically.
          </Muted>
          <FlatList
            data={found}
            keyExtractor={(d) => d.id}
            ListEmptyComponent={<Muted>Looking for recorders nearby…</Muted>}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => pickDevice(item)}
                disabled={!!connecting}
                style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
              >
                <Card>
                  <View style={s.row}>
                    <Text style={s.devName}>{item.name}</Text>
                    <Pill
                      text={connecting === item.id ? "CONNECTING…" : "NEW"}
                      tone="info"
                    />
                  </View>
                  <Muted>
                    Signal {item.rssi} dBm ·{" "}
                    {connecting === item.id ? "connecting" : "tap to set up"}
                  </Muted>
                </Card>
              </Pressable>
            )}
          />
        </>
      )}

      {phase === "wifi" && (
        <WifiSteps
          link={link}
          onSubmit={provisionSubmit}
          successState="registered"
          submitLabel="Connect & set up"
          doneTitle="Recorder is connected"
          doneBody="It’s on Wi-Fi and saved to your account. It will upload sessions to SATE on its own."
          onDone={close}
        />
      )}
    </KeyboardAvoidingView>
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
});
