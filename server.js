const express = require("express");
const { WebSocketServer } = require("ws");
const path = require("path");

// Configuração local (fora do Git): email.env ao lado do server.js, uma variável por linha (CHAVE=valor).
// Usada para o envio de e-mail (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, PUBLIC_URL).
(() => {
  const fs = require("fs"), f = process.env.HC_ENV_FILE || path.join(__dirname, "email.env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (!m || line.trim().startsWith("#")) continue;
    let v = m[2]; if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const app = express();
app.disable("x-powered-by"); // não anuncia a tecnologia do servidor
app.use(express.static(path.join(__dirname, "public")));

// Modo de senhas do HELSIM (cadastro por e-mail + senha temporária + troca obrigatória)
// e banco central (sincronização entre computadores; HC_SYNC=0 desliga)
const { createAuth } = require("./auth");
const { createStore } = require("./store");
let auth = null;
if (process.env.HC_AUTH !== "0") {
  const dataDir = process.env.HC_DATA_DIR || path.join(__dirname, "data");
  auth = createAuth({ dataDir, baseUrl: process.env.PUBLIC_URL || "" });
  app.use("/api/auth", auth.router);
  if (process.env.HC_SYNC !== "0") app.use("/api/data", createStore({ dataDir, need: auth.need }).router);
}

// Endereços deste computador na rede, para o QR code do celular
app.get("/api/cam/info", (req, res) => {
  const ips = Object.values(require("os").networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  res.json({ ips, httpsPort: HTTPS_PORT, https: !!httpsServer });
});

// Rota catch-all → index.html (SPA)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`SimClin rodando na porta ${PORT}`));

// ── HTTPS local (celular como câmera) ───────────────────────────────────────
// O navegador do celular só libera a câmera em https. O servidor cria um certificado próprio
// (openssl) em <dados>/tls na primeira vez e escuta também em HTTPS_PORT (3443). HC_HTTPS=0 desliga.
const HTTPS_PORT = +process.env.HTTPS_PORT || 3443;
let httpsServer = null;
if (process.env.HC_HTTPS !== "0") {
  const tls = require("./tls").ensureCert(process.env.HC_DATA_DIR || path.join(__dirname, "data"));
  if (tls) {
    httpsServer = require("https").createServer({ key: tls.key, cert: tls.cert }, app);
    httpsServer.on("error", (e) => { console.log(`HTTPS indisponível (${e.code || e.message}); o celular como câmera não vai funcionar.`); httpsServer = null; });
    httpsServer.listen(HTTPS_PORT, () => console.log(`HTTPS para o celular em https://<ip-do-computador>:${HTTPS_PORT}`));
  }
}

// ── WebSocket Relay ──────────────────────────────────────────────────────────
// Rooms: Map<roomCode, { instructor: ws|null, monitors: Set<ws> }>
const rooms = new Map();

const wss = new WebSocketServer({ noServer: true });
const upgrade = (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
server.on("upgrade", upgrade);
if (httpsServer) httpsServer.on("upgrade", upgrade);

// ── Celular como câmera: pareamento por código de 6 dígitos ─────────────────
// A estação (docente ou administrador logado) pede um código; o celular entra com ele e os dois trocam
// a negociação WebRTC (oferta, resposta e candidatos) por aqui. O vídeo vai direto do celular à estação.
const cams = new Map(); // código → { host: ws, phone: ws|null }
const camSend = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
function camCode() { let c; do { c = String(require("crypto").randomInt(0, 1000000)).padStart(6, "0"); } while (cams.has(c)); return c; }

wss.on("connection", (ws) => {
  let wsRoom = null;
  let wsRole = null;
  let camFails = 0;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CELULAR COMO CÂMERA ──
    if (msg.type === "cam-host") { // estação pede um código
      if (auth) {
        const u = auth.userForToken(msg.token);
        if (!u || !["admin", "docente"].includes(u.role)) return camSend(ws, { type: "cam-error", error: u ? "Apenas docente ou administrador conecta câmeras." : "Entre no HELSIM para conectar o celular." });
      }
      const code = camCode(); cams.set(code, { host: ws, phone: null });
      return camSend(ws, { type: "cam-ready", code });
    }
    if (msg.type === "cam-join") { // celular entra com o código
      const c = cams.get(String(msg.code || ""));
      if (!c || c.phone) {
        camSend(ws, { type: "cam-error", error: c ? "Este código já está em uso por outro celular." : "Código não encontrado. Confira os 6 números na tela do HELSIM." });
        if (++camFails >= 5) ws.close(4429);
        return;
      }
      c.phone = ws; ws.camCode = String(msg.code);
      camSend(ws, { type: "cam-joined" });
      return camSend(c.host, { type: "cam-peer", code: ws.camCode, label: String(msg.label || "Celular").slice(0, 40) });
    }
    if (msg.type === "cam-signal") { // negociação WebRTC entre os dois lados do mesmo código
      const c = cams.get(String(msg.code || ""));
      if (!c) return;
      if (ws === c.host) camSend(c.phone, { type: "cam-signal", code: msg.code, data: msg.data });
      else if (ws === c.phone) camSend(c.host, { type: "cam-signal", code: msg.code, data: msg.data });
      return;
    }
    if (msg.type === "cam-end") { // estação encerra um código
      const c = cams.get(String(msg.code || ""));
      if (c && c.host === ws) { camSend(c.phone, { type: "cam-bye" }); cams.delete(String(msg.code)); }
      return;
    }

    // ── JOIN ──
    if (msg.type === "join") {
      const { room, role } = msg;
      if (!room || !role) return;
      // com o modo de senhas ligado, só entra quem tem login; controlar o simulador é só de docente e administrador
      if (auth) {
        const u = auth.userForToken(msg.token);
        if (!u || (role === "instructor" && !["admin", "docente"].includes(u.role))) {
          ws.send(JSON.stringify({ type: "auth", error: u ? "Apenas docente ou administrador controla o simulador." : "Entre no HELSIM para usar o simulador." }));
          ws.close(4401); return;
        }
      }

      wsRoom = String(room).slice(0, 4);
      wsRole = role;

      if (!rooms.has(wsRoom)) {
        rooms.set(wsRoom, { instructor: null, monitors: new Set(), state: null });
      }
      const r = rooms.get(wsRoom);

      if (role === "instructor") {
        // Se havia instrutor anterior, fecha
        if (r.instructor && r.instructor !== ws && r.instructor.readyState === 1) {
          r.instructor.close();
        }
        r.instructor = ws;
        ws.send(JSON.stringify({ type: "joined", role: "instructor", room: wsRoom }));
        // Envia estado atual para o instrutor (se havia)
        if (r.state) ws.send(JSON.stringify({ type: "state", state: r.state }));
      } else {
        r.monitors.add(ws);
        ws.send(JSON.stringify({ type: "joined", role: "monitor", room: wsRoom }));
        // Envia estado atual para o monitor
        if (r.state) ws.send(JSON.stringify({ type: "state", state: r.state }));
      }
      return;
    }

    // ── EVENTO DO ROTEIRO (instrutor → monitores e estações de captura) ──
    // Não fica guardado na sala: só interessa a quem está gravando naquele momento.
    if (msg.type === "event" && wsRole === "instructor" && wsRoom && msg.entry) {
      const r = rooms.get(wsRoom);
      if (!r) return;
      const out = JSON.stringify({ type: "event", entry: msg.entry });
      r.monitors.forEach((m) => { if (m.readyState === 1) m.send(out); });
      return;
    }

    // ── STATE UPDATE (instrutor → monitores) ──
    if (msg.type === "state" && wsRole === "instructor" && wsRoom) {
      const r = rooms.get(wsRoom);
      if (!r) return;
      r.state = msg.state;
      // Broadcast para todos os monitores
      r.monitors.forEach((m) => {
        if (m.readyState === 1) {
          m.send(JSON.stringify({ type: "state", state: msg.state }));
        }
      });
      return;
    }
  });

  ws.on("close", () => {
    for (const [code, c] of cams) {
      if (c.host === ws) { camSend(c.phone, { type: "cam-bye" }); cams.delete(code); }
      else if (c.phone === ws) { c.phone = null; camSend(c.host, { type: "cam-bye", code }); }
    }
    if (!wsRoom) return;
    const r = rooms.get(wsRoom);
    if (!r) return;
    if (wsRole === "instructor" && r.instructor === ws) {
      r.instructor = null;
    } else {
      r.monitors.delete(ws);
    }
    // Limpa sala vazia após 10 min
    if (!r.instructor && r.monitors.size === 0) {
      setTimeout(() => {
        const cur = rooms.get(wsRoom);
        if (cur && !cur.instructor && cur.monitors.size === 0) rooms.delete(wsRoom);
      }, 600000);
    }
  });

  ws.on("error", () => {});
});
