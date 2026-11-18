/* HELSIM – modo de senhas (cadastro por e-mail, senha temporária e troca obrigatória).
 *
 * Fluxo: a pessoa se cadastra com nome e e-mail → o servidor gera uma senha
 * temporária aleatória (válida por 24 h) e envia por e-mail → no primeiro
 * acesso a sessão só permite trocar a senha → com a senha definitiva, o
 * acesso libera o perfil atribuído (estudante por padrão; o primeiro cadastro
 * do servidor vira administrador, que depois promove docentes).
 *
 * Senhas: scrypt com sal por usuário; tokens de sessão aleatórios guardados
 * só como hash SHA-256. Bloqueio de 15 min após 5 erros seguidos e limite de
 * pedidos por IP para cadastro e recuperação. Sem SMTP configurado, os
 * e-mails vão para data/outbox/ (modo de teste).
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const ROLES = ["admin", "docente", "estudante"];
const TEMP_TTL = 24 * 3600 * 1000, SESSION_TTL = 12 * 3600 * 1000, LOCK_MS = 15 * 60 * 1000, MAX_FAIL = 5;
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // sem 0/O, 1/l/I

function tempPassword(n = 12) {
  const out = [];
  while (out.length < n) { const b = crypto.randomBytes(n * 2); for (const x of b) { if (x < 256 - (256 % ALPHA.length) && out.length < n) out.push(ALPHA[x % ALPHA.length]); } }
  const s = out.join("");
  return /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s) ? s : tempPassword(n);
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
function checkPw(pw, u) {
  const a = Buffer.from(hashPw(pw, u.salt), "hex"), b = Buffer.from(u.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Regras da senha definitiva: ≥10 caracteres, letra e número, diferente da temporária e do e-mail. */
function passwordProblems(pw, u) {
  const p = [], s = String(pw || "");
  if (s.length < 10) p.push("ter pelo menos 10 caracteres");
  if (!/[A-Za-zÀ-ÿ]/.test(s) || !/\d/.test(s)) p.push("combinar letras e números");
  if (u && u.email && s.toLowerCase().includes(u.email.split("@")[0].toLowerCase())) p.push("não conter o nome do e-mail");
  if (u && u.hash && checkPw(s, u)) p.push("ser diferente da senha temporária");
  return p;
}
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(e || ""));

function createAuth({ dataDir = path.join(__dirname, "data"), mailer = null, appName = "HELSIM", baseUrl = "" } = {}) {
  const file = path.join(dataDir, "users.json");
  fs.mkdirSync(dataDir, { recursive: true });
  let db = { users: [] };
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  const persist = () => { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); };
  // sessões persistidas (só o hash do token) para que reiniciar o servidor não desconecte ninguém
  const sfile = path.join(dataDir, "sessions.json");
  const sessions = new Map(); // sha256(token) → { userId, scope, exp }
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(sfile, "utf8")))) if (v.exp > Date.now()) sessions.set(k, v); } catch (e) {}
  let sT = 0;
  const saveSessions = () => { clearTimeout(sT); sT = setTimeout(() => { try { const tmp = sfile + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries([...sessions].filter(([, v]) => v.exp > Date.now()))), { mode: 0o600 }); fs.renameSync(tmp, sfile); } catch (e) {} }, 200); };
  const _set = sessions.set.bind(sessions), _del = sessions.delete.bind(sessions);
  sessions.set = (k, v) => { const r = _set(k, v); saveSessions(); return r; };
  sessions.delete = (k) => { const r = _del(k); saveSessions(); return r; };
  const hits = new Map(); // ip → [timestamps]

  const transport = mailer || makeTransport(dataDir);
  async function sendTemp(u, pw, reason) {
    const link = baseUrl ? `\n\nAcesse: ${baseUrl}/captura.html` : "";
    const text = `Olá, ${u.name || u.email}.\n\n${reason === "reset" ? "Foi gerada uma nova senha temporária" : "Seu cadastro no " + appName + " foi criado"}.\n\nE-mail: ${u.email}\nSenha temporária: ${pw}\n\nEla vale por 24 horas e só serve para o primeiro acesso: o sistema vai pedir que você cadastre uma senha definitiva (mínimo de 10 caracteres, com letras e números).${link}\n\nSe você não pediu este acesso, ignore esta mensagem.\n\n${appName} · Helse Solutions`;
    await transport.send({ to: u.email, subject: `${appName}: sua senha temporária`, text });
  }
  const pub = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, mustChange: !!u.mustChange, createdAt: u.createdAt, lastLogin: u.lastLogin || null });
  const find = (email) => db.users.find((u) => u.email === String(email || "").trim().toLowerCase());
  function issue(u, scope) {
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(crypto.createHash("sha256").update(token).digest("hex"), { userId: u.id, scope, exp: Date.now() + SESSION_TTL });
    return token;
  }
  function session(req) {
    const t = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!t) return null;
    const k = crypto.createHash("sha256").update(t).digest("hex"), s = sessions.get(k);
    if (!s || s.exp < Date.now()) { sessions.delete(k); return null; }
    const u = db.users.find((x) => x.id === s.userId);
    return u ? { ...s, key: k, user: u } : null;
  }
  function limited(req, max = 5, win = 15 * 60 * 1000) {
    const ip = req.ip || "?", now = Date.now(), l = (hits.get(ip) || []).filter((t) => now - t < win);
    l.push(now); hits.set(ip, l); return l.length > max;
  }
  function setTemp(u) { const pw = tempPassword(); u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(pw, u.salt); u.mustChange = true; u.tempExpires = Date.now() + TEMP_TTL; u.failed = 0; u.lockedUntil = 0; return pw; }
  const GENERIC = "Se o e-mail estiver correto, a senha temporária chegará em alguns minutos. Confira também a caixa de spam.";

  const r = express.Router();
  r.use(express.json({ limit: "20kb" }));
  r.get("/status", (req, res) => res.json({ enabled: true, users: db.users.length, mail: transport.kind, sync: process.env.HC_SYNC !== "0" }));

  r.post("/register", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
    const email = String(req.body.email || "").trim().toLowerCase(), name = String(req.body.name || "").trim().slice(0, 120);
    if (!validEmail(email)) return res.status(400).json({ error: "Informe um e-mail válido." });
    if (!name) return res.status(400).json({ error: "Informe seu nome." });
    if (find(email)) return res.json({ ok: true, message: GENERIC }); // não revela quem já tem cadastro
    const u = { id: crypto.randomUUID(), email, name, role: db.users.length ? "estudante" : "admin", createdAt: Date.now() };
    const pw = setTemp(u);
    db.users.push(u); persist();
    try { await sendTemp(u, pw, "new"); } catch (e) { console.error("[auth] falha ao enviar e-mail:", e.message); return res.status(502).json({ error: "Cadastro criado, mas o e-mail não pôde ser enviado. Avise o administrador." }); }
    res.json({ ok: true, message: GENERIC, first: u.role === "admin" });
  });

  r.post("/forgot", async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Muitas tentativas. Aguarde 15 minutos." });
    const u = find(req.body.email);
    if (u) { const pw = setTemp(u); persist(); for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k); sendTemp(u, pw, "reset").catch((e) => console.error("[auth] falha ao enviar e-mail:", e.message)); }
    res.json({ ok: true, message: GENERIC });
  });

  r.post("/login", (req, res) => {
    const u = find(req.body.email), pw = String(req.body.password || "");
    const fail = (msg = "E-mail ou senha incorretos.") => res.status(401).json({ error: msg });
    if (!u) { hashPw(pw, "x"); return fail(); }
    if (u.lockedUntil && u.lockedUntil > Date.now()) return fail(`Acesso bloqueado por excesso de tentativas. Tente após ${new Date(u.lockedUntil).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`);
    if (!checkPw(pw, u)) { u.failed = (u.failed || 0) + 1; if (u.failed >= MAX_FAIL) { u.lockedUntil = Date.now() + LOCK_MS; u.failed = 0; } persist(); return fail(); }
    if (u.mustChange && u.tempExpires < Date.now()) return fail("A senha temporária expirou. Use “Esqueci minha senha” para receber outra.");
    u.failed = 0; u.lockedUntil = 0; u.lastLogin = Date.now(); persist();
    res.json({ token: issue(u, u.mustChange ? "change" : "full"), user: pub(u) });
  });

  r.post("/change-password", (req, res) => {
    const s = session(req); if (!s) return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    const u = s.user, cur = String(req.body.current || ""), next = String(req.body.password || "");
    if (!checkPw(cur, u)) return res.status(400).json({ error: "A senha atual não confere." });
    const p = passwordProblems(next, u);
    if (p.length) return res.status(400).json({ error: "A nova senha deve " + p.join(", ") + "." });
    u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hashPw(next, u.salt); u.mustChange = false; u.tempExpires = 0; u.passwordChangedAt = Date.now(); persist();
    for (const [k, x] of sessions) if (x.userId === u.id) sessions.delete(k);
    res.json({ token: issue(u, "full"), user: pub(u) });
  });

  const need = (role) => (req, res, next) => {
    const s = session(req);
    if (!s || s.scope !== "full") return res.status(401).json({ error: s ? "Troque a senha temporária para continuar." : "Entre para continuar." });
    if (role && s.user.role !== role) return res.status(403).json({ error: "Apenas o administrador pode fazer isso." });
    req.auth = s; next();
  };
  r.get("/me", need(), (req, res) => res.json({ user: pub(req.auth.user) }));
  r.post("/logout", (req, res) => { const s = session(req); if (s) sessions.delete(s.key); res.json({ ok: true }); });
  r.get("/users", need("admin"), (req, res) => res.json({ users: db.users.map(pub) }));
  r.post("/users/:id/role", need("admin"), (req, res) => {
    const u = db.users.find((x) => x.id === req.params.id), role = req.body.role;
    if (!u || !ROLES.includes(role)) return res.status(400).json({ error: "Usuário ou perfil inválido." });
    if (u.role === "admin" && role !== "admin" && db.users.filter((x) => x.role === "admin").length === 1) return res.status(400).json({ error: "O sistema precisa de ao menos um administrador." });
    u.role = role; persist(); res.json({ user: pub(u) });
  });
  r.post("/users/:id/reset", need("admin"), async (req, res) => {
    const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "Usuário não encontrado." });
    const pw = setTemp(u); persist(); for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k);
    try { await sendTemp(u, pw, "reset"); res.json({ ok: true }); } catch (e) { res.status(502).json({ error: "Não foi possível enviar o e-mail: " + e.message }); }
  });
  r.post("/users", need("admin"), async (req, res) => { // administrador cadastra alguém já com perfil
    const email = String(req.body.email || "").trim().toLowerCase(), name = String(req.body.name || "").trim().slice(0, 120), role = ROLES.includes(req.body.role) ? req.body.role : "estudante";
    if (!validEmail(email) || !name) return res.status(400).json({ error: "Informe nome e e-mail válidos." });
    if (find(email)) return res.status(409).json({ error: "Este e-mail já tem cadastro." });
    const u = { id: crypto.randomUUID(), email, name, role, createdAt: Date.now() }; const pw = setTemp(u); db.users.push(u); persist();
    try { await sendTemp(u, pw, "new"); res.json({ user: pub(u) }); } catch (e) { res.status(502).json({ error: "Usuário criado, mas o e-mail falhou: " + e.message, user: pub(u) }); }
  });
  r.delete("/users/:id", need("admin"), (req, res) => {
    const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "Usuário não encontrado." });
    if (u.id === req.auth.user.id) return res.status(400).json({ error: "Você não pode excluir a própria conta." });
    db.users = db.users.filter((x) => x !== u); persist(); for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k); res.json({ ok: true });
  });
  return { router: r, need, _db: () => db };
}

/** SMTP pelas variáveis SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (e SMTP_SECURE=1 para a porta 465). */
function makeTransport(dataDir) {
  if (process.env.SMTP_HOST) {
    const nodemailer = require("nodemailer");
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, secure: process.env.SMTP_SECURE === "1" || +process.env.SMTP_PORT === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
    return { kind: "smtp", send: (m) => t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, ...m }) };
  }
  const out = path.join(dataDir, "outbox");
  return { kind: "teste", send: async (m) => {
    fs.mkdirSync(out, { recursive: true });
    const f = path.join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}-${m.to.replace(/[^a-z0-9@._-]/gi, "_")}.txt`);
    fs.writeFileSync(f, `Para: ${m.to}\nAssunto: ${m.subject}\n\n${m.text}\n`, { mode: 0o600 });
    console.log(`[auth] SMTP não configurado: e-mail para ${m.to} salvo em ${f}`);
  } };
}

module.exports = { createAuth, tempPassword, passwordProblems, validEmail };
