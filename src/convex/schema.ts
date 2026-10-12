import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";



// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

/** Stream encoder mount configuration (Icecast / Shoutcast source endpoint). */
export const mountValidator = {
  userId: v.id("users"),
  name: v.string(),
  protocol: v.string(), // "icecast2" | "shoutcast"
  server: v.string(),
  port: v.number(),
  mount: v.string(),
  username: v.string(),
  password: v.string(),
  codec: v.string(), // "opus" | "aac" | ...
  bitrateKbps: v.number(),
  sampleRateKhz: v.number(), // 44.1 | 48
  channels: v.string(), // "stereo" | "mono"
  nowPlayingTitle: v.optional(v.string()),
  nowPlayingArtist: v.optional(v.string()),
  updatedAt: v.number(),
};

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // saved processor-chain presets (full parameter snapshots)
    presets: defineTable({
      userId: v.id("users"),
      name: v.string(),
      description: v.optional(v.string()),
      params: v.any(), // ProcessorParams snapshot
    }).index("by_user", ["userId"]),

    // stream encoder mount configuration (one per user)
    mounts: defineTable(mountValidator).index("by_user", ["userId"]),

    // broadcast log: sessions, metadata updates, config changes
    broadcastLog: defineTable({
      userId: v.id("users"),
      kind: v.union(
        v.literal("session"),
        v.literal("metadata"),
        v.literal("config"),
        v.literal("preset"),
      ),
      title: v.string(),
      detail: v.optional(v.string()),
      at: v.number(),
      meta: v.optional(v.any()),
    }).index("by_user_time", ["userId", "at"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
