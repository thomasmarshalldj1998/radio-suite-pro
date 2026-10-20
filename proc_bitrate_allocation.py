"""Bitrate allocation across simulcast outputs.

The stage is a control-plane block: it does not alter audio, but it can sit in
the chain as a pass-through to estimate programme complexity from the
high-frequency residual. ``allocate()`` splits a total bitrate across named
outputs by weight while respecting a per-output minimum.

    allocation = min + floor(remaining × weight / sum(weights))

Any leftover bits go to the largest fractional remainder, so the integer
allocations always add up to the total.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import clamp, copy_stereo, level_db, rms

__all__ = ["BitrateAllocation"]


class BitrateAllocation:
    def __init__(
        self,
        total_kbps: int = 192,
        streams: Sequence[str] = ("primary", "secondary", "tertiary"),
        weights: Sequence[float] = (0.6, 0.3, 0.1),
        min_kbps: int = 24,
        enabled: bool = True,
    ) -> None:
        if len(streams) == 0 or len(streams) != len(weights):
            raise ValueError("streams and weights must be non-empty and equal length")
        if any(w <= 0 for w in weights):
            raise ValueError("weights must be positive")
        if total_kbps < min_kbps * len(streams):
            raise ValueError("total bitrate cannot cover the minimum for every stream")
        self.total_kbps = int(total_kbps)
        self.streams = tuple(str(s) for s in streams)
        self.weights = tuple(float(w) for w in weights)
        self.min_kbps = int(min_kbps)
        self.enabled = bool(enabled)
        self.complexity = 0.0
        self.high_frequency_db = -120.0
        self.allocation = self.allocate()

    def reset(self) -> None:
        self.complexity = 0.0
        self.high_frequency_db = -120.0
        self.allocation = self.allocate()

    def allocate(self) -> dict[str, int]:
        total = self.total_kbps
        count = len(self.streams)
        remaining = total - self.min_kbps * count
        weight_sum = sum(self.weights)
        raw = [remaining * (w / weight_sum) for w in self.weights]
        alloc = [self.min_kbps + int(math.floor(x)) for x in raw]
        leftover = total - sum(alloc)
        order = sorted(
            range(count),
            key=lambda i: (raw[i] - math.floor(raw[i])),
            reverse=True,
        )
        for index in order[:leftover]:
            alloc[index] += 1
        self.allocation = {
            name: int(kbps) for name, kbps in zip(self.streams, alloc)
        }
        return self.allocation

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled or not l:
            return l, r
        diff = 0.0
        total = 0.0
        prev_l = l[0]
        prev_r = r[0]
        for xl, xr in zip(l, r):
            diff += (xl - prev_l) ** 2 + (xr - prev_r) ** 2
            total += xl * xl + xr * xr
            prev_l, prev_r = xl, xr
        self.complexity = clamp(math.sqrt(diff / max(total, 1e-12)), 0.0, 1.0)
        self.high_frequency_db = level_db(rms([(a - b) * 0.5 for a, b in zip(l, r)]))
        return l, r

    def state(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "total_kbps": self.total_kbps,
            "allocation": self.allocation,
            "complexity": round(self.complexity, 3),
            "high_frequency_db": round(self.high_frequency_db, 2),
        }
