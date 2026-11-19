const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createAuth } = require("../auth");
test("acesso temporário: entra sem troca de senha e expira", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-tmp-"));
  const a = createAuth({ dataDir: dir, mailer: { kind: "none", send: async () => ({}) } });
  const r = a.createTemporary({ email: "Visita@Exemplo.com", name: "Visita", role: "admin", hours: 48 });
  assert.ok(r.password && r.password.length >= 14);
  const u = a._db().users[0];
  assert.equal(u.email, "visita@exemplo.com"); assert.equal(u.mustChange, false);
  assert.ok(Math.abs(u.accessUntil - (Date.now() + 48 * 3600e3)) < 5000);
  u.accessUntil = Date.now() - 1;
  assert.equal(a.userForToken("x"), null);
  // conta permanente não é convertida
  a._db().users.push({ id: "p", email: "fixa@exemplo.com", name: "F", role: "docente" });
  assert.ok(a.createTemporary({ email: "fixa@exemplo.com", name: "F" }).error);
});
