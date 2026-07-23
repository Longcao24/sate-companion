"""SATE hardware-in-the-loop test harness.

Runs the automated pre-release checks that a compiler CANNOT catch — the bugs the
audit found live on real timing and real silicon: reboot mid-recording, dropped
BLE packets truncating a WAV, delete-during-upload splicing two takes, verified
trim, OTA. Point it at a recorder on USB (and the device-api backend) and it
drives reset/record/upload and asserts the firmware's own serial log + the bytes
the server actually stored.

Real hardware is the primary target. `--sim` swaps in an in-memory device that
replays the firmware's log lines so the harness's own assertions can be
self-tested with no board attached.
"""

__version__ = "0.1.0"
