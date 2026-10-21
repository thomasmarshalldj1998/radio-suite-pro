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

from proc_accel import filter_block
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
        det_l = filter_block(self._det_l, l)
        det_r = filter_block(self._det_r, r)
        high_l = filter_block(self._hp_l, l)
        high_r = filter_block(self._hp_r, r)
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        env_state = self._env
        attack_env = env_state.attack
        release_env = env_state.release
        env = env_state.value
        attack = self._attack
        release = self._release
        gain = self._gain
        mix = self.mix
        threshold = self.threshold_db
        threshold_lin = 10.0 ** (threshold / 20.0)
        slope = 1.0 - 1.0 / self.ratio
        max_reduction = self.range_db
        for i, (xl, xr) in enumerate(zip(l, r)):
            detector = abs(det_l[i])
            other = abs(det_r[i])
            if other > detector:
                detector = other
            coef_env = attack_env if detector > env else release_env
            env += (detector - env) * coef_env
            if env <= threshold_lin:
                target = 1.0
            else:
                level = 20.0 * math.log10(env)
                reduction = (level - threshold) * slope
                if reduction < 0.0:
                    reduction = 0.0
                elif reduction > max_reduction:
                    reduction = max_reduction
                target = 10.0 ** (-reduction / 20.0)
            coef = attack if target < gain else release
            gain += (target - gain) * coef
            out_l[i] = xl + high_l[i] * (gain - 1.0) * mix
            out_r[i] = xr + high_r[i] * (gain - 1.0) * mix
        env_state.value = env
        self._gain = gain
        self.reduction_db = -20.0 * math.log10(max(gain, 1e-9))
        self.sibilance_db = level_db(env)
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
