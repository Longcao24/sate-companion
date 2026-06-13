import React, { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { C, radius } from "../theme";

export function Card({ children, style }: { children: ReactNode; style?: any }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Pill({
  text,
  tone,
}: {
  text: string;
  tone: "ok" | "warn" | "err" | "info";
}) {
  const map = {
    ok: { bg: C.greenBg, fg: C.green },
    warn: { bg: C.amberBg, fg: C.amber },
    err: { bg: C.redBg, fg: C.red },
    info: { bg: C.ice, fg: C.navy },
  }[tone];
  return (
    <View style={[s.pill, { backgroundColor: map.bg }]}>
      <Text style={[s.pillText, { color: map.fg }]}>{text}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  loading,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
}) {
  const bg =
    kind === "primary" ? C.sky : kind === "danger" ? C.redBg : C.ice;
  const fg =
    kind === "primary" ? "#FFFFFF" : kind === "danger" ? C.red : C.navy;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.btn,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[s.btnText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field(props: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  autoCapitalize?: "none" | "sentences";
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.fieldLabel}>{props.label}</Text>
      <TextInput
        style={s.input}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={C.slate}
        secureTextEntry={props.secure}
        autoCapitalize={props.autoCapitalize ?? "none"}
        autoCorrect={false}
      />
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={s.title}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: any }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <View style={s.barTrack}>
      <View style={[s.barFill, { width: `${Math.min(100, value * 100)}%` }]} />
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.mist,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: 14,
    marginBottom: 12,
  },
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  pillText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  btn: {
    borderRadius: radius.button,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  btnText: { fontSize: 15, fontWeight: "600" },
  fieldLabel: { fontSize: 12, color: C.slate, marginBottom: 5 },
  input: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: C.ink,
    backgroundColor: "#FFFFFF",
  },
  title: { fontSize: 22, fontWeight: "700", color: C.navy, marginBottom: 4 },
  muted: { fontSize: 13, color: C.slate },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: C.line,
    overflow: "hidden",
    marginTop: 8,
  },
  barFill: { height: 8, borderRadius: 4, backgroundColor: C.sky },
});
