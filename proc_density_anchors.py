"""Dynamic density anchors (SignalPath v3.1, module B3).

Two narrow anchors — bass (60–120 Hz) and midrange (1–4 kHz) — whose dynamics
are tightened independently. The band is extracted, its envelope followed with
material-appropriate attack/release, and a bounded gain reduction is applied to
that band only:

    band      = bandpass(x, anchor)
    env       = envelope(|band|, attack, release)
    gain_db   = −depth × clamp((env_db − threshold) / 12, 0, 1)
    output    = x + band × (gain − 1)          # other bands untouched

Depth is 3 dB at 100 % strength, so the anchor adds density without changing
the overall level. Defaults are bypassed; bypass is bit-exact.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_accel import filter_block_array
from stream_encoder_core import Biquad, clamp

try:  # optional acceleration; the scalar path is the reference
    import numpy as _np
except ImportError:  # pragma: no cover - fallback hosts
    _np = None

BASS_RANGE = (60.0, 120.0)
MID_RANGE = (1000.0, 4000.0)


class _Anchor:
    def __init__(
        self,
        fs: int,
        freq: float,
        strength: float,
        attack_ms: float,
        release_ms: float,
        threshold_db: float = -30.0,
    ) -> None:
        self.filter_l = Biquad.bandpass(fs, freq, 0.9)
        self.filter_r = Biquad.bandpass(fs, freq, 0.9)
        self.strength = clamp(strength, 0.0, 100.0) / 100.0
        self.depth_db = 3.0 * self.strength
        self.attack = 1.0 - math.exp(-1.0 / max(1.0, attack_ms * fs / 1000.0))
        self.release = 1.0 - math.exp(-1.0 / max(1.0, release_ms * fs / 1000.0))
        self.threshold_db = threshold_db
        self.env_l = 0.0
        self.env_r = 0.0
        self.gain_db = 0.0

    def process(self, xl: float, xr: float) -> tuple[float, float]:
        bl = self.filter_l.process(xl)
        br = self.filter_r.process(xr)
        self.env_l += (abs(bl) - self.env_l) * (self.attack if abs(bl) > self.env_l else self.release)
        self.env_r += (abs(br) - self.env_r) * (self.attack if abs(br) > self.env_r else self.release)
        env = max(self.env_l, self.env_r)
        env_db = 20.0 * math.log10(env) if env > 0.0 else -120.0
        over = clamp((env_db - self.threshold_db) / 12.0, 0.0, 1.0)
        target = -self.depth_db * over
        # Smooth the gain itself so the anchor never chatters.
        self.gain_db += (target - self.gain_db) * (self.attack if target < self.gain_db else self.release)
        gain = 10.0 ** (self.gain_db / 20.0)
        return xl + bl * (gain - 1.0), xr + br * (gain - 1.0)

    def process_block(
        self, xl: Sequence[float], xr: Sequence[float]
    ) -> tuple[list[float], list[float]] | None:
        """Same maths as :meth:`process`, with the biquads run in C.

        The envelope and gain recursions stay sample-accurate but operate on
        plain lists, so the per-sample cost is arithmetic only — the four
        biquad evaluations per stereo frame are gone. Returns ``None`` when
        NumPy/SciPy are unavailable so the caller can use the scalar path.
        """
        if _np is None:
            return None
        bl = filter_block_array(self.filter_l, xl)
        br = filter_block_array(self.filter_r, xr)
        if bl is None or br is None:
            return None
        bands_l = bl.tolist()
        bands_r = br.tolist()
        n = len(bands_l)
        attack = self.attack
        release = self.release
        env_l = self.env_l
        env_r = self.env_r
        peaks = [0.0] * n
        for i in range(n):
            a = bands_l[i]
            if a < 0.0:
                a = -a
            env_l += (a - env_l) * (attack if a > env_l else release)
            b = bands_r[i]
            if b < 0.0:
                b = -b
            env_r += (b - env_r) * (attack if b > env_r else release)
            peaks[i] = env_l if env_l > env_r else env_r
        self.env_l = env_l
        self.env_r = env_r
        env = _np.asarray(peaks, dtype=_np.float64)
        with _np.errstate(divide="ignore"):
            env_db = _np.where(env > 0.0, 20.0 * _np.log10(_np.maximum(env, 1e-300)), -120.0)
        over = _np.clip((env_db - self.threshold_db) / 12.0, 0.0, 1.0)
        targets = (-self.depth_db * over).tolist()
        gain_db = self.gain_db
        gains = [0.0] * n
        for i in range(n):
            target = targets[i]
            gain_db += (target - gain_db) * (attack if target < gain_db else release)
            gains[i] = gain_db
        self.gain_db = gain_db
        gain = _np.power(10.0, _np.asarray(gains, dtype=_np.float64) / 20.0) - 1.0
        return (
            (_np.asarray(xl[:n], dtype=_np.float64) + _np.asarray(bands_l) * gain).tolist(),
            (_np.asarray(xr[:n], dtype=_np.float64) + _np.asarray(bands_r) * gain).tolist(),
        )


class DensityAnchors:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        bass_hz: float = 90.0,
        bass_strength: float = 50.0,
        mid_hz: float = 2500.0,
        mid_strength: float = 50.0,
        bass_attack_ms: float = 8.0,
        bass_release_ms: float = 120.0,
        mid_attack_ms: float = 5.0,
        mid_release_ms: float = 80.0,
    ) -> None:
        if not BASS_RANGE[0] <= bass_hz <= BASS_RANGE[1]:
            raise ValueError("bass anchor must sit in 60–120 Hz")
        if not MID_RANGE[0] <= mid_hz <= MID_RANGE[1]:
            raise ValueError("mid anchor must sit in 1–4 kHz")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.bass_hz = float(bass_hz)
        self.mid_hz = float(mid_hz)
        self.bass_strength = float(clamp(bass_strength, 0.0, 100.0))
        self.mid_strength = float(clamp(mid_strength, 0.0, 100.0))
        self._bass = _Anchor(
            self.sample_rate, bass_hz, bass_strength, bass_attack_ms, bass_release_ms
        )
        self._mid = _Anchor(
            self.sample_rate, mid_hz, mid_strength, mid_attack_ms, mid_release_ms
        )

    def reset(self) -> None:
        self._bass = _Anchor(
            self.sample_rate, self.bass_hz, self.bass_strength, 8.0, 120.0
        )
        self._mid = _Anchor(self.sample_rate, self.mid_hz, self.mid_strength, 5.0, 80.0)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        n = min(len(left), len(right))
        if not self.enabled or (self.bass_strength <= 0 and self.mid_strength <= 0):
            return [float(x) for x in left[:n]], [float(x) for x in right[:n]]
        bass_on = self.bass_strength > 0
        mid_on = self.mid_strength > 0
        if _np is not None and n >= 64:
            out_l = _np.asarray(left[:n], dtype=_np.float64).tolist()
            out_r = _np.asarray(right[:n], dtype=_np.float64).tolist()
            processed = True
            for stage, active in ((self._bass, bass_on), (self._mid, mid_on)):
                if not active:
                    continue
                result = stage.process_block(out_l, out_r)
                if result is None:
                    processed = False
                    break
                out_l, out_r = result
            if processed:
                return out_l, out_r
        out_l = [0.0] * n
        out_r = [0.0] * n
        for i in range(n):
            xl, xr = float(left[i]), float(right[i])
            if bass_on:
                xl, xr = self._bass.process(xl, xr)
            if mid_on:
                xl, xr = self._mid.process(xl, xr)
            out_l[i], out_r[i] = xl, xr
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "bass_hz": self.bass_hz,
            "bass_strength": self.bass_strength,
            "bass_gain_db": round(self._bass.gain_db, 2),
            "mid_hz": self.mid_hz,
            "mid_strength": self.mid_strength,
            "mid_gain_db": round(self._mid.gain_db, 2),
        }


__all__ = ["DensityAnchors", "BASS_RANGE", "MID_RANGE"]
