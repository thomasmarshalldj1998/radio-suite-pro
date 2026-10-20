"""Stereo bandwidth limit.

Above ``cutoff_hz`` the side signal is narrowed (or fully mono at width 0),
which saves bits for codecs that cannot afford high-frequency stereo. The low
band keeps its full image.

    low = LP(cutoff), high = x − low
    high mid/side: side × width
    out = low + high
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo

__all__ = ["StereoBandwidthLimit"]


class StereoBandwidthLimit:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        cutoff_hz: float = 8_000.0,
        width: float = 0.5,
    ) -> None:
        if not 2_000.0 <= cutoff_hz < sample_rate * 0.45:
            raise ValueError("cutoff_hz must be 2 kHz…Nyquist")
        if not 0.0 <= width <= 1.0:
            raise ValueError("width must be 0–1")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.cutoff_hz = float(cutoff_hz)
        self.width = float(width)
        self.reset()

    def reset(self) -> None:
        self._low_l = Biquad.lowpass(self.sample_rate, self.cutoff_hz)
        self._low_r = Biquad.lowpass(self.sample_rate, self.cutoff_hz)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or self.width >= 1.0:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            low = self._low_l.process(xl)
            low2 = self._low_r.process(xr)
            high = xl - low
            high2 = xr - low2
            high_mid = 0.5 * (high + high2)
            high_side = 0.5 * (high - high2) * self.width
            out_l[i] = low + high_mid + high_side
            out_r[i] = low2 + high_mid - high_side
        return out_l, out_r

    def state(self) -> dict[str, float | bool]:
        return {
            "enabled": self.enabled,
            "cutoff_hz": self.cutoff_hz,
            "width": self.width,
        }
