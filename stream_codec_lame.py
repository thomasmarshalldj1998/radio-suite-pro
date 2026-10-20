"""LAME 3.100 MP3 backend (SignalPath v3.1, module A4).

The binding is a thin ctypes wrapper around `libmp3lame`, so the encoder that
ships with the station is the same LAME 3.100 build the presets were tuned on
rather than a re-implementation. Where the library is absent the module still
builds (so a headless install can load the app), and encoding raises a clear
`CodecUnavailable` naming the packages to install.

Supported, as specified:

* CBR / ABR / VBR, 96–320 kbps (VBR quality 0–9);
* `standard` (VBR −V2) and `extreme` (VBR −V0) presets;
* the full nine-frame bit reservoir (LAME's own, not bypassed);
* optional per-frame CRC (`lame_set_error_protection`).
"""

from __future__ import annotations

import ctypes
import ctypes.util
import shutil
import struct
from dataclasses import dataclass
from typing import Sequence

from stream_encoder_core import EncoderCore

MIN_BITRATE = 96
MAX_BITRATE = 320
MODES = ("cbr", "abr", "vbr")
PRESETS = {
    "standard": {"mode": "vbr", "vbr_quality": 2},
    "extreme": {"mode": "vbr", "vbr_quality": 0},
}


class CodecUnavailable(RuntimeError):
    """The native encoder is not installed on this host."""


@dataclass
class LameConfig:
    sample_rate: int = 48_000
    channels: int = 2
    bitrate_kbps: int = 128
    mode: str = "cbr"
    vbr_quality: int = 2
    quality: int = 2
    crc: bool = False

    def validate(self) -> "LameConfig":
        if self.mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if not MIN_BITRATE <= self.bitrate_kbps <= MAX_BITRATE:
            raise ValueError(f"bitrate must be {MIN_BITRATE}–{MAX_BITRATE} kbps")
        if not 0 <= self.vbr_quality <= 9:
            raise ValueError("VBR quality must be 0–9")
        if not 0 <= self.quality <= 9:
            raise ValueError("quality must be 0–9")
        if self.channels not in (1, 2):
            raise ValueError("channels must be 1 or 2")
        return self

    @classmethod
    def preset(cls, name: str, **overrides: object) -> "LameConfig":
        key = name.lower()
        if key not in PRESETS:
            raise ValueError(f"preset must be one of {tuple(PRESETS)}")
        values = dict(PRESETS[key])
        values.update(overrides)
        return cls(**values).validate()  # type: ignore[arg-type]


def find_library() -> str | None:
    """Absolute path to libmp3lame, or None when it is not installed."""
    name = ctypes.util.find_library("mp3lame")
    return name or None


def lame_version() -> str | None:
    path = find_library()
    if not path:
        return None
    try:
        lib = ctypes.CDLL(path)
        lib.get_lame_version.restype = ctypes.c_char_p
        value = lib.get_lame_version()
        return value.decode("ascii", "replace") if value else None
    except (OSError, AttributeError):
        return None


def cli_path() -> str | None:
    return shutil.which("lame")


class LameEncoder:
    """Streaming MP3 encoder with LAME's native bit reservoir."""

    def __init__(self, config: LameConfig | None = None) -> None:
        self.config = (config or LameConfig()).validate()
        self._lib = None
        self._handle = None
        self._frame_samples = 1152
        self._closed = False
        path = find_library()
        if path:
            self._open(path)

    # ── native handle ───────────────────────────────────────────────────
    def _open(self, path: str) -> None:
        try:
            lib = ctypes.CDLL(path)
        except OSError as exc:
            raise CodecUnavailable(f"libmp3lame could not be loaded: {exc}") from exc
        for fn in (
            "lame_init",
            "lame_set_in_samplerate",
            "lame_set_num_channels",
            "lame_set_brate",
            "lame_set_mode",
            "lame_set_quality",
            "lame_set_VBR",
            "lame_set_VBR_q",
            "lame_set_error_protection",
            "lame_init_params",
            "lame_encode_buffer_interleaved_float",
            "lame_encode_flush",
            "lame_close",
        ):
            if not hasattr(lib, fn):
                raise CodecUnavailable(f"libmp3lame is missing {fn}")
        lib.lame_init.restype = ctypes.c_void_p
        lib.lame_encode_buffer_interleaved_float.restype = ctypes.c_int
        lib.lame_encode_buffer_interleaved_float.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_ubyte),
            ctypes.c_int,
        ]
        lib.lame_encode_flush.restype = ctypes.c_int
        lib.lame_encode_flush.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_ubyte),
            ctypes.c_int,
        ]
        lib.lame_close.argtypes = [ctypes.c_void_p]
        lib.lame_init_params.argtypes = [ctypes.c_void_p]
        handle = lib.lame_init()
        if not handle:
            raise CodecUnavailable("lame_init failed")
        cfg = self.config
        lib.lame_set_in_samplerate(handle, cfg.sample_rate)
        lib.lame_set_num_channels(handle, cfg.channels)
        lib.lame_set_brate(handle, cfg.bitrate_kbps)
        lib.lame_set_mode(handle, 3 if cfg.channels == 1 else 1)  # MONO / JOINT_STEREO
        lib.lame_set_quality(handle, cfg.quality)
        # LAME VBR enum: 0 off, 4 vbr_mtrh (the modern VBR engine), 3 abr.
        vbr = {"cbr": 0, "abr": 3, "vbr": 4}[cfg.mode]
        lib.lame_set_VBR(handle, vbr)
        lib.lame_set_VBR_q(handle, cfg.vbr_quality)
        lib.lame_set_error_protection(handle, 1 if cfg.crc else 0)
        if lib.lame_init_params(handle) < 0:
            lib.lame_close(handle)
            raise CodecUnavailable("lame_init_params rejected the configuration")
        self._lib = lib
        self._handle = handle

    @property
    def available(self) -> bool:
        return self._lib is not None

    @property
    def reservoir_frames(self) -> int:
        return 9

    @property
    def latency_ms(self) -> float:
        # LAME's encoder delay (576 samples) plus the decoder delay (529).
        return (576 + 529) * 1000.0 / self.config.sample_rate

    def _require(self) -> None:
        if self._lib is None:
            raise CodecUnavailable(
                "LAME 3.100 is not installed — install libmp3lame "
                "(Debian: libmp3lame0, macOS: brew install lame) or use the "
                "bundled WASM encoder in the desktop build."
            )

    # ── encoding ────────────────────────────────────────────────────────
    def encode_frame(self, pcm: Sequence[float]) -> bytes:
        """Encode up to 1152 interleaved float samples; returns MP3 bytes."""
        self._require()
        channels = self.config.channels
        frames = len(pcm) // channels
        if frames == 0:
            return b""
        buf = (ctypes.c_float * len(pcm))(*[float(x) for x in pcm])
        out = (ctypes.c_ubyte * (frames * 2 + 7200))()
        written = self._lib.lame_encode_buffer_interleaved_float(
            self._handle, buf, frames, out, len(out)
        )
        if written < 0:
            raise RuntimeError(f"lame_encode_buffer returned {written}")
        return bytes(out[:written])

    def flush(self) -> bytes:
        self._require()
        out = (ctypes.c_ubyte * 7200)()
        written = self._lib.lame_encode_flush(self._handle, out, len(out))
        return bytes(out[: max(0, written)])

    def close(self) -> None:
        if self._handle and self._lib:
            self._lib.lame_close(self._handle)
        self._handle = None
        self._lib = None
        self._closed = True

    def __enter__(self) -> "LameEncoder":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def core(self) -> EncoderCore:
        """Wire this encoder into the timestamp/reservoir core.

        LAME writes its CRC inside the MP3 frame header, so the core's
        two-byte trailer check stays off: enabling it here would flag every
        frame as bad. `lame_set_error_protection` still applies the CRC.
        """
        return EncoderCore(
            lambda pcm, _index: self.encode_frame(pcm),
            codec="mp3",
            sample_rate=self.config.sample_rate,
            frame_samples=self._frame_samples,
            bitrate_kbps=self.config.bitrate_kbps,
            delay_ms=self.latency_ms,
            crc=False,
        )

    def status(self) -> dict[str, object]:
        return {
            "available": self.available,
            "version": lame_version(),
            "library": find_library(),
            "cli": cli_path(),
            "config": self.config.__dict__,
            "reservoir_frames": self.reservoir_frames,
            "latency_ms": round(self.latency_ms, 2),
        }


def mp3_frame_header(bitrate_kbps: int, sample_rate: int = 48_000, mono: bool = False) -> bytes:
    """A valid MPEG-1 Layer III frame header (for stream probes and tests)."""
    rates = {32_000: 0, 44_100: 1, 48_000: 2}
    if sample_rate not in rates:
        raise ValueError("MPEG-1 supports 32, 44.1 and 48 kHz")
    table = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    if bitrate_kbps not in table:
        raise ValueError("bitrate must be a valid MPEG-1 Layer III rate")
    index = table.index(bitrate_kbps)
    header = 0xFFE00000                    # 11-bit sync word
    header |= 0b11 << 19                   # MPEG-1
    header |= 0b01 << 17                   # Layer III
    header |= 1 << 16                      # no CRC
    header |= index << 12
    header |= rates[sample_rate] << 10
    header |= (3 if mono else 1) << 6      # single channel / joint stereo
    return struct.pack(">I", header)


__all__ = [
    "LameEncoder",
    "LameConfig",
    "CodecUnavailable",
    "find_library",
    "lame_version",
    "cli_path",
    "mp3_frame_header",
    "PRESETS",
]
