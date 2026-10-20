"""Full-band attack/sustain envelope shaper.

A dual envelope (3 ms fast, 80 ms slow) separates the initial transient from the
body. Positive attack emphasises the leading edge; negative attack softens it.
Sustain compares the slow envelope with a two-second reference and gently moves
the body up or down. Mode ``transparent`` disables the attack term.

At 0/0 the stage is neutral and is bypassed bit-exactly.
"""

from __future__ import annotations

import math
from typing import Sequence

from proc_dsp import Envelope, clamp, copy_stereo

__all__ = ["EnvelopeShaper"]


class EnvelopeShaper:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        attack_pct: float = 0.0,
        sustain_pct: float = 0.0,
        fast_ms: float = 3.0,
        slow_ms: float = 80.0,
        mode: str = "emphasise",
    ) -> None:
        if mode not in ("emphasise", "smooth", "transparent"):
            raise ValueError("mode must be emphasise, smooth or transparent")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.attack_pct = float(clamp(attack_pct, -100.0, 100.0))
        self.sustain_pct = float(clamp(sustain_pct, -100.0, 100.0))
        self.fast_ms = max(0.5, float(fast_ms))
        self.slow_ms = max(5.0, float(slow_ms))
        self.mode = mode
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._fast = Envelope(fs, self.fast_ms, self.fast_ms * 3.0)
        self._slow = Envelope(fs, self.slow_ms, self.slow_ms * 2.0)
        self._ref = Envelope(fs, 2_000.0, 2_000.0)
        self._gain = 1.0

    def _gain_for(self, fast: float, slow: float) -> float:
        ratio = fast / slow if slow > 1e-9 else 1.0
        attack = self.attack_pct / 100.0
        if self.mode == "transparent":
            attack = 0.0
        elif self.mode == "smooth":
            attack = -attack
        attack_gain = 1.0 + attack * 0.5 * clamp(ratio - 1.0, -1.0, 1.0)
        ref_ratio = slow / self._ref.value if self._ref.value > 1e-9 else 1.0
        sustain_gain = clamp(
            ref_ratio ** (self.sustain_pct / 100.0 * 0.5), 0.5, 2.0
        )
        return clamp(attack_gain * sustain_gain, 0.25, 4.0)

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        l, r = copy_stereo(left, right)
        neutral = self.attack_pct == 0.0 and self.sustain_pct == 0.0
        if not self.enabled or neutral:
            return l, r
        out_l = [0.0] * len(l)
        out_r = [0.0] * len(r)
        for i, (xl, xr) in enumerate(zip(l, r)):
            linked = max(abs(xl), abs(xr))
            fast = self._fast.process(linked)
            slow = self._slow.process(linked)
            self._ref.process(slow)
            target = self._gain_for(fast, slow)
            # Smooth the gain itself to avoid envelope chatter.
            self._gain += (target - self._gain) * 0.08
            out_l[i] = xl * self._gain
            out_r[i] = xr * self._gain
        return out_l, out_r

    def state(self) -> dict[str, float | bool | str]:
        return {
            "enabled": self.enabled,
            "attack_pct": self.attack_pct,
            "sustain_pct": self.sustain_pct,
            "mode": self.mode,
            "gain": round(self._gain, 3),
        }
