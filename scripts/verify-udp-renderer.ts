/**
 * Verification of the renderer half of the UDP transport:
 *
 *   bun scripts/verify-udp-renderer.ts
 *
 * The socket itself is covered by verify-udp.ts. What is checked here is the
 * wiring between the console and that bridge — the part that decides which
 * path a packet goes down, how arriving datagrams are attributed, and what the
 * panel is told when a socket refuses to open. The preload is replaced by an
 * in-memory fake; everything else is the real module.
 *
 * Checks:
 *  1  bridge: the transport reports itself available and opens both paths
 *  2  send: one framed packet per path, each with its own link number
 *  3  receive: datagrams are decoded and attributed to the socket they came in
 *  4  damage: a corrupted datagram is rejected instead of reaching the receiver
 *  5  failure: a socket that will not bind is reported, not hidden
 *  6  close: the paths close and the transport stops sending
 */
import { MPX_LINK_FRAME_SAMPLES, decodePacket, encodePacket } from "../src/lib/audio/mpxlink";

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ── the fake preload bridge ─────────────────────────────────────────────── */

const sent: { id: "a" | "b"; bytes: Uint8Array }[] = [];
let inboundHandler: ((id: "a" | "b", bytes: Uint8Array) => void) | null = null;
let refusals: Record<string, string> = {};
const opened: string[] = [];

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    signalpath: {
      platform: "test",
      udp: {
        available: true,
        open: async (args: { id: "a" | "b"; listenPort: number; host: string; port: number }) => {
          if (refusals[args.id]) return { ok: false, error: refusals[args.id] };
          opened.push(args.id);
          return { ok: true, port: args.listenPort || 9000 };
        },
        send: (id: "a" | "b", bytes: Uint8Array) => void sent.push({ id, bytes }),
        close: async (id: "a" | "b") => {
          const i = opened.indexOf(id);
          if (i >= 0) opened.splice(i, 1);
          return { ok: true };
        },
        onData: (cb: (id: "a" | "b", bytes: Uint8Array) => void) => {
          inboundHandler = cb;
          return () => {
            inboundHandler = null;
          };
        },
      },
    },
  },
  configurable: true,
});

const udp = await import("../src/lib/audio/udp");

function packet(sequence: number, link = 0) {
  const payload = new Uint8Array(MPX_LINK_FRAME_SAMPLES * 2);
  for (let i = 0; i < payload.length; i++) payload[i] = (sequence + i) & 0xff;
  return {
    codec: "raw" as const,
    link,
    sequence,
    timestamp: sequence * MPX_LINK_FRAME_SAMPLES,
    sampleRate: 192000,
    channels: 1,
    frames: MPX_LINK_FRAME_SAMPLES,
    payload,
  };
}

async function main(): Promise<void> {
  // ── 1 · bridge ───────────────────────────────────────────────────────────
  console.log("\n1 · bridge");
  check(udp.udpAvailable(), "the desktop bridge is detected");
  check(!udp.getUdp().open, "nothing is open before connecting");
  await udp.openUdp();
  const state = udp.getUdp();
  check(state.open, "both paths opened", `${state.endpoints.filter((e) => e.open).length} of 2`);
  check(udp.udpPaths() === 2, "both paths are counted", opened.join(", "));
  check(
    state.endpoints[0].boundPort > 0 && state.endpoints[1].boundPort > 0,
    "each path reports its bound port",
    `${state.endpoints[0].boundPort} · ${state.endpoints[1].boundPort}`,
  );

  // ── 2 · send ─────────────────────────────────────────────────────────────
  console.log("\n2 · send");
  const received: Array<{ link: number; sequence: number }> = [];
  udp.setUdpInbound((p) => received.push({ link: p.link, sequence: p.sequence }));

  udp.sendPacket(packet(7));
  check(sent.length === 2, "one frame becomes one datagram per path", `${sent.length} datagrams`);
  const [wireA, wireB] = sent.map((s) => decodePacket(s.bytes));
  check(sent[0].id === "a" && sent[1].id === "b", "the datagrams went to A then B");
  check(wireA !== null && wireB !== null, "both datagrams carry valid framing");
  check(
    wireA!.link === 0 && wireB!.link === 1,
    "each path's header carries its own link number",
    `${wireA!.link} · ${wireB!.link}`,
  );
  check(
    wireA!.sequence === 7 && wireB!.sequence === 7,
    "both paths carry the same sequence — one stream, two copies",
    `${wireA!.sequence}`,
  );
  check(
    udp.getUdp().packetsSent === 1,
    "the transport counted one send",
    `${udp.getUdp().packetsSent}`,
  );

  // ── 3 · receive ──────────────────────────────────────────────────────────
  console.log("\n3 · receive");
  inboundHandler?.("a", sent[0].bytes);
  inboundHandler?.("b", sent[1].bytes);
  check(received.length === 2, "both datagrams reached the inbound handler");
  check(
    received[0].link === 0 && received[1].link === 1,
    "attribution follows the socket, not the sender's claim",
    `${received.map((r) => r.link).join(" · ")}`,
  );
  // A misconfigured peer sending link-1 headers into socket A must still be
  // filed under A.
  inboundHandler?.("a", sent[1].bytes);
  check(
    received[2]?.link === 0,
    "a lying header cannot merge the paths",
    `socket A → link ${received[2]?.link}`,
  );
  check(udp.getUdp().packetsReceived === 3, "arrivals are counted", `${udp.getUdp().packetsReceived}`);

  // ── 4 · damage ───────────────────────────────────────────────────────────
  console.log("\n4 · damage");
  const bad = encodePacket({ ...packet(9), link: 0 });
  bad[bad.length - 1] ^= 0xff;
  const beforeInbound = received.length;
  inboundHandler?.("a", bad);
  check(received.length === beforeInbound, "a corrupted datagram never reaches the receiver");
  check(udp.getUdp().invalid === 1, "it is counted as invalid", `${udp.getUdp().invalid}`);

  await udp.closeUdp();
  const closed = udp.getUdp();
  check(!closed.open && udp.udpPaths() === 0, "close closes every path");
  const sentBefore = sent.length;
  udp.sendPacket(packet(10));
  check(sent.length === sentBefore, "a closed transport refuses to send");

  // ── 5 · failure ──────────────────────────────────────────────────────────
  console.log("\n5 · failure");
  refusals = { b: "EADDRINUSE: bind EADDRINUSE 0.0.0.0:9212" };
  await udp.openUdp();
  const partial = udp.getUdp();
  check(partial.open, "the path that bound still works", `${udp.udpPaths()} of 2 open`);
  check(
    partial.endpoints[1].error !== null,
    "the path that failed is reported",
    partial.endpoints[1].error ?? "",
  );
  check(
    partial.error !== null,
    "the transport surfaces the failure to the panel",
    partial.error ?? "",
  );
  await udp.closeUdp();

  // ── 6 · config ───────────────────────────────────────────────────────────
  console.log("\n6 · config");
  udp.setUdpConfig({ portA: 9300, hostA: "10.0.0.5", listenA: 9301 });
  const cfg = udp.getUdp().config;
  check(cfg.portA === 9300 && cfg.hostA === "10.0.0.5", "the target is stored", `${cfg.hostA}:${cfg.portA}`);
  udp.setUdpConfig({ portA: 99999, hostA: "not a host!" });
  const guarded = udp.getUdp().config;
  check(
    guarded.portA === 9300 && guarded.hostA === "10.0.0.5",
    "an invalid target is refused, not applied",
    `${guarded.hostA}:${guarded.portA}`,
  );
  check(store.has("signalpath.mpxlink.udp.v1"), "the settings persist for the next session");

  console.log(`\n${passed} checks passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

await main();
