"""Short-term loudness stage (compatibility entry point).

The v3.1 implementation lives in ``proc_loudness_shortterm.ShortTermCeiling``
and is unchanged: a 1 s or 3 s BS.1770 window, a 10 ms look-ahead, and a gain
that holds the measured short-term loudness under a ceiling. This module gives
the full-chain tree the requested entry point without duplicating the DSP.

``lufs`` exposes the latest measured short-term value; ``process_stereo`` is
the same bit-exact-bypass interface used by every full-chain stage.
"""

from __future__ import annotations

from proc_loudness_shortterm import CEILINGS, WINDOWS, ShortTermCeiling

__all__ = ["ShortTermLoudness", "CEILINGS", "WINDOWS"]


class ShortTermLoudness(ShortTermCeiling):
    """Alias with the full-chain module name and a ``lufs`` property."""

    @property
    def lufs(self) -> float:
        return self.lufs_s
