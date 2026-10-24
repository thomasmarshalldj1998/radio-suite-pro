/**
 * Gain ramps and waits for device hand-offs.
 *
 * Every device change moves the signal path underneath a live programme: a
 * new microphone, a new speaker, a rebuilt context. What makes that move
 * inaudible is arriving at *exact* silence before the hardware is touched,
 * and returning to level only once the new endpoint is confirmed running.
 *
 * A linear ramp is used rather than `setTargetAtTime`. An exponential
 * approach never reaches zero — after a 4 ms time constant and a 20 ms wait
 * the bus is still at about −43 dB of the old programme (plus whatever DC
 * offset came with it), which is exactly the last thing the new endpoint
 * hears before it opens. A linear ramp lands on zero, so the disconnect is
 * a clean cut in already-silent audio.
 *
 * The module has no Web Audio dependency beyond the structural `RampParam`
 * shape, so the schedule can be checked without an audio device.
 */

/** Length of the gain ramp used on every device hand-off (5–10 ms window). */
export const DEVICE_RAMP_MS = 8;

/** Guard after a ramp before hardware is touched — one render quantum. */
const RAMP_GUARD_MS = 4;

/** The part of an AudioParam a ramp touches. */
export interface RampParam {
  value: number;
  cancelScheduledValues(time: number): unknown;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}

/**
 * Schedule a linear ramp from wherever the param is *now* to `target`.
 *
 * The anchor write is not cosmetic: after cancelling a ramp that was already
 * in flight, the param would otherwise start the new ramp from its last
 * scheduled value rather than its current one, and step on the first block.
 * Returns the context time at which the ramp lands.
 */
export function rampTo(
  param: RampParam,
  target: number,
  now: number,
  ms: number = DEVICE_RAMP_MS,
): number {
  const seconds = Math.max(0, ms) / 1000;
  const from = Number.isFinite(param.value) ? param.value : target;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.linearRampToValueAtTime(target, now + seconds);
  return now + seconds;
}

/** How long to hold after a ramp before the hardware may be touched. */
export function rampWaitMs(ms: number = DEVICE_RAMP_MS): number {
  return Math.max(0, ms) + RAMP_GUARD_MS;
}

/**
 * Frames the graph has already produced but the speaker has not played yet.
 *
 * Fading to zero only clears the graph — the endpoint still has a buffer of
 * pre-fade frames queued. Touching the device before those have played is
 * what turns a silent fade into a truncated, half-rendered burst.
 */
export function outputLatencyMs(
  ctx: { baseLatency?: number; outputLatency?: number },
  capMs = 80,
): number {
  const a = ctx.baseLatency;
  const b = ctx.outputLatency;
  const seconds = (Number.isFinite(a) ? (a as number) : 0) + (Number.isFinite(b) ? (b as number) : 0);
  if (!(seconds > 0)) return 0;
  return Math.min(capMs, Math.round(seconds * 1000));
}

/**
 * Wait until a context reports `running`, bounded.
 *
 * `resume()` resolves once the request is accepted, which on some platforms
 * is before the endpoint is actually clocking. Anything that feeds audio
 * has to wait for the state, not the promise.
 */
export async function waitForRunning(
  ctx: { state: AudioContextState },
  timeoutMs = 400,
  stepMs = 10,
): Promise<boolean> {
  // Read through a call each time: the compiler would otherwise narrow the
  // property once and treat every later check as unreachable.
  const running = () => ctx.state === "running";
  if (running()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, stepMs));
    if (running()) return true;
    if (ctx.state === "closed") return false;
  }
  return running();
}
