/**
 * Signalpath desktop shell.
 *
 * The renderer is the Vite build in dist-desktop/, served through a custom
 * `app://` scheme (standard + secure) so the BrowserRouter deep links, ES
 * module workers, WASM codecs and the audio worklet all behave exactly like
 * they do over http — which file:// cannot offer.
 */
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  protocol,
  net,
  session,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { UdpEndpoint } = require("./udp-link.cjs");

const DIST = path.join(__dirname, "..", "dist-desktop");
const isMac = process.platform === "darwin";
/** Set by `vite --port` when driving the renderer from a dev server. */
const DEV_URL = process.env.SIGNALPATH_DEV_URL || "";

let mainWindow = null;

/* ── composite-over-IP links: one UDP socket per path ───────────────────── */

/** @type {Map<"a" | "b", InstanceType<typeof UdpEndpoint>>} */
const links = new Map();

function closeAllLinks() {
  for (const endpoint of links.values()) endpoint.close();
  links.clear();
}

/** Only the console's own document may drive the sockets. */
function fromApp(event) {
  return Boolean(mainWindow) && event.sender === mainWindow.webContents;
}

function linkEndpoint(id) {
  let endpoint = links.get(id);
  if (!endpoint) {
    endpoint = new UdpEndpoint({
      onData: (bytes) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("mpx:data", id, bytes);
        }
      },
    });
    links.set(id, endpoint);
  }
  return endpoint;
}

const linkId = (value) => (value === "b" ? "b" : "a");

ipcMain.handle("mpx:open", async (event, args) => {
  if (!fromApp(event)) return { ok: false, error: "not the console window" };
  const id = linkId(args?.id);
  const endpoint = linkEndpoint(id);
  endpoint.close();
  try {
    const port = await endpoint.open({
      listenPort: args?.listenPort ?? 0,
      listenHost: args?.listenHost ?? "0.0.0.0",
      host: args?.host,
      port: args?.port,
    });
    return { ok: true, port };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.on("mpx:send", (event, id, bytes) => {
  if (!fromApp(event)) return;
  const endpoint = links.get(linkId(id));
  if (!endpoint || !endpoint.open) return;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return;
  endpoint.send(bytes);
});

ipcMain.handle("mpx:close", (event, id) => {
  if (!fromApp(event)) return { ok: false };
  const which = linkId(id);
  links.get(which)?.close();
  links.delete(which);
  return { ok: true };
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

/** Map an app:// URL to a file in dist-desktop, falling back to the SPA
 * shell so client-side routes survive a reload. Blocks path traversal. */
function resolveAppFile(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const file = path.normalize(path.join(DIST, pathname));
  if (!file.startsWith(DIST + path.sep) && file !== DIST) return null;
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  return path.join(DIST, "index.html");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: "#0b0d11",
    title: "Signalpath",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
    closeAllLinks();
  });

  // External links leave the app; everything else stays on app://.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("app://") || (DEV_URL && url.startsWith(DEV_URL))) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadURL("app://signalpath/index.html");
  }
}

function buildMenu() {
  // Standard roles keep Edit → Copy/Paste and the usual accelerators working.
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle("app", (request) => {
      const file = resolveAppFile(request.url);
      if (!file) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    // The console mics the input path and streams audio — grant the media
    // and full-screen permissions the studio UI asks for, nothing else.
    session.defaultSession.setPermissionRequestHandler(
      (_wc, permission, callback) => {
        const granted = [
          "media",
          "audio-capture",
          "fullscreen",
          "pointerLock",
          "clipboard-sanitized-write",
        ].includes(permission);
        callback(granted);
      },
    );

    buildMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", closeAllLinks);

  // A broadcast console quits when its last window closes — on every OS.
  app.on("window-all-closed", () => app.quit());
}
