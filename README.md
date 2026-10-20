## Overview

This project uses the following tech stack:
- Vite
- Typescript
- React Router v7 (all imports from `react-router` instead of `react-router-dom`)
- React 19 (for frontend components)
- Tailwind v4 (for styling)
- Shadcn UI (for UI components library)
- Lucide Icons (for icons)
- Convex (for backend & database)
- Convex Auth (for authentication)
- Framer Motion (for animations)
- Three js (for 3d models)

All relevant files live in the 'src' directory.

Use bun for the package manager.

## Setup

This project is set up already and running on a cloud environment, as well as a convex development in the sandbox.

## Environment Variables

The project is set up with project specific CONVEX_DEPLOYMENT and VITE_CONVEX_URL environment variables on the client side.

The convex server has a separate set of environment variables that are accessible by the convex backend.

Currently, these variables include auth-specific keys: JWKS, JWT_PRIVATE_KEY, and SITE_URL.

## Studio workspace (`/studio`)

`src/pages/Studio.tsx` is a self-contained broadcast processor surface: one
file holds the rack styling, the Web Audio graph, the demo program generator,
the meters and the scopes. It is reachable from the landing-page nav or
directly at `/studio`, and starts on a click because browsers only allow audio
after a gesture.

- **Signal path** — INPUT → PREAMP → DE-CLIPPER → AGC → SUB-BASS → DYN-EQ →
  MULTIBAND (5) → TRANSIENT SNAP → LIMITER → OUTPUT, shown as a numbered ribbon
  and wired in exactly that order. The AGC is the only macro leveler ahead of
  the band split, so the five lanes always start from a controlled level.
- **Delivery targets** — −14.0 LUFS (AES71 web default), −16.0 LUFS
  (podcast) and −23.0 LUFS (EBU R128). The optional slow servo trims the gain
  into the limiter toward the selected target.
- **Restoration** — de-clipper with 0…+12 dB reconstruction drive, threshold
  and dry/wet, using a 4× oversampled concave peak-rebuild curve.
- **Sub-harmonic synth** — pitch-tracked octave-down sine plus upper harmonics
  (small-speaker bass), 0…100 % drive, 30–60 Hz cutoff.
- **Transient snap** — 0…+6 dB attack boost and sensitivity on a high-band
  parallel path ahead of the limiter.
- **Telemetry** — vector scope (L vs R, three trace colours, −1…+1 correlation)
  and a rolling 60 s LUFS chart for momentary, short-term and integrated
  loudness against the target, plus a three-second silence-gate banner.
- **Workflow** — A/B morph (0–100 % interpolation of every numeric parameter),
  preset library, and auto-speech sensing that switches the AGC and all five
  band compressors to a faster profile while voice is detected.
- **Stream TX (source uplink)** — the encoder's container bytes are pushed to
  a real Icecast/SHOUTcast source socket: `PUT /<mount>` with Basic auth,
  `Ice-Name`/`Ice-Bitrate` headers and `icy-metaint` ICY metadata framing
  (`StreamTitle='…'`, re-sent automatically after a reconnect). Encoded
  chunks reach the socket through `onChunk` on every encoder (MediaRecorder,
  the WASM workers and the MPX FLAC feed). In the desktop build the socket
  lives in `electron/stream-source.cjs` behind the `signalpath.stream`
  bridge, because a browser `PUT` with an Authorization header cannot pass an
  Icecast CORS preflight; the web build falls back to a streaming `fetch`
  body where the server allows it. Drops reconnect with exponential backoff
  (1 s → 30 s), audio produced while offline is discarded rather than queued,
  and the deck reports live / retrying / local-only plus bytes sent and
  dropped. Containers Icecast cannot take (M4A/WebM) record locally and say so
  instead of pretending to be on air.
- **Streaming & automation** — codec preview through MP3 64/128/320, AAC-HE 64k
  and Opus 96k (band-limited monitor plus a 3.2 ms pre-echo comb), with
  auto-codec HF compensation that limits the top band harder and backs off the
  HF shelf as the bitrate falls; a voice-duck sidechain (depth, recovery time,
  manual mic switch or the voice detector) that drops the bed and a 260 Hz
  low-mid shelf; a metadata preset trigger that reads `[EDM]`, `genre=hiphop`
  or `#talk` and shifts the tone tilt and band thresholds; a five-second
  silence backup that crossfades to a standby loop and returns after two
  seconds of healthy programme; and a low-latency talent monitor that feeds
  the headphones from before the limiter, with a soft clip as its only guard.

The DSP helpers and the engine class are exported so the verification scripts
drive the real implementation rather than a copy:

```bash
bun scripts/verify-studio-render.ts  # SSR markup: chain order, meters, tabs, targets
bun scripts/verify-studio-dsp.ts     # morph, de-clipper curve, loudness gating, pitch, correlation
bun scripts/verify-studio-engine.ts  # headless graph build + a finite measurement frame
```

## Broadcast processing tools

The console chain (`src/lib/audio/engine.ts`, surfaced in `ProcessingTab`,
`InputTab` and the meter bridge) carries four operator tools on top of the
EQ → AGC → multiband → limiter chain. Their control maths is pure and lives
in `src/lib/audio/tools.ts`, so it is verified without a browser:
`bun scripts/verify-core-tools.ts`.

The engine is split by responsibility: `src/lib/audio/devices.ts`
(enumeration, saved picks, virtual-endpoint and feedback detection),
`src/lib/audio/measure.ts` (peak, true peak, BS.1770 loudness and its gating)
and `engine.ts` (the graph, the program sources and the meter control loop).
That leaves three invariants the engine enforces, each covered by a suite:

- **One program source at a time.** Arming a microphone, selecting the
generator or loading a file stops and releases the other two, so a mic is
never mixed with the test tone — and arming a mic makes it the source instead
of leaving the generator on air.
- **Power cycling restores the source.** Stop → Start rebuilds the selected
source (or re-arms the saved mic once the OS already allows it) instead of
coming back up "running" with silence. Power-off releases the capture track.
- **Two channels on the program bus.** A mono interface or mono file is
up-mixed at the bus, so the right meter, the correlation readout and the M/S
matrix do not silently lose half the programme.

```bash
bun scripts/verify-audio-sources.ts   # source routing, arming, power cycling, 2-channel bus
bun scripts/verify-audio-measure.ts   # peaks/true peak/LUFS/LRA + device listing and saved picks
bun scripts/verify-audio-devices.ts   # device selection, hot-swap, sink fallback
bun scripts/verify-processing-extras.ts  # loudness standards/CSV, limiter envelopes, width, M/S, monitor checks
```

- **Dual-window AGC** — `agc.fast`. The leveller's slow window
  (`thresholdDb`, `ratio`, `attackMs`, `releaseMs`) rides long-term level,
  while an optional fast peak window with its own threshold, ratio and
  short release sits ahead of it and catches transients the long release
  would let through. Both windows are summed on the AGC meter, and the fast
  window's own reduction is reported separately (`gr.agcFast`). It ships
  bypassed (ratio 1 = unity), so every existing preset sounds unchanged.
- **Window gate (AGC)** — `agc.windowDb`, 0–9 dB (0 = off). While the
  programme's peak-to-trough spread over the last 1.5 s stays inside the
  window, the AGC gain is held instead of re-ridden, so quiet intros and
  speech pauses cannot pump the noise floor up. A 35 % release band stops it
  chattering on a level that sits on the edge. The AGC card shows a **Hold**
  badge while the gain is frozen.
- **Phase rotator (allpass)** — `phase.on`. Four staggered allpass stages
  (0.5× / 0.75× / 1× / 1.5× of the tuning frequency, 150/225/300/450 Hz at the
  voice default) rotate phase without touching magnitude, making
  asymmetrical vocal waveforms symmetrical so the limiter meets the same peak
  from either polarity. Toggle it from the input stage or the preamp strip in
  `InputTab`.
- **Less–More density macro** — `density`, 1–10 (5 = neutral). One control
  scales every multiband ratio (×0.68…×1.4), their attack/release times
  (×1.28…×0.65) and the drive into the final limiter (−1.2…+1.5 dB). The
  limiter ceiling never moves, so "more" raises average density without
  spending true-peak headroom. It lives on the meter bridge, always visible.
- **De-esser** — `deess`, a dynamic band cut ahead of the limiter. Tuning is
  clamped to 5–10 kHz (default 7.5 kHz); a fast detector (1 ms attack, 60 ms
  release) subtracts up to `maxCutDb` of the band, so sibilance is tamed
  before the final stage sees it rather than after it has already squashed
  the programme.
- **Dual-stage limiter** — `limiter.program`. The fast peak stage catches
  transients; a slow program stage with its own ceiling and release rides the
  short-term level. `limiter.adaptive` scales both releases from the live
  crest factor (faster on percussion, smoother on sustained music) and
  `limiter.holdMs` freezes the release for 20–200 ms after a real reduction so
  short peaks cannot breathe. Both stages sit ahead of the soft clipper and
  the ceiling guard.
- **True-peak oversampling** — `limiter.truePeakX`, 2× / 4× / 8×. 8× resolves
  the shallow inter-sample crests a lossy encoder reconstructs; the meter
  interpolates the signed waveform at every sample, so a steady tone cannot
  hide a crest between the samples it skips.
- **Per-band width + M/S trim** — `psy.cohWidth` splits only the side channel
  into five bands (bass-to-mono while the air band widens), with widening
  scaled back as correlation falls so a hollow image is never made worse.
  `psy.msTrim` trims mid/side balance and high-passes the side channel.
- **Bass enhancement** — `psy.bassSynth`. Harmonics are generated from the
  programme's own low band and mixed back in parallel: no delayed copy and no
  allpass network, so the low end keeps its transient shape.
- **Monitor checks** — `monitor.mono` / `monitor.invertL` / `monitor.invertR`
  fold the monitor to mono and flip either channel's polarity. They are
  monitor-path only (the encoder send is tapped upstream), and the Input tab
  draws the last two minutes of correlation beside them.
- **Loudness compliance** — `loudness.standard` picks EBU R128 (−23), R128 s1
  (−16), ATSC A/85 (−24), Spotify (−14), Apple Music (−16) or a custom target.
  One picker drives the rider (via loudness lock), the meter bridge target and
  the compliance verdict; Telemetry exports the session log as a CSV report
  with the station, preset, target, deviation and true peak per second.

### Peak stage, mount failover and batch delivery

- **Worklet limiter** — `limiter.engine` (Limiter → Engine). `worklet` runs a
  sample-accurate lookahead brickwall on the audio thread: the gain target for
  every sample is the minimum over the coming lookahead window, so the gain is
  already down when a transient arrives and no sample leaves above the
  ceiling. The native compressor path stays wired; switching is a crossfade,
  and a platform without AudioWorklet falls back to it automatically (the
  panel reads `Worklet unavailable · running native`). The kernel in
  `src/lib/audio/limiter.ts` is stringified into the worklet module, so the
  audio thread runs the same code the suite tests.
- **Dual-mount failover** — an optional **Backup mount** on the mount
  configuration. After two failed source attempts the client rotates to the
  backup mount and keeps retrying with backoff; once the backup has been live
  for five minutes the next reconnect tries the primary again, dropping
  straight back if it is still refusing sources. The mount panel shows which
  mount is in use and how many automatic switches have happened.
- **Batch delivery** — the **Batch** page normalises a queue of local files
  offline: BS.1770 K-weighted loudness to a published target, the same
  lookahead limiter at the target's true-peak ceiling, and 16-bit WAV output.
  Nothing is uploaded and live metering is untouched.

```bash
bun scripts/verify-delivery.ts  # limiter kernel + running worklet, mount routing, batch loudness/WAV
```

## Desktop App (Windows, macOS, Linux)

The whole console also ships as a standalone desktop package built with
[Electron](https://electronjs.org) + [electron-builder](https://electron.build).
The desktop build is **fully offline**: presets, the broadcast log, the stream
mount configuration and the operator session persist on-device (localStorage)
through the pluggable backend in `src/lib/backend/`, and no Convex client is
constructed. The web build keeps the cloud binding (accounts + sync) exactly as
before.

### Build installers

```bash
bun install              # installs electron + electron-builder (dev deps)
bun run desktop:icon     # regenerates build/icon.png from the logo geometry

bun run desktop:build:linux   # AppImage + .deb   → release/
bun run desktop:build:win     # NSIS installer    → release/  (run on Windows)
bun run desktop:build:mac     # DMG + zip         → release/  (run on macOS)
bun run desktop:build         # current platform's default targets
```

Cross-build notes:
- Linux targets (AppImage, deb) build on Linux; deb additionally needs
  `binutils` (`ar`) and `xz-utils` — both preinstalled on normal desktops and
  CI runners.
- The Windows NSIS installer builds natively on Windows; building it from
  Linux requires `wine` for the final NSIS link step.
- macOS targets must be built on macOS. Code signing is disabled by default
  (`mac.identity: null` in `electron-builder.yml`) — remove that line and set
  `CSC_LINK`/`CSC_KEY_PATH` to sign and notarize.

### How the desktop build differs from the web build

- `vite.desktop.config.ts` compiles with `VITE_APP_MODE=desktop` and an empty
  `VITE_CONVEX_URL`, which flips `src/lib/backend/context.ts` to the
  device-local binding and compiles out the Freebuff preview toolbar.
- `electron/main.cjs` serves `dist-desktop/` through a custom `app://`
  scheme (standard + secure) so BrowserRouter deep links, ES-module workers,
  the WASM codecs and the audio worklet all behave exactly like they do over
  http.
- The app opens straight on the console (`/` → `/dashboard`); the marketing
  landing page and the sign-in page remain web-only.
- Media/fullscreen permissions are granted in the main process; microphone
  use is declared for macOS in `electron-builder.yml`.
- `electron/preload.cjs` exposes one narrow bridge, `window.signalpath.udp`,
  backed by `electron/udp-link.cjs`. It is what lets the composite-over-IP
  link put its packets on real UDP sockets; the browser build has no sockets
  and loops the framed stream back into its own receiver instead.

### Composite over IP (UDP)

The link carries the FM branch's 192 kHz composite as numbered datagrams —
28-byte header (magic, version, codec, link, sequence, timestamp, rate,
length, CRC-32) plus 16-bit PCM — one composite frame per packet, 187.5
packets/s, 3.07 Mbit/s per path.

Two independent paths are carried: each has its own destination and its own
listen port, each packet goes out on both with its own link number in the
header, and whatever arrives on a socket is decoded into the link receiver on
that path. A path that goes silent or crosses the loss/jitter thresholds is
spliced away without the composite ever stopping.

```
Link A  destination 192.0.2.10:9220   listen 9210
Link B  destination 192.0.2.11:9220   listen 9212
```

A datagram is 2076 bytes, so a path with a standard 1500-byte MTU will
fragment it — set the interface MTU to 2300 (or jumbo frames) end to end.
The kernel's receive buffer is the burst ceiling: the endpoint reports what it
was actually granted, and a default Linux buffer holds roughly 1.3 s of
composite.

Transport faults reach the durable alarm history through
`src/lib/audio/linkwatch.ts`: a path switch, both paths quiet long enough for
the splice to be running on its buffer, sustained loss or jitter on the serving
path, and a receiver that never locks to RDS. Each is edge-triggered and the
alarm store's per-kind cooldown stops a stuck fault from flooding the record.

**Latency, not bufferbloat.** Each path's jitter buffer tracks the measured
jitter instead of holding a fixed delay: it starts at 120 ms, rises at once
when the network gets spikier, decays 8 ms/s once it settles, and is clamped to
40–200 ms. No link may hold more than 240 ms of composite — past that the
oldest frames are skipped and counted as *Skipped*, not as loss — and a
consumer that went away for a moment is caught up to the live edge rather than
replaying the backlog it missed. The receiver is drained on its own 100 ms
timer, so closing the panel cannot let packets pile up, and the kernel receive
buffer is requested at 512 KiB (about 1.3 s of composite) rather than a
multi-second tail that would only ever add latency.

```bash
bun scripts/verify-bufferbloat.ts   # target adapts, ceiling holds, stall skips
```

**On compression.** The payload is uncompressed 16-bit PCM on purpose. A
general-purpose compressor is the wrong tool here — measured with
`CompressionStream("deflate-raw")` on a real composite frame it returns
1.00:1, because the multiplex is wideband and noise-like once programme and
RDS are in it. FLAC is the right codec (linear prediction on a smooth signal),
but no FLAC *decoder* is in the dependency set, so a receiver — including this
console's own decode path — could not read the stream back. A private codec
would compress but break interop with real exciters and STL receivers, which
expect PCM or FLAC. PCM at 3.07 Mbit/s per path is what those boxes accept, so
that is what goes on the wire.

```bash
bun scripts/verify-udp.ts           # real loopback sockets, both paths
bun scripts/verify-udp-renderer.ts  # renderer bridge wiring and attribution
```

### Receiving: decoding the composite

Receive mode does not just meter what arrives — `src/lib/audio/mpxdecode.ts`
demodulates it back into programme material:

- the 19 kHz pilot is recovered and used as the phase reference, exactly the
  way the generator derives its subcarriers (cos 2φ at 38 kHz, sin 3φ at
  57 kHz);
- the 38 kHz difference signal is mixed down, filtered to 15 kHz and matrixed
  with the main channel into left and right;
- the 57 kHz data subcarrier is mixed down, biphase-sliced, differentially
  decoded and block-synchronised against the RDS (26,16) code, which yields
  PI, PTY, the programme service name and RadioText from the wire;
- RadioText Plus (11A) is decoded too, so the artist and title come back as
  their own fields rather than one string.

Bit timing is not tracked with a loop. Both ends run off the same composite
sample clock, so the symbol grid is exact; only the phase is unknown, and a
splice shifts it by a fraction of a bit. Eight slicers are run at eighths of a
bit and the block layer picks the one whose 26-bit words satisfy the syndrome.

Cost is about 35 ms of CPU per second of received composite (≈3.5 % of one
core), and it only runs while Receive is on.

```bash
bun scripts/verify-link-content.ts  # programme content over real UDP + splice
```

That test is the proof the link carries content rather than samples: a tone on
each leg and a station name are generated into the composite, framed, sent over
two real UDP paths, spliced, and then recovered by the decoder — with a
quarter of path A removed, the receiver switches to B and the station name,
RadioText and both tones come back at their original levels and separation.

### Engine stability

- the graph runs with `latencyHint: "interactive"`; base and output latency are
  reported in **Telemetry → System health** beside the main-thread frame cost,
  so a growing device buffer is visible rather than guessed at;
- clock health is sampled once a second by comparing
  `AudioContext.currentTime` with wall time. Two consecutive seconds more than
  6 ms behind is a starved render thread: it is counted in **Clock stalls**,
  fires a critical *Audio thread starved* alarm into the durable history, and
  clears on the first healthy sample. A single bad second is deliberately not
  an episode;
- power-up fades the output bus in over ~8 ms and power-down fades it out
  before the context is suspended, so the transition is not a click on air;
- a context the platform suspends on its own (sleep, output-device change) is
  resumed immediately while the chain is powered;
- source changes go through the same 20 ms mute-fade, so switching input while
  on air does not click.

```bash
bun scripts/verify-glitch.ts        # hold time, no chatter, recovery
```

### Download links

The landing page (`src/pages/Landing.tsx`) has a **Download** section with a
per-platform installer link plus a link to all releases. Every URL derives
from one constant — `RELEASES_URL` in `src/lib/version.ts`. Point it at your
repository's releases page before publishing:

```ts
// src/lib/version.ts
export const RELEASES_URL = "https://github.com/<you>/<repo>/releases";
```

The artifact names are version-free (`Signalpath-Setup-x64.exe`,
`Signalpath-arm64-mac.dmg`, `Signalpath-x86_64.AppImage`,
`signalpath-amd64.deb`, …) so the `/releases/latest/download/…` URLs never
go stale between versions.

### CI

`.github/workflows/desktop-release.yml` builds all three platforms natively
(Ubuntu/Windows/macOS runners) on every `v*` tag, then publishes them all on
one GitHub Release (the `release` job). That is what the landing page's
download links resolve against. The same installers are also kept as workflow
artifacts for non-tag builds.

To test the build without cutting a release: **Actions → desktop-release →
Run workflow → `targets: linux`** (one cheap runner; `all` builds
Windows + macOS too).

**Never diagnose a red run with "Re-run jobs".** A re-run replays the *original
commit* of that run, so it can never pick up a later fix — it just goes red the
same way. Always start a **new** run (Run workflow, a fresh push, or a new
`v*` tag). Each run is labelled `desktop-release rev N` and its first step
prints the commit, ref, event, runner and toolchain (also on the run's Summary
tab), so you can confirm at a glance which revision and commit a run actually
used. When a packaging leg fails, its `electron-builder.log` is uploaded as a
`signalpath-<os>-logs` artifact.


# Using Authentication (Important!)

You must follow these conventions when using authentication.

## Auth is already set up.

All convex authentication functions are already set up. The auth currently uses email OTP and anonymous users, but can support more.

The email OTP configuration is defined in `src/convex/auth/emailOtp.ts`. DO NOT MODIFY THIS FILE.

Also, DO NOT MODIFY THESE AUTH FILES: `src/convex/auth.config.ts` and `src/convex/auth.ts`.

## Using Convex Auth on the backend

On the `src/convex/users.ts` file, you can use the `getCurrentUser` function to get the current user's data.

## Using Convex Auth on the frontend

The `/auth` page is already set up to use auth. Navigate to `/auth` for all log in / sign up sequences.

You MUST use this hook to get user data. Never do this yourself without the hook:
```typescript
import { useAuth } from "@/hooks/use-auth";

const { isLoading, isAuthenticated, user, signIn, signOut } = useAuth();
```

## Protected Routes

The starter `/dashboard` route is protected with `RequireAuth`. Extend that page
for the product's authenticated experience, and reuse `RequireAuth` when adding
another protected route — do NOT hand-roll a redirect to `/auth`, since landing
on a bare sign-in form with no explanation of what was blocked is confusing.

`RequireAuth` states the block on the page the visitor asked for and sends them
to `/auth?returnTo=<current route>` when they choose to sign in, so they come
back to it. Pass `title` and `description` to say what the page is:

```tsx
<Route
  path="/dashboard"
  element={
    <RequireAuth
      title="Sign in to view your dashboard"
      description="Your projects and settings live here."
    >
      <Dashboard />
    </RequireAuth>
  }
/>
```

Pass `redirectImmediately` for a route where bouncing straight to `/auth` really
is better.

## Auth Page

The auth page is defined in `src/pages/Auth.tsx`. Send sign-in and sign-up actions
to `/auth`.

## Authorization

You can perform authorization checks on the frontend and backend.

On the frontend, you can use the `useAuth` hook to get the current user's data and authentication state.

You should also be protecting queries, mutations, and actions at the base level, checking for authorization securely.

## Adding a redirect after auth

The `/auth` route in `src/main.tsx` redirects to `/dashboard` by default. If the
product's main authenticated route is different, update `redirectAfterAuth` to
that route. A validated same-origin `returnTo` query parameter takes priority so
users can resume the protected page they originally requested. Never leave an
authenticated product redirecting back to the public landing page.

## Complete authenticated products

When the requested product implies accounts, a workspace, a dashboard, or other
signed-in functionality, the task is not complete with only a landing page and
auth form. Build the main authenticated experience, protect its route, and verify
that signing in reaches it.

# Frontend Conventions

You will be using the Vite frontend with React 19, Tailwind v4, and Shadcn UI.

Generally, pages should be in the `src/pages` folder, and components should be in the `src/components` folder.

Shadcn primitives are located in the `src/components/ui` folder and should be used by default.

## Page routing

Your page component should go under the `src/pages` folder.

When adding a page, update the react router configuration in `src/main.tsx` to include the new route you just added.

## Shad CN conventions

Follow these conventions when using Shad CN components, which you should use by default.
- Remember to use "cursor-pointer" to make the element clickable
- For title text, use the "tracking-tight font-bold" class to make the text more readable
- Always make apps MOBILE RESPONSIVE. This is important
- AVOID NESTED CARDS. Try and not to nest cards, borders, components, etc. Nested cards add clutter and make the app look messy.
- AVOID SHADOWS. Avoid adding any shadows to components. stick with a thin border without the shadow.
- Avoid skeletons; instead, use the loader2 component to show a spinning loading state when loading data.


## Landing Pages

You must always create good-looking designer-level styles to your application. 
- Make it well animated and fit a certain "theme", ie neo brutalist, retro, neumorphism, glass morphism, etc

Use known images and emojis from online.

If the user is logged in already, show the get started button to say "Dashboard" or "Profile" instead to take them there.

## Responsiveness and formatting

Make sure pages are wrapped in a container to prevent the width stretching out on wide screens. Always make sure they are centered aligned and not off-center.

Always make sure that your designs are mobile responsive. Verify the formatting to ensure it has correct max and min widths as well as mobile responsiveness.

- Always create sidebars for protected dashboard pages and navigate between pages
- Always create navbars for landing pages
- On these bars, the created logo should be clickable and redirect to the index page

## Animating with Framer Motion

You must add animations to components using Framer Motion. It is already installed and configured in the project.

To use it, import the `motion` component from `framer-motion` and use it to wrap the component you want to animate.


### Other Items to animate
- Fade in and Fade Out
- Slide in and Slide Out animations
- Rendering animations
- Button clicks and UI elements

Animate for all components, including on landing page and app pages.

## Three JS Graphics

Your app comes with three js by default. You can use it to create 3D graphics for landing pages, games, etc.


## Colors

You can override colors in: `src/index.css`

This uses the oklch color format for tailwind v4.

Always use these color variable names.

Make sure all ui components are set up to be mobile responsive and compatible with both light and dark mode.

Set theme using `dark` or `light` variables at the parent className.

## Styling and Theming

When changing the theme, always change the underlying theme of the shad cn components app-wide under `src/components/ui` and the colors in the index.css file.

Avoid hardcoding in colors unless necessary for a use case, and properly implement themes through the underlying shad cn ui components.

When styling, ensure buttons and clickable items have pointer-click on them (don't by default).

Always follow a set theme style and ensure it is tuned to the user's liking.

## Toasts

You should always use toasts to display results to the user, such as confirmations, results, errors, etc.

Use the shad cn Sonner component as the toaster. For example:

```
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
export function SonnerDemo() {
  return (
    <Button
      variant="outline"
      onClick={() =>
        toast("Event has been created", {
          description: "Sunday, December 03, 2023 at 9:00 AM",
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Show Toast
    </Button>
  )
}
```

Remember to import { toast } from "sonner". Usage: `toast("Event has been created.")`

## Dialogs

Always ensure your larger dialogs have a scroll in its content to ensure that its content fits the screen size. Make sure that the content is not cut off from the screen.

Ideally, instead of using a new page, use a Dialog instead. 

# Using the Convex backend

You will be implementing the convex backend. Follow your knowledge of convex and the documentation to implement the backend.

## The Convex Schema

You must correctly follow the convex schema implementation.

The schema is defined in `src/convex/schema.ts`.

Do not include the `_id` and `_creationTime` fields in your queries (it is included by default for each table).
Do not index `_creationTime` as it is indexed for you. Never have duplicate indexes.


## Convex Actions: Using CRUD operations

When running anything that involves external connections, you must use a convex action with "use node" at the top of the file.

You cannot have queries or mutations in the same file as a "use node" action file. Thus, you must use pre-built queries and mutations in other files.

You can also use the pre-installed internal crud functions for the database:

```ts
// in convex/users.ts
import { crud } from "convex-helpers/server/crud";
import schema from "./schema.ts";

export const { create, read, update, destroy } = crud(schema, "users");

// in some file, in an action:
const user = await ctx.runQuery(internal.users.read, { id: userId });

await ctx.runMutation(internal.users.update, {
  id: userId,
  patch: {
    status: "inactive",
  },
});
```


## Common Convex Mistakes To Avoid

When using convex, make sure:
- Document IDs are referenced as `_id` field, not `id`.
- Document ID types are referenced as `Id<"TableName">`, not `string`.
- Document object types are referenced as `Doc<"TableName">`.
- Keep schemaValidation to false in the schema file.
- You must correctly type your code so that it passes the type checker.
- You must handle null / undefined cases of your convex queries for both frontend and backend, or else it will throw an error that your data could be null or undefined.
- Always use the `@/folder` path, with `@/convex/folder/file.ts` syntax for importing convex files.
- This includes importing generated files like `@/convex/_generated/server`, `@/convex/_generated/api`
- Remember to import functions like useQuery, useMutation, useAction, etc. from `convex/react`
- NEVER have return type validators.
