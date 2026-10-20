/**
 * Dual-mount failover for the stream source socket.
 *
 * An Icecast server can list a mount but refuse a source (listener limit,
 * fallback mount, a relay that died). Rather than retry the same dead path
 * forever, the console accepts a backup mount point on the same server and
 * rotates to it once the primary has failed repeatedly — then, after the
 * backup has been healthy for a while, tries the primary again on the next
 * reconnect so a repaired primary can take the programme back.
 *
 * The router is deliberately time- and socket-free: it is a small policy
 * object the StreamClient asks at the start of every connection attempt, which
 * keeps the rule testable without a server.
 */

/** Normalise a mount point to one leading slash ("" stays ""). */
export function normalizeMount(raw: string): string {
  const text = (raw ?? "").trim();
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

/** Primary first, then the backup when it names a different mount. */
export function mountCandidates(primary: string, backup?: string | null): string[] {
  const first = normalizeMount(primary) || "/stream";
  const second = normalizeMount(backup ?? "");
  return second && second !== first ? [first, second] : [first];
}

export interface MountFailoverOptions {
  /** Consecutive failures on the active mount before switching (default 2). */
  failuresBeforeSwitch?: number;
  /** Healthy time on the backup before the primary is retried (default 5 min). */
  primaryRetryMs?: number;
}

export interface MountFailoverState {
  primary: string;
  backup: string | null;
  /** Mount the next connection attempt uses. */
  active: string;
  /** True while the backup mount is the active one. */
  switched: boolean;
  /** Number of automatic transitions (to the backup or back to primary). */
  switches: number;
  /** Consecutive failures on the active mount. */
  failures: number;
  /** Epoch ms the active mount last connected, 0 until it has. */
  liveSince: number;
  /** True when the next attempt is a scheduled retry of the primary. */
  retryingPrimary: boolean;
}

export class DualMountFailover {
  readonly primary: string;
  readonly backup: string | null;
  readonly candidates: string[];

  private readonly switchAfter: number;
  private readonly retryPrimaryMs: number;

  private activeMount: string;
  private failuresOnActive = 0;
  private switches = 0;
  private liveSince = 0;
  private retryingPrimary = false;
  private lastSwitchAt = 0;
  private lastFailureAt = 0;

  constructor(
    primary: string,
    backup?: string | null,
    opts: MountFailoverOptions = {},
  ) {
    this.candidates = mountCandidates(primary, backup);
    this.primary = this.candidates[0];
    this.backup = this.candidates.length > 1 ? this.candidates[1] : null;
    this.activeMount = this.primary;
    this.switchAfter = Math.max(1, Math.floor(opts.failuresBeforeSwitch ?? 2));
    this.retryPrimaryMs = Math.max(1000, opts.primaryRetryMs ?? 5 * 60_000);
  }

  get active(): string {
    return this.activeMount;
  }

  get switched(): boolean {
    return this.activeMount !== this.primary;
  }

  get state(): MountFailoverState {
    return {
      primary: this.primary,
      backup: this.backup,
      active: this.activeMount,
      switched: this.switched,
      switches: this.switches,
      failures: this.failuresOnActive,
      liveSince: this.liveSince,
      retryingPrimary: this.retryingPrimary,
    };
  }

  /**
   * Mount to try now. A backup that has been live past the retry window sends
   * the next attempt to the primary; a failure there drops straight back.
   */
  choose(now = Date.now()): string {
    if (
      this.activeMount !== this.primary &&
      this.liveSince > 0 &&
      now - this.liveSince >= this.retryPrimaryMs
    ) {
      this.retryingPrimary = true;
      return this.primary;
    }
    return this.activeMount;
  }

  /** A source session is live on `mount` (the attempt's mount when known). */
  recordLive(now = Date.now(), mount?: string): void {
    const used = normalizeMount(mount ?? "") || this.activeMount;
    if (used === this.primary && this.activeMount !== this.primary) {
      this.activeMount = this.primary;
      this.switches += 1;
      this.lastSwitchAt = now;
    }
    this.retryingPrimary = false;
    this.failuresOnActive = 0;
    this.liveSince = now;
  }

  /** A connection attempt failed (or a live session dropped). */
  recordFailure(now = Date.now()): void {
    this.lastFailureAt = now;
    if (this.retryingPrimary) {
      // The primary is still down: stay on the backup and restart its clock.
      this.retryingPrimary = false;
      this.liveSince = now;
      return;
    }
    this.failuresOnActive += 1;
    if (
      this.backup &&
      this.activeMount !== this.backup &&
      this.failuresOnActive >= this.switchAfter
    ) {
      this.activeMount = this.backup;
      this.failuresOnActive = 0;
      this.liveSince = 0;
      this.switches += 1;
      this.lastSwitchAt = now;
    }
  }

  /** Operator stop: forget the session's health, keep the counters. */
  reset(): void {
    this.retryingPrimary = false;
    this.failuresOnActive = 0;
    this.liveSince = 0;
  }

  /** Epoch ms of the latest automatic mount switch (0 = never). */
  get switchedAt(): number {
    return this.lastSwitchAt;
  }

  /** Epoch ms of the latest failed attempt (0 = none this session). */
  get failedAt(): number {
    return this.lastFailureAt;
  }
}
