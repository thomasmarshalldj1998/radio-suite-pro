"""Input DC blocking, polarity and inter-channel phase alignment.

Broadcast captures often arrive with a small DC offset, inverted polarity on
one leg, or a fraction of a millisecond of path delay between channels. This
stage cleans those up before any dynamics or EQ:

    x      = highpass(x, dc_block_hz)       # remove DC / sub-rumble
    x     *= polarity                       # +1 or -1
    right  = delay(right, align_ms)         # align a late leg

The defaults are bypassed. Disabled, both channels are returned bit-exactly and
no filter or delay state advances.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Biquad, copy_stereo

__all__ = ["InputDcPhase"]


class InputDcPhase:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        dc_block_hz: float = 5.0,
        polarity: int = 1,
        align_ms: float = 0.0,
    ) -> None:
        if not 1.0 <= dc_block_hz <= 30.0:
            raise ValueError("dc_block_hz must be 1–30 Hz")
        if polarity not in (-1, 1):
            raise ValueError("polarity must be +1 or -1")
        if not 0.0 <= align_ms <= 5.0:
            raise ValueError("align_ms must be 0–5 ms")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.dc_block_hz = float(dc_block_hz)
        self.polarity = int(polarity)
        self.align_ms = float(align_ms)
        self.reset()

    def reset(self) -> None:
        self._hp_l = Biquad.highpass(self.sample_rate, self.dc_block_hz)
        self._hp_r = Biquad.highpass(self.sample_rate, self.dc_block_hz)
        self._delay = max(0, int(round(self.align_ms * self.sample_rate / 1000.0)))
        self._buffer = [0.0] * self._delay
        self._pos = 0
        self._last_l = 0.0
        self._last_r = 0.0
        self._dc_avg_l = 0.0
        self._dc_avg_r = 0.0
        self._dc_coef = 1.0 - math.exp(-1.0 / (0.5 * self.sample_rate))
        self.dc_offset = 0.0

    @property
    def latency_samples(self) -> int:
        return self._delay

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            self._dc_avg_l += (xl - self._dc_avg_l) * self._dc_coef
            self._dc_avg_r += (xr - self._dc_avg_r) * self._dc_coef
            yl = self._hp_l.process(xl) * self.polarity
            yr = self._hp_r.process(xr) * self.polarity
            if self._delay:
                delayed = self._buffer[self._pos]
                self._buffer[self._pos] = yr
                self._pos = (self._pos + 1) % self._delay
                yr = delayed
            out_l[i] = yl
            out_r[i] = yr
        self._last_l = out_l[-1] if out_l else 0.0
        self._last_r = out_r[-1] if out_r else 0.0
        self.dc_offset = 0.5 * (self._dc_avg_l + self._dc_avg_r)
        return out_l, out_r

    def state(self) -> dict[str, float | int | bool]:
        return {
            "enabled": self.enabled,
            "dc_block_hz": self.dc_block_hz,
            "polarity": self.polarity,
            "align_ms": self.align_ms,
            "latency_samples": self.latency_samples,
            "dc_offset": round(self.dc_offset, 8),
        }
