import React, { useRef } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "./ui";
import { D } from "../theme";

// Full-screen camera modal that reads the QR shown in the SATE web app and hands
// the decoded one-time code back to the caller. The QR payload is the raw code
// string (e.g. "8K2P-L9QX"); we strip any surrounding URL just in case.
export function QrScannerModal({
  visible,
  onClose,
  onScanned,
}: {
  visible: boolean;
  onClose: () => void;
  onScanned: (code: string) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  // Guard against the scanner firing many times for the same frame.
  const handled = useRef(false);

  // Re-arm each time the modal opens.
  React.useEffect(() => {
    if (visible) handled.current = false;
  }, [visible]);

  const handleScan = (data: string) => {
    if (handled.current) return;
    handled.current = true;
    // Accept either a bare code or a deep link / URL that carries ?code=...
    const m = data.match(/(?:code=)?([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})/);
    const code = (m?.[1] ?? data).trim();
    onScanned(code);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.wrap}>
        {!permission ? (
          <View style={s.center}>
            <Text style={s.msg}>Checking camera permission…</Text>
          </View>
        ) : !permission.granted ? (
          <View style={s.center}>
            <Text style={s.msg}>
              Camera access is needed to scan the sign-in QR code.
            </Text>
            <Button title="Allow camera" onPress={requestPermission} />
          </View>
        ) : (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => handleScan(data)}
            />
            <View style={s.overlay} pointerEvents="none">
              <View style={s.reticle} />
              <Text style={s.hint}>
                Point at the QR code on the SATE web app
              </Text>
            </View>
          </>
        )}

        <Pressable onPress={onClose} hitSlop={12} style={s.close}>
          <Text style={s.closeText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  msg: { color: "#fff", textAlign: "center", fontSize: 15 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  reticle: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: D.sky,
    borderRadius: 20,
    backgroundColor: "transparent",
  },
  hint: { color: "#fff", marginTop: 20, fontSize: 14, textAlign: "center", paddingHorizontal: 24 },
  close: {
    position: "absolute",
    top: 56,
    right: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 10,
  },
  closeText: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
