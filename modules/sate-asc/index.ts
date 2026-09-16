import { requireOptionalNativeModule } from "expo-modules-core";

// ASC-VI -> WAV, the codec the L816 recorder speaks.
//
// The L816 does not send PCM: it sends 82-byte ASC-VI frames, and the only
// decoder that exists is the vendor's ARM ELF pair (libasc_dec.so +
// libASCDecoder.so). They load on Android only — not iOS, not the x86
// cf-processor container — which is why the L816 is an Android-only device
// family (see src/features.ts). Everything upstream of this file is portable;
// this is the wall.
//
// `requireOptionalNativeModule` returns null instead of throwing, so importing
// this on iOS (or in Expo Go) is harmless and `isAscAvailable()` simply says no.

interface SateAscNative {
  /** Codec present AND loadable on this ABI (arm64-v8a / armeabi-v7a only). */
  isAvailable(): boolean;
  /** Why not, for the on-screen diagnostic. Null when it loaded fine. */
  unavailableReason(): string | null;
  /** base64 ASC frames -> base64 16 kHz mono 16-bit WAV. */
  decodeToWavBase64(ascBase64: string): Promise<string>;
}

const native = requireOptionalNativeModule<SateAscNative>("SateAsc");

/** One 82-byte ASC-VI frame = 41 int16 LE words = 320 samples (20 ms @ 16 kHz). */
export const ASC_FRAME_BYTES = 82;
export const ASC_SAMPLE_RATE = 16000;

/**
 * True when this build can turn L816 audio into a WAV. Gate the L816 entry point
 * on it: offering hardware whose recordings can be downloaded but never decoded
 * or uploaded is worse than not offering it.
 */
export function isAscAvailable(): boolean {
  try {
    return native?.isAvailable() ?? false;
  } catch {
    return false;
  }
}

/** Human-readable reason `isAscAvailable()` is false (or null when it's true). */
export function ascUnavailableReason(): string | null {
  if (!native) return "The ASC decoder native module is not in this build (Android only).";
  try {
    return native.unavailableReason();
  } catch (e: any) {
    return e?.message ?? "Unknown decoder error";
  }
}

/**
 * Decode a complete L816 take. `ascBase64` must be whole 82-byte frames — the
 * download is only considered complete when its byte count matches the device's
 * own acknowledgment AND divides by 82, so a truncated transfer never gets here.
 */
export async function decodeAscToWavBase64(ascBase64: string): Promise<string> {
  if (!native) {
    throw new Error("The L816 audio decoder is not available in this build (Android only).");
  }
  return native.decodeToWavBase64(ascBase64);
}
