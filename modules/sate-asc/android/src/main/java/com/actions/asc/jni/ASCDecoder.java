package com.actions.asc.jni;

/**
 * JNI ABI declaration for the vendor ASC-VI decoder shipped with the L816.
 *
 * The package and class name are NOT a choice: the supplied binary exports
 * `Java_com_actions_asc_jni_ASCDecoder_decode` (and friends), so the symbols only
 * resolve for a class at exactly this fully-qualified name. Renaming or moving
 * this file silently breaks the decoder with an UnsatisfiedLinkError at the first
 * `decode()` — not at load time.
 *
 * Deliberately NO static initializer: `System.loadLibrary` lives in
 * SateAscModule, which catches a missing .so and reports "decoder unavailable"
 * instead of throwing ExceptionInInitializerError out of a class load we can't
 * guard. The binaries are proprietary and git-ignored (see ../../../../README.md).
 */
public final class ASCDecoder {
    /** Returns samples-per-frame for the algorithm, or <= 0 on failure. */
    public native short init(short algorithm);

    /** Validates a frame header; 0 = invalid. `frame` is the 41 int16 words. */
    public native int readHead(short[] frame);

    /** Decodes 40 payload words into PCM samples. */
    public native short[] decode(short[] encoded, short length, short algorithm);

    public static native void destroy();
}
