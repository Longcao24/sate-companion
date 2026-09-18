import { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text as RNText,
  TextProps,
  View,
  ViewStyle,
} from "react-native";
import { FONT, R, S, TAP } from "../theme";

// The SATE app's UI kit — the 2026-09 redesign.
//
// Kept apart from `src/components/ui.tsx` on purpose: that file is shared with
// SATE Companion, which still wears the dark console look. One file per visual
// language means restyling the reading app cannot silently restyle screens in
// the other app that nobody asked to change.
//
// Everything here is presentation. Nothing in this file knows what a recorder
// is, and nothing in it may import a link, a session or the API.

// ---------------------------------------------------------------- type scale

type TxtProps = TextProps & { children: ReactNode };

/** Screen title — "Sessions", "Settings". */
export const H1 = ({ style, ...p }: TxtProps) => <RNText {...p} style={[t.h1, style]} />;
/** Card title — "What we heard". */
export const H2 = ({ style, ...p }: TxtProps) => <RNText {...p} style={[t.h2, style]} />;
/** Row title — a session name. */
export const H3 = ({ style, ...p }: TxtProps) => <RNText {...p} style={[t.h3, style]} />;
/** Body copy. Reads at a distance; used for anything explanatory. */
export const Body = ({ style, ...p }: TxtProps) => <RNText {...p} style={[t.body, style]} />;
/** Secondary line under a title — dates, durations, counts. */
export const Meta = ({ style, ...p }: TxtProps) => <RNText {...p} style={[t.meta, style]} />;
/** The uppercase section label above a group. */
export const SectionLabel = ({ style, ...p }: TxtProps) => (
  <RNText {...p} style={[t.section, style]} />
);
/** A big number in a stat tile. */
export const Stat = ({ style, ...p }: TxtProps) => <RNText {...p} style={[t.stat, style]} />;

// ------------------------------------------------------------------ surfaces

/** The white card everything sits in. */
export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode;
  style?: ViewStyle | ViewStyle[];
  onPress?: () => void;
}) {
  if (!onPress) return <View style={[t.card, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [t.card, pressed && t.cardPressed, style]}
    >
      {children}
    </Pressable>
  );
}

/** The inset tile inside a card — battery, uploads, recorded, length. */
export function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={t.tile}>
      <RNText style={t.tileLabel}>{label.toUpperCase()}</RNText>
      <View style={{ marginTop: 7 }}>{children}</View>
    </View>
  );
}

// -------------------------------------------------------------------- status

export type Tone = "ok" | "go" | "warn" | "bad" | "idle";

const TONES: Record<Tone, { dot: string; bg: string; ink: string }> = {
  ok: { dot: S.okDot, bg: S.okBg, ink: S.okInk },
  go: { dot: S.goDot, bg: S.goBg, ink: S.goInk },
  warn: { dot: S.warnDot, bg: S.warnBg, ink: S.warnInk },
  bad: { dot: S.badDot, bg: S.badBg, ink: S.badInk },
  idle: { dot: S.idleDot, bg: S.idleBg, ink: S.idleInk },
};

/**
 * A status pill. 🛑 The five tones are fixed and mean the same thing everywhere:
 * ok = finished, go = working, warn = needs a person, bad = failed, idle =
 * nothing happening. A screen that invents a sixth meaning breaks the only
 * thing a colour is good for.
 */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = TONES[tone];
  return (
    <View style={[t.pill, { backgroundColor: c.bg }]}>
      <View style={[t.pillDot, { backgroundColor: c.dot }]} />
      <RNText style={[t.pillTxt, { color: c.ink }]}>{children}</RNText>
    </View>
  );
}

/** Progress that is a real fraction of something countable. */
export function Meter({ pct, tone = "go" }: { pct: number; tone?: Tone }) {
  const c = TONES[tone];
  return (
    <View style={[t.meterTrack, { backgroundColor: c.bg }]}>
      <View
        style={[
          t.meterFill,
          { width: `${Math.max(0, Math.min(100, pct))}%`, backgroundColor: c.dot },
        ]}
      />
    </View>
  );
}

// ------------------------------------------------------------------- buttons

type BtnKind = "primary" | "dark" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  kind = "primary",
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: BtnKind;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const box =
    kind === "primary" ? t.bPrimary : kind === "dark" ? t.bDark : kind === "danger" ? t.bDanger : t.bGhost;
  const ink =
    kind === "primary" || kind === "dark" ? t.bInkOn : kind === "danger" ? t.bInkDanger : t.bInkOff;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      style={({ pressed }) => [t.bBase, box, (pressed || disabled || loading) && { opacity: 0.72 }, style]}
    >
      {loading ? (
        <ActivityIndicator color={kind === "primary" || kind === "dark" ? "#FFFFFF" : S.teal} />
      ) : (
        // minWidth + centring, not a hugging box: Android's Bold text setting
        // draws fonts heavier than the metrics RN measured, and a label sized to
        // its own measured width loses its last character. See CLAUDE.md.
        <RNText style={[t.bTxt, ink]} numberOfLines={1}>
          {title}
        </RNText>
      )}
    </Pressable>
  );
}

/** The segmented control above a report's tabs. */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <View style={t.segTrack}>
      {items.map((it) => {
        const on = it.id === value;
        return (
          <Pressable
            key={it.id}
            onPress={() => onChange(it.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [t.seg, on && t.segOn, pressed && { opacity: 0.8 }]}
          >
            <RNText style={[t.segTxt, on && t.segTxtOn]} numberOfLines={1}>
              {it.label}
            </RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

const t = StyleSheet.create({
  h1: { fontFamily: FONT.extra, fontSize: 25, letterSpacing: -0.6, color: S.ink, lineHeight: 30 },
  h2: { fontFamily: FONT.extra, fontSize: 17.5, letterSpacing: -0.2, color: S.ink },
  h3: { fontFamily: FONT.extra, fontSize: 16, color: S.ink },
  body: { fontFamily: FONT.regular, fontSize: 14.5, lineHeight: 22, color: S.sub },
  meta: { fontFamily: FONT.regular, fontSize: 13, color: S.sub },
  section: {
    fontFamily: FONT.extra,
    fontSize: 12,
    letterSpacing: 0.9,
    color: S.mute,
  },
  stat: { fontFamily: FONT.extra, fontSize: 26, letterSpacing: -1, color: S.ink },

  card: {
    backgroundColor: S.card,
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: S.line,
    padding: 18,
    // The design's shadow is barely there on purpose — it separates the card
    // from the ground without making the screen look stacked.
    shadowColor: "#12211F",
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  cardPressed: { borderColor: "#C9D8D7" },

  tile: { flex: 1, backgroundColor: S.tile, borderRadius: R.tile, padding: 12, minWidth: 100 },
  tileLabel: { fontFamily: FONT.extra, fontSize: 11, letterSpacing: 0.5, color: S.mute },

  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: R.pill,
    paddingVertical: 7,
    paddingLeft: 10,
    paddingRight: 12,
    alignSelf: "flex-start",
  },
  pillDot: { width: 8, height: 8, borderRadius: 99 },
  pillTxt: { fontFamily: FONT.extra, fontSize: 12.5 },

  meterTrack: { height: 8, borderRadius: 99, overflow: "hidden" },
  meterFill: { height: "100%", borderRadius: 99 },

  bBase: {
    minHeight: TAP.button,
    borderRadius: R.button,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  bPrimary: { backgroundColor: S.teal },
  bDark: { backgroundColor: S.ink },
  bGhost: { backgroundColor: S.card, borderWidth: 1.5, borderColor: "#DDE5E4" },
  bDanger: { backgroundColor: S.card, borderWidth: 1.5, borderColor: S.badLine },
  bTxt: { fontFamily: FONT.bold, fontSize: 15.5, minWidth: 40, textAlign: "center" },
  bInkOn: { color: "#FFFFFF" },
  bInkOff: { color: S.ink },
  bInkDanger: { color: S.badInk },

  segTrack: { flexDirection: "row", gap: 6, backgroundColor: S.sunken, borderRadius: R.button, padding: 4 },
  seg: {
    flex: 1,
    minHeight: TAP.tap,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  segOn: {
    backgroundColor: S.card,
    shadowColor: "#12211F",
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  segTxt: { fontFamily: FONT.extra, fontSize: 13.5, color: S.mute },
  segTxtOn: { color: S.ink },
});
