// Kingnode desktop: Electron window + a local server that runs the project's api/*.js handlers.
// Run:  cd desktop && npm install && npm start
import { app, BrowserWindow, shell } from "electron";
import { startServer } from "./server.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let port = 4810;
app.whenReady().then(async () => {
  port = await startServer(path.join(__dirname, ".."), port);
  const win = new BrowserWindow({ width: 1500, height: 980, backgroundColor: "#000000", title: "Kingnode", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadURL(`http://127.0.0.1:${port}/app.html`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
});
app.on("window-all-closed", () => app.quit());
