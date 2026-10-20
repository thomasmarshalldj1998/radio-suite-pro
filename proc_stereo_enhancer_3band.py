"""Three-band stereo enhancer.

Low, mid and high bands get independent mid/side width controls. Keeping bass
narrow (or mono) while widening highs is the classic recipe for a stable low end
and an open top.

    low  = LP200, high = HP4k, mid = x − low − high
    for each band: side *= width; band = mid ± side
    out  = low + mid + high
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import Biquad, clamp, copy_stereo

__all__ = ["StereoEnhancer3Band"]


class StereoEnhancer3Band:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        widths: tuple[float, float, float] = (0.8, 1.0, 1.3),
        crossover_hz: tuple[float, float] = (200.0, 4_000.0),
    ) -> None:
        if len(widths) != 3 or any(not 0.0 <= w <= 2.0 for w in widths):
            raise ValueError("three widths in 0–2 are required")
        if not 20.0 < crossover_hz[0] < crossover_hz[1] < sample_rate * 0.45:
            raise ValueError("crossovers must be ordered and below Nyquist")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.widths = tuple(float(w) for w in widths)
        self.crossover_hz = (float(crossover_hz[0]), float(crossover_hz[1]))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._low_l = Biquad.lowpass(fs, self.crossover_hz[0])
        self._low_r = Biquad.lowpass(fs, self.crossover_hz[0])
        self._high_l = Biquad.highpass(fs, self.crossover_hz[1])
        self._high_r = Biquad.highpass(fs, self.crossover_hz[1])

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or all(w == 1.0 for w in self.widths):
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        wl, wm, wh = self.widths
        for i, (xl, xr) in enumerate(zip(l, r)):
            low = self._low_l.process(xl)
            low2 = self._low_r.process(xr)
            high = self._high_l.process(xl)
            high2 = self._high_r.process(xr)
            mid_l = xl - low - high
            mid_r = xr - low2 - high2
            out = []
            for a, b, width in (
                (low, low2, wl),
                (mid_l, mid_r, wm),
                (high, high2, wh),
            ):
                mid = 0.5 * (a + b)
                side = 0.5 * (a - b) * width
                out.append((mid + side, mid - side))
            out_l[i] = sum(band[0] for band in out)
            out_r[i] = sum(band[1] for band in out)
        return out_l, out_r

    def state(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "widths": list(self.widths),
            "crossover_hz": list(self.crossover_hz),
        }
