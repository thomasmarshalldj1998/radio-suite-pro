/** Shared record shapes for the pluggable backend (cloud or local).
 *
 * The console only needs four things persisted — the preset library, the
 * broadcast log, the stream mount configuration and the operator session.
 * `src/lib/backend/index.ts` binds these to the Convex deployment when one is
 * configured (web build) or to device-local storage (standalone desktop
 * build), so every panel talks to one interface either way.
 */
import type { MountForm } from "@/lib/audio/outputs";

export type LogKind =
  | "session"
  | "metadata"
  | "config"
  | "preset"
  | "error"
  | "warn";

export interface PresetRecord {
  _id: string;
  name: string;
  description?: string;
  params: unknown;
  _creationTime: number;
}

export interface LogRecord {
  _id: string;
  kind: LogKind;
  title: string;
  detail?: string;
  at: number;
}

/** The saved stream configuration plus the last metadata sent to listeners. */
export interface MountRecord extends MountForm {
  nowPlayingTitle?: string;
  nowPlayingArtist?: string;
  updatedAt?: number;
}

export interface LogPush {
  kind: LogKind;
  title: string;
  detail?: string;
  meta?: unknown;
}

/** What `useAuth()` hands every consumer, regardless of backend. */
export interface Session {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: { name?: string } | null;
  signIn: (flow: string, formData?: FormData) => Promise<unknown>;
  signOut: () => Promise<unknown>;
}

export type ConnectionState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "local";
