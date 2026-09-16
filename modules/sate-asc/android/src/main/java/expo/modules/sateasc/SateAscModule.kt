package expo.modules.sateasc

import android.util.Base64
import com.actions.asc.jni.ASCDecoder
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

// ASC-VI -> 16 kHz mono 16-bit PCM WAV, for the L816 recorder.
//
// The L816 hands over its audio as ASC-VI frames, not PCM and not a container
// format: 82 bytes = 41 little-endian int16 words, of which word[0] is a header
// and words[1..40] are the payload, decoding to 320 samples (20 ms @ 16 kHz).
// The only decoder that exists is the vendor's ARM ELF pair (libasc_dec.so +
// libASCDecoder.so) lifted from the reference APK. That is the whole reason the
// L816 is an ANDROID-ONLY device family: those binaries cannot load on iOS, and
// they cannot run in the x86 cf-processor container either, so the conversion
// has to happen on the phone, here, before the take enters the SATE pipeline.
//
// Everything in this file is ours; the codec itself is a black box behind four
// JNI entry points. Frame layout and the init(6) algorithm id were taken from
// the reference implementation in /Users/longcao/Desktop/recorder (AscWav.java).

private const val FRAME_BYTES = 82      // one ASC-VI frame on the wire
private const val FRAME_WORDS = 41      // = FRAME_BYTES / 2
private const val PAYLOAD_WORDS = 40    // words[1..40]
private const val ALGORITHM: Short = 6  // ASC-VI
private const val SAMPLE_RATE = 16000

class SateAscModule : Module() {
  // Loaded once, lazily, and NEVER allowed to throw out of the module: a build
  // without the proprietary .so must degrade to "decoder unavailable" (a message
  // the user can act on) rather than crash the app on first import.
  private var loadError: String? = null
  private var loaded = false

  @Synchronized
  private fun ensureLoaded() {
    if (loaded) return
    loadError?.let { throw AscUnavailable(it) }
    try {
      // asc_dec first: libASCDecoder dlopen()s it by name at init.
      System.loadLibrary("asc_dec")
      System.loadLibrary("ASCDecoder")
      loaded = true
    } catch (t: Throwable) {
      // UnsatisfiedLinkError on a build with no jniLibs, or on an ABI the vendor
      // never shipped (x86 emulators — the binaries are arm64/armeabi only).
      loadError = t.message ?: t.toString()
      throw AscUnavailable(loadError!!)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("SateAsc")

    // True when the vendor codec is present AND loadable on this ABI. The JS side
    // gates the whole L816 entry point on this, so a build missing the binaries
    // never offers hardware it cannot finish a recording from.
    Function("isAvailable") {
      try {
        ensureLoaded(); true
      } catch (e: Throwable) {
        false
      }
    }

    // Why the decoder is unavailable, for the on-screen diagnostic. Null when it
    // loaded fine.
    Function("unavailableReason") {
      try {
        ensureLoaded(); null
      } catch (e: Throwable) {
        loadError
      }
    }

    // base64 ASC bytes in, base64 WAV out. Runs on a background thread (AsyncFunction)
    // because a full-length take is tens of thousands of JNI round-trips and must
    // not block the JS thread.
    AsyncFunction("decodeToWavBase64") { ascBase64: String ->
      ensureLoaded()
      val asc = Base64.decode(ascBase64, Base64.DEFAULT)
      decodeToWav(asc)
    }
  }

  private fun decodeToWav(asc: ByteArray): String {
    if (asc.isEmpty() || asc.size % FRAME_BYTES != 0) {
      throw AscBadInput("ASC data must be whole ${FRAME_BYTES}-byte frames (got ${asc.size})")
    }

    val decoder = ASCDecoder()
    val pcm = ByteArrayOutputStream(asc.size * 8)
    try {
      val samplesPerFrame = decoder.init(ALGORITHM)
      if (samplesPerFrame <= 0) throw AscBadInput("Could not initialise the ASC-VI codec")

      val words = ShortArray(FRAME_WORDS)
      val payload = ShortArray(PAYLOAD_WORDS)
      val src = ByteBuffer.wrap(asc).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()

      val frames = asc.size / FRAME_BYTES
      for (n in 0 until frames) {
        src.get(words)
        if (decoder.readHead(words) == 0) throw AscBadInput("Invalid ASC header at frame $n")
        System.arraycopy(words, 1, payload, 0, PAYLOAD_WORDS)
        val out = decoder.decode(payload, PAYLOAD_WORDS.toShort(), ALGORITHM)
        if (out == null || out.isEmpty()) throw AscBadInput("Could not decode frame $n")
        val bytes = ByteBuffer.allocate(out.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        bytes.asShortBuffer().put(out)
        pcm.write(bytes.array())
      }
    } finally {
      // The codec keeps global state, so a take that failed halfway must still
      // release it or the NEXT decode starts from a dirty decoder.
      try { ASCDecoder.destroy() } catch (ignored: Throwable) { }
    }

    val data = pcm.toByteArray()
    if (data.isEmpty()) throw AscBadInput("Decoder produced no audio")
    return Base64.encodeToString(wav(data), Base64.NO_WRAP)
  }

  // 16 kHz / mono / 16-bit PCM WAV — the exact shape device-api and the AI
  // pipeline already accept from the pendant.
  private fun wav(pcm: ByteArray): ByteArray {
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
    header.put("RIFF".toByteArray(Charsets.US_ASCII))
    header.putInt(36 + pcm.size)
    header.put("WAVE".toByteArray(Charsets.US_ASCII))
    header.put("fmt ".toByteArray(Charsets.US_ASCII))
    header.putInt(16)                       // PCM chunk size
    header.putShort(1)                      // format = PCM
    header.putShort(1)                      // channels = mono
    header.putInt(SAMPLE_RATE)
    header.putInt(SAMPLE_RATE * 2)          // byte rate
    header.putShort(2)                      // block align
    header.putShort(16)                     // bits per sample
    header.put("data".toByteArray(Charsets.US_ASCII))
    header.putInt(pcm.size)
    return header.array() + pcm
  }
}

class AscUnavailable(reason: String) :
  CodedException("ERR_ASC_UNAVAILABLE", "The L816 audio decoder is not available in this build: $reason", null)

class AscBadInput(message: String) :
  CodedException("ERR_ASC_DECODE", message, null)
