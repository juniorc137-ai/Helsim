const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const express = require("express");
const { createAuth, tempPassword, passwordProblems } = require("../auth.js");

test("senha temporária: 12 caracteres, maiúscula, minúscula e número, sem ambíguos", () => {
  for (let i = 0; i < 50; i++) { const p = tempPassword(); assert.equal(p.length, 12); assert.match(p, /\d/); assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.doesNotMatch(p, /[0O1lI]/); }
  assert.ok(passwordProblems("curta1").length); assert.ok(passwordProblems("somenteletras").length); assert.deepEqual(passwordProblems("Simulacao2026"), []);
});

test("fluxo: cadastro → e-mail com senha temporária → troca obrigatória → acesso", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcauth-")), sent = [];
  const auth = createAuth({ dataDir: dir, mailer: { kind: "teste", send: async (m) => sent.push(m) } });
  const app = express(); app.use("/api/auth", auth.router);
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/auth`;
  const call = async (p, body, tok, method) => { const r = await fetch(base + p, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json() }; };
  try {
    let r = await call("/register", { name: "Ana Admin", email: "Ana@Exemplo.edu.br" });
    assert.equal(r.status, 200); assert.equal(r.j.first, true); assert.equal(sent.length, 1);
    const temp = sent[0].text.match(/Senha temporária: (\S+)/)[1];
    assert.equal(sent[0].to, "ana@exemplo.edu.br");
    assert.ok(!JSON.stringify(auth._db()).includes(temp), "senha não fica em texto puro");
    r = await call("/register", { name: "Outra", email: "ana@exemplo.edu.br" }); assert.equal(r.status, 200); assert.equal(sent.length, 1, "não reenvia nem revela cadastro existente");
    r = await call("/login", { email: "ana@exemplo.edu.br", password: "errada" }); assert.equal(r.status, 401);
    r = await call("/login", { email: "ana@exemplo.edu.br", password: temp }); assert.equal(r.status, 200); assert.equal(r.j.user.mustChange, true);
    const t1 = r.j.token;
    r = await call("/me", null, t1); assert.equal(r.status, 401, "senha temporária não libera o sistema");
    r = await call("/change-password", { current: temp, password: "curta" }, t1); assert.equal(r.status, 400);
    r = await call("/change-password", { current: temp, password: "Simulacao2026" }, t1); assert.equal(r.status, 200); assert.equal(r.j.user.mustChange, false); assert.equal(r.j.user.role, "admin");
    const t2 = r.j.token;
    r = await call("/me", null, t1); assert.equal(r.status, 401, "sessão antiga invalidada");
    r = await call("/me", null, t2); assert.equal(r.status, 200);
    r = await call("/login", { email: "ana@exemplo.edu.br", password: temp }); assert.equal(r.status, 401, "temporária deixa de valer");
    // segundo cadastro vira estudante; admin promove
    await call("/register", { name: "Bruno Docente", email: "bruno@exemplo.edu.br" });
    const { j: { users } } = await call("/users", null, t2); const bruno = users.find((u) => u.email.startsWith("bruno"));
    assert.equal(bruno.role, "estudante");
    r = await call(`/users/${bruno.id}/role`, { role: "docente" }, t2); assert.equal(r.j.user.role, "docente");
    const tb = sent.at(-1).text.match(/Senha temporária: (\S+)/)[1];
    const lb = await call("/login", { email: "bruno@exemplo.edu.br", password: tb });
    r = await call("/users", null, lb.j.token); assert.equal(r.status, 401);
    // bloqueio após 5 erros
    for (let i = 0; i < 5; i++) await call("/login", { email: "bruno@exemplo.edu.br", password: "x" });
    r = await call("/login", { email: "bruno@exemplo.edu.br", password: tb }); assert.equal(r.status, 401); assert.match(r.j.error, /bloqueado/);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
