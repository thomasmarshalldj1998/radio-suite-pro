"""Psychoacoustic de-esser.

A bandpass detector follows 5–9 kHz sibilance while a high-pass split isolates
the band that is actually reduced. Reduction is applied only to that high band,
so vowels and low-mid body are unaffected. Slow-ish attack and release (1 ms /
60 ms) avoid the lisping produced by sample-fast gain changes.

    sib   = bandpass(x, freq, q)
    high  = highpass(x, freq × 0.6)
    level = envelope(|sib|)
    gain  = 1 above threshold, reduced by (level − threshold) × (1 − 1/ratio)
    out   = x + high × (gain − 1)
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Biquad, Envelope, clamp, copy_stereo, level_db

__all__ = ["PsychoDeEsser", "DeEsserPsycho"]


class PsychoDeEsser:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        freq: float = 6_500.0,
        q: float = 1.2,
        threshold_db: float = -28.0,
        ratio: float = 4.0,
        range_db: float = 12.0,
        attack_ms: float = 1.0,
        release_ms: float = 60.0,
        mix: float = 1.0,
    ) -> None:
        if not 4_000.0 <= freq <= 10_000.0:
            raise ValueError("freq must be 4–10 kHz")
        if not 2.0 <= ratio <= 20.0 or not 0.0 <= range_db <= 24.0:
            raise ValueError("ratio/range outside range")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.freq = float(freq)
        self.q = max(0.3, float(q))
        self.threshold_db = float(threshold_db)
        self.ratio = float(ratio)
        self.range_db = float(range_db)
        self.attack_ms = max(0.1, float(attack_ms))
        self.release_ms = max(5.0, float(release_ms))
        self.mix = float(clamp(mix, 0.0, 1.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._det_l = Biquad.bandpass(fs, self.freq, self.q)
        self._det_r = Biquad.bandpass(fs, self.freq, self.q)
        self._hp_l = Biquad.highpass(fs, min(self.freq * 0.6, fs * 0.45))
        self._hp_r = Biquad.highpass(fs, min(self.freq * 0.6, fs * 0.45))
        self._env = Envelope(fs, self.attack_ms, self.release_ms)
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._gain = 1.0
        self.reduction_db = 0.0
        self.sibilance_db = -120.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.mix <= 0.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            detect = max(
                abs(self._det_l.process(xl)),
                abs(self._det_r.process(xr)),
            )
            env = self._env.process(detect)
            level = level_db(env)
            over = max(0.0, level - self.threshold_db)
            reduction = min(self.range_db, over * (1.0 - 1.0 / self.ratio))
            target = 10.0 ** (-reduction / 20.0)
            coef = self._attack if target < self._gain else self._release
            self._gain += (target - self._gain) * coef
            high_l = self._hp_l.process(xl)
            high_r = self._hp_r.process(xr)
            out_l[i] = xl + high_l * (self._gain - 1.0) * self.mix
            out_r[i] = xr + high_r * (self._gain - 1.0) * self.mix
            self.reduction_db = -20.0 * math.log10(max(self._gain, 1e-9))
            self.sibilance_db = level
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "freq": self.freq,
            "threshold_db": self.threshold_db,
            "ratio": self.ratio,
            "reduction_db": round(self.reduction_db, 2),
            "sibilance_db": round(self.sibilance_db, 2),
        }


DeEsserPsycho = PsychoDeEsser
