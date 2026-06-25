import React, { ReactNode } from "react";
import { Image, View } from "react-native";

// DeviceFrame — the real SATE recorder body (PNG with a transparent screen
// cutout) with live content showing through the screen. Mirrors the web app's
// DeviceFrame. The bezel image sits on top; the screen content renders behind it
// and shows through the transparent cutout.

// Screen cutout as a fraction of the frame image (1024×1536).
const SCREEN = { left: 0.2695, top: 0.2090, width: 0.4590, height: 0.4342 };
const FRAME_RATIO = 1536 / 1024; // height / width = 1.5
const FRAME = require("../../assets/device.png");

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
