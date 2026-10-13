import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const mountArgs = {
  name: v.string(),
  protocol: v.string(),
  server: v.string(),
  port: v.number(),
  mount: v.string(),
  username: v.string(),
  password: v.string(),
  codec: v.string(),
  bitrateKbps: v.number(),
  sampleRateKhz: v.number(),
  channels: v.string(),
  targetFormat: v.optional(v.string()),
};

/** Load the signed-in user's stream mount configuration. */
export const getMount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const doc = await ctx.db
      .query("mounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return doc;
  },
});

/** Create or update the stream mount configuration. */
export const saveMount = mutation({
  args: mountArgs,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("mounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt });
      return existing._id;
    }
    return await ctx.db.insert("mounts", { userId, ...args, updatedAt });
  },
});

/** Update the now-playing metadata sent to listeners + log it. */
export const setNowPlaying = mutation({
  args: {
    title: v.string(),
    artist: v.optional(v.string()),
  },
  handler: async (ctx, { title, artist }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const updatedAt = Date.now();

    const mount = await ctx.db
      .query("mounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (mount) {
      await ctx.db.patch(mount._id, {
        nowPlayingTitle: title,
        nowPlayingArtist: artist || undefined,
        updatedAt,
      });
    }
    await ctx.db.insert("broadcastLog", {
      userId,
      kind: "metadata",
      title: artist ? `${artist} — ${title}` : title,
      detail: "Now-playing metadata sent to listeners",
      at: updatedAt,
    });
  },
});

/** Append an entry to the broadcast log (sessions, config, presets). */
export const pushLog = mutation({
  args: {
    kind: v.union(
      v.literal("session"),
      v.literal("metadata"),
      v.literal("config"),
      v.literal("preset"),
    ),
    title: v.string(),
    detail: v.optional(v.string()),
    meta: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    return await ctx.db.insert("broadcastLog", {
      userId,
      kind: args.kind,
      title: args.title,
      detail: args.detail,
      meta: args.meta,
      at: Date.now(),
    });
  },
});

/** Recent broadcast log entries, newest first. */
export const listLog = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const n = Math.min(Math.max(limit ?? 50, 1), 200);
    return await ctx.db
      .query("broadcastLog")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(n);
  },
});
