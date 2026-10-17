/**
 * HTTP surface for station agents.
 *
 * The desktop/standalone build has no Convex client (the renderer is
 * deliberately offline-capable), so it reports telemetry and alarms here with
 * its station token instead of a signed-in session. Bodies are accepted as
 * `application/json` or `text/plain` — the latter keeps the agent's POST a
 * CORS "simple request" so it works from the app:// scheme without preflight.
 */
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Station-Token",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, 400) : undefined;

http.route({
  path: "/station-report",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
});

http.route({
  path: "/station-report",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let parsed: unknown = null;
    const raw = await req.text();
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "body must be JSON" }, 400);
    }
    if (!parsed || typeof parsed !== "object") {
      return json({ ok: false, error: "body must be a JSON object" }, 400);
    }
    const body = parsed as Record<string, unknown>;
    const token =
      str(body.token) ?? req.headers.get("x-station-token") ?? undefined;
    if (!token) return json({ ok: false, error: "token required" }, 401);

    const severityOf = (v: unknown): "critical" | "warning" | "info" =>
      v === "critical" || v === "warning" ? v : "info";

    const rawAlarms = Array.isArray(body.alarms) ? body.alarms : [];
    const alarms = rawAlarms.slice(0, 20).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const a = entry as Record<string, unknown>;
      const title = str(a.title);
      if (!title) return [];
      return [
        {
          kind: str(a.kind) ?? "remote",
          severity: severityOf(a.severity),
          title,
          detail: str(a.detail),
          at: num(a.at) ?? Date.now(),
        },
      ];
    });

    const result = await ctx.runMutation(internal.ops.reportByToken, {
      token,
      onAir: body.onAir === true,
      presetName: str(body.presetName),
      lufs: num(body.lufs),
      truePeakDb: num(body.truePeakDb),
      modPct: num(body.modPct),
      openAlarms: num(body.openAlarms),
      version: str(body.version),
      alarms,
    });

    return result.ok
      ? json(result)
      : json({ ok: false, error: result.reason }, 404);
  }),
});

export default http;
