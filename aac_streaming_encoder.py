"""Streaming AAC encoder — native libfdk-aac first, fdkaac CLI second.

The native path binds `libfdk-aac` directly through ctypes. That is the one the
bridge uses: no temporary file, no pipe, and the codec delay is read back from
the encoder (`AACENC_InfoStruct.nDelay`) instead of guessed. HE-AAC v2 and
AAC-LD are both configured here, matching `stream_codec_libfdk_aac.py`.

If the shared library is missing but the `fdkaac` command exists, the encoder
falls back to a stdin/stdout pipe carrying a WAV header with an unknown length
(`--ignorelength`). That path is slower but keeps a station on air.

Latency is read from the library, not assumed: FDK 2.0.2 reports 148 ms for
HE-AAC v2 at 48 kHz (SBR + parametric-stereo filterbank included) and 10.7 ms
for AAC-LD. Report the measured value rather than the older 48 ms figure.

    enc = StreamingAACEncoder(bitrate=64000, profile="he-aacv2")
    enc.start()
    aac = enc.encode(pcm_s16le_interleaved)   # ADTS/LOAS bytes, possibly b""
    enc.stop()
"""

from __future__ import annotations

import array
import ctypes
import ctypes.util
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

AACENC_OK = 0x0000
AACENC_ENCODE_EOF = 0x0080

# AACENC_PARAM
AACENC_AOT = 0x0100
AACENC_BITRATE = 0x0101
AACENC_SAMPLERATE = 0x0103
AACENC_GRANULE_LENGTH = 0x0105
AACENC_CHANNELMODE = 0x0106
AACENC_CHANNELORDER = 0x0107
AACENC_AFTERBURNER = 0x0200
AACENC_TRANSMUX = 0x0300
AACENC_PROTECTION = 0x0306

# TRANSPORT_TYPE
TT_MP4_RAW = 0
TT_MP4_ADTS = 2
TT_MP4_LATM_MCP1 = 6
TT_MP4_LOAS = 10

# CHANNEL_MODE
MODE_1 = 1
MODE_2 = 2

PROFILES = {
    "aac-lc": {"aot": 2, "min": 32_000, "max": 320_000, "transport": TT_MP4_ADTS},
    "he-aac": {"aot": 5, "min": 24_000, "max": 128_000, "transport": TT_MP4_ADTS},
    "he-aacv2": {"aot": 29, "min": 24_000, "max": 128_000, "transport": TT_MP4_ADTS},
    # LOAS carries the LATM AudioMuxElement with a sync word, so a live link
    # can lock without an out-of-band StreamMuxConfig.
    "aac-ld": {"aot": 23, "min": 64_000, "max": 192_000, "transport": TT_MP4_LOAS},
}


class AACEncoderError(RuntimeError):
    pass


# ── ctypes ABI ──────────────────────────────────────────────────────────


class _BufDesc(ctypes.Structure):
    _fields_ = [
        ("numBufs", ctypes.c_int),
        ("bufs", ctypes.POINTER(ctypes.c_void_p)),
        ("bufferIdentifiers", ctypes.POINTER(ctypes.c_int)),
        ("bufSizes", ctypes.POINTER(ctypes.c_int)),
        ("bufElSizes", ctypes.POINTER(ctypes.c_int)),
    ]


class _InArgs(ctypes.Structure):
    _fields_ = [("numInSamples", ctypes.c_int), ("numAncBytes", ctypes.c_int)]


class _OutArgs(ctypes.Structure):
    _fields_ = [
        ("numOutBytes", ctypes.c_int),
        ("numInSamples", ctypes.c_int),
        ("numAncBytes", ctypes.c_int),
        ("bitResState", ctypes.c_int),
    ]


class _Info(ctypes.Structure):
    _fields_ = [
        ("maxOutBufBytes", ctypes.c_uint),
        ("maxAncBytes", ctypes.c_uint),
        ("inBufFillLevel", ctypes.c_uint),
        ("inputChannels", ctypes.c_uint),
        ("frameLength", ctypes.c_uint),
        ("nDelay", ctypes.c_uint),
        ("nDelayCore", ctypes.c_uint),
        ("confBuf", ctypes.c_ubyte * 64),
        ("confSize", ctypes.c_uint),
    ]


def find_fdk_library() -> Optional[str]:
    name = ctypes.util.find_library("fdk-aac") or ctypes.util.find_library("fdk_aac")
    if name:
        return name
    for candidate in (
        "libfdk-aac.so.2",
        "libfdk-aac.so",
        "/usr/lib/x86_64-linux-gnu/libfdk-aac.so.2",
        "/usr/local/lib/libfdk-aac.so",
    ):
        try:
            ctypes.CDLL(candidate)
            return candidate
        except OSError:
            continue
    return None


class _FdkNative:
    """One libfdk-aac encoder handle."""

    def __init__(
        self,
        bitrate: int,
        sample_rate: int,
        channels: int,
        profile: str,
        crc: bool,
        afterburner: bool = True,
    ) -> None:
        if profile not in PROFILES:
            raise AACEncoderError(f"unknown profile {profile!r}")
        spec = PROFILES[profile]
        if not spec["min"] <= bitrate <= spec["max"]:
            raise AACEncoderError(
                f"{profile} bitrate must be {spec['min'] // 1000}–{spec['max'] // 1000} kbps"
            )
        if profile == "he-aacv2" and channels != 2:
            raise AACEncoderError("HE-AAC v2 requires stereo")
        path = find_fdk_library()
        if not path:
            raise AACEncoderError("libfdk-aac is not installed")
        self.lib = ctypes.CDLL(path)
        self._bind()
        self.profile = profile
        self.sample_rate = sample_rate
        self.channels = channels
        self.crc = crc
        self.handle = ctypes.c_void_p()
        err = self.lib.aacEncOpen(ctypes.byref(self.handle), 0, 0)
        if err != AACENC_OK:
            raise AACEncoderError(f"aacEncOpen failed ({err:#x})")

        self._set(AACENC_AOT, spec["aot"])
        self._set(AACENC_BITRATE, bitrate)
        self._set(AACENC_SAMPLERATE, sample_rate)
        self._set(AACENC_CHANNELMODE, MODE_1 if channels == 1 else MODE_2)
        self._set(AACENC_CHANNELORDER, 1)  # WAV order: L, R
        self._set(AACENC_TRANSMUX, spec["transport"])
        self._set(AACENC_PROTECTION, 1 if crc and spec["transport"] == TT_MP4_ADTS else 0)
        self._set(AACENC_AFTERBURNER, 1 if afterburner else 0)
        if profile == "aac-ld":
            self._set(AACENC_GRANULE_LENGTH, 512)

        # NULL encode call initialises the configured instance.
        err = self.lib.aacEncEncode(self.handle, None, None, None, None)
        if err != AACENC_OK:
            self.close()
            raise AACEncoderError(f"encoder initialisation failed ({err:#x})")

        self.info = _Info()
        err = self.lib.aacEncInfo(self.handle, ctypes.byref(self.info))
        if err != AACENC_OK:
            self.close()
            raise AACEncoderError(f"aacEncInfo failed ({err:#x})")

        self.frame_length = int(self.info.frameLength)
        self.max_out = max(4096, int(self.info.maxOutBufBytes))
        self._pcm = array.array("h")
        self._closed = False

    def _bind(self) -> None:
        lib = self.lib
        lib.aacEncOpen.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint, ctypes.c_uint]
        lib.aacEncOpen.restype = ctypes.c_int
        lib.aacEncoder_SetParam.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint]
        lib.aacEncoder_SetParam.restype = ctypes.c_int
        lib.aacEncEncode.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(_BufDesc),
            ctypes.POINTER(_BufDesc),
            ctypes.POINTER(_InArgs),
            ctypes.POINTER(_OutArgs),
        ]
        lib.aacEncEncode.restype = ctypes.c_int
        lib.aacEncInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Info)]
        lib.aacEncInfo.restype = ctypes.c_int
        lib.aacEncClose.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        lib.aacEncClose.restype = ctypes.c_int

    def _set(self, param: int, value: int) -> None:
        err = self.lib.aacEncoder_SetParam(self.handle, param, value)
        if err != AACENC_OK:
            raise AACEncoderError(f"parameter {param:#x}={value} rejected ({err:#x})")

    def _encode_frame(self, samples: Sequence[int]) -> bytes:
        pcm = (ctypes.c_short * len(samples))(*samples)
        out = (ctypes.c_ubyte * self.max_out)()
        in_bufs = (ctypes.c_void_p * 1)(ctypes.cast(pcm, ctypes.c_void_p))
        in_ids = (ctypes.c_int * 1)(0)  # IN_AUDIO_DATA
        in_sizes = (ctypes.c_int * 1)(len(samples) * 2)
        in_el = (ctypes.c_int * 1)(2)
        in_desc = _BufDesc(1, in_bufs, in_ids, in_sizes, in_el)
        out_bufs = (ctypes.c_void_p * 1)(ctypes.cast(out, ctypes.c_void_p))
        out_ids = (ctypes.c_int * 1)(3)  # OUT_BITSTREAM_DATA
        out_sizes = (ctypes.c_int * 1)(len(out))
        out_el = (ctypes.c_int * 1)(1)
        out_desc = _BufDesc(1, out_bufs, out_ids, out_sizes, out_el)
        inargs = _InArgs(len(samples), 0)
        outargs = _OutArgs()
        err = self.lib.aacEncEncode(
            self.handle, ctypes.byref(in_desc), ctypes.byref(out_desc),
            ctypes.byref(inargs), ctypes.byref(outargs),
        )
        if err != AACENC_OK:
            raise AACEncoderError(f"aacEncEncode failed ({err:#x})")
        if outargs.numOutBytes < 0 or outargs.numOutBytes > len(out):
            raise AACEncoderError("encoder reported an impossible output size")
        return bytes(out[: outargs.numOutBytes])

    def encode_samples(self, samples: Iterable[int]) -> bytes:
        if self._closed:
            raise AACEncoderError("encoder is closed")
        self._pcm.extend(int(max(-32768, min(32767, s))) for s in samples)
        frame = self.frame_length * self.channels
        chunks = []
        while len(self._pcm) >= frame:
            block = self._pcm[:frame]
            del self._pcm[:frame]
            chunks.append(self._encode_frame(block))
        return b"".join(chunks)

    def encode_s16le(self, data: bytes) -> bytes:
        pcm = array.array("h")
        pcm.frombytes(data[: len(data) - (len(data) % 2)])
        if sys.byteorder == "big":
            pcm.byteswap()
        return self.encode_samples(pcm)

    def flush(self) -> bytes:
        if self._closed:
            return b""
        # Drain whole frames still in the Python buffer first.
        frame = self.frame_length * self.channels
        out = b""
        while len(self._pcm) >= frame:
            out += self._encode_frame(self._pcm[:frame])
            del self._pcm[:frame]
        if self._pcm:
            padded = list(self._pcm) + [0] * (frame - len(self._pcm))
            out += self._encode_frame(padded)
            self._pcm = array.array("h")
        out_buf = (ctypes.c_ubyte * self.max_out)()
        out_bufs = (ctypes.c_void_p * 1)(ctypes.cast(out_buf, ctypes.c_void_p))
        ids = (ctypes.c_int * 1)(3)
        sizes = (ctypes.c_int * 1)(len(out_buf))
        el = (ctypes.c_int * 1)(1)
        desc = _BufDesc(1, out_bufs, ids, sizes, el)
        inargs = _InArgs(-1, 0)
        for _ in range(32):
            outargs = _OutArgs()
            err = self.lib.aacEncEncode(
                self.handle, None, ctypes.byref(desc), ctypes.byref(inargs), ctypes.byref(outargs)
            )
            if outargs.numOutBytes:
                out += bytes(out_buf[: outargs.numOutBytes])
            if err == AACENC_ENCODE_EOF or outargs.numOutBytes <= 0:
                break
            if err != AACENC_OK:
                raise AACEncoderError(f"flush failed ({err:#x})")
        return out

    @property
    def latency_ms(self) -> float:
        return self.info.nDelay * 1000.0 / self.sample_rate

    def status(self) -> dict[str, object]:
        return {
            "backend": "native",
            "profile": self.profile,
            "aot": PROFILES[self.profile]["aot"],
            "frame_length": self.frame_length,
            "delay_samples": int(self.info.nDelay),
            "latency_ms": round(self.latency_ms, 2),
            "max_out_bytes": self.max_out,
            "conf_size": int(self.info.confSize),
            "transport": {
                TT_MP4_ADTS: "adts",
                TT_MP4_LOAS: "loas",
                TT_MP4_LATM_MCP1: "latm",
            }.get(PROFILES[self.profile]["transport"], "raw"),
        }

    def close(self) -> None:
        if not self._closed and self.handle:
            self.lib.aacEncClose(ctypes.byref(self.handle))
        self.handle = ctypes.c_void_p()
        self._closed = True


# ── fdkaac CLI fallback ─────────────────────────────────────────────────


class _FdkCli:
    """fdkaac pipe wrapper (WAV header with an unknown length + raw PCM)."""

    def __init__(self, bitrate: int, sample_rate: int, channels: int, profile: str) -> None:
        cli = shutil.which("fdkaac")
        if not cli:
            raise AACEncoderError("fdkaac is not installed")
        self.cli = cli
        self.profile = profile
        self.sample_rate = sample_rate
        self.channels = channels
        self.bitrate = bitrate
        self.proc: Optional[subprocess.Popen] = None
        self.started_at = 0.0

    def start(self) -> None:
        spec = PROFILES[self.profile]
        cmd = [
            self.cli,
            "--ignorelength",
            "--profile", str(spec["aot"]),
            "--bitrate", str(self.bitrate // 1000),
            "--sampling-rate", str(self.sample_rate),
            "--channel-mode", "stereo" if self.channels == 2 else "mono",
            "--transport-format", "2" if spec["transport"] == TT_MP4_ADTS else "10",
            "--output", "-",
            "-",
        ]
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        # WAV header with "unknown" sizes; --ignorelength makes fdkaac stream it.
        self._write(self._wav_header())
        self.started_at = time.time()

    def _wav_header(self) -> bytes:
        import struct

        block = self.channels * 2
        return (
            b"RIFF"
            + struct.pack("<I", 0xFFFFFFFF)
            + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, self.channels, self.sample_rate, self.sample_rate * block, block, 16)
            + b"data"
            + struct.pack("<I", 0xFFFFFFFF)
        )

    def _write(self, data: bytes) -> None:
        if not self.proc or not self.proc.stdin:
            return
        try:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass

    def encode(self, pcm: bytes) -> bytes:
        self._write(pcm)
        if not self.proc or not self.proc.stdout:
            return b""
        import select

        ready, _, _ = select.select([self.proc.stdout], [], [], 0.005)
        if not ready:
            return b""
        return os.read(self.proc.stdout.fileno(), 8192)

    @property
    def latency_ms(self) -> float:
        return 200.0

    def status(self) -> dict[str, object]:
        return {
            "backend": "cli",
            "profile": self.profile,
            "latency_ms": self.latency_ms,
            "pid": self.proc.pid if self.proc else None,
        }

    def flush(self) -> bytes:
        if not self.proc:
            return b""
        out = b""
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            out = self.proc.stdout.read() if self.proc.stdout else b""
            self.proc.wait(timeout=2)
        except Exception:
            pass
        return out

    def close(self) -> None:
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2)
            except Exception:
                pass
        self.proc = None


class StreamingAACEncoder:
    """Public encoder: native libfdk first, CLI when only fdkaac exists."""

    def __init__(
        self,
        bitrate: int = 96_000,
        sample_rate: int = 48_000,
        profile: str = "he-aacv2",
        channels: int = 2,
        crc: bool = True,
        backend: str = "auto",
    ) -> None:
        if profile not in PROFILES:
            raise AACEncoderError(f"profile must be one of {tuple(PROFILES)}")
        if backend not in ("auto", "native", "cli"):
            raise AACEncoderError("backend must be auto, native or cli")
        spec = PROFILES[profile]
        if not spec["min"] <= bitrate <= spec["max"]:
            raise AACEncoderError(
                f"{profile} bitrate must be {spec['min'] // 1000}–{spec['max'] // 1000} kbps"
            )
        self.bitrate = int(bitrate)
        self.sample_rate = int(sample_rate)
        self.profile = profile
        self.channels = int(channels)
        self.crc = bool(crc)
        self.requested_backend = backend
        self._inner: _FdkNative | _FdkCli | None = None
        self._error: str | None = None
        self._bytes_out = 0
        self._frames = 0
        self._latency_ms = 0.0

    @property
    def started(self) -> bool:
        return self._inner is not None

    @property
    def mode(self) -> str:
        if isinstance(self._inner, _FdkNative):
            return "native"
        if isinstance(self._inner, _FdkCli):
            return "cli"
        return "none"

    @property
    def error(self) -> str | None:
        return self._error

    @property
    def latency_ms(self) -> float:
        # Keep the last measured value after stop() so telemetry can still
        # report the pipeline delay of the session that just ended.
        return self._inner.latency_ms if self._inner else self._latency_ms

    @property
    def frames(self) -> int:
        return self._frames

    @property
    def bytes_out(self) -> int:
        return self._bytes_out

    def start(self) -> bool:
        if self._inner:
            return True
        self._error = None
        if self.requested_backend in ("auto", "native"):
            try:
                self._inner = _FdkNative(
                    self.bitrate, self.sample_rate, self.channels, self.profile, self.crc
                )
                self._latency_ms = self._inner.latency_ms
                return True
            except (AACEncoderError, OSError) as exc:
                self._error = str(exc)
                if self.requested_backend == "native":
                    return False
        if self.requested_backend in ("auto", "cli"):
            try:
                inner = _FdkCli(self.bitrate, self.sample_rate, self.channels, self.profile)
                inner.start()
                self._inner = inner
                self._latency_ms = inner.latency_ms
                return True
            except (AACEncoderError, OSError) as exc:
                self._error = f"{self._error + '; ' if self._error else ''}{exc}"
        return False

    def encode(self, pcm_s16le: bytes) -> bytes:
        if not self._inner:
            return b""
        if isinstance(self._inner, _FdkNative):
            out = self._inner.encode_s16le(pcm_s16le)
        else:
            out = self._inner.encode(pcm_s16le)
        self._bytes_out += len(out)
        if out:
            self._frames += 1
        return out

    def encode_samples(self, samples: Sequence[int]) -> bytes:
        if not isinstance(self._inner, _FdkNative):
            raise AACEncoderError("sample input requires the native backend")
        out = self._inner.encode_samples(samples)
        self._bytes_out += len(out)
        return out

    def restart(self) -> bool:
        self.stop()
        return self.start()

    def stop(self) -> bytes:
        tail = b""
        if self._inner:
            try:
                tail = self._inner.flush()
            except AACEncoderError:
                tail = b""
            self._inner.close()
            self._inner = None
        self._bytes_out += len(tail)
        return tail

    def status(self) -> dict[str, object]:
        detail = self._inner.status() if self._inner else {}
        return {
            "started": self.started,
            "mode": self.mode,
            "error": self._error,
            "bitrate": self.bitrate,
            "profile": self.profile,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "latency_ms": round(self.latency_ms, 2),
            "frames": self._frames,
            "bytes_out": self._bytes_out,
            **detail,
        }


def _pcm_s16le(samples: Sequence[int]) -> bytes:
    pcm = array.array("h", [int(max(-32768, min(32767, s))) for s in samples])
    if sys.byteorder == "big":
        pcm.byteswap()
    return pcm.tobytes()


if __name__ == "__main__":
    # 2 s of 1 kHz stereo at -6 dBFS → count ADTS frames.
    import math

    rate = 48_000
    enc = StreamingAACEncoder(bitrate=64_000)
    if not enc.start():
        raise SystemExit(f"encoder unavailable: {enc.error}")
    total = b""
    block = 960
    for n in range(0, rate * 2, block):
        samples = []
        for i in range(block):
            value = int(0.5 * 32767 * math.sin(2 * math.pi * 1000 * (n + i) / rate))
            samples.extend((value, value))
        total += enc.encode(_pcm_s16le(samples))
    status = enc.status()
    total += enc.stop()
    print(f"{status['mode']} · {len(total)} bytes · {status['latency_ms']} ms")
    print("first bytes:", total[:7].hex())
