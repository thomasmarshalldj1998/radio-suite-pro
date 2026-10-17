/**
 * Station operations: durable alarms, dayparting schedules and the
 * multi-station registry.
 *
 * `stations.ts` owns the stream mount + broadcast log; this module owns the
 * three tables the operator-facing features need, and follows the same rules
 * (every row is scoped to the signed-in user, indexes are oldest-first and
 * retention is pruned opportunistically on write).
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

const severityValidator = v.union(
  v.literal("critical"),
  v.literal("warning"),
  v.literal("info"),
);

const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const ALARM_LIMIT = 500;

/** Delete this user's oldest alarms past the retention window. */
async function pruneAlarms(
  ctx: { db: any },
  userId: unknown,
  now: number,
): Promise<void> {
  const cutoff = now - RETENTION_MS;
  const rows = await ctx.db
    .query("alarms")
    .withIndex("by_user_time", (q: any) => q.eq("userId", userId))
    .take(80);
  for (const row of rows) {
    if (row.at >= cutoff) break;
    await ctx.db.delete(row._id);
  }
}

/* ── alarms ─────────────────────────────────────────────────────────────── */

/** Record one alarm. Returns the new row id. */
export const pushAlarm = mutation({
  args: {
    kind: v.string(),
    severity: severityValidator,
    title: v.string(),
    detail: v.optional(v.string()),
    source: v.optional(v.string()),
    at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const at = args.at ?? Date.now();
    await pruneAlarms(ctx, userId, Date.now());

    // Collapse a repeat of the same kind that is already open, so a runaway
    // condition cannot bury the history in duplicates.
    const recent = await ctx.db
      .query("alarms")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(6);
    const twin = recent.find(
      (row) => row.kind === args.kind && row.ackAt === undefined && row.title === args.title,
    );
    if (twin && at - twin.at < 60_000) {
      await ctx.db.patch(twin._id, { at, detail: args.detail });
      return twin._id;
    }

    return await ctx.db.insert("alarms", {
      userId,
      kind: args.kind,
      severity: args.severity,
      title: args.title,
      detail: args.detail,
      at,
      source: args.source ?? "console",
    });
  },
});

/** Alarm history, newest first. `onlyOpen` hides acknowledged events. */
export const listAlarms = query({
  args: {
    limit: v.optional(v.number()),
    onlyOpen: v.optional(v.boolean()),
  },
  handler: async (ctx, { limit, onlyOpen }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const n = Math.min(Math.max(limit ?? 100, 1), ALARM_LIMIT);
    const rows = await ctx.db
      .query("alarms")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(n);
    return onlyOpen ? rows.filter((row) => row.ackAt === undefined) : rows;
  },
});

export const ackAlarm = mutation({
  args: { id: v.id("alarms") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;
    await ctx.db.patch(id, { ackAt: Date.now() });
    return id;
  },
});

export const ackAllAlarms = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const rows = await ctx.db
      .query("alarms")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(ALARM_LIMIT);
    const now = Date.now();
    let acked = 0;
    for (const row of rows) {
      if (row.ackAt !== undefined) continue;
      await ctx.db.patch(row._id, { ackAt: now });
      acked += 1;
    }
    return acked;
  },
});

/** Wipe this user's alarm history. */
export const clearAlarms = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const rows = await ctx.db
      .query("alarms")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .take(ALARM_LIMIT);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

/* ── dayparting schedules ───────────────────────────────────────────────── */

export const listSchedules = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("schedules")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);
    return rows.sort((a, b) => a.startMin - b.startMin || a.name.localeCompare(b.name));
  },
});

export const saveSchedule = mutation({
  args: {
    id: v.optional(v.id("schedules")),
    name: v.string(),
    days: v.array(v.number()),
    startMin: v.number(),
    endMin: v.number(),
    presetName: v.string(),
    params: v.any(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const name = args.name.trim().slice(0, 80);
    const presetName = args.presetName.trim().slice(0, 80);
    if (!name) throw new Error("Schedule name is required");
    if (!presetName) throw new Error("Pick a preset for the slot");
    if (args.days.length === 0) throw new Error("Pick at least one day");
    const startMin = Math.min(Math.max(Math.round(args.startMin), 0), 1439);
    const endMin = Math.min(Math.max(Math.round(args.endMin), 0), 1439);
    const patch = {
      name,
      days: Array.from(new Set(args.days.map((d) => Math.min(Math.max(Math.round(d), 0), 6)))),
      startMin,
      endMin,
      presetName,
      params: args.params,
      enabled: args.enabled,
      updatedAt: Date.now(),
    };
    if (args.id) {
      const existing = await ctx.db.get(args.id);
      if (!existing || existing.userId !== userId) throw new Error("Not found");
      await ctx.db.patch(args.id, patch);
      return args.id;
    }
    return await ctx.db.insert("schedules", { userId, ...patch });
  },
});

export const removeSchedule = mutation({
  args: { id: v.id("schedules") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;
    await ctx.db.delete(id);
    return id;
  },
});

export const setScheduleEnabled = mutation({
  args: { id: v.id("schedules"), enabled: v.boolean() },
  handler: async (ctx, { id, enabled }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;
    await ctx.db.patch(id, { enabled, updatedAt: Date.now() });
    return id;
  },
});

/* ── multi-station registry ─────────────────────────────────────────────── */

export const listStations = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("stations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);
    return rows.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  },
});

/** Register this console as a station and mint its reporting token. */
export const registerStation = mutation({
  args: {
    name: v.string(),
    token: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const name = args.name.trim().slice(0, 80);
    if (!name) throw new Error("Station name is required");
    const token = args.token.trim();
    if (token.length < 16) throw new Error("Reporting token is too short");
    const existing = await ctx.db
      .query("stations")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { name, note: args.note, userId });
      return existing._id;
    }
    return await ctx.db.insert("stations", {
      userId,
      stationId: `st_${token.slice(0, 8)}`,
      name,
      token,
      note: args.note,
      lastSeenAt: 0,
      onAir: false,
    });
  },
});

export const removeStation = mutation({
  args: { id: v.id("stations") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) return null;
    await ctx.db.delete(id);
    return id;
  },
});

/** Heartbeat for a console signed in to this deployment. */
export const reportStation = mutation({
  args: {
    stationId: v.string(),
    onAir: v.boolean(),
    presetName: v.optional(v.string()),
    lufs: v.optional(v.number()),
    truePeakDb: v.optional(v.number()),
    modPct: v.optional(v.number()),
    openAlarms: v.optional(v.number()),
    version: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const rows = await ctx.db
      .query("stations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(50);
    const row = rows.find((r) => r.stationId === args.stationId) ?? rows[0];
    if (!row) throw new Error("Register this station first");
    await ctx.db.patch(row._id, {
      lastSeenAt: Date.now(),
      onAir: args.onAir,
      presetName: args.presetName,
      lufs: args.lufs,
      truePeakDb: args.truePeakDb,
      modPct: args.modPct,
      openAlarms: args.openAlarms,
      version: args.version,
    });
    return row._id;
  },
});

/**
 * Token heartbeat — used by the standalone/desktop agent over HTTP, which has
 * no signed-in Convex session. Called by convex/http.ts, never by a client.
 */
export const reportByToken = internalMutation({
  args: {
    token: v.string(),
    onAir: v.boolean(),
    presetName: v.optional(v.string()),
    lufs: v.optional(v.number()),
    truePeakDb: v.optional(v.number()),
    modPct: v.optional(v.number()),
    openAlarms: v.optional(v.number()),
    version: v.optional(v.string()),
    alarms: v.optional(
      v.array(
        v.object({
          kind: v.string(),
          severity: severityValidator,
          title: v.string(),
          detail: v.optional(v.string()),
          at: v.number(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const station = await ctx.db
      .query("stations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
    if (!station) return { ok: false as const, reason: "unknown token" };

    await ctx.db.patch(station._id, {
      lastSeenAt: Date.now(),
      onAir: args.onAir,
      presetName: args.presetName,
      lufs: args.lufs,
      truePeakDb: args.truePeakDb,
      modPct: args.modPct,
      openAlarms: args.openAlarms,
      version: args.version,
    });

    // Remote alarms land in the same history the console writes to, tagged
    // with the station id so the operator can see which site raised them.
    let ingested = 0;
    for (const alarm of args.alarms ?? []) {
      await ctx.db.insert("alarms", {
        userId: station.userId,
        kind: alarm.kind,
        severity: alarm.severity,
        title: alarm.title,
        detail: alarm.detail,
        at: alarm.at,
        source: station.name,
      });
      ingested += 1;
    }
    if (ingested > 0) await pruneAlarms(ctx, station.userId, Date.now());

    return { ok: true as const, station: station.name, ingested };
  },
});
