/* HELSIM – aplicativo de computador (Electron).
 *
 * Abre o HELSIM numa janela própria, sem navegador. Se já houver um servidor do HELSIM na porta
 * (por exemplo, o que inicia junto com o Mac), o app só se conecta a ele; senão, liga o servidor
 * embutido e o desliga ao sair. Os dados ficam em ~/HelseCapture/SimClin/data quando essa pasta existe
 * (instalação atual) ou na pasta de dados do aplicativo.
 */
const { app, BrowserWindow, shell, session, desktopCapturer, Menu, dialog } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), http = require("http");
const { spawn } = require("child_process");

const PORT = +process.env.HELSIM_PORT || 3000;
const BASE = `http://localhost:${PORT}`;
let win = null, child = null;

app.setName("HELSIM");
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function ping() {
  return new Promise((ok) => {
    const req = http.get(`${BASE}/api/auth/status`, { timeout: 1500 }, (r) => { r.resume(); ok(r.statusCode === 200); });
    req.on("error", () => ok(false)); req.on("timeout", () => { req.destroy(); ok(false); });
  });
}
function dataDir() {
  if (process.env.HC_DATA_DIR) return process.env.HC_DATA_DIR;
  const legacy = path.join(os.homedir(), "HelseCapture", "SimClin", "data");
  return fs.existsSync(legacy) ? legacy : path.join(app.getPath("userData"), "data");
}
async function ensureServer() {
  if (await ping()) return true;
  const dir = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server");
  const script = path.join(dir, "server.js");
  if (!fs.existsSync(script)) return false;
  const log = fs.openSync(path.join(app.getPath("userData"), "servidor.log"), "a");
  child = spawn(process.execPath, [script], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT: String(PORT), HC_DATA_DIR: dataDir() }, stdio: ["ignore", log, log] });
  child.on("exit", () => { child = null; });
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); if (await ping()) return true; }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 380, minHeight: 560, title: "HELSIM", backgroundColor: "#0B2A5B", show: false,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("page-title-updated", (e) => e.preventDefault());
  win.loadURL(`${BASE}/captura.html`);
  // links para fora do HELSIM abrem no navegador padrão
  const internal = (u) => u.startsWith(BASE + "/") || u.startsWith("blob:") || u.startsWith("data:") || u === "about:blank";
  win.webContents.setWindowOpenHandler(({ url }) => { if (internal(url)) return { action: "allow" }; shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!internal(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (!url.startsWith(BASE)) return;
    dialog.showMessageBox(win, { type: "warning", title: "HELSIM", message: "Não foi possível conectar ao servidor do HELSIM.", detail: `${desc} (${code}). O app tentará de novo.`, buttons: ["Tentar de novo"] })
      .then(async () => { await ensureServer(); win.loadURL(`${BASE}/captura.html`); });
  });
  win.on("closed", () => { win = null; });
}

function permissions() {
  const ses = session.defaultSession;
  const ours = (wc, origin) => (origin || (wc && wc.getURL()) || "").startsWith(BASE);
  const allowed = new Set(["media", "display-capture", "clipboard-sanitized-write", "fullscreen", "notifications"]);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && ours(wc, details.requestingUrl)));
  ses.setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && ours(wc, origin));
  // "Capturar tela" na sessão ao vivo: usa o seletor do sistema quando existe; senão a tela principal
  ses.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((s) => cb(s[0] ? { video: s[0] } : {})).catch(() => cb({}));
  }, { useSystemPicker: true });
}

function menu() {
  const mac = process.platform === "darwin";
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ label: "HELSIM", submenu: [{ role: "about", label: "Sobre o HELSIM" }, { type: "separator" }, { role: "hide", label: "Ocultar HELSIM" }, { role: "hideOthers", label: "Ocultar outros" }, { type: "separator" }, { role: "quit", label: "Encerrar HELSIM" }] }] : []),
    { label: "Editar", submenu: [{ role: "undo", label: "Desfazer" }, { role: "redo", label: "Refazer" }, { type: "separator" }, { role: "cut", label: "Recortar" }, { role: "copy", label: "Copiar" }, { role: "paste", label: "Colar" }, { role: "selectAll", label: "Selecionar tudo" }] },
    { label: "Visualizar", submenu: [{ role: "reload", label: "Recarregar" }, { role: "togglefullscreen", label: "Tela cheia" }, { type: "separator" }, { role: "zoomIn", label: "Aumentar" }, { role: "zoomOut", label: "Diminuir" }, { role: "resetZoom", label: "Tamanho real" }] },
    { label: "Janela", submenu: [{ role: "minimize", label: "Minimizar" }, { role: "close", label: "Fechar janela" }] },
  ]));
}

app.whenReady().then(async () => {
  app.setAboutPanelOptions({ applicationName: "HELSIM", applicationVersion: app.getVersion(), copyright: "Helse Solutions" });
  menu(); permissions();
  if (!(await ensureServer())) dialog.showErrorBox("HELSIM", "O servidor do HELSIM não iniciou. Veja o arquivo servidor.log na pasta de dados do aplicativo.");
  createWindow();
  app.on("activate", () => { if (!win) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (child) child.kill(); });
