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
  // optional second mount on the same server, used when the primary keeps
  // refusing the source (dual-mount failover)
  backupMount: v.optional(v.string()),
  username: v.string(),
  password: v.string(),
  codec: v.string(), // "opus" | "aac" | ...
  bitrateKbps: v.number(),
  sampleRateKhz: v.number(), // 44.1 | 48
  channels: v.string(), // "stereo" | "mono"
  // full delivery-matrix profile the mount targets, e.g.
  // "MP3 @ 128 kbps (44.1 kHz, Joint Stereo)" — used when the target
  // format needs a transcoder relay
  targetFormat: v.optional(v.string()),
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
        v.literal("error"),
        v.literal("warn"),
      ),
      title: v.string(),
      detail: v.optional(v.string()),
      at: v.number(),
      meta: v.optional(v.any()),
    }).index("by_user_time", ["userId", "at"]),

    // durable alarm history — the console's tolerance watchdog (peak, clip,
    // loudness, correlation, overmodulation, dead air, failover, RDS) writes
    // here so a 3 a.m. event survives the session and can be acknowledged.
    alarms: defineTable({
      userId: v.id("users"),
      kind: v.string(),
      severity: v.union(
        v.literal("critical"),
        v.literal("warning"),
        v.literal("info"),
      ),
      title: v.string(),
      detail: v.optional(v.string()),
      at: v.number(),
      ackAt: v.optional(v.number()),
      /** "console" for this app, or a station id when reported remotely. */
      source: v.optional(v.string()),
    }).index("by_user_time", ["userId", "at"]),

    // dayparting — preset snapshots switched by day-of-week + time of day
    schedules: defineTable({
      userId: v.id("users"),
      name: v.string(),
      /** 0 = Sunday … 6 = Saturday */
      days: v.array(v.number()),
      /** minutes past local midnight */
      startMin: v.number(),
      endMin: v.number(),
      presetName: v.string(),
      /** full ProcessorParams snapshot, so a slot is self-contained */
      params: v.any(),
      enabled: v.boolean(),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // remote console — one row per reporting station
    stations: defineTable({
      userId: v.id("users"),
      stationId: v.string(),
      name: v.string(),
      /** Shared secret the station agent posts with (see convex/http.ts). */
      token: v.string(),
      lastSeenAt: v.number(),
      onAir: v.boolean(),
      presetName: v.optional(v.string()),
      lufs: v.optional(v.number()),
      truePeakDb: v.optional(v.number()),
      modPct: v.optional(v.number()),
      openAlarms: v.optional(v.number()),
      version: v.optional(v.string()),
      note: v.optional(v.string()),
    })
      .index("by_user", ["userId"])
      .index("by_token", ["token"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
