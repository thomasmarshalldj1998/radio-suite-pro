"""Dual-band attack/sustain shaping (SignalPath v3.1, module B4).

A 300 Hz Linkwitz-Riley split feeding independent transient shapers. Attack is
driven by the ratio of a fast peak envelope to a slow one; sustain is the slow
envelope compared with a two-second reference, so body moves without touching
the initial hit.

    low  = LR4-LP(x),  high = LR4-HP(x)             # 300 Hz, 24 dB/oct
    fast = envelope(|band|, 3 ms), slow = envelope(|band|, 80 ms)
    attack_gain  = 1 + (±attack/100)  × 0.5 × clamp(fast/slow − 1, −1, 1)
    sustain_gain = clamp((slow/ref) ** (sustain/100 × 0.5), 0.5, 2)
    out = low × low_gain + high × high_gain

Attack/sustain are −100…+100 %; mode `emphasise` uses attack with its sign,
`smooth` inverts it (transients are softened), `transparent` leaves attack at
unity and only applies sustain. Every mode is bypassed at 0/0.
"""

from __future__ import annotations

import math
from typing import Sequence

from stream_encoder_core import Biquad, clamp

CROSSOVER_HZ = 300.0


class _Band:
    """Fast/slow/reference envelopes for one band."""

    def __init__(self, fs: int, fast_ms: float = 3.0, slow_ms: float = 80.0) -> None:
        self.fast_a = 1.0 - math.exp(-1.0 / max(1.0, fast_ms * fs / 1000.0))
        self.fast_r = 1.0 - math.exp(-1.0 / max(2.0, fast_ms * 3.0 * fs / 1000.0))
        self.slow_a = 1.0 - math.exp(-1.0 / max(1.0, slow_ms * fs / 1000.0))
        self.slow_r = 1.0 - math.exp(-1.0 / max(2.0, slow_ms * 2.0 * fs / 1000.0))
        self.ref_a = 1.0 - math.exp(-1.0 / (2.0 * fs))
        self.fast = 0.0
        self.slow = 0.0
        self.ref = 0.0

    def envelopes(self, value: float) -> tuple[float, float]:
        peak = abs(value)
        self.fast += (peak - self.fast) * (self.fast_a if peak > self.fast else self.fast_r)
        self.slow += (peak - self.slow) * (self.slow_a if peak > self.slow else self.slow_r)
        self.ref += (self.slow - self.ref) * self.ref_a
        return self.fast, self.slow


def band_gains(
    band: _Band, attack: float, sustain: float, mode: str
) -> tuple[float, float]:
    """(attack_gain, sustain_gain) for one band at the current envelope."""
    a = clamp(attack / 100.0, -1.0, 1.0)
    s = clamp(sustain / 100.0, -1.0, 1.0)
    if mode == "transparent":
        a = 0.0
    elif mode == "smooth":
        a = -a
    ratio = band.fast / band.slow if band.slow > 1e-9 else 1.0
    attack_gain = 1.0 + a * 0.5 * clamp(ratio - 1.0, -1.0, 1.0)
    ref_ratio = band.slow / band.ref if band.ref > 1e-9 else 1.0
    sustain_gain = clamp(ref_ratio ** (s * 0.5), 0.5, 2.0)
    return clamp(attack_gain, 0.4, 2.5), sustain_gain


class DualBandTransient:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        low_attack: float = 0.0,
        low_sustain: float = 0.0,
        high_attack: float = 0.0,
        high_sustain: float = 0.0,
        mode: str = "emphasise",
    ) -> None:
        if mode not in ("emphasise", "smooth", "transparent"):
            raise ValueError("mode must be emphasise, smooth or transparent")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.low_attack = float(clamp(low_attack, -100, 100))
        self.low_sustain = float(clamp(low_sustain, -100, 100))
        self.high_attack = float(clamp(high_attack, -100, 100))
        self.high_sustain = float(clamp(high_sustain, -100, 100))
        self.mode = mode
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._low_l = [Biquad.lowpass(fs, CROSSOVER_HZ), Biquad.lowpass(fs, CROSSOVER_HZ)]
        self._low_r = [Biquad.lowpass(fs, CROSSOVER_HZ), Biquad.lowpass(fs, CROSSOVER_HZ)]
        self._high_l = [Biquad.highpass(fs, CROSSOVER_HZ), Biquad.highpass(fs, CROSSOVER_HZ)]
        self._high_r = [Biquad.highpass(fs, CROSSOVER_HZ), Biquad.highpass(fs, CROSSOVER_HZ)]
        self._low_band = _Band(fs)
        self._high_band = _Band(fs)

    def _split(self, x: float, stages: list[Biquad]) -> float:
        return stages[1].process(stages[0].process(x))

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        n = min(len(left), len(right))
        neutral = (
            self.low_attack == 0
            and self.low_sustain == 0
            and self.high_attack == 0
            and self.high_sustain == 0
        )
        if not self.enabled or neutral:
            # Bypass is exact, including the crossover phase response.
            return [float(x) for x in left[:n]], [float(x) for x in right[:n]]

        out_l = [0.0] * n
        out_r = [0.0] * n
        for i in range(n):
            xl, xr = float(left[i]), float(right[i])
            ll = self._split(xl, self._low_l)
            lr = self._split(xr, self._low_r)
            hl = self._split(xl, self._high_l)
            hr = self._split(xr, self._high_r)
            self._low_band.envelopes(ll if abs(ll) > abs(lr) else lr)
            self._high_band.envelopes(hl if abs(hl) > abs(hr) else hr)
            la, ls = band_gains(self._low_band, self.low_attack, self.low_sustain, self.mode)
            ha, hs = band_gains(
                self._high_band, self.high_attack, self.high_sustain, self.mode
            )
            out_l[i] = ll * la * ls + hl * ha * hs
            out_r[i] = lr * la * ls + hr * ha * hs
        return out_l, out_r

    def state(self) -> dict[str, float | bool | str]:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "crossover_hz": CROSSOVER_HZ,
            "low_attack": self.low_attack,
            "low_sustain": self.low_sustain,
            "high_attack": self.high_attack,
            "high_sustain": self.high_sustain,
        }


__all__ = ["DualBandTransient", "CROSSOVER_HZ", "band_gains"]
