import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { L816Session } from "./useL816Session";
import { l816DisplayName } from "./L816Link";
import { APP as D } from "../theme";

// A recorder transfer, shown WHERE THE USER IS.
//
// 🛑 It is a modal on purpose. The progress used to be a line of text and a bar
// inside the L816 screen, which is the one screen a user is almost never on
// while this runs: the whole point of the background link is that a take made
// with the phone in a pocket uploads by itself, so the transfer usually starts
// while the user is reading a report or on the dashboard. From there the app
// looked completely idle — no way to tell a recording was moving, how far along
// it was, or that closing the app would interrupt it.
//
// Two rules keep it from being a trap:
//
//   * it never blocks the transfer — `Hide` dismisses the sheet and the sweep
//     carries on untouched (the engine is at the root of the app, not here);
//   * it comes BACK for the next take. Hiding means "not this one", not
//     "never tell me again", because the next thing to arrive may be the
//     recording the user is actually waiting for.
//
// It shows no percentage for a phase that cannot be measured. Decoding and
// uploading have no progress the app can honestly report, and a bar creeping
// forward on a guess turns "I don't know how long this takes" into a promise.

export function L816TransferModal({ session }: { session: L816Session }) {
  const p = session.progress;
  const [hidden, setHidden] = useState(false);

  // One "showing" per transfer: the key changes when a new one starts, which is
  // what un-hides the sheet for the next take.
  const runId = useRef(0);
  const wasIdle = useRef(true);
  if (!p && !wasIdle.current) {
    wasIdle.current = true;
  } else if (p && wasIdle.current) {
    wasIdle.current = false;
    runId.current += 1;
  }
  const run = runId.current;
  const lastRun = useRef(run);
  if (lastRun.current !== run) {
    lastRun.current = run;
    if (hidden) setHidden(false);
  }

  const visible = !!p && !hidden;
  const pct = p?.phase === "downloading" ? Math.max(0, Math.min(100, p.percent)) : null;

  // An indeterminate phase gets a sweeping bar, not a fake percentage.
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible || pct !== null) return;
    slide.setValue(0);
    const loop = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [visible, pct, slide]);

  if (!visible || !p) return null;

  const name = l816DisplayName(session.model);
  const heading =
    p.phase === "downloading"
      ? `Getting the recording from your ${name}`
      : p.phase === "decoding"
        ? "Sending the recording to SATE"
        : "Working with your recorder";

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      // Android back must not feel like it cancelled the transfer, so it does
      // exactly what Hide does and says so on the button.
      onRequestClose={() => setHidden(true)}
      statusBarTranslucent
    >
      <View style={s.backdrop}>
        <View style={s.card}>
          <View style={s.head}>
            <View style={s.icon}>
              <Feather
                name={p.phase === "downloading" ? "download" : "upload-cloud"}
                size={18}
                color={D.sky}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{heading}</Text>
              <Text style={s.sub} numberOfLines={2}>
                {p.message}
              </Text>
            </View>
          </View>

          <View style={s.track}>
            {pct !== null ? (
              <View style={[s.fill, { width: `${pct}%` }]} />
            ) : (
              <Animated.View
                style={[
                  s.fill,
                  s.sweep,
                  {
                    transform: [
                      {
                        translateX: slide.interpolate({
                          inputRange: [0, 1],
                          outputRange: [-90, 260],
                        }),
                      },
                    ],
                  },
                ]}
              />
            )}
          </View>

          <Text style={s.pct}>
            {pct !== null ? `${Math.round(pct)}%` : "This can take a minute"}
          </Text>

          <Text style={s.note}>
            Keep the app open and the recorder nearby. Nothing is deleted from the
            recorder — a transfer that is interrupted starts again next time.
          </Text>

          {/* minWidth, not a hugging box: Android's Bold-text setting draws the
              font heavier than RN measured and clips the last glyph. */}
          <Pressable
            onPress={() => setHidden(true)}
            accessibilityRole="button"
            style={({ pressed }) => [s.hide, pressed && { opacity: 0.6 }]}
          >
            <Text style={s.hideTxt} numberOfLines={1}>
              Hide — it keeps going
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(9, 24, 23, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: D.panel,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: D.line,
    padding: 20,
  },
  head: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: D.skyBg,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: D.ink, fontSize: 16, fontWeight: "700" },
  sub: { color: D.sub, fontSize: 13.5, marginTop: 3, lineHeight: 19 },

  track: {
    height: 8,
    borderRadius: 99,
    backgroundColor: D.chip,
    marginTop: 18,
    overflow: "hidden",
  },
  fill: { height: 8, borderRadius: 99, backgroundColor: D.sky },
  sweep: { width: 90 },

  pct: { color: D.ink, fontSize: 13, fontWeight: "700", marginTop: 8 },
  note: { color: D.faint, fontSize: 12.5, lineHeight: 18, marginTop: 12 },

  hide: {
    marginTop: 16,
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: D.line,
    alignItems: "center",
    justifyContent: "center",
  },
  hideTxt: {
    color: D.sky,
    fontSize: 14.5,
    fontWeight: "700",
    minWidth: 170,
    textAlign: "center",
  },
});
