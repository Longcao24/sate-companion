import React, { ReactNode } from "react";
import { Image, View } from "react-native";

// DeviceFrame — the real SATE recorder body (PNG with a transparent screen
// cutout) with live content showing through the screen. Mirrors the web app's
// DeviceFrame. The bezel image sits on top; the screen content renders behind it
// and shows through the transparent cutout.

// Screen cutout as a fraction of the frame image (732×1385).
const SCREEN = { left: 0.168, top: 0.1856, width: 0.668, height: 0.5264 };
const FRAME_RATIO = 1385 / 732; // height / width
const FRAME = require("../../assets/sate-device-frame.png");

export function DeviceFrame({
  children,
  width = 150,
}: {
  children?: ReactNode;
  width?: number;
}) {
  const height = width * FRAME_RATIO;
  return (
    <View style={{ width, height }}>
      {/* Live screen — behind the bezel, visible through the cutout. */}
      <View
        style={{
          position: "absolute",
          left: width * SCREEN.left,
          top: height * SCREEN.top,
          width: width * SCREEN.width,
          height: height * SCREEN.height,
          backgroundColor: "#FFFFFF",
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 6,
        }}
      >
        {children}
      </View>
      {/* Device bezel overlay. */}
      <Image
        source={FRAME}
        style={{ position: "absolute", width, height }}
        resizeMode="contain"
      />
    </View>
  );
}
