"""libfdk-aac backend (SignalPath v3.1, module A4).

Two profiles, as specified:

``he-aacv2``  24–128 kbps, SBR/PS automatic, 48 ms pipeline delay, ADTS + CRC
``aac-ld``    64–192 kbps, low-delay AOT 23, < 15 ms end-to-end, raw/LATM for
              live links (ADTS cannot signal AAC-LD)

Backend discovery is explicit: the `fdkaac` command line encoder is used for
offline encodes (it writes a real ADTS stream), and a `libfdk-aac` shared
library is reported when present for a host that links it directly. When
neither exists the module imports fine, `available` is False, and encoding
raises `CodecUnavailable` with the package names to install — a station that
loses its codec should still be able to open its console and alarm.
"""

from __future__ import annotations

import ctypes.util
import os
import shutil
import struct
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from typing import Sequence

from stream_encoder_core import EncoderCore

PROFILES = {
    # bitrate range, AOT, ADTS profile bits, latency, container
    "he-aacv2": {"min": 24, "max": 128, "aot": 29, "adts": 1, "latency_ms": 48.0},
    "aac-ld": {"min": 64, "max": 192, "aot": 23, "adts": None, "latency_ms": 12.0},
}
ADTS_RATES = [
    96000,
    88200,
    64000,
    48000,
    44100,
    32000,
    24000,
    22050,
    16000,
    12000,
    11025,
    8000,
    7350,
]


class CodecUnavailable(RuntimeError):
    """No libfdk backend on this host."""


@dataclass
class AACConfig:
    profile: str = "he-aacv2"
    bitrate_kbps: int = 64
    sample_rate: int = 48_000
    channels: int = 2
    crc: bool = True
    sbr: str = "auto"
    container: str = "auto"  # resolved to ADTS for HE-AACv2, LATM for AAC-LD

    def validate(self) -> "AACConfig":
        if self.profile not in PROFILES:
            raise ValueError(f"profile must be one of {tuple(PROFILES)}")
        spec = PROFILES[self.profile]
        if not spec["min"] <= self.bitrate_kbps <= spec["max"]:
            raise ValueError(
                f"{self.profile} bitrate must be {spec['min']}–{spec['max']} kbps"
            )
        if self.sample_rate not in ADTS_RATES:
            raise ValueError("sample rate is not an AAC sampling frequency")
        if self.channels not in (1, 2):
            raise ValueError("channels must be 1 or 2")
        if self.sbr not in ("auto", "on", "off"):
            raise ValueError("sbr must be auto, on or off")
        if self.container == "auto":
            self.container = "adts" if PROFILES[self.profile]["adts"] else "latm"
        if self.container not in ("adts", "raw", "latm"):
            raise ValueError("container must be adts, raw or latm")
        if self.profile == "aac-ld" and self.container == "adts":
            raise ValueError("ADTS cannot signal AAC-LD; use raw or LATM")
        if self.profile == "he-aacv2" and self.channels == 1:
            raise ValueError("HE-AACv2 (parametric stereo) needs two channels")
        return self

    @property
    def aot(self) -> int:
        return int(PROFILES[self.profile]["aot"])

    @property
    def latency_ms(self) -> float:
        return float(PROFILES[self.profile]["latency_ms"])

    @property
    def description(self) -> str:
        return (
            f"{self.profile.upper()} · {self.bitrate_kbps} kbps · "
            f"{self.sample_rate / 1000:g} kHz · {self.latency_ms:g} ms"
        )


def find_backend() -> str | None:
    """`fdkaac`, `libfdk-aac` or None."""
    cli = shutil.which("fdkaac")
    if cli:
        return f"cli:{cli}"
    lib = ctypes.util.find_library("fdk-aac") or ctypes.util.find_library("fdk_aac")
    return f"lib:{lib}" if lib else None


def adts_header(
    payload_len: int,
    *,
    sample_rate: int = 48_000,
    channels: int = 2,
    crc: bool = False,
) -> bytes:
    """7-byte ADTS header (9 bytes with CRC) for an AAC-LC/SBR frame.

    HE-AACv2 is signalled in ADTS as LC with implicit SBR, which is exactly how
    broadcast decoders expect it; the 13-bit frame length includes the header.
    """
    if sample_rate not in ADTS_RATES:
        raise ValueError("sample rate is not an AAC sampling frequency")
    if channels not in (1, 2):
        raise ValueError("ADTS supports 1 or 2 channels here")
    if payload_len < 0 or payload_len > 0x1FFF - 9:
        raise ValueError("payload too large for one ADTS frame")
    header_len = 9 if crc else 7
    frame_len = payload_len + header_len
    rate_index = ADTS_RATES.index(sample_rate)
    b = bytearray(header_len)
    b[0] = 0xFF
    b[1] = 0xF1                              # MPEG-4, layer 0, no CRC in bit 0
    if crc:
        b[1] &= 0xFE                         # protection_absent = 0
    b[2] = ((1 & 0x03) << 6) | ((rate_index & 0x0F) << 2) | ((channels >> 2) & 0x01)
    b[3] = ((channels & 0x03) << 6) | ((frame_len >> 11) & 0x03)
    b[4] = (frame_len >> 3) & 0xFF
    b[5] = ((frame_len & 0x07) << 5) | 0x1F  # buffer fullness high bits
    b[6] = 0xFC                              # fullness low bits + 1 raw block
    if crc:
        from stream_encoder_core import crc16_mpeg

        checksum = crc16_mpeg(bytes(b[:7]))
        b[7] = (checksum >> 8) & 0xFF
        b[8] = checksum & 0xFF
    return bytes(b)


def _write_wav(path: str, pcm: Sequence[float], sample_rate: int, channels: int) -> None:
    with wave.open(path, "wb") as fh:
        fh.setnchannels(channels)
        fh.setsampwidth(2)
        fh.setframerate(sample_rate)
        frames = bytearray()
        for value in pcm:
            sample = int(max(-1.0, min(1.0, float(value))) * 32767.0)
            frames += struct.pack("<h", sample)
        fh.writeframes(bytes(frames))


class FdkAACEncoder:
    """Configuration + ADTS framing around the libfdk encoder."""

    def __init__(self, config: AACConfig | None = None) -> None:
        self.config = (config or AACConfig()).validate()
        self.backend = find_backend()

    @property
    def available(self) -> bool:
        return self.backend is not None

    @property
    def latency_ms(self) -> float:
        return self.config.latency_ms

    @property
    def frame_samples(self) -> int:
        # AAC-LC/HE-AAC core frame is 1024 samples; at 48 kHz SBR doubles the
        # output rate but not the frame count.
        return 2048 if self.config.profile == "he-aacv2" else 1024

    def _require(self) -> str:
        if not self.backend:
            raise CodecUnavailable(
                "libfdk-aac is not installed — install `fdkaac` "
                "(Debian: fdkaac, macOS: brew install fdkaac) or link libfdk-aac."
            )
        if not self.backend.startswith("cli:"):
            raise CodecUnavailable(
                "a libfdk-aac shared library was found but this build has no "
                "ABI binding for it; install the `fdkaac` command line encoder."
            )
        return self.backend.split(":", 1)[1]

    def encode_pcm(self, pcm: Sequence[float]) -> bytes:
        """Encode interleaved float PCM to one ADTS access unit stream."""
        cli = self._require()
        cfg = self.config
        with tempfile.TemporaryDirectory(prefix="signalpath-aac-") as tmp:
            wav_path = os.path.join(tmp, "in.wav")
            out_path = os.path.join(tmp, "out.aac")
            _write_wav(wav_path, pcm, cfg.sample_rate, cfg.channels)
            cmd = [
                cli,
                "--profile",
                str(cfg.aot),
                "--bitrate",
                str(cfg.bitrate_kbps),
                "--transport-format",
                "1" if cfg.container == "adts" else "0",
                "--output",
                out_path,
            ]
            if cfg.crc:
                cmd.append("--crc")
            cmd.append(wav_path)
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"fdkaac failed ({proc.returncode}): {proc.stderr.strip()[:240]}"
                )
            with open(out_path, "rb") as fh:
                return fh.read()

    def wrap(self, payload: bytes) -> bytes:
        """Frame a raw AAC access unit in ADTS (no-op for ADTS/raw configs)."""
        if self.config.container != "adts":
            return payload
        return adts_header(
            len(payload),
            sample_rate=self.config.sample_rate,
            channels=self.config.channels,
            crc=self.config.crc,
        ) + payload

    def core(self) -> EncoderCore:
        return EncoderCore(
            None,
            codec=self.config.profile,
            sample_rate=self.config.sample_rate,
            frame_samples=self.frame_samples,
            bitrate_kbps=self.config.bitrate_kbps,
            delay_ms=self.latency_ms,
        )

    def status(self) -> dict[str, object]:
        return {
            "available": self.available,
            "backend": self.backend,
            "profile": self.config.profile,
            "bitrate_kbps": self.config.bitrate_kbps,
            "sbr": self.config.sbr,
            "adts": self.config.container == "adts",
            "crc": self.config.crc,
            "latency_ms": self.latency_ms,
            "frame_samples": self.frame_samples,
            "aot": self.config.aot,
        }


__all__ = [
    "FdkAACEncoder",
    "AACConfig",
    "CodecUnavailable",
    "adts_header",
    "find_backend",
    "PROFILES",
    "ADTS_RATES",
]
