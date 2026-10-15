/** Operator session hook — delegates to the pluggable backend, so the
 * console works signed-in through Convex on the web build and as the local
 * operator in the standalone desktop package.
 */
import { useSession } from "@/lib/backend/hooks";

export function useAuth() {
  return useSession();
}
