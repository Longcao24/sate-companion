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
  /** base64 ASC frames -> a WAV written to the cache, never held in the heap. */
  decodeToWavFile(ascBase64: string): Promise<{
    path: string;
    uri: string;
    bytes: number;
    sampleRate: number;
  }>;
}

/** A decoded take on disk. */
export interface AscWavFile {
  /** Absolute path, for the native module. */
  path: string;
  /** `file://…`, for anything that wants a URI. */
  uri: string;
  /** WAV bytes, header included. */
  bytes: number;
  sampleRate: number;
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

/**
 * Decode a take STRAIGHT TO A FILE, and never let the audio into the JS heap.
 *
 * 🛑 This is what long takes must use. The base64 version above returns the whole
 * recording as a string: Android hands this app a 256 MB heap, and a real take
 * asked for a single 183 MB allocation inside it and died —
 * `OutOfMemoryError: Failed to allocate a 183468512 byte allocation ...
 * growth limit 268435456`. Between the decoder's buffer, the byte array, the
 * header concatenation and the base64 string there were four or five live copies
 * of audio that is itself ~7.8x the size of the ASC it came from.
 *
 * On disk there is one frame in memory at a time, and the upload streams from the
 * file — so the take's length stops being a number anyone has to think about.
 */
export async function decodeAscToWavFile(ascBase64: string): Promise<AscWavFile> {
  if (!native) {
    throw new Error("The L816 audio decoder is not available in this build (Android only).");
  }
  return native.decodeToWavFile(ascBase64);
}
