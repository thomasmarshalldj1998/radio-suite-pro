"""Continuity log (SignalPath v3.1, module C2).

Every transport event that matters to a listener is recorded once, with the gap
it caused:

    timestamp,event,gap_ms,stream_id
    2026-10-20T18:04:11Z,Disconnect,0,primary
    2026-10-20T18:04:14Z,Connect,2430,primary

Seven days roll in memory; `export()` writes
`continuity_log_YYYYMMDD.csv` (one click, no dialog required). Events are the
specified five: Connect, Disconnect, Underrun, Overrun, Metadata-Fail.
"""

from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable

EVENTS = ("Connect", "Disconnect", "Underrun", "Overrun", "Metadata-Fail")
RETENTION_DAYS = 7
FIELDS = ("timestamp", "event", "gap_ms", "stream_id")


@dataclass
class Entry:
    at: datetime
    event: str
    gap_ms: int = 0
    stream_id: str = "primary"

    def row(self) -> dict[str, str | int]:
        return {
            "timestamp": self.at.astimezone(timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z"),
            "event": self.event,
            "gap_ms": int(self.gap_ms),
            "stream_id": self.stream_id,
        }


class ContinuityLog:
    def __init__(self, retain_days: int = RETENTION_DAYS) -> None:
        if retain_days < 1:
            raise ValueError("retention must be at least one day")
        self.retain_days = int(retain_days)
        self.entries: list[Entry] = []

    # ── recording ───────────────────────────────────────────────────────
    def log(
        self,
        event: str,
        gap_ms: int = 0,
        stream_id: str = "primary",
        at: datetime | None = None,
    ) -> Entry:
        if event not in EVENTS:
            raise ValueError(f"event must be one of {EVENTS}")
        if gap_ms < 0:
            raise ValueError("gap must not be negative")
        entry = Entry(
            at=(at or datetime.now(timezone.utc)).astimezone(timezone.utc),
            event=event,
            gap_ms=int(gap_ms),
            stream_id=stream_id or "primary",
        )
        self.entries.append(entry)
        self.prune(entry.at)
        return entry

    def prune(self, now: datetime | None = None) -> int:
        """Drop entries older than the retention window; returns how many."""
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        cutoff = now - timedelta(days=self.retain_days)
        keep = [e for e in self.entries if e.at >= cutoff]
        removed = len(self.entries) - len(keep)
        self.entries = keep
        return removed

    # ── reading / export ────────────────────────────────────────────────
    def rows(self) -> list[dict[str, str | int]]:
        return [e.row() for e in self.entries]

    def export(self, path: str | None = None, now: datetime | None = None) -> str:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        self.prune(now)
        target = path or f"continuity_log_{now:%Y%m%d}.csv"
        with open(target, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(FIELDS))
            writer.writeheader()
            writer.writerows(self.rows())
        return os.path.abspath(target)

    def load(self, path: str) -> int:
        """Merge a previously exported CSV (e.g. after a console restart)."""
        added = 0
        with open(path, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                if row.get("event") not in EVENTS:
                    continue
                stamp = str(row.get("timestamp", "")).replace("Z", "+00:00")
                try:
                    at = datetime.fromisoformat(stamp)
                except ValueError:
                    continue
                self.entries.append(
                    Entry(
                        at=at.astimezone(timezone.utc),
                        event=str(row["event"]),
                        gap_ms=max(0, int(row.get("gap_ms") or 0)),
                        stream_id=str(row.get("stream_id") or "primary"),
                    )
                )
                added += 1
        self.entries.sort(key=lambda e: e.at)
        self.prune()
        return added

    def summary(self) -> dict[str, object]:
        by_event = {name: 0 for name in EVENTS}
        for entry in self.entries:
            by_event[entry.event] = by_event.get(entry.event, 0) + 1
        return {
            "events": len(self.entries),
            "by_event": by_event,
            "gap_total_ms": sum(e.gap_ms for e in self.entries),
            "retain_days": self.retain_days,
            "oldest": self.entries[0].row()["timestamp"] if self.entries else None,
        }

    def extend(self, entries: Iterable[Entry]) -> None:
        for entry in entries:
            self.entries.append(entry)
        self.entries.sort(key=lambda e: e.at)
        self.prune()


__all__ = ["ContinuityLog", "Entry", "EVENTS", "FIELDS", "RETENTION_DAYS"]
