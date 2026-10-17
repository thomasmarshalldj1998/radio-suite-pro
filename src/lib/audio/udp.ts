/**
 * UDP transport for the composite-over-IP link.
 *
 * The browser has no UDP socket, so on the desktop build the sockets live in
 * the main process and this module is the renderer half of that bridge: it
 * encodes each framed packet once per path, hands the bytes across IPC, and
 * decodes whatever comes back the other way into the link receiver.
 *
 * On the web build there is no bridge, `available` is false, and the panel says
 * so rather than pretending a link exists.
 *
 * The transport is deliberately dumb about audio: it moves the framed packets
 * the link layer produced and nothing else, so what leaves the socket is
 * exactly what the packetiser counted.
 */
import { decodePacket, encodePacket, type MpxPacket } from "./mpxlink";

export type LinkId = "a" | "b";

export interface UdpConfig {
  hostA: string;
  portA: number;
  listenA: number;
  hostB: string;
  portB: number;
  listenB: number;
}

/** Loopback-style defaults: each path has its own destination and port. */
export const DEFAULT_UDP: UdpConfig = {
  hostA: "127.0.0.1",
  portA: 9220,
  listenA: 9210,
  hostB: "127.0.0.1",
  portB: 9222,
  listenB: 9212,
};

export interface EndpointState {
  id: LinkId;
  open: boolean;
  /** Port actually bound (useful when the config asked for 0). */
  boundPort: number;
  sent: number;
  sentBytes: number;
  received: number;
  error: string | null;
}

export interface UdpState {
  /** A bridge exists (desktop build). */
  available: boolean;
  open: boolean;
  connecting: boolean;
  config: UdpConfig;
  endpoints: [EndpointState, EndpointState];
  packetsSent: number;
  packetsReceived: number;
  /** Datagrams that arrived but failed magic/version/CRC checks. */
  invalid: number;
  /** Mean payload rate since the sockets opened, kbit/s. */
  kbps: number;
  error: string | null;
}

const STORAGE_KEY = "signalpath.mpxlink.udp.v1";

function port(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

function host(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const h = value.trim();
  if (!/^[0-9a-zA-Z.:_-]{1,255}$/.test(h)) return fallback;
  return h;
}

function readConfig(): UdpConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UDP };
    const parsed = JSON.parse(raw) as Partial<UdpConfig>;
    return {
      hostA: host(parsed.hostA, DEFAULT_UDP.hostA),
      portA: port(parsed.portA, DEFAULT_UDP.portA),
      listenA: port(parsed.listenA, DEFAULT_UDP.listenA),
      hostB: host(parsed.hostB, DEFAULT_UDP.hostB),
      portB: port(parsed.portB, DEFAULT_UDP.portB),
      listenB: port(parsed.listenB, DEFAULT_UDP.listenB),
    };
  } catch {
    return { ...DEFAULT_UDP };
  }
}

const bridge = (): NonNullable<Window["signalpath"]>["udp"] | null =>
  typeof window === "undefined" ? null : (window.signalpath?.udp ?? null);

const emptyEndpoint = (id: LinkId): EndpointState => ({
  id,
  open: false,
  boundPort: 0,
  sent: 0,
  sentBytes: 0,
  received: 0,
  error: null,
});

let state: UdpState = {
  available: bridge() !== null,
  open: false,
  connecting: false,
  config: readConfig(),
  endpoints: [emptyEndpoint("a"), emptyEndpoint("b")],
  packetsSent: 0,
  packetsReceived: 0,
  invalid: 0,
  kbps: 0,
  error: null,
};
let openedAt = 0;
let inbound: ((packet: MpxPacket) => void) | null = null;
let detachBridge: (() => void) | null = null;

const listeners = new Set<() => void>();
let lastEmit = 0;

function emit(): void {
  lastEmit = performance.now();
  for (const cb of listeners) cb();
}

/** Counters move with every datagram; the display refresh does not. */
function emitThrottled(): void {
  if (performance.now() - lastEmit < 200) return;
  emit();
}

export function getUdp(): UdpState {
  return state;
}

export function subscribeUdp(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function udpAvailable(): boolean {
  return bridge() !== null;
}

/** How many paths are actually open right now. */
export function udpPaths(): number {
  return state.endpoints.filter((e) => e.open).length;
}

/** Where inbound datagrams go — the link receiver, from the runtime. */
export function setUdpInbound(cb: ((packet: MpxPacket) => void) | null): void {
  inbound = cb;
}

export function setUdpConfig(patch: Partial<UdpConfig>): void {
  const next: UdpConfig = {
    hostA: host(patch.hostA ?? state.config.hostA, state.config.hostA),
    portA: port(patch.portA ?? state.config.portA, state.config.portA),
    listenA: port(patch.listenA ?? state.config.listenA, state.config.listenA),
    hostB: host(patch.hostB ?? state.config.hostB, state.config.hostB),
    portB: port(patch.portB ?? state.config.portB, state.config.portB),
    listenB: port(patch.listenB ?? state.config.listenB, state.config.listenB),
  };
  state = { ...state, config: next };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // private mode / storage full — the sockets still work this session
  }
  emit();
}

/** Decode one datagram onto the path it arrived on. */
function onData(id: LinkId, bytes: Uint8Array): void {
  const packet = decodePacket(bytes);
  const index = id === "b" ? 1 : 0;
  const endpoint = state.endpoints[index];
  if (!packet) {
    state = {
      ...state,
      invalid: state.invalid + 1,
      endpoints: state.endpoints.map((e, i) =>
        i === index ? { ...e, error: "framing/CRC check failed" } : e,
      ) as [EndpointState, EndpointState],
    };
    emitThrottled();
    return;
  }
  state = {
    ...state,
    packetsReceived: state.packetsReceived + 1,
    endpoints: state.endpoints.map((e, i) =>
      i === index
        ? { ...e, received: e.received + 1, error: null }
        : e,
    ) as [EndpointState, EndpointState],
  };
  // Trust the socket, not the header: a misconfigured sender cannot make the
  // receiver believe two paths are one.
  inbound?.({ ...packet, link: index });
  emitThrottled();
}

/**
 * Open both paths. Resolves once every endpoint has either bound or reported
 * why it could not — a half-open pair is reported, not hidden.
 */
export async function openUdp(): Promise<void> {
  const api = bridge();
  if (!api) {
    state = {
      ...state,
      available: false,
      error: "UDP needs the desktop app — the browser has no sockets",
    };
    emit();
    return;
  }
  if (state.connecting) return;
  state = { ...state, connecting: true, error: null, invalid: 0 };
  emit();

  detachBridge?.();
  detachBridge = api.onData((id, bytes) => {
    if (id === "a" || id === "b") onData(id, bytes);
  });
  setUdpInbound(inbound);

  const cfg = state.config;
  const plan: { id: LinkId; args: Record<string, unknown> }[] = [
    { id: "a", args: { id: "a", listenPort: cfg.listenA, host: cfg.hostA, port: cfg.portA } },
    { id: "b", args: { id: "b", listenPort: cfg.listenB, host: cfg.hostB, port: cfg.portB } },
  ];
  const results = await Promise.all(
    plan.map(async ({ id, args }) => {
      try {
        const res = await api.open(args as never);
        return res?.ok
          ? { id, open: true, boundPort: res.port ?? 0, error: null }
          : { id, open: false, boundPort: 0, error: res?.error ?? "could not open socket" };
      } catch (err) {
        return {
          id,
          open: false,
          boundPort: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const endpoints = state.endpoints.map((endpoint) => {
    const result = results.find((r) => r.id === endpoint.id);
    return result
      ? {
          ...endpoint,
          open: result.open,
          boundPort: result.boundPort,
          sent: 0,
          sentBytes: 0,
          received: 0,
          error: result.error,
        }
      : endpoint;
  }) as [EndpointState, EndpointState];

  openedAt = performance.now();
  state = {
    ...state,
    connecting: false,
    open: endpoints.some((e) => e.open),
    endpoints,
    packetsSent: 0,
    packetsReceived: 0,
    kbps: 0,
    error: endpoints.find((e) => e.error)?.error ?? null,
  };
  emit();
}

export async function closeUdp(): Promise<void> {
  const api = bridge();
  detachBridge?.();
  detachBridge = null;
  if (api) {
    await Promise.all(
      (["a", "b"] as LinkId[]).map((id) => api.close(id).catch(() => ({ ok: false }))),
    );
  }
  state = {
    ...state,
    open: false,
    connecting: false,
    endpoints: state.endpoints.map((e) => ({
      ...e,
      open: false,
      boundPort: 0,
    })) as [EndpointState, EndpointState],
    kbps: 0,
  };
  emit();
}

/**
 * Put one framed packet on every open path. Called per packet by the runtime's
 * transport hook; each path gets its own header copy carrying that path's link
 * number, so the receiver can tell the two apart without guessing.
 */
export function sendPacket(packet: MpxPacket): void {
  const api = bridge();
  if (!api || !state.open) return;
  let sent = 0;
  const endpoints = state.endpoints.map((endpoint, index) => {
    if (!endpoint.open) return endpoint;
    const wire = encodePacket({ ...packet, link: index });
    api.send(endpoint.id, wire);
    sent += 1;
    return { ...endpoint, sent: endpoint.sent + 1, sentBytes: endpoint.sentBytes + wire.length };
  }) as [EndpointState, EndpointState];
  if (sent === 0) return;
  const bytes = endpoints.reduce((n, e) => n + e.sentBytes, 0);
  const elapsedMs = performance.now() - openedAt;
  state = {
    ...state,
    endpoints,
    packetsSent: state.packetsSent + 1,
    kbps: elapsedMs > 0 ? (bytes * 8) / Math.max(elapsedMs, 1) : 0,
  };
  emitThrottled();
}
