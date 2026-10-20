"""Short-term loudness ceiling (SignalPath v3.1, module B1).

A slow, transparent gain stage that holds the short-term loudness under a
selected ceiling. It is not a limiter: the window is 1 s or 3 s, attack is
20 ms and release 300 ms, so gain moves at programme speed rather than sample
speed and cannot pump on individual transients.

    measured = BS.1770 short-term loudness over the window
    gain_db  = clamp(ceiling − measured, −max_reduction, 0)
    output   = input delayed by lookahead × smoothed_gain

The gain is computed from the *input* loudness, not the output, so the loop has
no feedback and settles exactly at the ceiling. Bypassed, `process_stereo`
returns the input unchanged (bit-exact) and no filter state advances.
"""

from __future__ import annotations

import math
from typing import Sequence

from stream_encoder_core import k_weighting, lufs_from_mean_square

WINDOWS = (1.0, 3.0)
CEILINGS = (-10.0, -12.0, -14.0, -16.0)


class ShortTermCeiling:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        window_s: float = 1.0,
        ceiling_lufs: float = -16.0,
        lookahead_ms: float = 10.0,
        attack_ms: float = 20.0,
        release_ms: float = 300.0,
        max_reduction_db: float = 12.0,
    ) -> None:
        if window_s not in WINDOWS:
            raise ValueError("window_s must be 1 or 3 seconds")
        if ceiling_lufs > 0:
            raise ValueError("ceiling must be a negative LUFS value")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.window_s = float(window_s)
        self.ceiling_lufs = float(ceiling_lufs)
        self.lookahead_ms = max(0.0, float(lookahead_ms))
        self.attack_ms = max(0.1, float(attack_ms))
        self.release_ms = max(1.0, float(release_ms))
        self.max_reduction_db = max(0.0, float(max_reduction_db))
        self.reset()

    # ── configuration / state ───────────────────────────────────────────
    def reset(self) -> None:
        fs = self.sample_rate
        self.window_samples = max(1, int(round(self.window_s * fs)))
        self._sq_l = [0.0] * self.window_samples
        self._sq_r = [0.0] * self.window_samples
        self._pos = 0
        self._sum_l = 0.0
        self._sum_r = 0.0
        self._filled = 0
        self._shelf_l, self._hpf_l = k_weighting(fs)
        self._shelf_r, self._hpf_r = k_weighting(fs)
        self._delay = max(0, int(round(self.lookahead_ms * fs / 1000.0)))
        self._delay_l = [0.0] * self._delay
        self._delay_r = [0.0] * self._delay
        self._delay_pos = 0
        self._gain = 1.0
        self._attack = 1.0 - math.exp(-1.0 / (self.attack_ms * fs / 1000.0))
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._update_every = max(1, int(0.05 * fs))
        self._since_update = 0
        self._target = 1.0
        self.lufs_s = -120.0
        self.gain_reduction_db = 0.0

    @property
    def latency_samples(self) -> int:
        return self._delay

    def _target_for(self, ms: float) -> float:
        loudness = lufs_from_mean_square(ms)
        self.lufs_s = loudness
        db = min(0.0, self.ceiling_lufs - loudness)
        db = max(-self.max_reduction_db, db)
        return 10.0 ** (db / 20.0)

    # ── processing ──────────────────────────────────────────────────────
    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        n = min(len(left), len(right))
        if not self.enabled:
            # Bypass must be exact: no K-weighting, no delay, no state.
            return [float(x) for x in left[:n]], [float(x) for x in right[:n]]

        out_l = [0.0] * n
        out_r = [0.0] * n
        size = self.window_samples
        for i in range(n):
            xl = float(left[i])
            xr = float(right[i])
            kl = self._hpf_l.process(self._shelf_l.process(xl))
            kr = self._hpf_r.process(self._shelf_r.process(xr))

            self._sum_l -= self._sq_l[self._pos]
            self._sum_r -= self._sq_r[self._pos]
            self._sq_l[self._pos] = kl * kl
            self._sq_r[self._pos] = kr * kr
            self._sum_l += kl * kl
            self._sum_r += kr * kr
            self._pos = (self._pos + 1) % size
            if self._filled < size:
                self._filled += 1

            # Only judge once the window holds real programme; until then the
            # gain stays at unity rather than reacting to a partially filled
            # (and therefore artificially quiet) window.
            self._since_update += 1
            if self._filled >= size and self._since_update >= self._update_every:
                self._since_update = 0
                ms = (self._sum_l + self._sum_r) / (2.0 * size)
                self._target = self._target_for(ms)

            coef = self._attack if self._target < self._gain else self._release
            self._gain += (self._target - self._gain) * coef

            if self._delay:
                dl = self._delay_l[self._delay_pos]
                dr = self._delay_r[self._delay_pos]
                self._delay_l[self._delay_pos] = xl
                self._delay_r[self._delay_pos] = xr
                self._delay_pos = (self._delay_pos + 1) % self._delay
                out_l[i] = dl * self._gain
                out_r[i] = dr * self._gain
            else:
                out_l[i] = xl * self._gain
                out_r[i] = xr * self._gain

        self.gain_reduction_db = max(0.0, -20.0 * math.log10(max(self._gain, 1e-9)))
        return out_l, out_r

    def state(self) -> dict[str, float | bool | int]:
        return {
            "enabled": self.enabled,
            "window_s": self.window_s,
            "ceiling_lufs": self.ceiling_lufs,
            "lufs_s": round(self.lufs_s, 2),
            "gain_reduction_db": round(self.gain_reduction_db, 2),
            "latency_samples": self.latency_samples,
        }


__all__ = ["ShortTermCeiling", "WINDOWS", "CEILINGS"]
