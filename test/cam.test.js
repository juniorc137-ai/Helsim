// Celular como câmera: pareamento por código, troca de sinais e certificado https
const test = require("node:test"), assert = require("node:assert");
const { spawn } = require("child_process"), path = require("path"), os = require("os"), fs = require("fs");
const WebSocket = require("ws");
function start(env) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => { out += d; if (/HTTPS para o celular|HTTPS indispon|certificado/.test(out) && /porta/.test(out)) ok(p); });
  });
}
function client(url, opts) {
  const ws = new WebSocket(url, opts), q = [], waiters = [];
  ws.on("message", (d) => { const m = JSON.parse(d); const w = waiters.shift(); if (w) w(m); else q.push(m); });
  return { ws, open: new Promise((ok) => ws.on("open", ok)), send: (m) => ws.send(JSON.stringify(m)), next: () => q.length ? Promise.resolve(q.shift()) : new Promise((ok) => waiters.push(ok)) };
}
test("estação gera código, celular entra por wss e os sinais passam entre os dois", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hccam-"));
  const p = await start({ PORT: "3191", HTTPS_PORT: "3491", HC_DATA_DIR: dir, HC_AUTH: "0", HC_ENV_FILE: path.join(dir, "nada.env") });
  try {
    assert.ok(fs.existsSync(path.join(dir, "tls", "cert.pem")), "certificado criado");
    const info = await (await fetch("http://127.0.0.1:3191/api/cam/info")).json();
    assert.equal(info.https, true); assert.equal(info.httpsPort, 3491);
    const host = client("ws://127.0.0.1:3191"); await host.open;
    host.send({ type: "cam-host" });
    const r = await host.next(); assert.equal(r.type, "cam-ready"); assert.match(r.code, /^\d{6}$/);
    const phone = client("wss://127.0.0.1:3491", { rejectUnauthorized: false }); await phone.open;
    phone.send({ type: "cam-join", code: "000000" === r.code ? "111111" : "000000" });
    assert.equal((await phone.next()).type, "cam-error");
    phone.send({ type: "cam-join", code: r.code, label: "iPhone" });
    assert.equal((await phone.next()).type, "cam-joined");
    const peer = await host.next(); assert.equal(peer.type, "cam-peer"); assert.equal(peer.label, "iPhone");
    phone.send({ type: "cam-signal", code: r.code, data: { sdp: { type: "offer", sdp: "x" } } });
    assert.equal((await host.next()).data.sdp.type, "offer");
    host.send({ type: "cam-signal", code: r.code, data: { sdp: { type: "answer", sdp: "y" } } });
    assert.equal((await phone.next()).data.sdp.type, "answer");
    // um segundo celular não toma o mesmo código
    const intruso = client("wss://127.0.0.1:3491", { rejectUnauthorized: false }); await intruso.open;
    intruso.send({ type: "cam-join", code: r.code }); assert.equal((await intruso.next()).type, "cam-error");
    host.send({ type: "cam-end", code: r.code });
    assert.equal((await phone.next()).type, "cam-bye");
    [host, phone, intruso].forEach((c) => c.ws.close());
  } finally { p.kill(); }
});
test("com o modo de senhas, só docente ou administrador gera código", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hccam-"));
  const p = await start({ PORT: "3192", HTTPS_PORT: "3492", HC_DATA_DIR: dir, HC_AUTH: "1", HC_ENV_FILE: path.join(dir, "nada.env") });
  try {
    const host = client("ws://127.0.0.1:3192"); await host.open;
    host.send({ type: "cam-host", token: "falso" });
    assert.equal((await host.next()).type, "cam-error");
    host.ws.close();
  } finally { p.kill(); }
});
