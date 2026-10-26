/** Signalpath application version — shown in the footer and diagnostics export. */
export const APP_NAME = "Signalpath";
export const APP_VERSION = "3.0.0";

/**
 * Desktop installers live on the GitHub Releases page. Each v* tag builds
 * all three platforms in CI (.github/workflows/desktop-release.yml) and
 * publishes them under version-free artifact names, so these /latest/
 * download URLs always point at the newest release.
 *
 * This is the single place the download links are derived from, so it must
 * name the repository that actually runs the release workflow — a placeholder
 * here makes every Download button on the landing page 404.
 */
export const RELEASES_URL =
  "https://github.com/thomasmarshalldj1998/radio-suite-pro/releases";

export const DESKTOP_DOWNLOADS = {
  /** Windows 10/11 — NSIS installer. */
  windows: `${RELEASES_URL}/latest/download/Signalpath-Setup-x64.exe`,
  /** macOS 12+ — Apple silicon (M1/M2/M3/M4). */
  macArm: `${RELEASES_URL}/latest/download/Signalpath-arm64-mac.dmg`,
  /** macOS 12+ — Intel. */
  macIntel: `${RELEASES_URL}/latest/download/Signalpath-x64-mac.dmg`,
  /** Linux — portable AppImage (any distro, no install). */
  linux: `${RELEASES_URL}/latest/download/Signalpath-x86_64.AppImage`,
  /** Linux — Debian/Ubuntu package. */
  deb: `${RELEASES_URL}/latest/download/signalpath-amd64.deb`,
} as const;
