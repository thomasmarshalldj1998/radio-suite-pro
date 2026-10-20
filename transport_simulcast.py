"""Three-way simulcast (SignalPath v3.1, module D1).

One DSP source, three independent outputs. Each slot carries its own codec,
bitrate, mount point and server, and all three receive the *same* frame and the
*same* 90 kHz PTS, so a receiver switching between them does not see a timeline
jump.

Secondary and tertiary are off by default; enabling one starts feeding it on the
next frame with no change to the primary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Sequence

from stream_encoder_core import MPEG_CLOCK_HZ

SLOT_NAMES = ("primary", "secondary", "tertiary")
CODECS = ("mp3", "aac", "he-aacv2", "aac-ld", "opus", "flac")


class SimulcastError(ValueError):
    pass


@dataclass
class OutputSlot:
    name: str
    enabled: bool = False
    codec: str = "mp3"
    bitrate_kbps: int = 128
    mount: str = "/stream"
    server: str = ""
    sample_rate: int = 48_000
    channels: int = 2
    packetizer: Callable[[Sequence[float], int], bytes] | None = field(
        default=None, repr=False, compare=False
    )
    # Optional sink for the finished packet (socket writer, file muxer…). A
    # failing writer is counted per output and never stalls the other two.
    writer: Callable[["Packet"], None] | None = field(
        default=None, repr=False, compare=False
    )

    def validate(self) -> "OutputSlot":
        if self.codec not in CODECS:
            raise SimulcastError(f"codec must be one of {CODECS}")
        if not 8 <= self.bitrate_kbps <= 512:
            raise SimulcastError("bitrate must be 8–512 kbps")
        if not self.mount.startswith("/"):
            raise SimulcastError("mount point must start with /")
        return self


@dataclass
class Packet:
    slot: str
    pts: int
    codec: str
    payload: bytes

    @property
    def size(self) -> int:
        return len(self.payload)


class Simulcast:
    def __init__(self, sample_rate: int = 48_000) -> None:
        self.sample_rate = int(sample_rate)
        self.slots: dict[str, OutputSlot] = {
            "primary": OutputSlot("primary", True),
            "secondary": OutputSlot("secondary", False),
            "tertiary": OutputSlot("tertiary", False),
        }
        self.frame_duration = round(1152 * MPEG_CLOCK_HZ / self.sample_rate)
        self.pts = 0
        self.frames = 0
        self.sent: dict[str, int] = {name: 0 for name in SLOT_NAMES}
        self.errors: dict[str, int] = {name: 0 for name in SLOT_NAMES}
        self.last: dict[str, Packet | None] = {name: None for name in SLOT_NAMES}

    # ── configuration ───────────────────────────────────────────────────
    def configure(self, name: str, **values: object) -> OutputSlot:
        if name not in self.slots:
            raise SimulcastError(f"unknown slot {name!r}")
        slot = self.slots[name]
        for key, value in values.items():
            if not hasattr(slot, key):
                raise SimulcastError(f"unknown slot field {key!r}")
            setattr(slot, key, value)
        slot.validate()
        # An enabled output with no packetizer stays configured: `status()`
        # reports `encoder: false` instead of silently pretending to send.
        return slot

    def enable(self, name: str, enabled: bool = True) -> OutputSlot:
        return self.configure(name, enabled=enabled)

    @property
    def enabled_slots(self) -> list[str]:
        return [n for n in SLOT_NAMES if self.slots[n].enabled]

    # ── streaming ───────────────────────────────────────────────────────
    def push_frame(self, pcm: Sequence[float], pts: int | None = None) -> list[Packet]:
        frame_pts = self.pts if pts is None else int(pts)
        packets: list[Packet] = []
        for name in SLOT_NAMES:
            slot = self.slots[name]
            if not slot.enabled:
                continue
            if slot.packetizer is None:
                continue
            payload = slot.packetizer(pcm, frame_pts)
            packet = Packet(name, frame_pts, slot.codec, payload)
            packets.append(packet)
            self.last[name] = packet
            self.sent[name] += 1
            if slot.writer is not None:
                try:
                    slot.writer(packet)
                except Exception:
                    # One dead output must not take the other two off air.
                    self.errors[name] += 1
        self.frames += 1
        # Follow an externally supplied clock as well: otherwise the first
        # generated PTS after an explicit one would jump back to the internal
        # counter.
        self.pts = frame_pts + self.frame_duration
        return packets

    def alignment(self) -> dict[str, int | None]:
        """PTS offsets between enabled outputs (0 when aligned)."""
        active = [self.last[n].pts for n in self.enabled_slots if self.last[n]]
        if not active:
            return {"spread_ticks": 0, "reference": None}
        return {"spread_ticks": max(active) - min(active), "reference": min(active)}

    def status(self) -> dict[str, dict[str, object]]:
        return {
            name: {
                "enabled": slot.enabled,
                "codec": slot.codec,
                "bitrate_kbps": slot.bitrate_kbps,
                "mount": slot.mount,
                "server": slot.server,
                "sent_frames": self.sent[name],
                "encoder": slot.packetizer is not None,
                "writer": slot.writer is not None,
                "errors": self.errors[name],
                "last_pts": self.last[name].pts if self.last[name] else None,
            }
            for name, slot in self.slots.items()
        }


__all__ = ["Simulcast", "OutputSlot", "Packet", "SLOT_NAMES", "CODECS", "SimulcastError"]
