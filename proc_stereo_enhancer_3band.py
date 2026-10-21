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

from proc_accel import filter_block, filter_block_array
from proc_dsp import Biquad, clamp, copy_stereo

try:
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

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
        wl, wm, wh = self.widths
        if _np is not None and len(l) >= 64:
            ll = filter_block_array(self._low_l, l)
            lr = filter_block_array(self._low_r, r)
            hl = filter_block_array(self._high_l, l)
            hr = filter_block_array(self._high_r, r)
            if ll is not None and lr is not None and hl is not None and hr is not None:
                ml, mr = _np.asarray(l) - ll - hl, _np.asarray(r) - lr - hr
                out_l = _np.zeros(len(l), dtype=_np.float64)
                out_r = _np.zeros(len(l), dtype=_np.float64)
                for a, b, width in ((ll, lr, wl), (ml, mr, wm), (hl, hr, wh)):
                    mid = 0.5 * (a + b)
                    side = 0.5 * (a - b) * width
                    out_l += mid + side
                    out_r += mid - side
                return out_l.tolist(), out_r.tolist()
        low_l = filter_block(self._low_l, l)
        low_r = filter_block(self._low_r, r)
        high_l = filter_block(self._high_l, l)
        high_r = filter_block(self._high_r, r)
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i in range(len(l)):
            mid_l = l[i] - low_l[i] - high_l[i]
            mid_r = r[i] - low_r[i] - high_r[i]
            out_l[i] = (
                0.5 * (low_l[i] + low_r[i]) + 0.5 * (low_l[i] - low_r[i]) * wl
                + 0.5 * (mid_l + mid_r) + 0.5 * (mid_l - mid_r) * wm
                + 0.5 * (high_l[i] + high_r[i]) + 0.5 * (high_l[i] - high_r[i]) * wh
            )
            out_r[i] = (
                0.5 * (low_l[i] + low_r[i]) - 0.5 * (low_l[i] - low_r[i]) * wl
                + 0.5 * (mid_l + mid_r) - 0.5 * (mid_l - mid_r) * wm
                + 0.5 * (high_l[i] + high_r[i]) - 0.5 * (high_l[i] - high_r[i]) * wh
            )
        return out_l, out_r

    def state(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "widths": list(self.widths),
            "crossover_hz": list(self.crossover_hz),
        }
