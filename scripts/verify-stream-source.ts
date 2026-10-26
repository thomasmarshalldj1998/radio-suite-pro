/**
 * Stream source checks — the desktop side of "go on air".
 *
 *   bun scripts/verify-stream-source.ts
 *
 * The transport is a real Node HTTP request, so the whole handshake is
 * verified against a loopback server: auth, headers, audio framing, ICY
 * metadata blocks and the refusal path. No Electron, no browser.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error — CJS module shared with the Electron shell has no types.
import { MAX_BACKLOG_BYTES, StreamSource, resolveTarget } from "../electron/stream-source.cjs";
import { mountUrl } from "../src/lib/audio/encoder";
import {
  isStreamableContainer,
  retryDelayMs,
  streamTitle,
} from "../src/lib/audio/stream-client";

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

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/* ── 1 · URL and config maths ──────────────────────────────────────────── */

console.log("\n1 · endpoint resolution");

{
  const target = resolveTarget({
    server: "radio.example.com",
    port: 8000,
    mount: "/live",
    protocol: "icecast2",
  });
  check(
    target.host === "radio.example.com" &&
      target.port === 8000 &&
      target.path === "/live" &&
      target.secure === false,
    "an icecast mount resolves to host/port/path",
    `${target.host}:${target.port}${target.path}`,
  );
  check(
    resolveTarget({ server: "h", port: 443, mount: "m", protocol: "icecast2" }).secure,
    "port 443 implies TLS",
  );
  check(
    resolveTarget({ server: "h", port: 8000, mount: "m", protocol: "https" }).secure,
    "an https protocol implies TLS",
  );
  check(
    resolveTarget({ server: "h", port: 8000, mount: "stream", protocol: "x" }).path ===
      "/stream",
    "a mount without a leading slash is normalised",
  );

  let badHost = "";
  try {
    resolveTarget({ server: "bad host", port: 8000, mount: "m" });
  } catch (err) {
    badHost = err instanceof Error ? err.message : String(err);
  }
  check(badHost.length > 0, "a host with spaces is rejected", badHost);

  let badPort = "";
  try {
    resolveTarget({ server: "h", port: 0, mount: "m" });
  } catch (err) {
    badPort = err instanceof Error ? err.message : String(err);
  }
  check(badPort.length > 0, "port 0 is rejected", badPort);

  check(mountUrl({ protocol: "icecast2", server: "h", port: 8000, mount: "live" }) === "http://h:8000/live", "mountUrl builds an http source URL");
  check(mountUrl({ protocol: "https", server: "h", port: 8443, mount: "/live" }) === "https://h:8443/live", "mountUrl follows https");
  check(mountUrl({ protocol: "icecast2", server: "h", port: 0, mount: "" }) === "http://h:8000/stream", "an empty mount and port fall back to the defaults", mountUrl({ protocol: "icecast2", server: "h", port: 0, mount: "" }));
}

/* ── 2 · renderer-side helpers ─────────────────────────────────────────── */

console.log("\n2 · stream helpers");

{
  check(isStreamableContainer("audio/mpeg"), "MP3 is a source container");
  check(isStreamableContainer("audio/ogg;codecs=opus"), "Ogg/Opus is a source container");
  check(!isStreamableContainer("audio/mp4;codecs=mp4a.40.2"), "M4A is not a source container");
  check(!isStreamableContainer("audio/webm;codecs=opus"), "WebM is not a source container");
  check(streamTitle("Artist", "Title") === "Artist - Title", "title joins artist and title");
  check(streamTitle("", "Title") === "Title", "a missing artist leaves the title alone");
  check(streamTitle("Artist", "") === "Artist", "a missing title leaves the artist alone");
  check(streamTitle("A", "B").length <= 250, "the title is capped at 250 chars");
  check(
    retryDelayMs(1, 0.5) === 1000 &&
      retryDelayMs(2, 0.5) === 2000 &&
      retryDelayMs(3, 0.5) === 4000 &&
      retryDelayMs(4, 0.5) === 8000 &&
      retryDelayMs(5, 0.5) === 15000,
    "backoff follows 1→2→4→8→15 s",
  );
  check(retryDelayMs(9, 0.5) === 30000, "backoff is capped at thirty seconds");
  check(MAX_BACKLOG_BYTES >= 1024 * 1024, "the backlog cap allows a real socket buffer", `${MAX_BACKLOG_BYTES} bytes`);
}

/* ── 3 · real handshake against a loopback server ──────────────────────── */

console.log("\n3 · source handshake");

interface Received {
  method: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  ended: boolean;
}

/** One HTTP server that accepts a source PUT and records what arrived. */
function sourceServer(
  status: number,
  onRequest?: (req: IncomingMessage, body: Received) => void,
): Promise<{ server: Server; port: number; got: Received }> {
  const got: Received = {
    method: "",
    headers: {},
    body: Buffer.alloc(0),
    ended: false,
  };
  const parts: Buffer[] = [];
  const server = createServer((req, res) => {
    got.method = req.method ?? "";
    got.headers = req.headers;
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      got.body = Buffer.concat(parts);
      got.ended = true;
    });
    if (status === 200) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.flushHeaders();
      onRequest?.(req, got);
    } else {
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end("source rejected");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, got });
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

{
  const { server, port, got } = await sourceServer(200);
  const states: string[] = [];
  const src = new StreamSource({ onState: (s: { status: string }) => states.push(s.status) });
  const res = await src.open({
    protocol: "icecast2",
    server: "127.0.0.1",
    port,
    mount: "/test",
    username: "source",
    password: "hackme",
    contentType: "audio/mpeg",
    name: "Signalpath test",
    bitrateKbps: 128,
  });
  check(res.ok, "the source connects to a 200 server", res.error ?? "");
  check(states.includes("connecting") && states.includes("live"), "state goes connecting → live", states.join(" → "));
  check(got.method === "PUT", "the request method is PUT", got.method);
  check(got.headers["authorization"] === `Basic ${Buffer.from("source:hackme").toString("base64")}`, "basic auth carries the source credentials");
  check(got.headers["content-type"] === "audio/mpeg", "the content type matches the encoder", String(got.headers["content-type"]));
  check(got.headers["ice-name"] === "Signalpath test", "the station name is advertised");
  check(got.headers["icy-metaint"] === undefined, "no metaint header when metadata is off");

  const audio = Buffer.alloc(2048, 7);
  src.write(audio);
  await wait(120);
  check(got.body.length === 0 || !got.ended, "the source keeps the request open while live");
  check(src.stats().sent === 2048, "sent bytes are counted", `${src.stats().sent}`);

  src.close();
  await wait(120);
  check(got.ended && got.body.length === 2048, "closing the source delivers every byte", `${got.body.length}`);
  check(src.stats().status === "ended", "the source reports ended after close");
  server.close();
}

/* ── 4 · ICY metadata interleaving ─────────────────────────────────────── */

console.log("\n4 · ICY metadata");

{
  const METAINT = 1024;
  const { server, port, got } = await sourceServer(200);
  const src = new StreamSource();
  await src.open({
    protocol: "icecast2",
    server: "127.0.0.1",
    port,
    mount: "/meta",
    username: "source",
    password: "pw",
    contentType: "audio/ogg",
    metaint: METAINT,
  });
  check(
    got.headers["icy-metaint"] === String(METAINT),
    "the metaint header advertises the interval",
    String(got.headers["icy-metaint"]),
  );

  src.setMetadata("The Artist - The Title");
  src.write(Buffer.alloc(METAINT * 2, 1));
  await wait(80);
  const sentAfterFirst = src.stats().sent;

  // a short tail keeps its own edge: no block is invented before metaint
  src.write(Buffer.alloc(64, 3));
  await wait(80);
  src.close();
  await wait(200);

  const body = got.body;
  // layout: 1024 audio · 1 length byte · frames×16 payload · 1024 audio · …
  const frames = body[METAINT];
  const text = body
    .subarray(METAINT + 1, METAINT + 1 + frames * 16)
    .toString("utf8")
    .replace(/\0+$/, "");
  check(frames > 0 && text.startsWith("StreamTitle='"), "a metadata block follows the first interval", `${frames} frames`);
  check(text.includes("The Artist - The Title"), "the block carries the queued title", text);
  check(sentAfterFirst === METAINT * 2, "sent counts only audio bytes", `${sentAfterFirst}`);
  check(
    body.length === METAINT * 2 + 64 + 2 * (1 + frames * 16),
    "audio and metadata sum to the expected frame length",
    `${body.length} bytes`,
  );
  const secondMetaAt = METAINT + 1 + frames * 16 + METAINT;
  check(
    body[secondMetaAt] === frames,
    "the block repeats at the next interval until the title changes",
    `${body[secondMetaAt]} frames`,
  );
  check(
    src.stats().sent === METAINT * 2 + 64,
    "metadata frames are not counted as audio bytes",
    `${src.stats().sent}`,
  );
  server.close();
}

/* ── 5 · refusal path ──────────────────────────────────────────────────── */

console.log("\n5 · refusal");

{
  const { server, port } = await sourceServer(401);
  const src = new StreamSource();
  const res = await src.open({
    protocol: "icecast2",
    server: "127.0.0.1",
    port,
    mount: "/nope",
    username: "source",
    password: "wrong",
    contentType: "audio/mpeg",
  });
  check(!res.ok, "a 401 is reported as a failed connection");
  check(
    (res.error ?? "").includes("401"),
    "the failure carries the server's status",
    res.error ?? "",
  );
  check(src.stats().status === "offline", "the source is offline after a refusal");

  const before = src.stats().dropped;
  src.write(Buffer.alloc(512, 1));
  check(src.stats().dropped === before + 512, "audio written while offline is counted as dropped");
  server.close();
}

{
  const src = new StreamSource();
  const res = await src.open({
    protocol: "icecast2",
    server: "127.0.0.1",
    port: 1,
    mount: "/closed",
    username: "source",
    password: "x",
    contentType: "audio/mpeg",
  });
  check(!res.ok && src.stats().status === "offline", "an unreachable port fails cleanly", res.error ?? "");
  check(near(src.stats().sent, 0), "a failed connection sends nothing");
}

/* ── 6 · preflight probe ───────────────────────────────────────────────── */

console.log("\n6 · preflight probe");

const probeCfg = (port: number) => ({
  protocol: "icecast2",
  server: "127.0.0.1",
  port,
  mount: "/probe",
  username: "source",
  password: "hackme",
  contentType: "audio/mpeg",
});

{
  const { server, port, got } = await sourceServer(200);
  const src = new StreamSource();
  const res = await src.probe(probeCfg(port));
  check(res.ok && res.status === 200, "a probe of an open mount passes", res.error ?? "");
  check(got.method === "PUT", "the probe is a source PUT, so the mount's own rules apply", got.method);
  check(
    got.headers["icy-metaint"] === undefined,
    "and it asks for no metadata framing",
    String(got.headers["icy-metaint"]),
  );
  check(src.stats().status === "idle", "the probe leaves the live source untouched", src.stats().status);
  server.close();
}

{
  const { server, port } = await sourceServer(401);
  const res = await new StreamSource().probe(probeCfg(port));
  check(!res.ok && res.status === 401, "a refusal reports its status", `${res.status}`);
  check(/credentials/i.test(res.error ?? ""), "and names credentials as the reason", res.error ?? "");
  server.close();
}

{
  const { server, port } = await sourceServer(403);
  const res = await new StreamSource().probe(probeCfg(port));
  check(!res.ok && res.status === 403, "a busy mount is reported as 403", `${res.status}`);
  check(/in use/i.test(res.error ?? ""), "and says the mount is taken", res.error ?? "");
  server.close();
}

{
  const res = await new StreamSource().probe(probeCfg(1));
  check(!res.ok && res.status === 0, "an unreachable endpoint fails the probe instead of hanging", res.error ?? "");
}

/* ── 7 · frames during an outstanding handshake ────────────────────────── */

console.log("\n7 · handshake that waits for frames");

{
  const { server, port, got } = await sourceServer(200);
  const src = new StreamSource();
  // Start the handshake and feed it without waiting for the verdict: this is
  // the case a server that answers only after hearing the source needs.
  const opening = src.open(probeCfg(port));
  src.write(Buffer.alloc(1024, 3));
  check(src.stats().dropped === 0, "frames written during the handshake are not dropped", `${src.stats().dropped}`);
  const res = await opening;
  check(res.ok, "the source still reaches live", res.error ?? "");
  src.close();
  await wait(120);
  check(got.body.length === 1024, "and the server received every byte", `${got.body.length}`);
  server.close();
}

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
