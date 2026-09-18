import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import Constants from "expo-constants";
import { Feather } from "@expo/vector-icons";
import { useStore } from "../store";
import { FONT, R, S, TAP } from "../theme";
import { Body, Card, H1, H2, Meta, SectionLabel } from "./ui";

// SATE's own Settings.
//
// It is a separate screen from `src/screens/SettingsScreen.tsx` rather than a
// restyle of it, for the same reason the dashboard is: that screen is SATE
// Companion's, it is written in the dark palette, and the two apps do not have
// the same settings. Companion sets hardware up, so its switch is about the
// radio; SATE reads reports, so this one is about the account, what the app is
// doing on your behalf, and how to get help. Sharing one screen meant every
// addition to either app had to be justified to the other.
//
// Everything here is a row in a card, and every row either shows a fact or does
// exactly one thing. Nothing on this page is a menu that opens another menu.

export function SateSettingsScreen({
  onOpenDevices,
  deviceCount,
}: {
  onOpenDevices: () => void;
  /** Paired hardware, shown so the row says what is behind it before it is tapped. */
  deviceCount: number;
}) {
  const { settings, update, signOut } = useStore();
  const [signingOut, setSigningOut] = useState(false);

  const user = settings.user;
  const email = user?.email?.trim() ?? "";
  const rawName = user?.name?.trim() ?? "";
  // A SATE account often has no display name, and the server fills `name` with
  // the address — so printing both put the same string on two lines and made the
  // card look broken. A name is only a name when it is not the email.
  const hasName = !!rawName && rawName.toLowerCase() !== email.toLowerCase();
  const title = hasName ? rawName : email || "Signed in";
  const sub = hasName ? email : "";
  // Two letters: one is ambiguous at this size, three stops being a monogram.
  // From the words of a real name — but from the address's local part when there
  // is none, because splitting an email on its punctuation takes a letter from
  // the provider and reads as someone else's initials.
  const initials = (
    hasName
      ? rawName
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0]!)
          .join("")
      : (email.split("@")[0] || "S").slice(0, 2)
  ).toUpperCase();

  const version = Constants.expoConfig?.version ?? "—";
  const build = Constants.expoConfig?.android?.versionCode;

  // Sign-out ASKS. It is the one control on this page that cannot be undone
  // without the account password, and it sits two taps from the report the user
  // was reading.
  const confirmSignOut = () =>
    Alert.alert(
      "Sign out of SATE?",
      "Your reports stay on the server. You will need your email and password " +
        "to sign back in, and any recorder paired to this phone will stop " +
        "syncing until you do.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            setSigningOut(true);
            signOut();
          },
        },
      ]
    );

  return (
    <View style={s.wrap}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
      >
        <H1 style={s.title}>Settings</H1>

        {/* ------------------------------------------------------- account */}
        <Card style={s.card}>
          <View style={s.idRow}>
            <View style={s.avatar}>
              <Body style={s.avatarTxt}>{initials}</Body>
            </View>
            <View style={s.idText}>
              <H2 numberOfLines={1}>{title}</H2>
              {!!sub && (
                <Meta numberOfLines={1} style={s.idMail}>
                  {sub}
                </Meta>
              )}
            </View>
          </View>
          <View style={s.hair} />
          <Row icon="cloud" label="Account" value="SATE cloud" />
        </Card>

        {/* -------------------------------------------------------- syncing */}
        <SectionLabel style={s.label}>Syncing</SectionLabel>
        <Card style={s.card}>
          <View style={s.switchRow}>
            <View style={s.switchIcon}>
              <Feather name="bluetooth" size={16} color={S.teal} />
            </View>
            <View style={s.switchText}>
              <H2>Auto-sync over Bluetooth</H2>
              <Body style={s.help}>
                While this app is open, recorders with no Wi-Fi are synced to SATE
                automatically through your phone.
              </Body>
            </View>
            <Switch
              value={settings.autoSync}
              onValueChange={(v) => update({ autoSync: v })}
              trackColor={{ true: S.teal, false: S.sunken }}
              thumbColor="#FFFFFF"
              ios_backgroundColor={S.sunken}
            />
          </View>
          <View style={s.hair} />
          <Row
            icon="radio"
            label="Recorders"
            value={
              deviceCount === 0
                ? "None paired"
                : `${deviceCount} paired`
            }
            onPress={onOpenDevices}
          />
        </Card>

        {/* ----------------------------------------------------------- help */}
        <SectionLabel style={s.label}>About</SectionLabel>
        <Card style={s.card}>
          <Row
            icon="info"
            label="Version"
            value={build ? `${version} (${build})` : version}
          />
          <View style={s.hair} />
          <Row
            icon="help-circle"
            label="Support"
            value="sate.ai"
            onPress={() => Linking.openURL("https://sate.ai").catch(() => {})}
          />
        </Card>

        {/* --------------------------------------------------------- danger */}
        <Pressable
          onPress={confirmSignOut}
          disabled={signingOut}
          accessibilityRole="button"
          style={({ pressed }) => [s.signOut, (pressed || signingOut) && { opacity: 0.7 }]}
        >
          <Feather name="log-out" size={16} color={S.badInk} />
          {/* minWidth, not a hugging box: Android's Bold-text setting draws the
              font heavier than RN measured and clips the last glyph. */}
          <Body style={s.signOutTxt} numberOfLines={1}>
            Sign out
          </Body>
        </Pressable>

        <Meta style={s.foot}>
          SATE keeps clinical recordings on your account, not on this phone.
        </Meta>
      </ScrollView>
    </View>
  );
}

/** One fact, or one thing to do. A chevron appears only when it is tappable. */
function Row({
  icon,
  label,
  value,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const body = (
    <>
      <View style={s.rowIcon}>
        <Feather name={icon} size={16} color={S.teal} />
      </View>
      <Body style={s.rowLabel}>{label}</Body>
      <Meta style={s.rowValue} numberOfLines={1}>
        {value}
      </Meta>
      {!!onPress && <Feather name="chevron-right" size={17} color={S.ghost} />}
    </>
  );
  if (!onPress) return <View style={s.row}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}
    >
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: S.bg },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 64, paddingBottom: 32 },
  title: { marginBottom: 18 },
  label: { marginTop: 22, marginBottom: 8, marginLeft: 4 },
  card: { marginBottom: 2 },

  idRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: R.pill,
    backgroundColor: S.tealTint,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTxt: { fontFamily: FONT.extra, fontSize: 17, color: S.tealDeep },
  idText: { flex: 1 },
  idMail: { marginTop: 2 },

  hair: { height: 1, backgroundColor: S.hair, marginVertical: 14 },

  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: TAP.tap - 12 },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: R.chip,
    backgroundColor: S.tealTint,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: { flex: 1, fontFamily: FONT.semi, color: S.ink },
  rowValue: { maxWidth: "45%", textAlign: "right" },

  switchRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  switchIcon: {
    width: 30,
    height: 30,
    borderRadius: R.chip,
    backgroundColor: S.tealTint,
    alignItems: "center",
    justifyContent: "center",
  },
  switchText: { flex: 1, paddingRight: 4 },
  help: { color: S.sub, marginTop: 4 },

  signOut: {
    marginTop: 26,
    minHeight: TAP.button,
    borderRadius: R.button,
    borderWidth: 1,
    borderColor: S.badLine,
    backgroundColor: S.badBg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  signOutTxt: { fontFamily: FONT.extra, color: S.badInk, minWidth: 66, textAlign: "center" },

  foot: { marginTop: 16, textAlign: "center", color: S.ghost },
});
