/* HELSIM – banco de dados central (sincronização entre computadores).
 *
 * O navegador continua trabalhando com a cópia local (IndexedDB, funciona
 * offline) e sincroniza com este servidor: o documento de dados inteiro tem
 * um número de revisão; cada envio informa a revisão em que se baseou e, se
 * outra pessoa gravou antes, o servidor responde 409 com a versão atual para
 * o navegador mesclar item a item e reenviar. Vídeos vão em blocos binários.
 *
 * Permissões: administrador lê e grava tudo. Docente recebe só as próprias sessões e avaliações (e as
 * avaliações vinculadas a cenários), os cenários das áreas dele, reservas alheias sem detalhes e sem almoxarifado; ao gravar, só alteram-se as próprias sessões,
 * avaliações e reservas, e pessoas ficam com o administrador (o que ele não vê é preservado). Estudante recebe só
 * as próprias sessões, cursos e reservas, e só consegue acrescentar as próprias
 * avaliações (autoavaliação e reflexão) nas sessões de que participou.
 * Cópias de segurança automáticas em data/backups (no máximo uma a cada 10 min).
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const { scenarioArea, isAdminItem, isApproved } = require("./public/helsim-areas.js");

function createStore({ dataDir, need }) {
  const file = path.join(dataDir, "db.json"), mediaDir = path.join(dataDir, "media"), bkDir = path.join(dataDir, "backups");
  fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(bkDir, { recursive: true });
  let doc = { rev: 0, db: null, updatedAt: 0, by: "" };
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  let lastBackup = 0;
  function persist() {
    const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 }); fs.renameSync(tmp, file);
    if (Date.now() - lastBackup > 10 * 60 * 1000) {
      lastBackup = Date.now();
      fs.copyFileSync(file, path.join(bkDir, `db-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
      const all = fs.readdirSync(bkDir).filter((f) => f.endsWith(".json")).sort();
      for (const f of all.slice(0, Math.max(0, all.length - 30))) fs.unlinkSync(path.join(bkDir, f));
    }
  }
  const personOf = (db, user) => (db && db.people || []).find((p) => (p.email || "").toLowerCase() === user.email);
  /** Recorte do banco visível para um estudante. */
  function studentView(db, user) {
    if (!db) return null;
    const me = personOf(db, user), id = me && me.id;
    const sessions = (db.sessions || []).filter((s) => id && (s.participantIds || []).includes(id));
    const courses = (db.courses || []).filter((c) => id && (c.participantIds || []).includes(id));
    const cIds = new Set(courses.map((c) => c.id));
    const peopleIds = new Set([id, ...sessions.flatMap((s) => s.participantIds || []), ...courses.flatMap((c) => c.facultyIds || [])]);
    return { ...db, sessions, courses, reservations: (db.reservations || []).filter((r) => cIds.has(r.courseId)),
      people: (db.people || []).filter((p) => peopleIds.has(p.id)).map((p) => (p.id === id ? p : { id: p.id, name: p.name, role: p.role })),
      patients: [], stock: [], movements: [], cabinets: [] };
  }
  const canWriteAll = (u) => u.role === "admin" || u.role === "docente";
  // Almoxarifado (armários, estoque, movimentações): somente administrador.
  const LAB = ["cabinets", "stock", "movements"];
  const viewFor = (u, db) => {
    if (!db) return null;
    if (u.role === "admin") return db;
    if (u.role === "docente") return docenteView(db, u);
    return studentView(db, u);
  };
  const sessionAllowed = (u, sid) => { if (u.role === "admin") return true;
    if (u.role === "docente") return owns((doc.db && doc.db.sessions || []).find((x) => x.id === sid), u); const me = personOf(doc.db, u); const s = (doc.db && doc.db.sessions || []).find((x) => x.id === sid); return !!(me && s && (s.participantIds || []).includes(me.id)); };
  const mediaSession = (mid) => (doc.db && doc.db.sessions || []).find((s) => (s.media || []).some((m) => m.id === mid));

  const owns = (x, u) => !!x && x.ownerEmail === u.email;
  /** Recorte do docente: só as próprias sessões e avaliações (mais as avaliações vinculadas aos cenários,
   *  para poder usá-las), sem almoxarifado. */
  function docenteView(db, u) {
    const me = personOf(db, u), areas = (me && me.areas) || [];
    const sessions = (db.sessions || []).filter((x) => owns(x, u));
    // cenários: os próprios e os do administrador aprovados nas áreas do docente
    const scenarios = (db.scenarios || []).filter((c) => owns(c, u) || (isAdminItem(c) && isApproved(c) && areas.includes(scenarioArea(c))));
    const need = new Set([...scenarios.flatMap((c) => c.evaluationIds || []), ...sessions.flatMap((x) => (x.results || []).map((y) => y.evaluationId))]);
    const evaluations = (db.evaluations || []).filter((e) => owns(e, u) || (isAdminItem(e) && (need.has(e.id))));
    // reservas de outras pessoas: só o horário e a sala
    const reservations = (db.reservations || []).map((x) => (x.createdByEmail === u.email ? x
      : { id: x.id, title: "Reservado", start: x.start, end: x.end, locationId: x.locationId, resourceIds: x.resourceIds || [], recur: x.recur, status: x.status, color: "#94A3B8", masked: true }));
    const v = { ...db, sessions, scenarios, evaluations, reservations };
    for (const k of LAB) v[k] = [];
    return v;
  }
  /** Itens com dono: os dos outros ficam como estão no servidor; os próprios e os novos vêm do envio. */
  /** approval: o que o docente cria ou altera fica "pendente" até o administrador aprovar. */
  function mergeOwned(server, incoming, u, allowDelete, approval) {
    const inc = new Map((incoming || []).map((x) => [x.id, x])), out = [];
    const strip = (x) => { const y = { ...x }; delete y.status; delete y.reviewedBy; delete y.reviewedAt; return JSON.stringify(y); };
    for (const old of server || []) {
      if (!owns(old, u)) { out.push(old); continue; }
      const x = inc.get(old.id);
      if (!x) { if (!allowDelete) out.push(old); continue; }
      const y = { ...x, ownerEmail: u.email, ownerRole: "docente" };
      if (approval) { y.status = strip(x) === strip(old) ? old.status : "pendente"; if (y.status === "pendente") { delete y.reviewedBy; delete y.reviewedAt; } }
      out.push(y);
    }
    const known = new Set((server || []).map((x) => x.id));
    for (const x of incoming || []) if (!known.has(x.id)) { const y = { ...x, ownerEmail: u.email, ownerRole: "docente" }; if (approval) { y.status = "pendente"; delete y.reviewedBy; delete y.reviewedAt; } out.push(y); }
    return out;
  }
  /** imagem do cenário é só do administrador: o que o docente envia é trocado pela imagem que já está no servidor */
  function withServerImages(server, incoming) {
    const img = new Map((server || []).map((x) => [x.id, x.image]));
    return (incoming || []).map((x) => { const y = { ...x }; delete y.image; if (img.get(x.id)) y.image = img.get(x.id); return y; });
  }
  /** foto do paciente simulado também é só do administrador */
  function withServerPhotos(server, incoming) {
    const ph = new Map((server || []).map((x) => [x.id, x.photo]));
    return (incoming || []).map((x) => { const y = { ...x }; delete y.photo; if (ph.get(x.id)) y.photo = ph.get(x.id); return y; });
  }
  function docenteWrite(keep, db, u) {
    const out = { ...db, patients: withServerPhotos(keep.patients, db.patients),
      sessions: mergeOwned(keep.sessions, db.sessions, u, false, false),
      scenarios: mergeOwned(keep.scenarios, withServerImages(keep.scenarios, db.scenarios), u, true, true),
      evaluations: mergeOwned(keep.evaluations, db.evaluations, u, true, true),
      reservations: docenteReservations(keep.reservations || [], db.reservations || [], u),
      people: [...(keep.people || [])] };
    // única pessoa que o docente pode incluir: ele mesmo, no primeiro acesso
    if (!out.people.some((p) => (p.email || "").toLowerCase() === u.email)) { const me = (db.people || []).find((p) => (p.email || "").toLowerCase() === u.email); if (me) out.people.push(me); }
    for (const k of LAB) out[k] = keep[k] || [];
    return out;
  }
  /** Docente cria reservas (sempre pendentes) e altera só as próprias; as dos outros ficam como estão no servidor.
   *  Mudança de horário, sala, recursos ou recorrência numa reserva própria volta para "pendente". */
  const RES_KEYS = ["start", "end", "locationId", "resourceIds", "recur"];
  function docenteReservations(server, incoming, u) {
    const inc = new Map(incoming.map((x) => [x.id, x])), out = [];
    for (const old of server) {
      const mine = old.createdByEmail === u.email, x = inc.get(old.id);
      if (!mine) { out.push(old); continue; }
      if (!x) continue; // excluiu a própria reserva
      const moved = RES_KEYS.some((k) => JSON.stringify(x[k]) !== JSON.stringify(old[k]));
      out.push({ ...x, createdByEmail: u.email, status: moved ? "pendente" : old.status });
    }
    const known = new Set(server.map((x) => x.id));
    for (const x of incoming) if (!known.has(x.id)) out.push({ ...x, createdByEmail: u.email, createdBy: x.createdBy || u.name, status: "pendente" });
    return out;
  }
  const r = express.Router();
  r.use(need());
  r.get("/db", (req, res) => {
    const u = req.auth.user;
    if (req.query.rev !== undefined && +req.query.rev === doc.rev) return res.json({ rev: doc.rev, same: true });
    res.json({ rev: doc.rev, updatedAt: doc.updatedAt, by: doc.by, db: viewFor(u, doc.db) });
  });
  r.put("/db", express.json({ limit: "50mb" }), (req, res) => {
    const u = req.auth.user, { db, baseRev } = req.body || {};
    if (!db || typeof db !== "object" || !Array.isArray(db.sessions)) return res.status(400).json({ error: "Dados inválidos." });
    if (+baseRev !== doc.rev) return res.status(409).json({ rev: doc.rev, db: viewFor(u, doc.db) });
    if (u.role === "admin") doc.db = db;
    else if (u.role === "docente") doc.db = docenteWrite(doc.db || {}, db, u);
    else {
      // estudante: aceita só avaliações novas feitas por ele nas próprias sessões
      if (!doc.db) return res.status(403).json({ error: "Somente docentes e administradores criam a base." });
      const me = personOf(doc.db, u);
      for (const s of db.sessions) {
        const target = doc.db.sessions.find((x) => x.id === s.id);
        if (!me || !target || !(target.participantIds || []).includes(me.id)) continue;
        target.results = target.results || [];
        for (const x of s.results || []) if (!target.results.some((y) => y.id === x.id) && x.subjectId === me.id) target.results.push(x);
      }
    }
    doc.rev++; doc.updatedAt = Date.now(); doc.by = u.name; persist();
    res.json({ rev: doc.rev, adjusted: u.role !== "admin" }); // não-admin: o servidor pode ter ajustado o envio
  });
  const safe = (s) => /^[A-Za-z0-9_-]{1,80}$/.test(s);
  r.get("/media/:id", (req, res) => {
    const id = req.params.id; if (!safe(id)) return res.status(400).end();
    const s = mediaSession(id); if (!s || !sessionAllowed(req.auth.user, s.id)) return res.status(404).json({ chunks: [] });
    const dir = path.join(mediaDir, id);
    const chunks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+\.bin$/.test(f)).map((f) => +f.slice(0, -4)).sort((a, b) => a - b) : [];
    res.json({ chunks });
  });
  r.get("/media/:id/:seq", (req, res) => {
    const { id, seq } = req.params; if (!safe(id) || !/^\d{1,7}$/.test(seq)) return res.status(400).end();
    const s = mediaSession(id); if (!s || !sessionAllowed(req.auth.user, s.id)) return res.status(404).end();
    const f = path.join(mediaDir, id, `${+seq}.bin`); if (!fs.existsSync(f)) return res.status(404).end();
    res.type("application/octet-stream").sendFile(f);
  });
  r.put("/media/:id/:seq", express.raw({ type: () => true, limit: "60mb" }), (req, res) => {
    const { id, seq } = req.params; if (!safe(id) || !/^\d{1,7}$/.test(seq)) return res.status(400).end();
    if (!canWriteAll(req.auth.user)) return res.status(403).json({ error: "Apenas docentes e administradores enviam vídeos." });
    { const s = mediaSession(id); if (s && !sessionAllowed(req.auth.user, s.id)) return res.status(403).end(); }
    if (!Buffer.isBuffer(req.body)) return res.status(400).end();
    const dir = path.join(mediaDir, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${+seq}.bin`), req.body); res.json({ ok: true });
  });
  r.delete("/media/:id", (req, res) => {
    const id = req.params.id; if (!safe(id)) return res.status(400).end();
    if (!canWriteAll(req.auth.user)) return res.status(403).end();
    { const s = mediaSession(id); if (s && !sessionAllowed(req.auth.user, s.id)) return res.status(403).end(); }
    fs.rmSync(path.join(mediaDir, id), { recursive: true, force: true }); res.json({ ok: true });
  });
  return { router: r, _doc: () => doc };
}
module.exports = { createStore };
