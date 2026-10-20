"""Two-pass protection for the full chain.

This wraps the v3.1 ``TwoPassClip`` engine: pass 1 is the 16× true-peak limiter,
pass 2 the optional even-harmonic saturation. Keeping one implementation means
the standalone v3.1 chain and the full chain cannot drift.

``enabled=False`` bypasses both passes exactly. Pass 1 is on when enabled and
pass 2 is explicitly opt-in, matching the v3.1 default.
"""

from __future__ import annotations

from typing import Sequence

from proc_2pass_clip import CEILINGS, MODES, TwoPassClip, true_peak

__all__ = ["TwoPassProtection", "TwopassProtection", "CEILINGS", "MODES", "true_peak"]


class TwoPassProtection:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        ceiling_db: float = -0.5,
        pass1: bool = True,
        pass2: bool = False,
        blend_pct: float = 0.0,
        mode: str = "warm",
        lookahead_ms: float = 2.0,
    ) -> None:
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self._clip = TwoPassClip(
            sample_rate=sample_rate,
            pass1=pass1,
            ceiling_db=ceiling_db,
            pass2=pass2,
            blend_pct=blend_pct,
            mode=mode,
            lookahead_ms=lookahead_ms,
        )

    def reset(self) -> None:
        self._clip = TwoPassClip(
            sample_rate=self.sample_rate,
            pass1=self._clip.pass1,
            ceiling_db=self._clip.ceiling_db,
            pass2=self._clip.pass2,
            blend_pct=self._clip.blend_pct,
            mode=self._clip.mode,
        )

    @property
    def latency_samples(self) -> int:
        return 0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        if not self.enabled:
            n = min(len(left), len(right))
            return [float(x) for x in left[:n]], [float(x) for x in right[:n]]
        return self._clip.process_stereo(left, right)

    def state(self) -> dict[str, object]:
        state = self._clip.state()
        state["enabled"] = self.enabled
        return state


TwopassProtection = TwoPassProtection
