import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import { makeApi } from "../api/sateApi";
import { Button, Card, Field, GlassBackground, Muted } from "../components/ui";
import { useStore } from "../store";
import { D } from "../theme";

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
      const api = makeApi(serverUrl.trim(), null);
      const { token, user } = await api.login(email.trim(), password);
      update({ serverUrl: serverUrl.trim(), token, user });
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <GlassBackground />
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={s.logo}>
          SATE <Text style={{ color: D.sky }}>Companion</Text>
        </Text>
        <Muted style={{ marginBottom: 24 }}>
          Sign in with your SATE account - the same one you use on the web.
          Recorders you set up are saved to this account.
        </Muted>

        <Card>
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secure
          />
          <Field
            label="Server URL"
            value={serverUrl}
            onChangeText={setServerUrl}
            keyboardType="url"
          />
          {error && <Text style={s.error}>{error}</Text>}
          <Button title="Sign in" onPress={signIn} loading={busy} />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 20, paddingTop: 80 },
  logo: { fontSize: 30, fontWeight: "800", color: D.ink, marginBottom: 6 },
  error: { color: D.red, fontSize: 13, marginBottom: 4 },
});
