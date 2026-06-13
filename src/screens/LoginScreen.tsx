import React, { useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";
import { makeApi } from "../api/sateApi";
import { Button, Card, Field, Muted, Title } from "../components/ui";
import { useStore } from "../store";
import { C } from "../theme";

export function LoginScreen() {
  const { settings, update } = useStore();
  const [email, setEmail] = useState("morgan@clinic.example.com");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const api = makeApi(serverUrl, null, settings.demoMode);
      const { token, user } = await api.login(email.trim(), password);
      update({ serverUrl, token, user });
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.wrap}>
      <Text style={s.logo}>
        SATE <Text style={{ color: C.sky }}>Companion</Text>
      </Text>
      <Muted style={{ marginBottom: 24 }}>
        Sign in with your SATE account - the same one you use on the web.
        Recorders you set up are saved to this account.
      </Muted>

      <Card>
        <Field label="Email" value={email} onChangeText={setEmail} />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secure
          placeholder={settings.demoMode ? "anything works in demo mode" : ""}
        />
        {!settings.demoMode && (
          <Field label="Server URL" value={serverUrl} onChangeText={setServerUrl} />
        )}
        {error && <Text style={s.error}>{error}</Text>}
        <Button title="Sign in" onPress={signIn} loading={busy} />
      </Card>

      <View style={s.demoRow}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.ink, fontSize: 14 }}>Demo mode</Text>
          <Muted>No backend or hardware needed</Muted>
        </View>
        <Switch
          value={settings.demoMode}
          onValueChange={(v) => update({ demoMode: v })}
          trackColor={{ true: C.sky, false: C.line }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 80 },
  logo: { fontSize: 30, fontWeight: "800", color: C.navy, marginBottom: 6 },
  error: { color: C.red, fontSize: 13, marginBottom: 4 },
  demoRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    marginTop: 8,
  },
});
