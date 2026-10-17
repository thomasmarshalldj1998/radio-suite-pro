/**
 * Preload bridge for the desktop shell.
 *
 * The renderer runs with context isolation and no Node access, so the one
 * thing it cannot do on its own — open a UDP socket — is exposed here as a
 * narrow, fixed surface. Nothing else crosses the boundary.
 */
const { contextBridge, ipcRenderer } = require("electron");

/** Renderer callbacks for inbound datagrams; one IPC listener fans out. */
const dataHandlers = new Set();
ipcRenderer.on("mpx:data", (_event, id, bytes) => {
  for (const handler of dataHandlers) handler(id, bytes);
});

contextBridge.exposeInMainWorld("signalpath", {
  platform: process.platform,
  udp: {
    available: true,
    /**
     * Open (or re-open) one link endpoint.
     * @param {{ id: "a" | "b", listenPort: number, listenHost?: string, host: string, port: number }} args
     * @returns {Promise<{ ok: boolean, port?: number, error?: string }>}
     */
    open: (args) => ipcRenderer.invoke("mpx:open", args),
    /** Send one framed packet on the link the packet belongs to. */
    send: (id, bytes) => ipcRenderer.send("mpx:send", id, bytes),
    /** @returns {Promise<{ ok: boolean }>} */
    close: (id) => ipcRenderer.invoke("mpx:close", id),
    /**
     * Datagrams arriving on either link. Returns an unsubscribe function.
     * @param {(id: "a" | "b", bytes: Uint8Array) => void} cb
     */
    onData: (cb) => {
      if (typeof cb !== "function") return () => {};
      dataHandlers.add(cb);
      return () => {
        dataHandlers.delete(cb);
      };
    },
  },
});
