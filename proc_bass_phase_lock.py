"""Bass phase lock.

Below ``crossover_hz`` the left and right low bands are blended toward their
mono sum. That keeps kick/bass centred and phase-coherent for mono club systems
and FM, while the rest of the spectrum keeps its stereo image.

    low = LP(x); high = x − low
    mono = (low_L + low_R)/2
    low = low + (mono − low) × amount
    out = low + high

Amount 0 is bit-exact; amount 100 is fully mono bass.
"""

from __future__ import annotations

from typing import Sequence

from proc_accel import filter_block, filter_block_array
from proc_dsp import Biquad, clamp, copy_stereo, rms

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

__all__ = ["BassPhaseLock"]


class BassPhaseLock:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        crossover_hz: float = 120.0,
        amount: float = 100.0,
    ) -> None:
        if not 40.0 <= crossover_hz <= 300.0:
            raise ValueError("crossover_hz must be 40–300 Hz")
        if not 0.0 <= amount <= 100.0:
            raise ValueError("amount must be 0–100 %")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.crossover_hz = float(crossover_hz)
        self.amount = float(amount)
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._low_l = Biquad.lowpass(fs, self.crossover_hz)
        self._low_r = Biquad.lowpass(fs, self.crossover_hz)
        self.bass_width = 1.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.amount <= 0.0:
            return l, r
        mix = self.amount / 100.0
        if _np is not None and len(l) >= 64:
            base_l = filter_block_array(self._low_l, l)
            base_r = filter_block_array(self._low_r, r)
            if base_l is not None and base_r is not None:
                mono = 0.5 * (base_l + base_r)
                low_l = base_l + (mono - base_l) * mix
                low_r = base_r + (mono - base_r) * mix
                diff = low_l - low_r
                self.bass_width = float(_np.sqrt(_np.mean(diff * diff))) / max(
                    float(_np.sqrt(_np.mean(_np.square(low_l)))), 1e-9
                )
                return (
                    (low_l + (_np.asarray(l) - base_l)).tolist(),
                    (low_r + (_np.asarray(r) - base_r)).tolist(),
                )
        low_l = filter_block(self._low_l, l)
        low_r = filter_block(self._low_r, r)
        base_l, base_r = low_l, low_r
        low_l = [0.0] * len(l)
        low_r = [0.0] * len(r)
        high_l = [0.0] * len(l)
        high_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            low = base_l[i]
            low2 = base_r[i]
            mono = 0.5 * (low + low2)
            low_l[i] = low + (mono - low) * mix
            low_r[i] = low2 + (mono - low2) * mix
            high_l[i] = xl - low
            high_r[i] = xr - low2
        self.bass_width = (
            rms([a - b for a, b in zip(low_l, low_r)]) / max(rms(low_l), 1e-9)
            if low_l
            else 0.0
        )
        return (
            [a + b for a, b in zip(low_l, high_l)],
            [a + b for a, b in zip(low_r, high_r)],
        )

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "crossover_hz": self.crossover_hz,
            "amount": self.amount,
            "bass_width": round(self.bass_width, 4),
        }
