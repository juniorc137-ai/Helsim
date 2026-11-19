const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const express = require("express");
const { createStore } = require("../store.js");
const { merge3 } = require("../public/captura-modulos.js");

test("merge3: alterações simultâneas em itens diferentes são preservadas", () => {
  const base = { people: [{ id: "a", name: "Ana" }, { id: "b", name: "Bia" }], settings: { institution: "X", retentionDays: 0 } };
  const local = { people: [{ id: "a", name: "Ana Souza" }, { id: "b", name: "Bia" }, { id: "c", name: "Caio" }], settings: { institution: "X", retentionDays: 30 } };
  const remote = { people: [{ id: "a", name: "Ana" }, { id: "b", name: "Beatriz" }], settings: { institution: "Y", retentionDays: 0 } };
  const m = merge3(base, local, remote);
  assert.deepEqual(m.people.map((p) => p.name).sort(), ["Ana Souza", "Beatriz", "Caio"]);
  assert.deepEqual(m.settings, { institution: "Y", retentionDays: 30 });
});

test("merge3: exclusões de um lado são respeitadas; conflito real mantém a versão local", () => {
  const base = { sessions: [{ id: "s1", title: "A", startedAt: 1 }, { id: "s2", title: "B", startedAt: 2 }] };
  const local = { sessions: [{ id: "s2", title: "B local", startedAt: 2 }] };          // apagou s1, editou s2
  const remote = { sessions: [{ id: "s1", title: "A", startedAt: 1 }, { id: "s2", title: "B remoto", startedAt: 2 }, { id: "s3", title: "C", startedAt: 3 }] };
  const m = merge3(base, local, remote);
  assert.deepEqual(m.sessions.map((s) => s.id), ["s3", "s2"]);
  assert.equal(m.sessions[1].title, "B local");
  const m2 = merge3(base, base, { sessions: [base.sessions[1]] }); // apagado no servidor
  assert.deepEqual(m2.sessions.map((s) => s.id), ["s2"]);
});

test("banco central: revisão, 409, recorte do estudante e vídeos", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcstore-"));
  const users = { adm: { id: "u1", email: "ana@x.br", name: "Ana", role: "admin" }, est: { id: "u2", email: "eva@x.br", name: "Eva", role: "estudante" }, out: { id: "u3", email: "rui@x.br", name: "Rui", role: "estudante" }, doc: { id: "u4", email: "bia@x.br", name: "Bia", role: "docente" } };
  const need = () => (req, res, next) => { const u = users[(req.headers.authorization || "").slice(7)]; if (!u) return res.status(401).end(); req.auth = { user: u }; next(); };
  const store = createStore({ dataDir: dir, need });
  const app = express(); app.use("/api/data", store.router);
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/data`;
  const call = async (tok, method, p, body, raw) => { const r = await fetch(base + p, { method, headers: { Authorization: "Bearer " + tok, ...(raw ? {} : { "Content-Type": "application/json" }) }, body: raw ? body : body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {} return { status: r.status, j }; };
  const db = { people: [{ id: "p1", name: "Eva", email: "eva@x.br", role: "estudante" }, { id: "p2", name: "Rui", email: "rui@x.br", role: "estudante", cpf: "segredo" }],
    courses: [], reservations: [], patients: [{ id: "pt" }], stock: [{ id: "it" }],
    sessions: [{ id: "s1", participantIds: ["p1"], media: [{ id: "m1" }], results: [] }, { id: "s2", participantIds: ["p2"], media: [{ id: "m2" }], results: [] }] };
  try {
    assert.equal((await call("x", "GET", "/db")).status, 401);
    let r = await call("adm", "GET", "/db"); assert.equal(r.j.rev, 0); assert.equal(r.j.db, null);
    r = await call("est", "PUT", "/db", { db, baseRev: 0 }); assert.equal(r.status, 403, "estudante não cria a base");
    r = await call("adm", "PUT", "/db", { db, baseRev: 0 }); assert.equal(r.j.rev, 1);
    r = await call("adm", "PUT", "/db", { db, baseRev: 0 }); assert.equal(r.status, 409); assert.equal(r.j.rev, 1); assert.equal(r.j.db.sessions.length, 2);
    assert.equal((await call("adm", "GET", "/db?rev=1")).j.same, true);
    r = await call("est", "GET", "/db"); const v = r.j.db;
    assert.deepEqual(v.sessions.map((s) => s.id), ["s1"]); assert.equal(v.patients.length, 0); assert.equal(v.stock.length, 0);
    assert.equal(v.people.some((p) => p.cpf), false, "dados de colegas não vazam");
    // estudante tenta apagar sessões e forjar avaliação de colega: só a própria avaliação entra
    const forged = { ...v, sessions: [{ ...v.sessions[0], results: [{ id: "r1", subjectId: "p1" }, { id: "r2", subjectId: "p2" }] }] };
    r = await call("est", "PUT", "/db", { db: forged, baseRev: 1 }); assert.equal(r.j.rev, 2);
    const doc = store._doc().db; assert.equal(doc.sessions.length, 2); assert.deepEqual(doc.sessions[0].results.map((x) => x.id), ["r1"]); assert.equal(doc.patients.length, 1);
    // docente: não recebe o almoxarifado e, ao gravar, não o apaga
    r = await call("doc", "GET", "/db"); assert.equal(r.j.db.stock.length, 0); assert.equal(r.j.db.patients.length, 1); assert.equal(r.j.db.sessions.length, 0, "docente não vê sessões alheias");
    r = await call("doc", "PUT", "/db", { db: { ...r.j.db, stock: [], locations: [{ id: "l1" }] }, baseRev: 2 }); assert.equal(r.j.rev, 3);
    assert.equal(store._doc().db.stock.length, 1); assert.equal(store._doc().db.locations.length, 1);
    assert.equal((await call("adm", "GET", "/db")).j.db.stock.length, 1);
    // sessões, avaliações e pessoas do docente
    { let d = (await call("doc", "GET", "/db")).j;
      const db2 = { ...d.db, sessions: [{ id: "sB", participantIds: [], media: [{ id: "mB" }], results: [] }], evaluations: [{ id: "evB", title: "Minha" }],
        people: [{ id: "px", name: "Intruso", email: "x@x.br" }, { id: "pb", name: "Bia", email: "bia@x.br" }] };
      await call("doc", "PUT", "/db", { db: db2, baseRev: d.rev });
      const sv = store._doc().db;
      assert.deepEqual(sv.sessions.map((x) => x.id).sort(), ["s1", "s2", "sB"], "sessões alheias preservadas");
      assert.equal(sv.sessions.find((x) => x.id === "sB").ownerEmail, "bia@x.br");
      assert.equal(sv.people.some((p) => p.id === "px"), false, "docente não cadastra pessoas"); assert.equal(sv.people.some((p) => p.id === "pb"), true, "mas entra o próprio cadastro");
      d = (await call("doc", "GET", "/db")).j; assert.deepEqual(d.db.sessions.map((x) => x.id), ["sB"]); assert.deepEqual(d.db.evaluations.map((x) => x.id), ["evB"]);
      assert.equal((await call("doc", "GET", "/media/m1")).status, 404, "vídeo de sessão alheia");
      assert.equal((await call("doc", "PUT", "/media/m1/0", Buffer.from("x"), true)).status, 403);
      assert.equal((await call("doc", "PUT", "/media/mB/0", Buffer.from("x"), true)).status, 200);
    }
    // áreas do conhecimento e aprovação de cenários
    { let cur = store._doc();
      const db3 = { ...cur.db, people: [...cur.db.people.filter((p) => p.email !== "bia@x.br"), { id: "pb", name: "Bia", email: "bia@x.br", role: "docente", areas: ["Saúde mental"] }],
        scenarios: [{ id: "scMH", libKey: "mh", title: "Crise" }, { id: "scPCR", libKey: "pcr", title: "PCR" }, { id: "scOutro", title: "De outro docente", area: "Saúde mental", ownerEmail: "zeca@x.br", ownerRole: "docente", status: "aprovado" }] };
      await call("adm", "PUT", "/db", { db: db3, baseRev: cur.rev });
      let d = (await call("doc", "GET", "/db")).j;
      assert.deepEqual(d.db.scenarios.map((x) => x.id), ["scMH"], "só a área dele e nada de outros docentes");
      await call("doc", "PUT", "/db", { db: { ...d.db, scenarios: [...d.db.scenarios, { id: "scNovo", title: "Meu", status: "aprovado", image: "data:image/jpeg;base64,AAAA" }] }, baseRev: d.rev });
      let sc = store._doc().db.scenarios; assert.equal(sc.find((x) => x.id === "scNovo").status, "pendente");
      assert.equal(sc.find((x) => x.id === "scNovo").image, undefined, "docente não envia imagem nova"); assert.equal(sc.length, 4, "cenários alheios preservados");
      cur = store._doc(); await call("adm", "PUT", "/db", { db: { ...cur.db, scenarios: cur.db.scenarios.map((x) => (x.id === "scNovo" ? { ...x, status: "aprovado" } : x)) }, baseRev: cur.rev });
      d = (await call("doc", "GET", "/db")).j;
      await call("doc", "PUT", "/db", { db: d.db, baseRev: d.rev }); assert.equal(store._doc().db.scenarios.find((x) => x.id === "scNovo").status, "aprovado", "sem mudança continua aprovado");
      d = (await call("doc", "GET", "/db")).j;
      await call("doc", "PUT", "/db", { db: { ...d.db, scenarios: d.db.scenarios.map((x) => (x.id === "scNovo" ? { ...x, title: "Meu v2" } : x)) }, baseRev: d.rev });
      assert.equal(store._doc().db.scenarios.find((x) => x.id === "scNovo").status, "pendente", "alteração volta para aprovação");
      d = (await call("doc", "GET", "/db")).j;
      await call("doc", "PUT", "/db", { db: { ...d.db, scenarios: [] }, baseRev: d.rev }); assert.deepEqual(store._doc().db.scenarios.map((x) => x.id), ["scMH", "scPCR", "scOutro"], "apaga só o próprio");
    }
    // reservas: docente cria (pendente) e altera só as próprias
    let d = (await call("doc", "GET", "/db")).j.db;
    const alheia = { id: "rA", title: "Do admin", start: "2026-12-01T10:00", end: "2026-12-01T11:00", status: "aprovada", createdByEmail: "ana@x.br" };
    let cur = store._doc(); await call("adm", "PUT", "/db", { db: { ...cur.db, reservations: [alheia] }, baseRev: cur.rev });
    d = (await call("doc", "GET", "/db")).j;
    const minha = { id: "rB", title: "Minha", start: "2026-12-02T10:00", end: "2026-12-02T11:00", status: "aprovada" };
    r = await call("doc", "PUT", "/db", { db: { ...d.db, reservations: [{ ...alheia, title: "Editada", status: "recusada" }, minha] }, baseRev: d.rev });
    let rs = store._doc().db.reservations; assert.equal(rs.find((x) => x.id === "rA").title, "Do admin"); assert.equal(rs.find((x) => x.id === "rB").status, "pendente"); assert.equal(rs.find((x) => x.id === "rB").createdByEmail, "bia@x.br");
    d = (await call("doc", "GET", "/db")).j;
    await call("doc", "PUT", "/db", { db: { ...d.db, reservations: [] }, baseRev: d.rev }); // tenta apagar tudo
    rs = store._doc().db.reservations; assert.deepEqual(rs.map((x) => x.id), ["rA"], "apaga só a própria");
    const masked = (await call("doc", "GET", "/db")).j.db.reservations.find((x) => x.id === "rA");
    assert.equal(masked.title, "Reservado"); assert.equal(masked.notes, undefined); assert.equal(masked.courseId, undefined);
    // vídeos
    assert.equal((await call("est", "PUT", "/media/m1/0", Buffer.from("abc"), true)).status, 403);
    assert.equal((await call("adm", "PUT", "/media/m1/0", Buffer.from("abc"), true)).status, 200);
    await call("adm", "PUT", "/media/m1/1", Buffer.from("def"), true);
    assert.deepEqual((await call("est", "GET", "/media/m1")).j.chunks, [0, 1]);
    const rr = await fetch(base + "/media/m1/1", { headers: { Authorization: "Bearer est" } }); assert.equal(await rr.text(), "def");
    assert.equal((await call("out", "GET", "/media/m1")).status, 404, "colega não vê o vídeo de outra sessão");
    assert.equal((await call("adm", "GET", "/media/..%2F..%2Fetc")).status, 400);
    assert.equal((await call("est", "DELETE", "/media/m1")).status, 403);
    assert.equal((await call("adm", "DELETE", "/media/m1")).status, 200);
    assert.deepEqual((await call("adm", "GET", "/media/m1")).j.chunks, []);
    // persiste após reinício
    assert.ok(createStore({ dataDir: dir, need })._doc().rev >= 6);
    assert.ok(fs.readdirSync(path.join(dir, "backups")).length >= 1);
  } finally { srv.close(); }
});
