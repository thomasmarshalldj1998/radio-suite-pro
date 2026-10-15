/** Public entry point for the pluggable backend.
 *
 * `main.tsx` mounts `BackendProvider` (cloud or local binding) once; every
 * panel consumes `@/lib/backend/hooks`. Nothing else should import
 * `convex/react` for console data.
 */
export {
  BackendContext,
  CLOUD_ENABLED,
  IS_DESKTOP,
  type Backend,
} from "./context";
export { CloudBackendProvider } from "./cloud-provider";
export { LocalBackendProvider } from "./local-provider";
