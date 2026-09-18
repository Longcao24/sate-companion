import React, { ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardTypeOptions,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
// 🛑 The palette is `APP`, not `D`.
//
// These components are shared by BOTH apps, and they are the reason the
// redesign leaked a black screen into a white one: `GlassBackground` paints a
// solid backdrop and `Card`/`Field`/`Button` carry their own surfaces, so a
// screen restyled to the light palette still came out dark underneath. `APP`
// IS `D` in SATE Companion — that build is byte-identical — and the light
// palette in SATE. Do not import `D` here again.
import { APP as D, radius } from "../theme";

// Apple-style grouped surface: a solid elevated card on the dark background with
// a hairline border. `raised` is a brighter fill for nested/elevated controls.
// `style` sizes the box (margins/width); `contentStyle` pads the contents.
export function Glass({
  children,
  style,
  contentStyle,
  r = radius.card,
  raised,
}: {
  children?: ReactNode;
  style?: any;
  contentStyle?: any;
  intensity?: number; // accepted for call-site compatibility; unused
  r?: number;
  raised?: boolean;
}) {
  return (
    <View
      style={[raised ? s.surfaceRaised : s.surface, { borderRadius: r }, style]}
    >
      <View style={contentStyle}>{children}</View>
    </View>
  );
}

// Solid dark backdrop behind a screen's content.
export function GlassBackground() {
  return <View style={s.base} pointerEvents="none" />;
}

// The SATE gradient mark (transparent PNG, reads on the dark theme). Square.
export function Logo({ size = 22, style }: { size?: number; style?: any }) {
  return (
    <Image
      source={require("../../assets/sate-mark.png")}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
    />
  );
}

export function Card({ children, style }: { children: ReactNode; style?: any }) {
  return (
    <Glass style={[s.cardBox, style]} contentStyle={s.cardPad}>
      {children}
    </Glass>
  );
}

export function Pill({
  text,
  tone,
}: {
  text: string;
  tone: "ok" | "warn" | "err" | "info";
}) {
  const map = {
    ok: { bg: D.greenBg, fg: D.green },
    warn: { bg: D.amberBg, fg: D.amber },
    err: { bg: D.redBg, fg: D.red },
    info: { bg: D.skyBg, fg: D.sky },
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
  const bg = kind === "primary" ? D.sky : kind === "danger" ? D.redBg : D.tile;
  const fg = kind === "primary" ? "#FFFFFF" : kind === "danger" ? D.red : D.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || loading) }}
      style={({ pressed }) => [
        s.btn,
        kind === "secondary" && s.btnBordered,
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
  keyboardType?: KeyboardTypeOptions;
  autoFocus?: boolean;
}) {
  // Reveal toggle for secure fields, so the SLP can check the Wi-Fi password.
  const [revealed, setRevealed] = React.useState(false);
  const hidden = !!props.secure && !revealed;
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.fieldLabel}>{props.label}</Text>
      <View style={props.secure ? s.inputRow : undefined}>
        <TextInput
          style={[s.input, props.secure && s.inputFlex]}
          value={props.value}
          onChangeText={props.onChangeText}
          placeholder={props.placeholder}
          placeholderTextColor={D.faint}
          secureTextEntry={hidden}
          autoCapitalize={props.autoCapitalize ?? "none"}
          autoCorrect={false}
          keyboardType={props.keyboardType}
          autoFocus={props.autoFocus}
        />
        {props.secure && (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={hidden ? "Show password" : "Hide password"}
            style={({ pressed }) => [s.eyeBtn, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Feather name={hidden ? "eye" : "eye-off"} size={18} color={D.sub} />
          </Pressable>
        )}
      </View>
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
  surface: {
    overflow: "hidden",
    backgroundColor: D.panel,
    borderWidth: 1,
    borderColor: D.line,
  },
  surfaceRaised: {
    overflow: "hidden",
    backgroundColor: D.tile,
    borderWidth: 1,
    borderColor: D.line,
  },
  cardBox: { marginBottom: 12 },
  cardPad: { padding: 14 },

  base: { ...StyleSheet.absoluteFillObject, backgroundColor: D.bg },
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
  btnBordered: { borderWidth: 1, borderColor: D.line },
  btnText: { fontSize: 15, fontWeight: "600" },
  fieldLabel: { fontSize: 12, color: D.sub, marginBottom: 5 },
  input: {
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: D.ink,
    backgroundColor: D.tile,
  },
  inputRow: { flexDirection: "row", alignItems: "center" },
  inputFlex: { flex: 1, paddingRight: 44 },
  eyeBtn: {
    position: "absolute",
    right: 6,
    height: 40,
    width: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  eyeGlyph: { fontSize: 18 },
  title: { fontSize: 22, fontWeight: "700", color: D.ink, marginBottom: 4 },
  muted: { fontSize: 13, color: D.sub },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: D.tile,
    overflow: "hidden",
    marginTop: 8,
  },
  barFill: { height: 8, borderRadius: 4, backgroundColor: D.sky },
});
