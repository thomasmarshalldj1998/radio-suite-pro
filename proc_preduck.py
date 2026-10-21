"""Lookahead pre-ducking (SignalPath v3.1, module B2).

Placed *before* the main limiter, this stage shaves the sharpest transients by
a small, bounded amount (0–6 dB) so the limiter meets them already tamed. The
detector runs ahead of the audio by 1–10 ms, which is why the duck is fully in
place before the transient arrives rather than after it.

    peak_db   = peak-hold over the detection window
    over_db   = max(0, peak_db − threshold(sensitivity))
    duck_db   = min(range_db, over_db × range_db / 6)
    output    = input delayed by detect_window × released_gain

The default is bypassed, and bypass is bit-exact.
"""

from __future__ import annotations

import math
from collections import deque
from typing import Sequence

from stream_encoder_core import clamp

try:  # optional acceleration; the scalar path is the reference
    import numpy as _np
    from scipy.ndimage import maximum_filter1d as _maximum_filter1d
except ImportError:  # pragma: no cover - fallback hosts
    _np = None
    _maximum_filter1d = None


class PreDuck:
    def __init__(
        self,
        sample_rate: int = 48_000,
        enabled: bool = False,
        detect_ms: float = 3.0,
        sensitivity: float = 50.0,
        range_db: float = 3.0,
        release_ms: float = 40.0,
    ) -> None:
        if not 1.0 <= detect_ms <= 10.0:
            raise ValueError("detect window must be 1–10 ms")
        if not 0.0 <= range_db <= 6.0:
            raise ValueError("ducking range must be 0–6 dB")
        self.sample_rate = int(sample_rate)
        self.enabled = bool(enabled)
        self.detect_ms = float(detect_ms)
        self.sensitivity = float(clamp(sensitivity, 0.0, 100.0))
        self.range_db = float(range_db)
        self.release_ms = float(detect_ms if release_ms is None else clamp(release_ms, 10.0, 100.0))
        self.reset()

    def reset(self) -> None:
        fs = self.sample_rate
        self._window = max(1, int(round(self.detect_ms * fs / 1000.0)))
        self._delay_l = [0.0] * self._window
        self._delay_r = [0.0] * self._window
        self._tail_l = [0.0] * self._window
        self._tail_r = [0.0] * self._window
        self._peak_tail = [0.0] * self._window
        self._pos = 0
        self._gain = 1.0
        self._release = 1.0 - math.exp(-1.0 / (self.release_ms * fs / 1000.0))
        self._history: deque[tuple[int, float]] = deque()
        self._index = 0
        self._peak_db = -120.0
        self.ducked = False
        self.max_duck_db = 0.0

    @property
    def latency_samples(self) -> int:
        return self._window

    @property
    def threshold_db(self) -> float:
        # 100 % sensitivity starts ducking at −6 dBFS; 0 % at −18 dBFS.
        return -18.0 + (self.sensitivity / 100.0) * 12.0

    def _push_peak(self, peak: float) -> float:
        # Monotonic deque: front is the largest value still inside the window.
        while self._history and self._history[-1][1] <= peak:
            self._history.pop()
        self._history.append((self._index, peak))
        while self._history and self._history[0][0] <= self._index - self._window:
            self._history.popleft()
        return self._history[0][1] if self._history else 0.0

    def process_stereo(
        self, left: Sequence[float], right: Sequence[float]
    ) -> tuple[list[float], list[float]]:
        n = min(len(left), len(right))
        if not self.enabled or self.range_db <= 0.0:
            return [float(x) for x in left[:n]], [float(x) for x in right[:n]]
        if _np is not None and _maximum_filter1d is not None and n >= 64:
            result = self._process_block(left, right, n)
            if result is not None:
                return result

        out_l = [0.0] * n
        out_r = [0.0] * n
        threshold = self.threshold_db
        worst = 0.0
        for i in range(n):
            xl = float(left[i])
            xr = float(right[i])
            peak = max(abs(xl), abs(xr))
            held = self._push_peak(peak)
            peak_db = 20.0 * math.log10(held) if held > 0.0 else -120.0
            over = max(0.0, peak_db - threshold)
            duck_db = 0.0 if over <= 0.0 else min(self.range_db, over * self.range_db / 6.0)
            target = 10.0 ** (-duck_db / 20.0)
            if target < self._gain:
                # Instant attack: the delayed audio still has time to arrive.
                self._gain = target
            else:
                self._gain += (target - self._gain) * self._release
            if duck_db > worst:
                worst = duck_db
            self.ducked = duck_db > 0.1

            dl = self._delay_l[self._pos]
            dr = self._delay_r[self._pos]
            self._delay_l[self._pos] = xl
            self._delay_r[self._pos] = xr
            self._pos = (self._pos + 1) % self._window
            out_l[i] = dl * self._gain
            out_r[i] = dr * self._gain
            self._index += 1

        held = self._history[0][1] if self._history else 0.0
        self._peak_db = 20.0 * math.log10(held) if held > 0.0 else -120.0
        self.max_duck_db = max(worst, self.max_duck_db)
        return out_l, out_r

    def _process_block(
        self, left: Sequence[float], right: Sequence[float], n: int
    ) -> tuple[list[float], list[float]] | None:
        """Vectorised block path: sliding peak-hold in C, gain in Python.

        The detector window is a trailing maximum over the last ``window``
        frames (carried across block boundaries), which is exactly the
        monotonic deque's result. Only the gain recurrence stays scalar — it
        is a stateful attack/release law, not a linear filter.
        """
        window = self._window
        xl = _np.asarray(left[:n], dtype=_np.float64)
        xr = _np.asarray(right[:n], dtype=_np.float64)
        peak = _np.maximum(_np.abs(xl), _np.abs(xr))
        tail = _np.asarray(self._peak_tail, dtype=_np.float64)
        combined = _np.concatenate((tail, peak)) if window else peak
        held = _maximum_filter1d(
            combined, size=window, origin=(window - 1) // 2, mode="nearest"
        )[-n:]
        self._peak_tail = (combined[-window:].tolist() if window else [])
        self._index += n
        held_db = _np.where(
            held > 0.0, 20.0 * _np.log10(_np.maximum(held, 1e-300)), -120.0
        )
        over = _np.clip(held_db - self.threshold_db, 0.0, None)
        duck = _np.minimum(self.range_db, over * self.range_db / 6.0)
        targets = _np.power(10.0, -duck / 20.0).tolist()
        worst = float(duck.max()) if n else 0.0

        gain = self._gain
        release = self._release
        gains = [0.0] * n
        for i in range(n):
            target = targets[i]
            if target < gain:
                # Instant attack: the delayed audio still has time to arrive.
                gain = target
            else:
                gain += (target - gain) * release
            gains[i] = gain
        self._gain = gain
        self.ducked = bool(duck[-1] > 0.1) if n else False
        self.max_duck_db = max(worst, self.max_duck_db)
        self._peak_db = float(held_db[-1]) if n else -120.0

        if window:
            stream_l = _np.concatenate((_np.asarray(self._tail_l), xl))
            stream_r = _np.concatenate((_np.asarray(self._tail_r), xr))
        else:
            stream_l, stream_r = xl, xr
        delayed_l, delayed_r = stream_l[:n], stream_r[:n]
        if window:
            self._tail_l = stream_l[n : n + window].tolist()
            self._tail_r = stream_r[n : n + window].tolist()
        gain_array = _np.asarray(gains, dtype=_np.float64)
        return (delayed_l * gain_array).tolist(), (delayed_r * gain_array).tolist()

    def state(self) -> dict[str, float | bool | int]:
        return {
            "enabled": self.enabled,
            "detect_ms": self.detect_ms,
            "sensitivity": self.sensitivity,
            "threshold_db": round(self.threshold_db, 2),
            "range_db": self.range_db,
            "release_ms": self.release_ms,
            "ducked": self.ducked,
            "max_duck_db": round(self.max_duck_db, 2),
            "latency_samples": self.latency_samples,
        }


__all__ = ["PreDuck"]
