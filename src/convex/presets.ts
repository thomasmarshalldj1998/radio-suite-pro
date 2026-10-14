import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** List the signed-in user's saved processor presets. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("presets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

/**
 * Server-side preset validation — runs before anything is written so the
 * database only ever holds well-formed parameter payloads, regardless of
 * what a client sends. Errors are client-safe messages (no internals).
 */
function validateParams(params: unknown): void {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid preset: params must be an object");
  }
  const json = JSON.stringify(params);
  if (json.length > 200_000) {
    throw new Error("Invalid preset: params payload is too large");
  }
  const ranges: Record<string, [number, number]> = {
    inputGainDb: [-48, 48],
    outputGainDb: [-48, 48],
    monitorDb: [-80, 6],
    ceilingDb: [-12, 0],
    targetLufs: [-40, -5],
    width: [0, 4],
    ratio: [1, 32],
    freqHz: [20, 24000],
    freq: [20, 24000],
    splitsHz: [20, 24000],
  };
  const errors: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 8) {
      errors.push(`${path}: nested too deeply`);
      return;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) errors.push(`${path}: not a finite number`);
      const key = path.split(".").pop() ?? "";
      const r = ranges[key];
      if (r && (v < r[0] || v > r[1])) {
        errors.push(`${path}: ${v} outside ${r[0]}…${r[1]}`);
      }
      return;
    }
    if (typeof v === "string") {
      if (v.length > 400) errors.push(`${path}: string too long`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > 64) errors.push(`${path}: array too long`);
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        walk(child, path ? `${path}.${k}` : k, depth + 1);
      }
      return;
    }
    if (typeof v === "boolean" || v === null || v === undefined) return;
    errors.push(`${path}: unsupported value type`);
  };
  walk(params, "", 0);
  if (errors.length > 0) {
    throw new Error(`Invalid preset params: ${errors.slice(0, 3).join(", ")}`);
  }
}

/** Save the current processor chain under a name (upserts by name). */
export const save = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    params: v.any(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const name = args.name.trim().slice(0, 80);
    if (!name) throw new Error("Preset name is required");
    validateParams(args.params);

    const existing = await ctx.db
      .query("presets")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const match = existing.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );

    if (match) {
      await ctx.db.patch(match._id, {
        name,
        description: args.description?.trim().slice(0, 280) || undefined,
        params: args.params,
      });
      return match._id;
    }
    return await ctx.db.insert("presets", {
      userId,
      name,
      description: args.description?.trim().slice(0, 280) || undefined,
      params: args.params,
    });
  },
});

/** Delete one of the user's presets. */
export const remove = mutation({
  args: { id: v.id("presets") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const doc = await ctx.db.get(id);
    if (!doc || doc.userId !== userId) throw new Error("Preset not found");
    await ctx.db.delete(id);
  },
});
