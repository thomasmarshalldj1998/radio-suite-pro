"""FM pre-emphasis / de-emphasis.

The 50 µs and 75 µs time constants are the two FM standards. A high shelf at
the corresponding corner gives the familiar rising response; ``mode='de'``
applies the inverse for monitoring a pre-emphasised feed.

The filter is a shelf rather than an exact analogue differentiator so it stays
stable at 48 kHz and composes with the rest of the chain. Bypass is bit-exact.
"""

from __future__ import annotations

from typing import Sequence

from proc_accel import filter_block
from proc_dsp import Biquad, copy_stereo

__all__ = ["PreEmphasisFilter"]


class PreEmphasisFilter:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        time_constant_us: float = 75.0,
        gain_db: float = 9.0,
        mode: str = "pre",
    ) -> None:
        if time_constant_us not in (50.0, 75.0):
            raise ValueError("time_constant_us must be 50 or 75")
        if not -12.0 <= gain_db <= 12.0:
            raise ValueError("gain_db must be -12…12 dB")
        if mode not in ("pre", "de"):
            raise ValueError("mode must be pre or de")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.time_constant_us = float(time_constant_us)
        self.gain_db = float(gain_db)
        self.mode = mode
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        corner = 1.0 / (2.0 * 3.141592653589793 * self.time_constant_us * 1e-6)
        signed_gain = self.gain_db if self.mode == "pre" else -self.gain_db
        self._shelf_l = Biquad.high_shelf(fs, corner, signed_gain)
        self._shelf_r = Biquad.high_shelf(fs, corner, signed_gain)
        self.corner_hz = corner

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        return filter_block(self._shelf_l, l), filter_block(self._shelf_r, r)

    def state(self) -> dict[str, float | bool | str]:
        return {
            "enabled": self.enabled,
            "time_constant_us": self.time_constant_us,
            "corner_hz": round(self.corner_hz, 1),
            "gain_db": self.gain_db,
            "mode": self.mode,
        }
