package expo.modules.sateasc

import android.util.Base64
import com.actions.asc.jni.ASCDecoder
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
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
    //
    // ⚠️ KEPT FOR SHORT TAKES ONLY. It holds the whole recording in the heap four
    // or five times over — see decodeToWavFile, which is what long takes use.
    AsyncFunction("decodeToWavBase64") { ascBase64: String ->
      ensureLoaded()
      val asc = Base64.decode(ascBase64, Base64.DEFAULT)
      decodeToWav(asc)
    }

    // Same decode, streamed to a FILE, returning its path.
    //
    // 🛑 THIS EXISTS BECAUSE THE BASE64 VERSION CANNOT SURVIVE A LONG TAKE.
    // Android gave this app a 256 MB heap ceiling and the old path asked for a
    // single 183 MB allocation inside it:
    //
    //     java.lang.OutOfMemoryError: Failed to allocate a 183468512 byte
    //     allocation with 8694048 free bytes ... growth limit 268435456
    //
    // For P bytes of PCM it held P in a ByteArrayOutputStream (which doubles its
    // buffer as it grows, so 2P transiently), P again from toByteArray(), P again
    // from `header + pcm` array concatenation, and then 1.33P as a base64 STRING —
    // before JS received a copy of that string and turned it back into bytes.
    // Four to five live copies of a recording that is itself ~7.8x the ASC input.
    //
    // Written straight to disk there is one frame in memory at a time. The take
    // length stops mattering.
    AsyncFunction("decodeToWavFile") { ascBase64: String ->
      ensureLoaded()
      val asc = Base64.decode(ascBase64, Base64.DEFAULT)
      decodeToWavFile(asc)
    }
  }

  private fun decodeToWavFile(asc: ByteArray): Map<String, Any> {
    if (asc.isEmpty() || asc.size % FRAME_BYTES != 0) {
      throw AscBadInput("ASC data must be whole ${FRAME_BYTES}-byte frames (got ${asc.size})")
    }
    val cacheDir = appContext.cacheDirectory
      ?: throw AscBadInput("No cache directory to decode into")
    val dir = File(cacheDir, "l816")
    dir.mkdirs()
    val out = File(dir, "take-${System.currentTimeMillis()}.wav")

    val decoder = ASCDecoder()
    var pcmBytes = 0L
    try {
      BufferedOutputStream(FileOutputStream(out), 1 shl 16).use { sink ->
        // A placeholder header: the two size fields are only knowable once every
        // frame has been decoded, and they are patched in below.
        sink.write(ByteArray(44))

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
          val decoded = decoder.decode(payload, PAYLOAD_WORDS.toShort(), ALGORITHM)
          if (decoded == null || decoded.isEmpty()) throw AscBadInput("Could not decode frame $n")
          val bytes = ByteBuffer.allocate(decoded.size * 2).order(ByteOrder.LITTLE_ENDIAN)
          bytes.asShortBuffer().put(decoded)
          sink.write(bytes.array())
          pcmBytes += decoded.size * 2
        }
      }
    } catch (t: Throwable) {
      out.delete()          // never leave a half-decoded take behind
      throw t
    } finally {
      try { ASCDecoder.destroy() } catch (ignored: Throwable) { }
    }

    if (pcmBytes <= 0L) {
      out.delete()
      throw AscBadInput("Decoder produced no audio")
    }
    patchWavHeader(out, pcmBytes)
    return mapOf(
      "path" to out.absolutePath,
      "uri" to "file://${out.absolutePath}",
      "bytes" to (pcmBytes + 44).toDouble(),
      "sampleRate" to SAMPLE_RATE,
    )
  }

  /** Write the real RIFF/data sizes into the placeholder header. */
  private fun patchWavHeader(file: File, pcmBytes: Long) {
    RandomAccessFile(file, "rw").use { raf ->
      val head = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
      head.put("RIFF".toByteArray(Charsets.US_ASCII))
      head.putInt((36 + pcmBytes).toInt())
      head.put("WAVE".toByteArray(Charsets.US_ASCII))
      head.put("fmt ".toByteArray(Charsets.US_ASCII))
      head.putInt(16)
      head.putShort(1)
      head.putShort(1)
      head.putInt(SAMPLE_RATE)
      head.putInt(SAMPLE_RATE * 2)
      head.putShort(2)
      head.putShort(16)
      head.put("data".toByteArray(Charsets.US_ASCII))
      head.putInt(pcmBytes.toInt())
      raf.seek(0)
      raf.write(head.array())
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
