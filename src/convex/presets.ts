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
