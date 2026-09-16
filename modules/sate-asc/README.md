# sate-asc — the SATE L816's audio codec

The SATE L816 does not send PCM. Every take arrives as **ASC-VI frames**: 82
bytes = 41 little-endian `int16` words, word 0 a header and words 1..40 a payload
that decodes to 320 samples (20 ms @ 16 kHz mono). Nothing in the SATE stack can
read that, so this module converts a downloaded take to the plain 16 kHz mono WAV
that `api.uploadSession` → `device-api` → the AI pipeline already accept.

## Why this is Android-only

The decode is done by **two proprietary vendor binaries** taken from the L816
reference APK:

```
libasc_dec.so      the codec itself
libASCDecoder.so   the JNI shim (dlopen()s libasc_dec.so at init)
```

They are **ARM ELF shared objects for Android** (`arm64-v8a`, `armeabi-v7a`).
They cannot load on iOS, and they cannot run in the x86 `cf-processor` container
either — so the conversion has to happen on the phone, and only an Android phone.
That single fact is why `L816_ENABLED` in `src/features.ts` is
`Platform.OS === "android"`, mirroring how Plaud is iOS-only for the opposite
reason.

If the codec is ever reverse-engineered or the vendor supplies source, this
module is the only thing that has to change: `src/l816/L816Link.ts` (BLE),
the screen and the upload path are all plain portable TypeScript.

## Installing the binaries (per machine)

**The `.so` files are NOT in git** — redistribution rights were never
established, exactly like the Plaud SDK frameworks
(`modules/plaud-sate/ios/Frameworks/`). Copy them in from the reference project:

```sh
cp /path/to/recorder/app/src/main/jniLibs/arm64-v8a/lib*.so \
   modules/sate-asc/android/src/main/jniLibs/arm64-v8a/
cp /path/to/recorder/app/src/main/jniLibs/armeabi-v7a/lib*.so \
   modules/sate-asc/android/src/main/jniLibs/armeabi-v7a/
```

Then rebuild the Android app (`npx expo run:android`).

A **missing `.so` is not a build failure** — it is a runtime "decoder
unavailable", and `isAscAvailable()` returns false so the L816 entry point never
appears. A clone without the binaries still builds and ships the recorder.

## The one thing you must not rename

`android/src/main/java/com/actions/asc/jni/ASCDecoder.java` is at that exact
fully-qualified name because the binary exports
`Java_com_actions_asc_jni_ASCDecoder_decode` and friends. Move or rename the
class and the symbols stop resolving — with an `UnsatisfiedLinkError` at the
first `decode()`, not at load time, so it looks like a codec bug rather than a
packaging one.

## API

```ts
import { isAscAvailable, ascUnavailableReason, decodeAscToWavBase64 } from "sate-asc";
```

`decodeAscToWavBase64` runs off the JS thread (a full take is tens of thousands
of JNI round-trips) and throws if the input is not whole 82-byte frames.
