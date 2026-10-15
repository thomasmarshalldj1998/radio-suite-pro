/** Cloud binding — wraps the Convex queries/mutations the console uses and
 * exposes them through the shared `Backend` shape. Only mounted on web
 * builds with a deployment configured.
 */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  useConvexAuth,
  useConvexConnectionState,
  useMutation,
  useQuery,
} from "convex/react";
import { useMemo, type ReactNode } from "react";
import type { Backend } from "./context";
import { BackendContext } from "./context";
import type { LogPush, MountRecord } from "./types";

export function CloudBackendProvider({
  children,
}: {
  children: ReactNode;
}) {
  const presets = useQuery(api.presets.list);
  const savePresetMut = useMutation(api.presets.save);
  const removePresetMut = useMutation(api.presets.remove);

  const logQuery = useQuery(api.stations.listLog, { limit: 200 });
  const pushLogMut = useMutation(api.stations.pushLog);

  const mountDoc = useQuery(api.stations.getMount);
  const saveMountMut = useMutation(api.stations.saveMount);
  const setNowPlayingMut = useMutation(api.stations.setNowPlaying);

  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.currentUser);
  const { signIn, signOut } = useAuthActions();

  const conn = useConvexConnectionState();

  const value = useMemo<Backend>(
    () => ({
      presets,
      savePreset: (args) => savePresetMut(args),
      removePreset: async (id) => {
        await removePresetMut({ id: id as Id<"presets"> });
      },

      log: logQuery,
      pushLog: (args: LogPush) => pushLogMut(args),

      mount: mountDoc
        ? ({
            name: mountDoc.name,
            protocol: mountDoc.protocol,
            server: mountDoc.server,
            port: mountDoc.port,
            mount: mountDoc.mount,
            username: mountDoc.username,
            password: mountDoc.password,
            codec: mountDoc.codec,
            bitrateKbps: mountDoc.bitrateKbps,
            sampleRateKhz: mountDoc.sampleRateKhz,
            channels: mountDoc.channels,
            targetFormat: mountDoc.targetFormat ?? "",
            nowPlayingTitle: mountDoc.nowPlayingTitle,
            nowPlayingArtist: mountDoc.nowPlayingArtist,
            updatedAt: mountDoc.updatedAt,
          } satisfies MountRecord)
        : (mountDoc ?? null),
      saveMount: (args: MountRecord) =>
        saveMountMut({
          name: args.name,
          protocol: args.protocol,
          server: args.server,
          port: args.port,
          mount: args.mount,
          username: args.username,
          password: args.password,
          codec: args.codec,
          bitrateKbps: args.bitrateKbps,
          sampleRateKhz: args.sampleRateKhz,
          channels: args.channels,
          targetFormat: args.targetFormat || undefined,
        }),
      setNowPlaying: async (title, artist) => {
        await setNowPlayingMut({ title, artist });
      },

      session: {
        isLoading: authLoading || user === undefined,
        isAuthenticated,
        user: user ?? null,
        signIn: signIn as Backend["session"]["signIn"],
        signOut: signOut as Backend["session"]["signOut"],
      },
      connection: conn.isWebSocketConnected
        ? "connected"
        : conn.hasEverConnected
          ? "connecting"
          : "disconnected",
    }),
    [
      presets,
      savePresetMut,
      removePresetMut,
      logQuery,
      pushLogMut,
      mountDoc,
      saveMountMut,
      setNowPlayingMut,
      authLoading,
      isAuthenticated,
      user,
      signIn,
      signOut,
      conn,
    ],
  );

  return (
    <BackendContext.Provider value={value}>{children}</BackendContext.Provider>
  );
}
