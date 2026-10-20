/**
 * Console ↔ Python bridge client.
 *
 *   bun scripts/verify-backend.ts
 *
 * The client is the only part of the console that talks to the Python encoder,
 * so its contract is checked against a mocked fetch: URL construction, JSON
 * parsing, error mapping, timeouts and the polling lifetime. No Python process
 * is required (the API itself is covered by tests/test_integration.py).
 */
import { BackendError, SignalPathBackend } from "../src/lib/backend-bridge";

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

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const calls: { url: string; init?: RequestInit }[] = [];
let handler: Handler = () => new Response("{}", { status: 200 });

const originalFetch = globalThis.fetch;
(globalThis as { fetch: typeof fetch }).fetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = String(input);
  calls.push({ url, init });
  return handler(url, init);
}) as typeof fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const metrics = {
  stream_status: "idle" as const,
  active_mount: null,
  uptime_seconds: 0,
  dropped_frames: 0,
  codec: null,
  profile: null,
  bitrate_kbps: 0,
  latency_ms: 0,
  frames: 0,
  bytes_in: 0,
  bytes_out: 0,
  input_level_db: null,
  output_level_db: null,
  lufs_integrated: null,
  true_peak_db: null,
  lra: null,
  source: "python" as const,
};

const client = new SignalPathBackend("http://test.local/api/");
const lastCall = () => calls[calls.length - 1];

async function run(): Promise<void> {
  check(client.baseUrl === "http://test.local/api", "base URL is normalised");

  handler = () => json({ ok: true, version: "3.1.0" });
  check(await client.checkConnection(), "health probe connects");
  check(lastCall()?.url === "http://test.local/api/health", "health path", lastCall()?.url);

  handler = () =>
    json({
      codecs: {
        "AAC (FDK)": {
          name: "AAC (FDK)",
          status: "available",
          mode: "native",
          library: "libfdk-aac.so.2",
          cli: null,
          version: null,
          note: "native",
        },
      },
    });
  const codecs = await client.getCodecStatus();
  check(codecs?.["AAC (FDK)"]?.mode === "native", "codec status parses");

  handler = () => json(metrics);
  const live = await client.getLiveMetrics();
  check(live?.stream_status === "idle", "live metrics parse");
  check(live?.true_peak_db === null, "unmeasured fields stay null");

  handler = () => json({ ok: true, status: { ...metrics, stream_status: "live", frames: 12 } });
  const started = await client.startStream({ mount: "/live" });
  check(started.stream_status === "live" && started.frames === 12, "start returns the session");
  const startCall = lastCall();
  check(startCall?.init?.method === "POST", "start is a POST");
  const body = JSON.parse(String(startCall?.init?.body ?? "{}")) as Record<string, unknown>;
  check(body.mount === "/live" && body.codec === "aac", "start carries mount + codec");
  check(body.bitrate_kbps === 64 && body.profile === "he-aacv2", "start carries codec defaults");

  await client.startStream("/string-mount");
  const stringBody = JSON.parse(String(lastCall()?.init?.body ?? "{}")) as Record<string, unknown>;
  check(stringBody.mount === "/string-mount", "start accepts a mount string");

  handler = () => json({ ok: true, status: { ...metrics, stream_status: "idle" } });
  check((await client.stopStream()).stream_status === "idle", "stop returns idle");

  handler = () => json({ detail: "A stream is already running" }, 409);
  try {
    await client.startStream({ mount: "/live" });
    check(false, "409 becomes BackendError");
  } catch (err) {
    check(
      err instanceof BackendError && err.status === 409 && err.message.includes("already"),
      "409 becomes BackendError",
      err instanceof Error ? err.message : "",
    );
  }

  handler = () => {
    throw new Error("connection refused");
  };
  check(!(await client.checkConnection()), "refused connection reports offline");
  check((await client.getCodecStatus()) === null, "offline codecs return null");
  check(client.isConnected === false, "connection state is exposed");

  handler = () => json({ ...metrics, stream_status: "live" });
  let seen = 0;
  const unsubscribe = client.subscribeMetrics(() => {
    seen += 1;
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 45));
  unsubscribe();
  const after = seen;
  await new Promise((resolve) => setTimeout(resolve, 30));
  check(seen >= 2, "metrics polling runs", `${seen} updates`);
  check(seen === after, "unsubscribe stops polling");

  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  console.log(`\n${passed} checks passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

void run();
