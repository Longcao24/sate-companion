#!/usr/bin/env python3
"""
Find the L816's DELETE opcode in a Bluetooth HCI snoop capture.

WHY THIS EXISTS
---------------
The L816's delete command is real — the vendor app (AI DVR Link 3.2.0) contains
`DeleteRequest` / `DeleteResponse` / `DeleteFailResponse` in the same protocol
family whose other classes map 1:1 onto the opcodes we already know (see
doc/14-l816.md §9). What we do NOT have is the opcode BYTE: it is an immediate in
compiled Dart AOT, it appears in no string, and the order of class names in the
binary is provably not declaration order, so it cannot be inferred.

Guessing it is not acceptable. The device holds the only copy of a recording
until it is uploaded, and an unknown opcode could erase more than one file or
wedge the unit. So: watch the vendor app do exactly one delete, and read the
bytes it actually sent.

This script reads a `btsnoop_hci.log` and prints every L816 protocol frame it
finds, in order, marked TX (phone -> device) or RX (device -> phone). The delete
is the TX frame that is not one of the opcodes we already know.

USAGE
-----
    python3 doc/l816-find-delete-opcode.py btsnoop_hci.log

See doc/14-l816.md for how to produce that file.
"""

import struct
import sys

# What we already know, so the script can tell you which frame is the NEW one.
KNOWN = {
    0x02: "sync clock",
    0x03: "start recording",
    0x04: "stop recording",
    0x05: "list files",
    0x06: "list end",
    0x07: "download",
    0x08: "cancel transfer",
    0x09: "transfer EOF",
    0x0F: "recording state",
}

REQ = b"\x55\xaa"   # phone -> device
RSP = b"\xaa\x55"   # device -> phone

# ATT opcodes that carry data the app wrote or the device notified.
ATT_WRITE_REQ = 0x12
ATT_WRITE_CMD = 0x52
ATT_NOTIFY = 0x1B
ATT_INDICATE = 0x1D
ATT_INTERESTING = {ATT_WRITE_REQ, ATT_WRITE_CMD, ATT_NOTIFY, ATT_INDICATE}


def records(blob: bytes):
    """Yield (is_sent, packet_bytes) from a btsnoop file."""
    if not blob.startswith(b"btsnoop\x00"):
        raise SystemExit("Not a btsnoop file (missing magic). Wrong file?")
    # 8 magic + 4 version + 4 datalink
    off = 16
    while off + 24 <= len(blob):
        orig_len, incl_len, flags, _drops, _ts = struct.unpack_from(">IIIIq", blob, off)
        off += 24
        pkt = blob[off : off + incl_len]
        off += incl_len
        if len(pkt) < incl_len:
            break
        # flags bit0: 0 = sent (host->controller), 1 = received
        yield (flags & 0x01) == 0, pkt


def att_payloads(pkt: bytes):
    """Pull the ATT value out of one H4 packet, if it is an ATT write/notify."""
    if len(pkt) < 1 or pkt[0] != 0x02:  # 0x02 = ACL data
        return None
    if len(pkt) < 9:
        return None
    # ACL: handle+flags(2) total_len(2) | L2CAP: len(2) cid(2) | ATT...
    _handle_flags, _acl_len, _l2_len, cid = struct.unpack_from("<HHHH", pkt, 1)
    if cid != 0x0004:  # 0x0004 = ATT
        return None
    att = pkt[9:]
    if len(att) < 4:
        return None
    op = att[0]
    if op not in ATT_INTERESTING:
        return None
    handle = struct.unpack_from("<H", att, 1)[0]
    return op, handle, att[3:]


def decode(frame: bytes) -> str:
    """Describe one 55AA/AA55 frame."""
    if len(frame) < 4:
        return "(too short)"
    direction = "TX" if frame[:2] == REQ else "RX"
    length, op = frame[2], frame[3]
    payload = frame[4:]
    name = KNOWN.get(op)
    tag = f"{name}" if name else "*** UNKNOWN — this is very likely DELETE ***"
    out = [f"{direction}  len=0x{length:02X}  opcode=0x{op:02X}  {tag}"]
    if payload:
        out.append(f"      payload ({len(payload)} B): {payload.hex().upper()}")
        # A 17-byte NN_yyyyMMddHHmmss name is the giveaway for a file-scoped command.
        ascii_part = payload[:17]
        if all(32 <= c < 127 for c in ascii_part) and len(ascii_part) == 17:
            out.append(f'      looks like a file name: "{ascii_part.decode()}"')
    return "\n".join(out)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    blob = open(sys.argv[1], "rb").read()

    frames = []
    for is_sent, pkt in records(blob):
        parsed = att_payloads(pkt)
        if not parsed:
            continue
        _op, handle, value = parsed
        if value[:2] in (REQ, RSP):
            frames.append((is_sent, handle, value))

    if not frames:
        print("No L816 protocol frames found.")
        print("Check that: HCI snoop was ON before the delete, Bluetooth was")
        print("restarted after enabling it, and the delete really happened in")
        print("the vendor app while this capture was running.")
        return

    print(f"Found {len(frames)} L816 frame(s).\n")
    unknown = []
    for is_sent, handle, value in frames:
        print(f"[handle 0x{handle:04X}]")
        print(decode(value))
        print()
        if value[:2] == REQ and value[3] not in KNOWN:
            unknown.append(value)

    print("=" * 62)
    if unknown:
        print("NEW opcode(s) the phone sent that we do not already know:\n")
        for v in unknown:
            print(f"  opcode 0x{v[3]:02X}   full frame: {v.hex().upper()}")
        print("\nIf you deleted exactly ONE file, exactly one of these is delete.")
    else:
        print("Every frame was an opcode we already know — the delete was not")
        print("captured. Re-run the capture and make sure the delete happens")
        print("while snoop logging is on.")


if __name__ == "__main__":
    main()
