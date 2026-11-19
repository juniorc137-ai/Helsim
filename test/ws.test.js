// Ligação em tempo real do simulador: com o modo de senhas ligado, sem login não entra
const test = require("node:test"), assert = require("node:assert");
const { spawn } = require("child_process"), path = require("path"), os = require("os"), fs = require("fs");
const WebSocket = require("ws");
function start(env) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => { if (/porta/.test(String(d))) ok(p); });
  });
}
function join(port, msg) {
  return new Promise((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify(msg)));
    ws.on("message", (d) => { ok(JSON.parse(d)); ws.close(); });
    ws.on("error", () => ok(null));
  });
}
test("simulador exige login quando o modo de senhas está ligado", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcws-"));
  const p = await start({ PORT: "3197", HC_DATA_DIR: dir, HC_AUTH: "1", HC_ENV_FILE: path.join(dir, "nada.env") });
  try {
    const m = await join(3197, { type: "join", room: "1234", role: "instructor" });
    assert.equal(m.type, "auth");
    const m2 = await join(3197, { type: "join", room: "1234", role: "monitor", token: "falso" });
    assert.equal(m2.type, "auth");
    // com login completo (primeiro cadastro = administrador) entra como instrutor
    const api = async (p, body, tok) => (await fetch(`http://127.0.0.1:3197/api/auth${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: JSON.stringify(body) })).json();
    await api("/register", { name: "Ana", email: "ana@x.br" });
    const box = path.join(dir, "outbox"), f = fs.readdirSync(box)[0], temp = fs.readFileSync(path.join(box, f), "utf8").match(/Senha temporária: (\S+)/)[1];
    const t1 = (await api("/login", { email: "ana@x.br", password: temp })).token;
    const tok = (await api("/change-password", { current: temp, password: "Simulacao2026" }, t1)).token || (await api("/login", { email: "ana@x.br", password: "Simulacao2026" })).token;
    const m3 = await join(3197, { type: "join", room: "1234", role: "instructor", token: tok });
    assert.equal(m3.type, "joined");
  } finally { p.kill(); }
});
test("sem modo de senhas, a sala funciona como antes", async () => {
  const p = await start({ PORT: "3198", HC_AUTH: "0" });
  try { const m = await join(3198, { type: "join", room: "1234", role: "monitor" }); assert.equal(m.type, "joined"); } finally { p.kill(); }
});
