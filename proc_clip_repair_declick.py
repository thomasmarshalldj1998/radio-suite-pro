"""Clipped-sample repair and de-clicking.

Two related repairs run in one pass:

* flat-topped runs at or above ``clip_threshold`` are replaced by a straight
  interpolation between the last good sample before the run and the first good
  sample after it, as long as the run is no longer than ``max_repair_ms``;
* an isolated one-sample spike that differs sharply from both neighbours is
  replaced by their average (the classic digital click).

Long clipped runs are left alone rather than inventing a waveform. The stage is
bypassed by default and bypass is bit-exact.
"""

from __future__ import annotations

from typing import Sequence

from proc_dsp import copy_stereo

__all__ = ["ClipRepairDeclick"]


class ClipRepairDeclick:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        clip_threshold: float = 0.999,
        max_repair_ms: float = 1.5,
        declick: bool = True,
        spike_threshold: float = 0.35,
    ) -> None:
        if not 0.5 <= clip_threshold <= 1.0:
            raise ValueError("clip_threshold must be 0.5–1.0")
        if not 0.05 <= max_repair_ms <= 10.0:
            raise ValueError("max_repair_ms must be 0.05–10 ms")
        if not 0.0 < spike_threshold <= 1.5:
            raise ValueError("spike_threshold must be 0–1.5")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.clip_threshold = float(clip_threshold)
        self.max_repair_ms = float(max_repair_ms)
        self.declick = bool(declick)
        self.spike_threshold = float(spike_threshold)
        self.max_repair_samples = max(1, int(round(self.max_repair_ms * self.sample_rate / 1000.0)))
        self.clipped_samples = 0
        self.repaired_samples = 0
        self.declicked_samples = 0

    def reset(self) -> None:
        self.clipped_samples = 0
        self.repaired_samples = 0
        self.declicked_samples = 0

    def _repair(self, values: list[float]) -> None:
        n = len(values)
        i = 0
        while i < n:
            if abs(values[i]) < self.clip_threshold:
                i += 1
                continue
            start = i
            while i < n and abs(values[i]) >= self.clip_threshold:
                i += 1
            end = i  # exclusive
            run = end - start
            self.clipped_samples += run
            if run > self.max_repair_samples or start == 0 or end >= n:
                continue
            left = values[start - 1]
            right = values[end]
            for j in range(run):
                t = (j + 1) / (run + 1)
                values[start + j] = left + (right - left) * t
            self.repaired_samples += run

    def _declick(self, values: list[float]) -> None:
        if not self.declick:
            return
        n = len(values)
        for i in range(1, n - 1):
            expected = 0.5 * (values[i - 1] + values[i + 1])
            if (
                abs(values[i]) >= self.clip_threshold
                and abs(values[i] - expected) >= self.spike_threshold
                and abs(values[i - 1]) < self.clip_threshold
                and abs(values[i + 1]) < self.clip_threshold
            ):
                values[i] = expected
                self.declicked_samples += 1

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        if not self.enabled:
            return l, r
        self._repair(l)
        self._repair(r)
        self._declick(l)
        self._declick(r)
        return l, r

    def state(self) -> dict[str, float | int | bool]:
        return {
            "enabled": self.enabled,
            "clip_threshold": self.clip_threshold,
            "max_repair_ms": self.max_repair_ms,
            "declick": self.declick,
            "clipped_samples": self.clipped_samples,
            "repaired_samples": self.repaired_samples,
            "declicked_samples": self.declicked_samples,
        }
