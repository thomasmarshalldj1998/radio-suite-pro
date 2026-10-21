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

from proc_accel import filter_block
from stream_encoder_core import k_weighting, lufs_from_mean_square

try:  # optional vectorised window; scalar path is the reference
    import numpy as _np
except ImportError:  # pragma: no cover
    _np = None

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
            return list(map(float, left[:n])), list(map(float, right[:n]))

        size = self.window_samples
        # K-weighting is two static biquads per channel: run the chain in C
        # and keep the sample loop for the sliding window and gain.
        kl = filter_block(self._hpf_l, filter_block(self._shelf_l, left[:n]))
        kr = filter_block(self._hpf_r, filter_block(self._shelf_r, right[:n]))
        if _np is not None and 64 <= n <= size:
            vector = self._vector_block(left, right, kl, kr, n)
            if vector is not None:
                return vector
        out_l = [0.0] * n
        out_r = [0.0] * n
        for i in range(n):
            xl = float(left[i])
            xr = float(right[i])
            kl_i = kl[i]
            kr_i = kr[i]

            self._sum_l -= self._sq_l[self._pos]
            self._sum_r -= self._sq_r[self._pos]
            self._sq_l[self._pos] = kl_i * kl_i
            self._sq_r[self._pos] = kr_i * kr_i
            self._sum_l += kl_i * kl_i
            self._sum_r += kr_i * kr_i
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

    def _vector_block(
        self,
        left: Sequence[float],
        right: Sequence[float],
        kl: Sequence[float],
        kr: Sequence[float],
        n: int,
    ) -> tuple[list[float], list[float]] | None:
        """Exact block path: prefix-sum window, closed-form gain ramps."""
        size = self.window_samples
        sq_l = _np.square(_np.asarray(kl, dtype=_np.float64))
        sq_r = _np.square(_np.asarray(kr, dtype=_np.float64))
        buf_l = _np.asarray(self._sq_l, dtype=_np.float64)
        buf_r = _np.asarray(self._sq_r, dtype=_np.float64)
        pos = self._pos % size
        idx = (pos + _np.arange(n)) % size
        # Sliding sum over the ring: subtract the value leaving the window and
        # add the one arriving, then prefix-sum the block's deltas.
        win_l = self._sum_l + _np.cumsum(sq_l - buf_l[idx])
        win_r = self._sum_r + _np.cumsum(sq_r - buf_r[idx])
        buf_l[idx] = sq_l
        buf_r[idx] = sq_r

        # Target only changes on the 50 ms control tick. Find those samples.
        events: list[int] = []
        first_full = max(0, size - self._filled - 1)
        step = self._update_every
        first = max(first_full, step - self._since_update - 1)
        if first < n:
            events = list(range(first, n, step))
        gains = _np.empty(n, dtype=_np.float64)
        gain = self._gain
        target = self._target
        start = 0
        for event in events + [n]:
            length = event - start
            if length > 0:
                coef = self._attack if target < gain else self._release
                ramp = 1.0 - coef
                gain = target + (gain - target) * (ramp ** length)
                # Per-sample values for this constant-target segment.
                gains[start:event] = target + (
                    gain - target
                ) / (ramp ** length) * _np.power(
                    ramp, _np.arange(1, length + 1)
                )
            if event < n:
                ms = float(win_l[event] + win_r[event]) / (2.0 * size)
                target = self._target_for(ms)
            start = event

        delay = self._delay
        if delay:
            dbuf_l = _np.asarray(self._delay_l, dtype=_np.float64)
            dbuf_r = _np.asarray(self._delay_r, dtype=_np.float64)
            dpos = self._delay_pos % delay
            dstream_l = _np.concatenate((dbuf_l[dpos:], dbuf_l[:dpos], _np.asarray(left, dtype=_np.float64)))
            dstream_r = _np.concatenate((dbuf_r[dpos:], dbuf_r[:dpos], _np.asarray(right, dtype=_np.float64)))
            out_l = dstream_l[:n] * gains
            out_r = dstream_r[:n] * gains
            self._delay_l = dstream_l[n : n + delay]
            self._delay_r = dstream_r[n : n + delay]
            self._delay_pos = 0
        else:
            out_l = _np.asarray(left[:n], dtype=_np.float64) * gains
            out_r = _np.asarray(right[:n], dtype=_np.float64) * gains

        self._sq_l = buf_l
        self._sq_r = buf_r
        self._pos = int((pos + n) % size)
        self._sum_l = float(win_l[-1])
        self._sum_r = float(win_r[-1])
        self._filled = min(size, self._filled + n)
        if events:
            self._since_update = n - 1 - events[-1]
        else:
            self._since_update += n
        self._target = target
        self._gain = gain
        self.gain_reduction_db = max(0.0, -20.0 * math.log10(max(gain, 1e-9)))
        return out_l.tolist(), out_r.tolist()

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
