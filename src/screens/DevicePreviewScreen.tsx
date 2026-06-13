import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GlassBackground } from "../components/ui";
import { C, D, radius } from "../theme";

// A self-contained, hardware-free replica of the SATE Recorder's on-screen UI
// plus the physical unit, so SLPs (and demos) can see and "feel" how the device
// behaves before they ever hold one. Everything here is a local simulation -
// no server, no BLE - driven by a small idle -> recording -> uploading state
// machine that mirrors the real firmware flow.

type Phase = "ready" | "recording" | "uploading" | "synced";

interface DemoPatient {
  patient_id: string;
  name: string;
  age: string;
  session_type: string;
  clinician: string;
}

const PATIENTS: DemoPatient[] = [
  {
    patient_id: "PT-1001",
    name: "Maya Nguyen",
    age: "7y 4m",
    session_type: "Articulation",
    clinician: "Dr. Taylor",
  },
  {
    patient_id: "PT-1002",
    name: "Liam Carter",
    age: "5y 9m",
    session_type: "Fluency",
    clinician: "Dr. Taylor",
  },
  {
    patient_id: "PT-1003",
    name: "Ava Rodriguez",
    age: "9y 1m",
    session_type: "Phonology",
    clinician: "Dr. Singh",
  },
];

const RECORD_MS = 3000;
const UPLOAD_MS: number = 1400;

export function DevicePreviewScreen({ onClose }: { onClose: () => void }) {
  const [patientIdx, setPatientIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [sessions, setSessions] = useState(2);
  const [pending, setPending] = useState(1);
  const [showSessions, setShowSessions] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds shown during recording
  const patient = PATIENTS[patientIdx];

  // Animations: ring spins while busy, red dot pulses while recording.
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  const busy = phase === "recording" || phase === "uploading";

  useEffect(() => {
    if (busy) {
      spin.setValue(0);
      spinLoop.current = Animated.loop(
        Animated.timing(spin, {
          toValue: 1,
          duration: 1100,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      spinLoop.current.start();
    } else {
      spinLoop.current?.stop();
      Animated.timing(spin, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [busy]);

  useEffect(() => {
    if (phase === "recording") {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1.35,
            duration: 550,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: 550,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      pulseLoop.current.start();
    } else {
      pulseLoop.current?.stop();
      Animated.timing(pulse, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [phase]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      if (tick.current) clearInterval(tick.current);
    },
    []
  );

  const after = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const record = () => {
    if (busy) return;
    setShowSessions(false);
    setPhase("recording");
    setElapsed(0);
    let s = 0;
    tick.current = setInterval(() => {
      s += 1;
      setElapsed(s);
    }, 1000);
    after(RECORD_MS, () => {
      if (tick.current) clearInterval(tick.current);
      setPhase("uploading");
      after(UPLOAD_MS, () => {
        setSessions((n) => n + 1);
        setPending((n) => n + 1);
        setPhase("ready");
      });
    });
  };

  const next = () => {
    if (busy) return;
    setPatientIdx((i) => (i + 1) % PATIENTS.length);
  };

  const sync = () => {
    if (busy || pending === 0) return;
    setPhase("uploading");
    after(UPLOAD_MS, () => {
      setPending(0);
      setPhase("synced");
      after(1200, () => setPhase("ready"));
    });
  };

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const status =
    phase === "recording"
      ? { text: "REC", tone: C.red, bg: C.redBg }
      : phase === "uploading"
      ? { text: "SYNC…", tone: C.navy, bg: C.ice }
      : phase === "synced"
      ? { text: "SENT", tone: C.green, bg: C.greenBg }
      : { text: "READY", tone: C.green, bg: C.greenBg };

  return (
    <View style={s.flex}>
      <GlassBackground />
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
        <View style={s.header}>
        <Text style={s.h1}>Device preview</Text>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Text style={s.close}>Back</Text>
        </Pressable>
      </View>
      <Text style={s.lead}>
        A live mock of the recorder's touchscreen. Tap its buttons to see exactly
        what the SLP sees on the unit - no hardware needed.
      </Text>

      {/* ----- the device's on-screen UI (240x320 screen, scaled up) ----- */}
      <View style={s.screenBezel}>
        <View style={s.screen}>
          <View style={s.scrHeader}>
            <Text style={s.scrBrand}>SATE Recorder</Text>
            <View style={[s.scrPill, { backgroundColor: status.bg }]}>
              <Text style={[s.scrPillTxt, { color: status.tone }]}>
                {status.text}
              </Text>
            </View>
          </View>
          <View style={s.scrDivider} />

          {showSessions ? (
            <View style={s.sessList}>
              <Text style={s.sessTitle}>Sessions on device</Text>
              {Array.from({ length: sessions }).map((_, i) => {
                const n = sessions - i;
                const unsynced = i < pending;
                return (
                  <View key={n} style={s.sessRow}>
                    <Text style={s.sessRowTxt}>
                      #{n} · {patient.patient_id}
                    </Text>
                    <Text
                      style={[
                        s.sessTag,
                        { color: unsynced ? C.amber : C.green },
                      ]}
                    >
                      {unsynced ? "pending" : "synced"}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : (
            <View style={s.patientCard}>
              <View style={s.patientTop}>
                <Text style={s.patientName}>{patient.name}</Text>
                <View style={s.idChip}>
                  <Text style={s.idChipTxt}>{patient.patient_id}</Text>
                </View>
              </View>
              <Text style={s.patientLine}>Age: {patient.age}</Text>
              <Text style={s.patientLine}>
                Session: {patient.session_type}
              </Text>
              <Text style={s.patientLine}>SLP: {patient.clinician}</Text>
            </View>
          )}

          <Text style={s.scrCount}>
            {phase === "recording"
              ? `Recording…  ${elapsed}s`
              : phase === "uploading"
              ? "Sending to SATE…"
              : `${sessions} sessions · ${pending} pending sync`}
          </Text>
          {phase === "ready" && (
            <Text style={s.scrHint}>
              {pending > 0 ? "Tap Sync to send to SATE" : "All sessions synced"}
            </Text>
          )}

          <View style={s.scrBtnRow}>
            <ScreenBtn
              label="● Record"
              kind="primary"
              disabled={busy}
              onPress={record}
            />
            <ScreenBtn label="Next ›" kind="soft" disabled={busy} onPress={next} />
          </View>
          <View style={s.scrBtnRow}>
            <ScreenBtn
              label="≡ Sessions"
              kind="soft"
              disabled={busy}
              onPress={() => setShowSessions((v) => !v)}
            />
            <ScreenBtn
              label="⤢ Sync"
              kind="success"
              disabled={busy || pending === 0}
              onPress={sync}
            />
          </View>
        </View>
      </View>

      {/* ----- the physical unit: spins while busy, dot pulses on record ----- */}
      <Text style={s.deviceWord}>S A T E</Text>
      <View style={s.deviceWrap}>
        <View style={s.ringTrack} />
        <Animated.View
          style={[s.ringAccent, { transform: [{ rotate }] }]}
        />
        <Animated.View
          style={[
            s.recDot,
            {
              transform: [{ scale: pulse }],
              backgroundColor: phase === "recording" ? C.red : D.faint,
              opacity: phase === "recording" ? 1 : 0.4,
            },
          ]}
        />
      </View>
      <Text style={s.deviceCaption}>
        {phase === "recording"
          ? "Capturing audio…"
          : phase === "uploading"
          ? "Uploading over Wi-Fi…"
          : phase === "synced"
          ? "Uploaded ✓"
          : "Idle · ready to record"}
        </Text>
      </ScrollView>
    </View>
  );
}

function ScreenBtn({
  label,
  kind,
  onPress,
  disabled,
}: {
  label: string;
  kind: "primary" | "soft" | "success";
  onPress: () => void;
  disabled?: boolean;
}) {
  const bg =
    kind === "primary" ? C.sky : kind === "success" ? C.green : C.ice;
  const fg = kind === "soft" ? C.navy : "#FFFFFF";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.scrBtn,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={[s.scrBtnTxt, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingTop: 56, paddingBottom: 48 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  h1: { fontSize: 22, fontWeight: "700", color: D.ink },
  close: { color: D.sky, fontSize: 14, fontWeight: "600" },
  lead: { fontSize: 13, color: D.sub, marginBottom: 18, lineHeight: 18 },

  // device screen frame
  screenBezel: {
    backgroundColor: "#0B1220",
    borderRadius: 26,
    padding: 10,
    alignSelf: "center",
    width: "100%",
    maxWidth: 320,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  screen: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 14,
    minHeight: 360,
  },
  scrHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  scrBrand: { fontSize: 17, fontWeight: "800", color: C.navy },
  scrPill: {
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  scrPillTxt: { fontSize: 11, fontWeight: "800", letterSpacing: 0.6 },
  scrDivider: {
    height: 1,
    backgroundColor: C.line,
    marginTop: 10,
    marginBottom: 12,
  },

  patientCard: {
    backgroundColor: C.mist,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  patientTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  patientName: { fontSize: 18, fontWeight: "800", color: C.ink },
  idChip: {
    backgroundColor: C.ice,
    borderRadius: radius.chip,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  idChipTxt: { fontSize: 12, fontWeight: "700", color: C.navy },
  patientLine: { fontSize: 13, color: C.slate, marginTop: 3 },

  sessList: {
    backgroundColor: C.mist,
    borderColor: C.line,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  sessTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: C.ink,
    marginBottom: 6,
  },
  sessRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  sessRowTxt: { fontSize: 13, color: C.ink },
  sessTag: { fontSize: 12, fontWeight: "700" },

  scrCount: {
    textAlign: "center",
    color: C.sky,
    fontWeight: "700",
    fontSize: 14,
    marginTop: 16,
  },
  scrHint: {
    textAlign: "center",
    color: C.slate,
    fontSize: 12,
    marginTop: 3,
  },

  scrBtnRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  scrBtn: {
    flex: 1,
    borderRadius: radius.button,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  scrBtnTxt: { fontSize: 14, fontWeight: "700" },

  // physical device
  deviceWord: {
    textAlign: "center",
    color: D.sub,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 6,
    marginTop: 28,
  },
  deviceWrap: {
    width: 130,
    height: 130,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 14,
  },
  ringTrack: {
    position: "absolute",
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 9,
    borderColor: D.line,
  },
  ringAccent: {
    position: "absolute",
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 9,
    borderTopColor: D.sky,
    borderLeftColor: D.sky,
    borderRightColor: "transparent",
    borderBottomColor: "transparent",
  },
  recDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
  },
  deviceCaption: {
    textAlign: "center",
    color: D.sub,
    fontSize: 13,
    marginTop: 16,
  },
});
