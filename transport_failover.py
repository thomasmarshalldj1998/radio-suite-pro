"""Crossfade failover (SignalPath v3.1, module D2).

Primary → secondary → tertiary switching for the simulcast outputs. A switch is
an equal-power crossfade (100–500 ms, cos/sin), never a hard cut, and the
router reverts to primary once it has been stable for ten seconds.

Triggers, per the specification:

* transport disconnect — immediate;
* underrun longer than 2 s;
* input silence longer than 5 s.

The router works on already-encoded-independent frames (it mixes the *source*
that each output will encode), so it can sit in front of the simulcast fan-out.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

SLOT_COUNT = 3


@dataclass
class FailoverConfig:
    crossfade_ms: float = 200.0
    underrun_limit_ms: float = 2000.0
    silence_limit_ms: float = 5000.0
    restore_stable_s: float = 10.0
    sample_rate: int = 48_000

    def validate(self) -> "FailoverConfig":
        if not 100.0 <= self.crossfade_ms <= 500.0:
            raise ValueError("crossfade must be 100–500 ms")
        if self.underrun_limit_ms <= 0 or self.silence_limit_ms <= 0:
            raise ValueError("triggers must be positive")
        return self


class FailoverRouter:
    def __init__(self, config: FailoverConfig | None = None) -> None:
        self.config = (config or FailoverConfig()).validate()
        self.fade_samples = max(
            1, int(round(self.config.crossfade_ms * self.config.sample_rate / 1000.0))
        )
        self.active = 0
        self.incoming: int | None = None
        self.fade_pos = 0
        self.available = [True, False, False]
        self.underrun_ms = [0.0, 0.0, 0.0]
        self.silence_ms = [0.0, 0.0, 0.0]
        self.stable_s = 0.0
        self.switches = 0
        self.restores = 0
        self.last_reason = ""

    # ── availability / triggers ─────────────────────────────────────────
    def set_available(self, index: int, available: bool) -> None:
        if not 0 <= index < SLOT_COUNT:
            raise ValueError("slot index out of range")
        self.available[index] = bool(available)

    @property
    def fading(self) -> bool:
        return self.incoming is not None

    def _next_available(self, start: int) -> int | None:
        for offset in range(1, SLOT_COUNT):
            index = (start + offset) % SLOT_COUNT
            if self.available[index]:
                return index
        return None

    def switch_to(self, index: int, reason: str = "manual") -> bool:
        if not 0 <= index < SLOT_COUNT or not self.available[index]:
            return False
        if index == self.active:
            return False
        self.incoming = index
        self.fade_pos = 0
        self.switches += 1
        self.last_reason = reason
        return True

    def notify_disconnect(self, index: int = 0) -> bool:
        self.set_available(index, False)
        self.underrun_ms[index] = 0.0
        if index == self.active:
            target = self._next_available(index)
            return self.switch_to(target, "disconnect") if target is not None else False
        return False

    def notify_underrun(self, ms: float, index: int = 0) -> bool:
        self.underrun_ms[index] += max(0.0, ms)
        if self.underrun_ms[index] >= self.config.underrun_limit_ms and index == self.active:
            target = self._next_available(index)
            return self.switch_to(target, "underrun") if target is not None else False
        return False

    def notify_silence(self, ms: float, index: int = 0) -> bool:
        self.silence_ms[index] += max(0.0, ms)
        if self.silence_ms[index] >= self.config.silence_limit_ms and index == self.active:
            target = self._next_available(index)
            return self.switch_to(target, "silence") if target is not None else False
        return False

    def notify_signal(self, index: int = 0) -> None:
        self.underrun_ms[index] = 0.0
        self.silence_ms[index] = 0.0

    def notify_primary_ok(self, dt_s: float) -> bool:
        """Primary has been stable for `dt_s`; auto-revert after 10 s."""
        self.set_available(0, True)
        if self.active == 0:
            self.stable_s = 0.0
            return False
        self.stable_s += max(0.0, dt_s)
        if self.stable_s >= self.config.restore_stable_s and not self.fading:
            self.restores += 1
            return self.switch_to(0, "restore")
        return False

    # ── mixing ──────────────────────────────────────────────────────────
    def weights(self) -> dict[int, float]:
        if self.incoming is None:
            return {self.active: 1.0}
        t = min(1.0, max(0.0, self.fade_pos / self.fade_samples))
        return {
            self.active: math.cos(t * math.pi / 2.0),
            self.incoming: math.sin(t * math.pi / 2.0),
        }

    def process(self, frames: Sequence[Sequence[float]]) -> tuple[float, float]:
        """Mix one frame from each source; returns one stereo sample pair."""
        weights = self.weights()
        left = 0.0
        right = 0.0
        for index, weight in weights.items():
            if index >= len(frames):
                continue
            pair = frames[index]
            left += float(pair[0]) * weight
            right += float(pair[1]) * weight
        if self.incoming is not None:
            self.fade_pos += 1
            if self.fade_pos >= self.fade_samples:
                self.active = self.incoming
                self.incoming = None
                self.stable_s = 0.0
        return left, right

    def process_block(
        self, blocks: Sequence[Sequence[Sequence[float]]]
    ) -> list[tuple[float, float]]:
        """Mix `n` samples, given one block of stereo pairs per source."""
        count = min((len(b) for b in blocks), default=0)
        return [self.process([b[i] for b in blocks]) for i in range(count)]

    def status(self) -> dict[str, object]:
        return {
            "active": self.active,
            "incoming": self.incoming,
            "fading": self.fading,
            "crossfade_ms": self.config.crossfade_ms,
            "switches": self.switches,
            "restores": self.restores,
            "last_reason": self.last_reason,
            "available": list(self.available),
            "stable_s": round(self.stable_s, 2),
        }


__all__ = ["FailoverRouter", "FailoverConfig", "SLOT_COUNT"]
