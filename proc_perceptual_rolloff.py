"""Perceptual codec roll-off.

A gentle cascade of low-pass filters removes the top octave before a lossy
encoder, preventing the codec from spending bits on content it will discard.
``slope_db_oct`` selects 12, 24 or 48 dB/octave; the default 24 dB/oct is a good
compromise between aliasing protection and air.

Bypass is exact and the default is bypassed.
"""

from __future__ import annotations

from typing import Sequence

from proc_accel import filter_chain
from proc_dsp import Biquad, copy_stereo

__all__ = ["PerceptualRolloff"]


class PerceptualRolloff:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        cutoff_hz: float = 15_000.0,
        slope_db_oct: int = 24,
    ) -> None:
        if not 4_000.0 <= cutoff_hz < sample_rate * 0.49:
            raise ValueError("cutoff_hz must be 4 kHz…Nyquist")
        if slope_db_oct not in (12, 24, 48):
            raise ValueError("slope_db_oct must be 12, 24 or 48")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.cutoff_hz = float(cutoff_hz)
        self.slope_db_oct = int(slope_db_oct)
        self.reset()

    def reset(self) -> None:
        stages = max(1, self.slope_db_oct // 12)
        self._filters_l = [Biquad.lowpass(self.sample_rate, self.cutoff_hz) for _ in range(stages)]
        self._filters_r = [Biquad.lowpass(self.sample_rate, self.cutoff_hz) for _ in range(stages)]

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        return filter_chain(self._filters_l, l), filter_chain(self._filters_r, r)

    def state(self) -> dict[str, float | int | bool]:
        return {
            "enabled": self.enabled,
            "cutoff_hz": self.cutoff_hz,
            "slope_db_oct": self.slope_db_oct,
        }
