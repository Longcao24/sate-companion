import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { DEVICE_API_URL, consumeMobileLink, makeApi } from "../api/sateApi";
import { Button, Card, Field, GlassBackground, Logo, Muted } from "../components/ui";
import { IS_SATE_APP } from "../sate/variant";
import { QrScannerModal } from "../components/QrScannerModal";
import { useStore } from "../store";
import { D } from "../theme";

// Two ways in: the traditional email + password, or a one-time code / QR
// generated in the SATE web app ("sign in on phone").
type Method = "password" | "quick";

export function LoginScreen() {
  const { settings, update } = useStore();
  const [method, setMethod] = useState<Method>("password");

  // Starts EMPTY. It used to be pre-filled with a fake clinician's address, which
  // in a shipped build reads as someone else's account already signed in - and it
  // is one tap away from being submitted by a user who did not notice.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      // Server is fixed to the bundled SATE backend - not user-editable.
      const api = makeApi(DEVICE_API_URL, null);
      const { token, refreshToken, expiresAt, user } = await api.login(
        email.trim(),
        password
      );
      update({
        serverUrl: DEVICE_API_URL,
        token,
        refreshToken,
        tokenExpiresAt: expiresAt,
        user,
        // Whatever ended the last session, it is answered now.
        signedOutReason: null,
      });
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  // Exchange a one-time code (typed or scanned) for a real session.
  const quickSignIn = async (raw?: string) => {
    const c = (raw ?? code).trim();
    if (!c) {
      setError("Enter or scan the code from the SATE web app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token, refreshToken, expiresAt, user } = await consumeMobileLink(c);
      update({
        serverUrl: DEVICE_API_URL,
        token,
        refreshToken,
        tokenExpiresAt: expiresAt,
        user,
        // Whatever ended the last session, it is answered now.
        signedOutReason: null,
      });
    } catch (e: any) {
      setError(e?.message ?? "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (scanned: string) => {
    setScanning(false);
    setCode(scanned);
    quickSignIn(scanned);
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
        {/* Why the app is asking again. Without this, a session ended somewhere
            else — a web sign-out, a password change — lands the user on a login
            form with no explanation, which reads as the app losing sessions at
            random. */}
        {!!settings.signedOutReason && (
          <View style={s.notice}>
            <Text style={s.noticeTxt}>{settings.signedOutReason}</Text>
          </View>
        )}
        {/* One login screen, two apps. The wording has to match what the user
            is signing in to: SATE is for reading reports, Companion is for
            setting hardware up, and telling a SATE user their "recorders are
            saved to this account" describes a screen they will never open. */}
        <View style={s.brandRow}>
          <Logo size={48} />
          {IS_SATE_APP ? (
            <Text style={s.logo}>SATE</Text>
          ) : (
            <Text style={s.logo}>
              SATE <Text style={{ color: D.sky }}>Companion</Text>
            </Text>
          )}
        </View>
        <Muted style={{ marginBottom: 20 }}>
          {IS_SATE_APP
            ? "Sign in with your SATE account - the same one you use on the web. " +
              "Your reports appear here as soon as SATE has finished processing them."
            : "Sign in with your SATE account - the same one you use on the web. " +
              "Recorders you set up are saved to this account."}
        </Muted>

        {/* Method switch */}
        <View style={s.tabs}>
          <Tab
            label="Password"
            active={method === "password"}
            onPress={() => {
              setMethod("password");
              setError(null);
            }}
          />
          <Tab
            label="Quick sign-in"
            active={method === "quick"}
            onPress={() => {
              setMethod("quick");
              setError(null);
            }}
          />
        </View>

        <Card>
          {method === "password" ? (
            <>
              <Field
                label="Email"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Field
                label="Password"
                value={password}
                onChangeText={setPassword}
                secure
              />
              {error && <Text style={s.error}>{error}</Text>}
              <Button title="Sign in" onPress={signIn} loading={busy} />
            </>
          ) : (
            <>
              <Muted style={{ marginBottom: 14 }}>
                In the SATE web app, open your profile and choose “Sign in on
                phone”. Scan the QR code, or type the code shown below.
              </Muted>
              <Button
                title="Scan QR code"
                onPress={() => {
                  setError(null);
                  setScanning(true);
                }}
                disabled={busy}
              />
              <View style={{ height: 12 }} />
              <Field
                label="Or enter code"
                value={code}
                onChangeText={(v) => setCode(v.toUpperCase())}
                placeholder="XXXX-XXXX"
                autoCapitalize="none"
              />
              {error && <Text style={s.error}>{error}</Text>}
              <Button title="Sign in" onPress={() => quickSignIn()} loading={busy} />
            </>
          )}
        </Card>
      </ScrollView>

      <QrScannerModal
        visible={scanning}
        onClose={() => setScanning(false)}
        onScanned={onScanned}
      />
    </KeyboardAvoidingView>
  );
}

function Tab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.tab,
        active && s.tabActive,
        { opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[s.tabText, active && s.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 20, paddingTop: 80 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  logo: { fontSize: 28, fontWeight: "800", color: D.ink },
  error: { color: D.red, fontSize: 13, marginBottom: 4 },
  notice: {
    backgroundColor: D.amberBg,
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  noticeTxt: { color: D.amber, fontSize: 13, lineHeight: 19 },
  tabs: {
    flexDirection: "row",
    backgroundColor: D.tile,
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 9,
  },
  tabActive: { backgroundColor: D.sky },
  tabText: { color: D.ink, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: "#FFFFFF" },
});
