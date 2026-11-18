/* HelseCapture – banco de dados central (sincronização entre computadores).
 *
 * O navegador continua trabalhando com a cópia local (IndexedDB, funciona
 * offline) e sincroniza com este servidor: o documento de dados inteiro tem
 * um número de revisão; cada envio informa a revisão em que se baseou e, se
 * outra pessoa gravou antes, o servidor responde 409 com a versão atual para
 * o navegador mesclar item a item e reenviar. Vídeos vão em blocos binários.
 *
 * Permissões: docente e administrador leem e gravam tudo. Estudante recebe só
 * as próprias sessões, cursos e reservas, e só consegue acrescentar as próprias
 * avaliações (autoavaliação e reflexão) nas sessões de que participou.
 * Cópias de segurança automáticas em data/backups (no máximo uma a cada 10 min).
 */
const fs = require("fs");
const path = require("path");
const express = require("express");

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
  const sessionAllowed = (u, sid) => { if (canWriteAll(u)) return true; const me = personOf(doc.db, u); const s = (doc.db && doc.db.sessions || []).find((x) => x.id === sid); return !!(me && s && (s.participantIds || []).includes(me.id)); };
  const mediaSession = (mid) => (doc.db && doc.db.sessions || []).find((s) => (s.media || []).some((m) => m.id === mid));

  const r = express.Router();
  r.use(need());
  r.get("/db", (req, res) => {
    const u = req.auth.user;
    if (req.query.rev !== undefined && +req.query.rev === doc.rev) return res.json({ rev: doc.rev, same: true });
    res.json({ rev: doc.rev, updatedAt: doc.updatedAt, by: doc.by, db: canWriteAll(u) ? doc.db : studentView(doc.db, u) });
  });
  r.put("/db", express.json({ limit: "50mb" }), (req, res) => {
    const u = req.auth.user, { db, baseRev } = req.body || {};
    if (!db || typeof db !== "object" || !Array.isArray(db.sessions)) return res.status(400).json({ error: "Dados inválidos." });
    if (+baseRev !== doc.rev) return res.status(409).json({ rev: doc.rev, db: canWriteAll(u) ? doc.db : studentView(doc.db, u) });
    if (canWriteAll(u)) doc.db = db;
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
    res.json({ rev: doc.rev });
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
    if (!Buffer.isBuffer(req.body)) return res.status(400).end();
    const dir = path.join(mediaDir, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${+seq}.bin`), req.body); res.json({ ok: true });
  });
  r.delete("/media/:id", (req, res) => {
    const id = req.params.id; if (!safe(id)) return res.status(400).end();
    if (!canWriteAll(req.auth.user)) return res.status(403).end();
    fs.rmSync(path.join(mediaDir, id), { recursive: true, force: true }); res.json({ ok: true });
  });
  return { router: r, _doc: () => doc };
}
module.exports = { createStore };
