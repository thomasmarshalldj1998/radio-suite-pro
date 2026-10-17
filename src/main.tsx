import { Toaster } from "@/components/ui/sonner";
import { AudioSync } from "@/components/console/AudioSync";
import { AudioWakeBanner } from "@/components/console/AudioWakeBanner";
import { RequireAuth } from "@/components/RequireAuth";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import {
  CLOUD_ENABLED,
  CloudBackendProvider,
  IS_DESKTOP,
  LocalBackendProvider,
} from "@/lib/backend";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Studio = lazy(() => import("./pages/Studio.tsx"));
const Devices = lazy(() => import("./pages/Devices.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in the browser runtime). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[Preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Cloud client — only constructed when a Convex deployment backs this
 * build. The standalone desktop package runs the local binding instead.
 */
const convex = CLOUD_ENABLED
  ? new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string)
  : null;



function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}


/** App routes + toaster — mounted under whichever backend binding applies.
 *
 * Desktop uses HashRouter: on the app:// scheme BrowserRouter paths like
 * /dashboard or /index.html can land on the "*" NotFound route (blank 404)
 * depending on the initial URL and history handling. Hash routes
 * (#/dashboard) never hit the protocol handler, so the console always
 * boots to index.html once and routes client-side from there.
 */
function AppTree() {
  const Router = IS_DESKTOP ? HashRouter : BrowserRouter;
  return (
    <>
      <AudioSync />
      <AudioWakeBanner />
      <Router>
        <RouteSyncer />
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route
              path="/"
              element={
                IS_DESKTOP ? <Navigate to="/dashboard" replace /> : <Landing />
              }
            />
            {/* Old desktop shells loaded app://…/index.html directly — treat
                it as root so they redirect instead of hitting NotFound. */}
            <Route
              path="/index.html"
              element={
                IS_DESKTOP ? (
                  <Navigate to="/dashboard" replace />
                ) : (
                  <Landing />
                )
              }
            />
            <Route
              path="/auth"
              element={<AuthPage redirectAfterAuth="/dashboard" />}
            />
            <Route
              path="/dashboard"
              element={
                <RequireAuth>
                  <Dashboard />
                </RequireAuth>
              }
            />
            <Route path="/studio" element={<Studio />} />
            {/* Desktop satellite window (Audio → Audio Devices…) and fallback. */}
            <Route path="/devices" element={<Devices />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </Router>
      <Toaster />
    </>
  );
}

/**
 * Provider wiring: cloud binding needs the Convex client in the tree (auth
 * + queries); local binding needs nothing but device storage. The desktop
 * package always takes the local branch and never loads the Freebuff
 * preview toolbar.
 */
function BoundTree({ children }: { children: React.ReactNode }) {
  if (convex) {
    return (
      <ConvexAuthProvider client={convex}>
        <CloudBackendProvider>{children}</CloudBackendProvider>
      </ConvexAuthProvider>
    );
  }
  return <LocalBackendProvider>{children}</LocalBackendProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      {!IS_DESKTOP && (
        <ToolbarErrorBoundary>
          <VlyToolbar />
        </ToolbarErrorBoundary>
      )}
      <BoundTree>
        <AppTree />
      </BoundTree>
    </RootErrorBoundary>
  </StrictMode>,
);
