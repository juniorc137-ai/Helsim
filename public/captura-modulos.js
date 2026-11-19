/* ════════════════════════════════════════════════════════════════════════
 * HELSIM – módulos exclusivos de docente e administrador (almoxarifado: somente administrador)
 *
 *  1. Prontuário eletrônico simulado (prescrição, aprazamento, administração,
 *     histórico e sinais vitais com NEWS2), integrado às sessões ao vivo:
 *     cada administração ou aferição vira anotação na linha do tempo do
 *     debriefing.
 *  2. Helse Log: almoxarifado do laboratório (mapa dos armários, inventário,
 *     movimentações, etiquetas) e ocupação diária das salas a partir da agenda.
 *
 * A parte de regras (HC_CLIN) é pura e testada em Node; a interface usa as
 * funções globais do captura.html e é instalada por hcInstallModules().
 * ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  // ── Regras puras ─────────────────────────────────────────────────────────
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
  const fromMin = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
  /** "6, 18h, 08h30;22:00" → ["06:00","08:30","18:00","22:00"] */
  function parseTimes(s) {
    const out = String(s || "").split(/[\s,;]+/).filter(Boolean).map((x) => {
      x = x.trim().toLowerCase();
      if (/^\d{1,2}h?$/.test(x)) x = parseInt(x, 10) + ":00";
      x = x.replace(/h/, ":");
      const m = toMin(x); return m == null ? null : fromMin(m);
    }).filter(Boolean);
    return [...new Set(out)].sort((a, b) => toMin(a) - toMin(b));
  }
  /** Horários padrão a partir da frequência "N/Nh" (primeiro horário institucional 06:00). */
  function autoTimes(freq, first = "06:00") {
    const m = /(\d{1,2})\s*\/\s*\1\s*h/i.exec(String(freq || "")) || /(\d{1,2})\s*em\s*\1\s*h/i.exec(String(freq || ""));
    const f = toMin(first) ?? 360;
    if (m && +m[1] > 0 && +m[1] <= 24) { const out = []; for (let t = 0; t < 1440; t += +m[1] * 60) out.push(fromMin(f + t)); return out.sort((a, b) => toMin(a) - toMin(b)); }
    if (/1\s*x\s*\/?\s*dia|1x ao dia|di[aá]ria/i.test(freq)) return [fromMin(f)];
    if (/2\s*x\s*\/?\s*dia/i.test(freq)) return [fromMin(f), fromMin(f + 720)];
    return [];
  }
  /** Situação de um horário: administrada, suspensa, atrasada (passou da tolerância) ou pendente. */
  function doseStatus(d, clockMin, tol = 30) {
    if (d.status === "administrada" || d.status === "suspensa") return d.status;
    const t = toMin(d.time);
    return t != null && clockMin != null && clockMin - t > tol ? "atrasada" : "pendente";
  }
  /** NEWS2 (Royal College of Physicians), escala 1 de SpO2. Retorna null se faltar parâmetro. */
  function news2(v) {
    const n = (x) => (x === "" || x == null || isNaN(+x) ? null : +x);
    const fr = n(v.fr), sp = n(v.spo2), pas = n(v.pas), fc = n(v.fc), t = n(v.temp);
    if ([fr, sp, pas, fc, t].some((x) => x == null) || !v.avpu) return null;
    const parts = {
      fr: fr <= 8 ? 3 : fr <= 11 ? 1 : fr <= 20 ? 0 : fr <= 24 ? 2 : 3,
      spo2: sp <= 91 ? 3 : sp <= 93 ? 2 : sp <= 95 ? 1 : 0,
      o2: v.o2 ? 2 : 0,
      pas: pas <= 90 ? 3 : pas <= 100 ? 2 : pas <= 110 ? 1 : pas <= 219 ? 0 : 3,
      fc: fc <= 40 ? 3 : fc <= 50 ? 1 : fc <= 90 ? 0 : fc <= 110 ? 1 : fc <= 130 ? 2 : 3,
      avpu: v.avpu === "A" ? 0 : 3,
      temp: t <= 35 ? 3 : t <= 36 ? 1 : t <= 38 ? 0 : t <= 39 ? 1 : 2,
    };
    const score = Object.values(parts).reduce((a, b) => a + b, 0);
    const risk = score >= 7 ? "alto" : score >= 5 ? "médio" : Object.values(parts).includes(3) ? "baixo-médio" : "baixo";
    return { score, risk, parts };
  }
  /** Sinais de alerta clínicos independentes do NEWS2 (inclui hipertensão grave, ACOG 2020). */
  function vitalFlags(v) {
    const f = [];
    if (+v.pas >= 160 || +v.pad >= 110) f.push("PA em faixa grave (≥160/110)");
    else if (+v.pas >= 140 || +v.pad >= 90) f.push("PA elevada (≥140/90)");
    if (v.pas !== "" && v.pas != null && +v.pas <= 90) f.push("Hipotensão (PAS ≤90)");
    if (+v.fc > 120) f.push("Taquicardia (>120)"); else if (v.fc !== "" && v.fc != null && +v.fc < 50) f.push("Bradicardia (<50)");
    if (v.spo2 !== "" && v.spo2 != null && +v.spo2 < 92) f.push("Hipoxemia (SpO₂ <92%)");
    if (+v.fr >= 25 || (v.fr !== "" && v.fr != null && +v.fr <= 8)) f.push("FR crítica");
    if (+v.temp >= 38.1) f.push("Febre (≥38,1 °C)");
    return f;
  }
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // Sinônimos e reatividade cruzada mais comuns em prescrição (lista curta e explícita).
  const ALLERGY_GROUPS = {
    dipirona: ["dipirona", "metamizol"], metamizol: ["dipirona", "metamizol"],
    penicilina: ["penicilina", "amoxicilina", "ampicilina", "oxacilina", "piperacilina", "benzilpenicilina"],
    aas: ["aas", "acido acetilsalicilico", "aspirina"], aspirina: ["aas", "acido acetilsalicilico", "aspirina"], "acido acetilsalicilico": ["aas", "acido acetilsalicilico", "aspirina"],
    sulfa: ["sulfa", "sulfametoxazol", "sulfadiazina"], iodo: ["iodo", "iodado", "iodopovidona", "contraste"],
    latex: ["latex"], morfina: ["morfina"], heparina: ["heparina", "enoxaparina"], aines: ["ibuprofeno", "diclofenaco", "cetoprofeno", "naproxeno", "cetorolaco"],
  };
  /** Retorna os alérgenos registrados que aparecem na descrição do item. */
  function allergyHit(desc, allergies) {
    const d = " " + norm(desc).replace(/[^a-z0-9]+/g, " ") + " ";
    return String(allergies || "").split(/[,;/]+/).map((a) => a.trim()).filter((a) => a && !/^(nega|nenhum|nao|sem)/i.test(norm(a))).filter((a) => {
      const k = norm(a).replace(/^alergia\s*(a|:)?\s*/, "").trim();
      const terms = ALLERGY_GROUPS[k] || [k];
      return terms.some((t) => t.length >= 3 && d.includes(" " + t));
    });
  }
  const stockStatus = (i) => (i.stock <= 0 ? "empty" : i.stock < i.min ? "crit" : i.stock < i.min * 1.5 ? "warn" : "ok");
  /** Reposição sugerida: recompor até 1,5 × o estoque mínimo. */
  const reorderQty = (i) => (i.stock < i.min ? Math.ceil(i.min * 1.5) - i.stock : 0);
  /** Fração ocupada de uma janela [from,to) por intervalos (sobreposições contam uma vez). */
  function occupancy(intervals, from, to) {
    const iv = intervals.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    let tot = 0, cs = 0, ce = 0, open = false;
    for (const [a, b] of iv) { if (!open || a > ce) { if (open) tot += ce - cs; cs = a; ce = b; open = true; } else ce = Math.max(ce, b); }
    if (open) tot += ce - cs;
    return to > from ? tot / (to - from) : 0;
  }
  // ── Mescla de três vias (sincronização com o banco central) ───────────────
  const eqJ = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const idArr = (...as) => as.some(Array.isArray) && as.every((a) => a === undefined || (Array.isArray(a) && a.every((x) => isObj(x) && "id" in x)));
  /**
   * Mescla a versão local e a remota a partir da última versão comum (base).
   * Listas de objetos com id são mescladas item a item; objetos alterados dos
   * dois lados são mesclados campo a campo; num conflito real vale o local.
   * Itens iguais ao local mantêm a mesma referência (telas abertas não quebram).
   */
  function merge3(base, local, remote) {
    base = base || {}; local = local || {}; remote = remote || {};
    const out = {};
    for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const b = base[k], l = local[k], r = remote[k];
      if (idArr(l, r, b)) out[k] = mergeList(b || [], l || [], r || [], k);
      else if (!(k in local)) { if (!(k in base) || !eqJ(r, b)) out[k] = r; }
      else if (!(k in remote)) { if (!(k in base) || !eqJ(l, b)) out[k] = l; }
      else if (eqJ(l, b)) out[k] = eqJ(r, l) ? l : r;
      else if (eqJ(r, b) || eqJ(r, l)) out[k] = l;
      else out[k] = isObj(l) && isObj(r) ? merge3(isObj(b) ? b : {}, l, r) : l;
    }
    return out;
  }
  function mergeList(b, l, r, key) {
    const bm = new Map(b.map((x) => [x.id, x])), lm = new Map(l.map((x) => [x.id, x])), rm = new Map(r.map((x) => [x.id, x]));
    const pick = (id) => {
      const B = bm.get(id), L = lm.get(id), R = rm.get(id);
      if (L && R) { if (eqJ(L, R) || eqJ(R, B)) return L; if (eqJ(L, B)) return R; return merge3(B || {}, L, R); }
      if (L) return B && eqJ(L, B) ? null : L; // removido no servidor (sem alteração local) ou novo/alterado aqui
      if (R) return B && eqJ(R, B) ? null : R; // removido aqui (sem alteração remota) ou novo/alterado no servidor
      return null;
    };
    const out = [], seen = new Set();
    const order = key === "sessions" ? [...l, ...r] : [...r, ...l];
    for (const x of order) { if (seen.has(x.id)) continue; seen.add(x.id); const v = pick(x.id); if (v) out.push(v); }
    if (key === "sessions") out.sort((a, c) => (c.startedAt || 0) - (a.startedAt || 0));
    return out;
  }
  const HC_CLIN = { toMin, fromMin, parseTimes, autoTimes, doseStatus, news2, vitalFlags, allergyHit, stockStatus, reorderQty, occupancy, merge3 };
  root.HC_CLIN = HC_CLIN;
  if (typeof module !== "undefined" && module.exports) module.exports = HC_CLIN;
  if (typeof window === "undefined") return;

  // ════════════════════════════ INTERFACE ════════════════════════════════
  root.hcInstallModules = function () {
    const isStaff = () => STAFF.includes(UI.role);
    const isAdmin = () => UI.role === "admin"; // almoxarifado: somente administrador
    const nowHM = () => isoTime(Date.now());
    const S = (k, d) => (UI[k] === undefined ? (UI[k] = d) : UI[k]);
    const svg = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
    void svg;

    ICO.prontuario = '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 3v3h6V3"/><path d="M12 10v6M9 13h6"/>';
    ICO.almox = '<path d="M3 21V7l9-4 9 4v14"/><path d="M7 21v-8h10v8"/><path d="M7 17h10"/>';
    ICO.salas = '<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="8" height="7" rx="1"/><rect x="13" y="13" width="8" height="7" rx="1"/>';
    NAV.splice(NAV.length - 1, 0, ["Laboratório · restrito", [["prontuario", "Prontuário eletrônico", ["admin"]], ["simclin", "Monitor SimClin", ["admin"]], ["almox", "Almoxarifado", ["admin"]], ["salas", "Ocupação das salas", ["admin"]]]]);
    NAV[0][1].push(["simclin", "Monitor SimClin", ["docente"]]);
    ICO.simclin = '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M5 12h3l2-4 3 7 2-3h4"/><path d="M8 21h8"/>';
    Object.assign(VIEW_LABEL, { simclin: "Monitor SimClin", prontuario: "Prontuário eletrônico", almox: "Almoxarifado (Helse Log)", salas: "Ocupação das salas" });
    root.HC_NAV_BADGE = {
      almox: () => { if (!isAdmin()) return ""; const n = (DB.stock || []).filter((i) => i.stock < i.min).length; return n ? `<span class="badge" title="Itens com estoque crítico">${n}</span>` : ""; },
    };
    root.hcAdminAlerts = () => {
      if (!isAdmin()) return [];
      const n = (DB.stock || []).filter((i) => i.stock < i.min).length;
      return n ? [{ n, text: n > 1 ? "itens do almoxarifado abaixo do estoque mínimo" : "item do almoxarifado abaixo do estoque mínimo", view: "almox", btn: "Ver almoxarifado", bad: true }] : [];
    };

    // ═══════════════════════ PRONTUÁRIO ELETRÔNICO ═══════════════════════
    const ROUTES = ["VO", "SL", "IV", "IV contínuo", "IM", "SC", "Inalatória", "Tópica", "SNE", "Retal", "Outra"];
    const FREQS = ["Dose única", "1x/dia", "2x/dia", "4/4h", "6/6h", "8/8h", "12/12h", "24/24h", "Contínuo", "Se necessário (SOS)", "Outra"];
    const TYPES = { MED: "Medicamento", SOL: "Solução", CUID: "Cuidado", DIE: "Dieta" };
    const DELAY_REASONS = ["Paciente dormindo", "Em procedimento", "Vômito", "Condição clínica", "Ajuste de horário institucional", "Outro"];
    const SUSP_REASONS = ["Prescrição médica", "Contraindicação clínica", "Alergia/Intolerância", "Efeito adverso", "Paciente recusou", "Outro"];
    const isSOS = (it) => /SOS|necess/i.test(it.freq || "");
    const isCont = (it) => /cont[ií]nuo/i.test(it.freq || "") || /cont[ií]nuo/i.test(it.route || "");

    function curPt() {
      let p = byId("patients", UI.ehrPt);
      if (!p && DB.patients[0]) { p = DB.patients[0]; UI.ehrPt = p.id; }
      return p;
    }
    const clockOf = (p) => p.clock || nowHM();
    const itemOf = (p, id) => p.items.find((i) => i.id === id) || {};
    const drug = (it) => [it.desc, it.dose, it.route].filter(Boolean).join(" ");
    const dStat = (p, d) => HC_CLIN.doseStatus(d, toMin(clockOf(p)), p.tolerance ?? 30);
    function plog(p, kind, text, extra = {}) { p.log.unshift({ id: C.uid("pl"), at: Date.now(), clock: clockOf(p), kind, text, by: meLabel(), ...extra }); }
    function liveNote(p, label, text) {
      if (!LIVE.recording || !LIVE.session) return;
      if (p.scenarioId && LIVE.session.scenarioId && p.scenarioId !== LIVE.session.scenarioId) return;
      addAnn({ label, cat: "Prontuário", color: "#0E7490", text: `${text} · ${p.name}`, source: "prontuario" });
    }
    function newPatient() {
      return { id: C.uid("pt"), name: "", record: String(100000 + Math.floor(Math.random() * 900000)), encounter: String(900000 + Math.floor(Math.random() * 99999)), unit: "", bed: "",
        age: "", sex: "", weight: "", diagnosis: "", allergies: "", scenarioId: "", clock: "", tolerance: 30,
        rx: { number: String(40000 + Math.floor(Math.random() * 59999)), validUntil: new Date(Date.now() + DAY).toISOString(), status: "digitacao", prescriber: "" },
        items: [], doses: [], log: [], vitals: [] };
    }
    /** Liberação: cria os horários dos itens ativos e remove horários pendentes que saíram da prescrição. */
    function syncDoses(p) {
      let added = 0;
      for (const it of p.items) {
        const times = it.status === "ativo" && !isSOS(it) ? it.times || [] : [];
        p.doses = p.doses.filter((d) => d.itemId !== it.id || d.status !== "pendente" || times.includes(d.orig) || d.sos);
        for (const t of times) if (!p.doses.some((d) => d.itemId === it.id && d.orig === t)) { p.doses.push({ id: C.uid("d"), itemId: it.id, time: t, orig: t, status: "pendente", resp: "", delays: [] }); added++; }
        if (it.status === "suspenso") p.doses.forEach((d) => { if (d.itemId === it.id && d.status === "pendente") d.status = "suspensa"; });
      }
      return added;
    }
    const sortDoses = (a, b) => (toMin(a.time) ?? 0) - (toMin(b.time) ?? 0);
    function doseTag(st, cont) {
      return { administrada: `<span class="tag ok">${cont ? "Iniciada" : "Administrada"}</span>`, pendente: `<span class="tag warn">Pendente</span>`, atrasada: `<span class="tag bad">ATRASADA</span>`, suspensa: `<span class="tag">Suspensa</span>` }[st];
    }

    R.prontuario = () => {
      const p = curPt();
      if (!p) return `<h1>Prontuário eletrônico</h1><div class="card"><p>Prontuário simulado para os cenários: prescrição, aprazamento, checagem da administração, histórico e sinais vitais com escore NEWS2. Cada administração e aferição registrada durante uma sessão ao vivo entra como anotação na linha do tempo do debriefing.</p>
        <div class="row"><button class="btn primary" data-act="ehr-new">+ Paciente</button><button class="btn" data-act="ehr-demo">Carregar pacientes de exemplo</button></div></div>`;
      const tab = S("ehrTab", "apraz");
      const t = (id, l) => `<button class="${tab === id ? "on" : ""}" data-act="ehr-tab" data-t="${id}">${l}</button>`;
      const sc = byId("scenarios", p.scenarioId);
      const al = String(p.allergies || "").trim();
      return `<div class="between"><h1 style="margin:0">Prontuário eletrônico</h1><div class="row">
        <select data-change="ehr-pt" aria-label="Paciente">${DB.patients.map((x) => opt(x.id, `${x.name} · ${x.unit || "sem setor"}`, p.id)).join("")}</select>
        <button class="btn primary" data-act="ehr-new">+ Paciente</button><button class="btn" data-act="ehr-edit">Editar paciente</button><button class="btn" data-act="ehr-del">Excluir</button></div></div>
      <section class="ptb${p.photo ? " has-photo" : ""}">${p.photo ? `<img class="ptphoto" src="${esc(p.photo)}" alt="Foto do paciente simulado ${esc(p.name)}" title="Clique para ampliar" data-act="pt-zoom">` : ""}
        <div><span>Paciente</span><b>${esc(p.name)}</b><i>${esc([p.age && p.age + " anos", p.sex, p.weight && p.weight + " kg"].filter(Boolean).join(" · "))}</i></div>
        <div><span>Atendimento / Prontuário</span><b class="mono">${esc(p.encounter)} / ${esc(p.record)}</b><i>${esc(p.diagnosis || "")}</i></div>
        <div><span>Acomodação</span><b>${esc(p.unit || "—")}${p.bed ? " · Leito " + esc(p.bed) : ""}</b><i>${sc ? "Cenário: " + esc(sc.title) : "Sem cenário vinculado"}</i></div>
        <div><span>Avisos clínicos</span>${al && !/^(nega|nenhum|sem)/i.test(al) ? `<b class="alg">ALERGIA: ${esc(al.toUpperCase())}</b>` : `<b class="muted">Sem alergias registradas</b>`}</div>
        <div><span>Relógio do cenário</span><div class="row" style="gap:4px"><input type="time" data-change="ehr-clock" value="${esc(p.clock || "")}" aria-label="Hora do cenário" style="width:104px">
          <button class="btn sm" data-act="ehr-clock-add" data-m="15" title="Avançar 15 minutos">+15</button><button class="btn sm" data-act="ehr-clock-add" data-m="60" title="Avançar 1 hora">+1h</button><button class="btn sm ghost" data-act="ehr-clock-real" title="Usar a hora real">real</button></div>
          <i>${p.clock ? "Hora simulada" : "Hora real"} · tolerância ${p.tolerance ?? 30} min</i></div>
      </section>
      <div class="tabs">${t("apraz", "Medicações (aprazamento)")}${t("rx", "Prescrição")}${t("hist", "Histórico de medicações")}${t("sv", "Sinais vitais")}</div>
      ${({ apraz: ehrApraz, rx: ehrRx, hist: ehrHist, sv: ehrSV })[tab](p)}`;
    };

    function ehrApraz(p) {
      const now = toMin(clockOf(p));
      const doses = p.doses.filter((d) => d.status !== "suspensa").sort(sortDoses);
      const st = (d) => dStat(p, d);
      const cnt = { administrada: 0, pendente: 0, atrasada: 0 };
      doses.forEach((d) => { cnt[st(d)]++; });
      const turno = doses.filter((d) => d.status !== "pendente" || (toMin(d.time) ?? 0) <= now + 60);
      const prox = doses.filter((d) => d.status === "pendente" && (toMin(d.time) ?? 0) > now + 60);
      const sos = p.items.filter((i) => i.status === "ativo" && isSOS(i));
      const susp = p.items.filter((i) => i.status === "suspenso");
      const rxTag = p.rx.status === "liberada" ? "" : `<div class="conf" style="background:var(--warn-bg);border-color:var(--warn)">Prescrição Nº ${esc(p.rx.number)} em digitação: os horários só são aprazados após a liberação. <button class="btn sm" data-act="ehr-tab" data-t="rx">Abrir prescrição</button></div>`;
      const row = (d) => {
        const it = itemOf(p, d.itemId), s = st(d), cont = isCont(it);
        return `<tr class="dose ${s}"><td><input type="checkbox" data-change="ehr-adm" data-id="${d.id}" ${d.status === "administrada" ? "checked" : ""} aria-label="Checar administração de ${esc(it.desc)}"></td>
          <td><b>${esc(it.desc)}</b>${d.sos ? ' <span class="tag info">SOS</span>' : ""}</td><td>${esc(it.dose || "")}</td><td>${esc(it.route || "")}</td>
          <td class="mono">${cont ? "Contínuo · " : ""}${esc(d.time)}${d.orig && d.orig !== d.time ? `<br><span class="muted small">prev. ${esc(d.orig)}</span>` : ""}</td>
          <td>${doseTag(s, cont)}</td><td class="mono">${esc(d.givenAt || "–")}</td><td class="small">${esc(d.givenBy || d.resp || "")}</td>
          <td class="row" style="gap:4px">${d.status === "administrada" ? `<button class="btn sm" data-act="ehr-undo" data-id="${d.id}">Desfazer</button>` : `<button class="btn sm" data-act="ehr-apraz" data-id="${d.id}">Aprazar</button>`}
            ${d.status !== "administrada" ? `<button class="btn sm" data-act="ehr-susp" data-item="${it.id}">Suspender</button>` : ""}</td></tr>`;
      };
      return `${rxTag}<div class="between" style="margin-bottom:8px"><span class="muted small">Hora de referência <b class="mono">${esc(clockOf(p))}</b>. Horários com mais de ${p.tolerance ?? 30} min de atraso ficam como ATRASADA.</span>
        <div class="row"><button class="btn" data-act="ehr-turno">Editar aprazamento</button><button class="btn" data-act="ehr-report">Relatório</button></div></div>
      <div class="kpis">${kpi("Administradas", cnt.administrada)}${kpi("Pendentes", cnt.pendente)}${kpi("Atrasadas", cnt.atrasada)}${kpi("Itens suspensos", susp.length)}</div>
      <section class="card"><h2>Medicações do turno atual</h2>${turno.length ? `<div class="tbl"><table><tr><th>✓</th><th>Medicação</th><th>Dose</th><th>Via</th><th>Horário previsto</th><th>Status</th><th>Horário real</th><th>Responsável</th><th>Ações</th></tr>${turno.map(row).join("")}</table></div>` : `<div class="empty">Nenhum horário no turno.</div>`}</section>
      <div class="cols">
        <section class="card"><h2>Próximos horários de administração</h2>${prox.length ? `<div class="tbl"><table><tr><th>Horário</th><th>Medicação</th><th>Dose / via</th><th>Responsável</th><th></th></tr>${prox.map((d) => { const it = itemOf(p, d.itemId); return `<tr><td class="mono">${esc(d.time)}</td><td>${esc(it.desc)}</td><td>${esc([it.dose, it.route].filter(Boolean).join(" / "))}</td><td><input data-change="ehr-resp" data-id="${d.id}" value="${esc(d.resp || "")}" placeholder="Enf. responsável" style="width:150px"></td><td><button class="btn sm" data-act="ehr-apraz" data-id="${d.id}">Aprazar</button></td></tr>`; }).join("")}</table></div>` : `<div class="empty">Sem horários futuros.</div>`}</section>
        <section class="card"><h2>Se necessário (SOS)</h2>${sos.length ? `<ul class="plain">${sos.map((it) => `<li class="between" style="margin:0"><span><b>${esc(drug(it))}</b><br><span class="muted small">${esc(it.obs || it.freq)}</span></span><button class="btn sm rec-o" data-act="ehr-sos" data-item="${it.id}">Administrar agora</button></li>`).join("")}</ul>` : `<div class="empty">Nenhum item SOS prescrito.</div>`}</section>
      </div>
      <section class="card"><h2>Medicações suspensas</h2>${susp.length ? `<div class="tbl"><table><tr><th>Medicação</th><th>Motivo da suspensão</th><th>Data/hora</th><th>Suspenso por</th><th></th></tr>${susp.map((it) => `<tr><td>${esc(drug(it))}</td><td>${esc((it.susp || {}).reason || "")}${(it.susp || {}).obs ? `<br><span class="muted small">${esc(it.susp.obs)}</span>` : ""}</td><td>${esc((it.susp || {}).when || "")}</td><td>${esc((it.susp || {}).by || "")}</td><td><button class="btn sm" data-act="ehr-react" data-item="${it.id}">Reativar</button></td></tr>`).join("")}</table></div>` : `<div class="empty">Nenhuma medicação suspensa.</div>`}</section>`;
    }

    function ehrRx(p) {
      const sel = UI.ehrItem;
      const lib = p.rx.status === "liberada";
      const valid = new Date(p.rx.validUntil), expired = +valid < Date.now();
      return `<div class="card"><div class="between" style="margin:0;align-items:center"><div><b>Prescrição Nº ${esc(p.rx.number)}</b> · válida até ${esc(fmtDT(+valid))} ${expired ? '<span class="tag bad">vencida</span>' : ""}
          · ${lib ? `<span class="tag ok">LIBERADA</span> <span class="muted small">por ${esc(p.rx.releasedBy || "")} em ${esc(p.rx.releasedAt ? fmtDT(p.rx.releasedAt) : "")}</span>` : '<span class="tag warn">Em digitação</span>'}
          <br><span class="muted small">Prescritor: ${esc(p.rx.prescriber || "—")}</span></div>
        <div class="row"><button class="btn" data-act="ehr-rxhead">Cabeçalho</button><button class="btn primary" data-act="ehr-release" ${lib ? "disabled" : ""}>Liberar</button></div></div></div>
      <div class="row" style="margin-bottom:10px"><button class="btn primary" data-act="ehr-item">+ Incluir item</button><button class="btn" data-act="ehr-item" data-id="${esc(sel || "")}" ${sel ? "" : "disabled"}>Editar item</button>
        <button class="btn" data-act="ehr-susp" data-item="${esc(sel || "")}" ${sel && itemOf(p, sel).status === "ativo" ? "" : "disabled"}>Suspender item</button><button class="btn" data-act="ehr-rxprint">Imprimir</button></div>
      ${p.items.length ? `<div class="tbl"><table><tr><th></th><th>Seq</th><th>Tipo</th><th>Descrição</th><th>Dose</th><th>Via</th><th>Frequência</th><th>Horários</th><th>Status</th></tr>
        ${p.items.map((it, i) => `<tr class="click" data-act="ehr-rxsel" data-id="${it.id}"><td><input type="radio" name="rxsel" ${sel === it.id ? "checked" : ""} tabindex="-1" aria-label="Selecionar item ${i + 1}"></td><td>${i + 1}</td><td>${esc(it.type)}</td><td><b>${esc(it.desc)}</b>${it.obs ? `<br><span class="muted small">${esc(it.obs)}</span>` : ""}${it.allergyOverride ? `<br><span class="tag bad">alergia registrada: ciência do prescritor</span>` : ""}</td>
          <td>${esc(it.dose || "")}</td><td>${esc(it.route || "")}</td><td>${esc(it.freq || "")}</td><td class="mono small">${esc((it.times || []).join(" · ") || (isSOS(it) ? "SOS" : "—"))}</td>
          <td>${it.status === "ativo" ? '<span class="tag info">Ativo</span>' : '<span class="tag">Suspenso</span>'}</td></tr>`).join("")}</table></div>` : `<div class="empty">Nenhum item prescrito.</div>`}
      <p class="muted small" style="margin-top:8px">Os horários dos itens “N/Nh”, “1x/dia” e “2x/dia” são sugeridos a partir das 06:00 quando não informados. Incluir ou editar itens devolve a prescrição para digitação; a liberação atualiza o aprazamento sem apagar o que já foi administrado. Itens que coincidem com a alergia registrada (incluindo sinônimos, como dipirona e metamizol) exigem confirmação.</p>`;
    }

    function ehrHist(p) {
      const adm = p.log.filter((l) => ["adm", "desfeita", "sos"].includes(l.kind));
      const other = p.log.filter((l) => !["adm", "desfeita", "sos", "sv"].includes(l.kind));
      return `<div class="row end" style="margin-bottom:8px"><button class="btn" data-act="ehr-histcsv">Exportar CSV</button></div>
      <section class="card"><h2>Medicações ativas</h2>${p.items.filter((i) => i.status === "ativo").length ? `<div class="tbl"><table><tr><th>Medicação</th><th>Dose</th><th>Via</th><th>Frequência</th><th>Início</th><th>Status</th><th>Observações</th></tr>
        ${p.items.filter((i) => i.status === "ativo").map((it) => `<tr><td>${esc(it.desc)}</td><td>${esc(it.dose || "")}</td><td>${esc(it.route || "")}</td><td>${esc(it.freq || "")}</td><td>${esc(it.start ? new Date(it.start + "T12:00").toLocaleDateString("pt-BR") : "")}</td><td><span class="tag ok">Ativa</span></td><td>${esc(it.obs || "")}</td></tr>`).join("")}</table></div>` : `<div class="empty">Nenhuma medicação ativa.</div>`}</section>
      <section class="card"><h2>Histórico de administrações</h2>${adm.length ? `<div class="tbl"><table><tr><th>Data/hora</th><th>Medicação</th><th>Dose</th><th>Via</th><th>Registro</th><th>Por</th><th>Observações</th></tr>
        ${adm.map((l) => `<tr><td class="mono small">${esc(new Date(l.at).toLocaleDateString("pt-BR"))} ${esc(l.clock)}</td><td>${esc(l.drug || "")}</td><td>${esc(l.dose || "")}</td><td>${esc(l.route || "")}</td><td>${l.kind === "desfeita" ? '<span class="tag warn">desfeita</span>' : l.kind === "sos" ? '<span class="tag info">SOS</span>' : '<span class="tag ok">administrada</span>'}</td><td>${esc(l.by || "")}</td><td>${esc(l.obs || "")}</td></tr>`).join("")}</table></div>` : `<div class="empty">Nenhuma administração registrada.</div>`}</section>
      <section class="card"><h2>Aprazamentos, suspensões e liberações</h2>${other.length ? `<ul class="plain">${other.map((l) => `<li><span class="mono small muted">${esc(new Date(l.at).toLocaleDateString("pt-BR"))} ${esc(l.clock)}</span> ${esc(l.text)} <span class="muted small">· ${esc(l.by || "")}</span></li>`).join("")}</ul>` : `<div class="empty">Sem registros.</div>`}</section>`;
    }

    function ehrSV(p) {
      const vs = [...p.vitals].sort((a, b) => b.at - a.at);
      const f = (id, label, ph, extra = "") => `<label class="f"><span>${label}</span><input type="number" id="sv-${id}" placeholder="${ph}" inputmode="decimal" ${extra}></label>`;
      const newsTag = (n) => (n ? `<span class="tag ${n.risk === "alto" ? "bad" : n.risk === "médio" || n.risk === "baixo-médio" ? "warn" : "ok"}" title="Risco ${esc(n.risk)}">${n.score} · ${esc(n.risk)}</span>` : '<span class="muted small">incompleto</span>');
      return `<section class="card"><h2>Registrar sinais vitais</h2>
        <div class="svf">${f("pas", "PA sistólica (mmHg)*", "120")}${f("pad", "PA diastólica (mmHg)*", "80")}${f("fc", "FC (bpm)*", "75")}${f("spo2", "SpO₂ (%)*", "98")}
        ${f("fr", "FR (irpm)", "16")}${f("temp", "Temperatura (°C)", "36,5", 'step="0.1"')}
        <label class="f"><span>Oxigênio</span><select id="sv-o2"><option value="">Ar ambiente</option><option value="1">O₂ suplementar</option></select></label>
        <label class="f"><span>Consciência (ACVPU)</span><select id="sv-avpu"><option value="A">A – alerta</option><option value="C">C – confusão nova</option><option value="V">V – responde à voz</option><option value="P">P – responde à dor</option><option value="U">U – não responde</option></select></label></div>
        <div class="row between" style="margin:0"><span class="muted small">* obrigatórios. Com FR e temperatura, o NEWS2 é calculado (escala 1 de SpO₂; Royal College of Physicians).</span><button class="btn primary" data-act="ehr-sv">Gravar</button></div></section>
      ${vs.length > 1 ? `<section class="card"><h2>Tendência</h2>${svChart([...vs].reverse())}</section>` : ""}
      <section class="card"><h2>Últimas aferições</h2>${vs.length ? `<div class="tbl"><table><tr><th>Data/hora</th><th>PA</th><th>FC</th><th>FR</th><th>SpO₂</th><th>T</th><th>O₂</th><th>ACVPU</th><th>NEWS2</th><th>Alertas</th><th>Anotador</th><th></th></tr>
        ${vs.map((v) => `<tr><td class="mono small">${esc(new Date(v.at).toLocaleDateString("pt-BR"))} ${esc(v.clock)}</td><td class="mono">${esc(v.pas)}/${esc(v.pad)}</td><td class="mono">${esc(v.fc)}</td><td class="mono">${esc(v.fr ?? "–")}</td><td class="mono">${esc(v.spo2)}%</td><td class="mono">${esc(v.temp ?? "–")}</td><td>${v.o2 ? "O₂" : "AA"}</td><td>${esc(v.avpu || "")}</td><td>${newsTag(v.news)}</td>
          <td class="small">${HC_CLIN.vitalFlags(v).map((x) => `<span class="tag bad" style="margin:1px">${esc(x)}</span>`).join(" ")}</td><td class="small">${esc(v.by || "")}</td><td><button class="btn sm" data-act="ehr-svdel" data-id="${v.id}" title="Excluir">✕</button></td></tr>`).join("")}</table></div>` : `<div class="empty">Nenhuma aferição registrada.</div>`}</section>`;
    }
    function svChart(vs) {
      const W = 1000, H = 200, L = 34, Rr = 10, T = 10, B = 24;
      const x = (i) => L + (vs.length === 1 ? 0 : (i * (W - L - Rr)) / (vs.length - 1));
      const y = (v) => T + (H - T - B) * (1 - (Math.max(30, Math.min(200, v)) - 30) / 170);
      const line = (k, c) => `<polyline fill="none" stroke="${c}" stroke-width="2" points="${vs.map((v, i) => `${x(i).toFixed(1)},${y(+v[k]).toFixed(1)}`).join(" ")}"/>` + vs.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(+v[k]).toFixed(1)}" r="3" fill="${c}"><title>${k.toUpperCase()} ${esc(v[k])} · ${esc(v.clock)}</title></circle>`).join("");
      const grid = [40, 80, 120, 160, 200].map((g) => `<line x1="${L}" x2="${W - Rr}" y1="${y(g)}" y2="${y(g)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(g) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${g}</text>`).join("");
      const lbl = vs.map((v, i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === vs.length - 1 ? "end" : "middle"}" font-size="10" fill="var(--muted)">${esc(v.clock)}</text>`).join("");
      return `<svg viewBox="0 0 ${W} ${H}" class="svc" role="img" aria-label="Tendência de PA, FC e SpO₂">${grid}${lbl}${line("pas", "var(--bp)")}${line("pad", "var(--hi)")}${line("fc", "var(--hr)")}${line("spo2", "var(--spo)")}</svg>
        <div class="legend"><span><i style="background:var(--bp)"></i>PAS</span><span><i style="background:var(--hi)"></i>PAD</span><span><i style="background:var(--hr)"></i>FC</span><span><i style="background:var(--spo)"></i>SpO₂</span></div>`;
    }

    function patientForm(p) {
      return `<div class="fg"><label class="f"><span>Nome (SOBRENOME, Nome)</span><input name="name" required value="${esc(p.name)}"></label>
        <label class="f"><span>Cenário vinculado</span><select name="scenarioId">${opts("scenarios", p.scenarioId, "(nenhum)")}</select></label>
        <label class="f"><span>Atendimento</span><input name="encounter" value="${esc(p.encounter)}"></label><label class="f"><span>Prontuário</span><input name="record" value="${esc(p.record)}"></label>
        <label class="f"><span>Setor / unidade</span><input name="unit" value="${esc(p.unit)}" placeholder="UTI cardiovascular"></label><label class="f"><span>Leito</span><input name="bed" value="${esc(p.bed)}"></label>
        <label class="f"><span>Idade (anos)</span><input name="age" type="number" min="0" max="120" value="${esc(p.age)}"></label><label class="f"><span>Sexo</span><select name="sex">${["", "Feminino", "Masculino", "Outro"].map((s) => opt(s, s || "—", p.sex)).join("")}</select></label>
        <label class="f"><span>Peso (kg)</span><input name="weight" type="number" step="0.1" min="0" value="${esc(p.weight)}"></label><label class="f"><span>Prescritor</span><input name="prescriber" value="${esc(p.rx.prescriber)}" placeholder="Nome e registro profissional"></label>
        <label class="f"><span>Relógio do cenário (vazio = hora real)</span><input name="clock" type="time" value="${esc(p.clock)}"></label><label class="f"><span>Tolerância para atraso (min)</span><input name="tolerance" type="number" min="0" max="240" value="${esc(p.tolerance ?? 30)}"></label></div>
        <label class="f"><span>Diagnóstico / hipótese</span><input name="diagnosis" value="${esc(p.diagnosis)}"></label>
        <label class="f"><span>Alergias (separe por vírgula; “Nega” se não houver)</span><input name="allergies" value="${esc(p.allergies)}"></label>`;
    }
    // foto do paciente: só o administrador inclui; recorte 4:5, 480×600 px, JPEG (fica no banco com o prontuário)
    let PT_IMG = "";
    function shrinkPatientPhoto(file) {
      return new Promise((ok, bad) => {
        const img = new Image(), url = URL.createObjectURL(file);
        img.onload = () => { const W = 480, H = 600, c = document.createElement("canvas"); c.width = W; c.height = H; const k = Math.max(W / img.width, H / img.height), w = img.width * k, h = img.height * k;
          c.getContext("2d").drawImage(img, (W - w) / 2, (H - h) / 3, w, h); URL.revokeObjectURL(url); ok(c.toDataURL("image/jpeg", 0.82)); };
        img.onerror = () => { URL.revokeObjectURL(url); bad(new Error("Não foi possível ler a imagem.")); };
        img.src = url;
      });
    }
    function patientPrompt(p) {
      const who = [p.age && `${p.age} anos`, p.sex && p.sex.toLowerCase()].filter(Boolean).join(", ");
      return `Fotografia realista, vertical 4:5, de um paciente simulado (ator ou manequim de simulação de alta fidelidade, nunca um paciente real) deitado em leito de ${p.unit || "UTI"} de um hospital-escola no Brasil${p.bed ? `, leito ${p.bed}` : ""}.` +
        `${who ? ` Paciente: ${who}.` : ""}${p.diagnosis ? ` Quadro clínico: ${p.diagnosis}; expressão e aparência coerentes com o quadro, sem exageros.` : ""}` +
        ` Cabeceira elevada a 30°, monitor multiparamétrico ao lado, acesso venoso periférico, oxímetro no dedo e pulseira de identificação sem texto legível. Iluminação hospitalar suave, paleta com azul-marinho e azul-claro.` +
        ` Enquadramento do tronco para cima, rosto visível, olhar natural. Sem texto, letras, logotipos ou marcas; sem sangue, ferimentos expostos ou nudez; retratado com dignidade.`;
    }
    function patientPhotoBlock(p) {
      if (!isAdmin()) return "";
      return `<div class="f"><span>Foto do paciente (somente administrador)</span>
        <div class="row" style="align-items:flex-start;gap:12px"><img id="pt-img-prev" class="ptphoto-prev" alt="" ${p.photo ? `src="${esc(p.photo)}"` : "hidden"}>
        <div class="row" style="flex-direction:column;align-items:flex-start;gap:6px"><label class="btn sm">Escolher foto<input type="file" accept="image/*" data-change="pt-photo" hidden></label>
        <button type="button" class="btn sm ghost" data-act="pt-photo-del">Remover foto</button>
        <button type="button" class="btn sm" data-act="pt-prompt" title="Copia um prompt para criar a foto no Gemini">Prompt para o Gemini</button>
        <span class="muted small">Recorte vertical 4:5. Use imagem gerada por IA ou de manequim/ator, nunca de paciente real.</span></div></div></div>`;
    }
    function openPatient(p) {
      const isNew = !DB.patients.includes(p);
      PT_IMG = p.photo || "";
      modal(isNew ? "Novo paciente simulado" : "Editar paciente", patientForm(p) + patientPhotoBlock(p), { onSubmit: (fd) => {
        if (isAdmin()) { if (PT_IMG) p.photo = PT_IMG; else delete p.photo; }
        ["name", "scenarioId", "encounter", "record", "unit", "bed", "age", "sex", "weight", "clock", "diagnosis", "allergies"].forEach((k) => { p[k] = String(fd.get(k) || "").trim(); });
        p.name = p.name.toUpperCase() || "PACIENTE SIMULADO"; p.tolerance = Math.max(0, +fd.get("tolerance") || 0); p.rx.prescriber = String(fd.get("prescriber") || "").trim();
        if (isNew) { DB.patients.push(p); UI.ehrPt = p.id; UI.ehrTab = "rx"; }
        save(); render(); toast(isNew ? "Paciente criado. Inclua os itens da prescrição." : "Paciente atualizado.");
      } });
    }
    function itemForm(it, hits) {
      return `<div class="fg"><label class="f"><span>Tipo</span><select name="type">${Object.entries(TYPES).map(([k, v]) => opt(k, `${k} – ${v}`, it.type)).join("")}</select></label>
        <label class="f"><span>Início</span><input type="date" name="start" value="${esc(it.start || isoDate(Date.now()))}"></label></div>
        <label class="f"><span>Descrição (princípio ativo e apresentação)</span><input name="desc" required value="${esc(it.desc || "")}" placeholder="Enoxaparina 40 mg/0,4 mL"></label>
        <div class="fg"><label class="f"><span>Dose</span><input name="dose" value="${esc(it.dose || "")}" placeholder="80 mg"></label>
        <label class="f"><span>Via</span><select name="route">${ROUTES.map((r) => opt(r, r, it.route || "VO")).join("")}</select></label>
        <label class="f"><span>Frequência</span><input name="freq" list="ehr-freqs" value="${esc(it.freq || "")}" placeholder="12/12h"><datalist id="ehr-freqs">${FREQS.map((f) => `<option value="${esc(f)}">`).join("")}</datalist></label>
        <label class="f"><span>Horários (ex.: 06:00, 18:00)</span><input name="times" value="${esc((it.times || []).join(", "))}" placeholder="vazio = sugestão pela frequência"></label></div>
        <label class="f"><span>Observações (diluição, tempo de infusão, critério do SOS)</span><input name="obs" value="${esc(it.obs || "")}"></label>
        ${hits && hits.length ? `<div class="conf"><b>Alerta de alergia:</b> o item coincide com a alergia registrada (${hits.map(esc).join(", ")}).<br><label><input type="checkbox" name="override"> Confirmo a prescrição com ciência da alergia</label></div>` : ""}`;
    }
    function openItem(p, it) {
      const isNew = !it;
      it = it || { id: C.uid("it"), type: "MED", status: "ativo", start: isoDate(Date.now()) };
      const submit = (fd) => {
        const cand = { ...it };
        ["type", "desc", "dose", "route", "freq", "obs", "start"].forEach((k) => { cand[k] = String(fd.get(k) || "").trim(); });
        if (!cand.desc) { toast("Informe a descrição do item."); return false; }
        let times = HC_CLIN.parseTimes(fd.get("times"));
        if (String(fd.get("times") || "").trim() && !times.length) { toast("Horários inválidos. Use HH:MM separados por vírgula."); return false; }
        if (!times.length && !isSOS(cand)) times = isCont(cand) ? [clockOf(p)] : HC_CLIN.autoTimes(cand.freq);
        if (!times.length && !isSOS(cand)) { toast("Informe ao menos um horário ou uma frequência N/Nh."); return false; }
        cand.times = isSOS(cand) ? [] : isCont(cand) ? times.slice(0, 1) : times;
        const hits = HC_CLIN.allergyHit(cand.desc, p.allergies);
        if (hits.length && !fd.get("override")) { modal("Alerta de alergia", itemForm(cand, hits), { onSubmit: submit }); return false; }
        cand.allergyOverride = hits.length ? hits.join(", ") : "";
        if (isNew) p.items.push(cand); else Object.assign(it, cand);
        UI.ehrItem = cand.id;
        const back = p.rx.status === "liberada";
        p.rx.status = "digitacao";
        plog(p, "item", `${isNew ? "Item incluído" : "Item editado"} na prescrição Nº ${p.rx.number}: ${drug(cand)} ${cand.freq ? "(" + cand.freq + ")" : ""}${cand.allergyOverride ? " — prescrito com ciência de alergia" : ""}`);
        save(); render(); toast(back ? "Item salvo. A prescrição voltou para digitação: libere para atualizar o aprazamento." : "Item salvo.");
      };
      modal(isNew ? "Incluir item na prescrição" : "Editar item da prescrição", itemForm(it), { onSubmit: submit });
    }
    function rxPrint(p) {
      const w = window.open("", "_blank");
      if (!w) return toast("Permita janelas pop-up para imprimir.");
      w.document.write(`<!doctype html><meta charset="utf-8"><title>Prescrição ${esc(p.rx.number)}</title><style>body{font:13px system-ui;margin:28px;color:#111}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left}th{background:#eef2f7}.al{color:#b00;font-weight:700}.sig{margin-top:48px;border-top:1px solid #333;width:280px;padding-top:4px}</style>
        <h1>Prescrição Nº ${esc(p.rx.number)} · ${p.rx.status === "liberada" ? "LIBERADA" : "EM DIGITAÇÃO"}</h1><div>Material de simulação clínica · HELSIM · ${esc(DB.settings.institution || "")}</div>
        <p><b>${esc(p.name)}</b> · Atendimento ${esc(p.encounter)} · Prontuário ${esc(p.record)} · ${esc(p.unit)} ${p.bed ? "Leito " + esc(p.bed) : ""}<br>${esc(p.diagnosis || "")}${p.allergies ? `<br><span class="al">ALERGIA: ${esc(p.allergies)}</span>` : ""}<br>Válida até ${esc(fmtDT(+new Date(p.rx.validUntil)))}</p>
        <table><tr><th>Seq</th><th>Tipo</th><th>Descrição</th><th>Dose</th><th>Via</th><th>Frequência</th><th>Horários</th><th>Status</th></tr>${p.items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.type)}</td><td>${esc(it.desc)}${it.obs ? "<br><small>" + esc(it.obs) + "</small>" : ""}</td><td>${esc(it.dose || "")}</td><td>${esc(it.route || "")}</td><td>${esc(it.freq || "")}</td><td>${esc((it.times || []).join(" · "))}</td><td>${it.status}</td></tr>`).join("")}</table>
        <div class="sig">${esc(p.rx.prescriber || "Prescritor")}</div><script>print()<\/script>`);
      w.document.close();
    }
    function reportHtml(p) {
      const doses = p.doses.slice().sort(sortDoses);
      const c = { administrada: 0, pendente: 0, atrasada: 0, suspensa: 0 };
      doses.forEach((d) => c[dStat(p, d)]++);
      const total = doses.filter((d) => d.status !== "suspensa").length;
      const due = doses.filter((d) => d.status !== "suspensa" && (toMin(d.time) ?? 0) <= toMin(clockOf(p)));
      const onTime = due.filter((d) => d.status === "administrada" && (toMin(d.givenAt) ?? 0) - (toMin(d.time) ?? 0) <= (p.tolerance ?? 30)).length;
      return { c, total, due: due.length, onTime, html: `<p class="muted small">${esc(p.name)} · hora de referência ${esc(clockOf(p))} · gerado por ${esc(meLabel())}</p>
        <div class="kpis">${kpi("Administradas", c.administrada)}${kpi("Pendentes", c.pendente)}${kpi("Atrasadas", c.atrasada)}${kpi("Pontualidade dos vencidos", due.length ? Math.round((onTime / due.length) * 100) + "%" : "—")}</div>
        <div class="tbl"><table><tr><th>Previsto</th><th>Medicação</th><th>Status</th><th>Real</th><th>Aprazamentos</th><th>Por</th></tr>${doses.map((d) => { const it = itemOf(p, d.itemId); return `<tr><td class="mono">${esc(d.time)}</td><td>${esc(drug(it))}</td><td>${doseTag(dStat(p, d), isCont(it))}</td><td class="mono">${esc(d.givenAt || "–")}</td><td class="small">${(d.delays || []).map((x) => `${esc(x.from)}→${esc(x.to)} (${esc(x.reason)})`).join("<br>")}</td><td class="small">${esc(d.givenBy || "")}</td></tr>`; }).join("")}</table></div>
        <p class="muted small" style="margin-top:8px">Pontualidade = horários vencidos administrados dentro da tolerância ÷ horários vencidos (indicador de processo para o debriefing).</p>` };
    }
    const reportCSV = (p) => C.toCSV(p.doses.slice().sort(sortDoses).map((d) => { const it = itemOf(p, d.itemId); return { paciente: p.name, previsto: d.time, original: d.orig, medicacao: it.desc, dose: it.dose, via: it.route, status: dStat(p, d), horario_real: d.givenAt || "", administrado_por: d.givenBy || "", responsavel: d.resp || "", aprazamentos: (d.delays || []).map((x) => `${x.from}->${x.to} ${x.reason}`).join(" | ") }; }));

    function administer(p, d, on) {
      const it = itemOf(p, d.itemId);
      if (on) {
        d.status = "administrada"; d.givenAt = clockOf(p); d.givenBy = meLabel();
        plog(p, "adm", `Administrada: ${drug(it)}`, { drug: it.desc, dose: it.dose, route: it.route, obs: d.time !== d.givenAt ? `previsto ${d.time}` : "" });
        liveNote(p, isCont(it) ? "Infusão iniciada" : "Medicação administrada", `${drug(it)} às ${d.givenAt}`);
      } else {
        plog(p, "desfeita", `Administração desfeita: ${drug(it)} (${d.givenAt})`, { drug: it.desc, dose: it.dose, route: it.route });
        d.status = "pendente"; d.givenAt = ""; d.givenBy = "";
      }
      save();
    }
    function openApraz(p, d) {
      const it = itemOf(p, d.itemId);
      modal("Aprazar medicação", `<p><b>${esc(drug(it))}</b><br>Horário previsto: <b class="mono">${esc(d.time)}</b> · hora atual: <b class="mono">${esc(clockOf(p))}</b></p>
        <div class="fg"><label class="f"><span>Novo horário</span><input type="time" name="to" required></label><label class="f"><span>Motivo</span><select name="reason">${DELAY_REASONS.map((r) => opt(r, r)).join("")}</select></label></div>
        <label class="f"><span>Observações</span><textarea name="obs"></textarea></label>`, { submit: "Confirmar aprazamento", onSubmit: (fd) => {
        const to = String(fd.get("to") || ""); if (toMin(to) == null) { toast("Informe o novo horário."); return false; }
        d.delays = d.delays || []; d.delays.push({ from: d.time, to, reason: fd.get("reason"), obs: String(fd.get("obs") || "").trim(), by: meLabel(), at: Date.now() });
        plog(p, "aprazada", `Aprazada: ${drug(it)} de ${d.time} para ${to} — ${fd.get("reason")}${fd.get("obs") ? " (" + String(fd.get("obs")).trim() + ")" : ""}`);
        liveNote(p, "Medicação aprazada", `${drug(it)} ${d.time}→${to} (${fd.get("reason")})`);
        d.time = to; save(); render(); toast(`${it.desc} aprazada para ${to}.`);
      } });
    }
    function openSusp(p, it) {
      modal("Suspender medicação", `<div class="conf"><b>Atenção:</b> a suspensão interrompe todos os horários pendentes deste item e requer revisão do prescritor.</div>
        <p><b>${esc(drug(it))}</b> · ${esc(new Date().toLocaleDateString("pt-BR"))} ${esc(clockOf(p))}</p>
        <label class="f"><span>Motivo da suspensão</span><select name="reason">${SUSP_REASONS.map((r) => opt(r, r)).join("")}</select></label>
        <label class="f"><span>Observações</span><textarea name="obs"></textarea></label>`, { submit: "Suspender medicação", onSubmit: (fd) => {
        it.status = "suspenso"; it.susp = { reason: fd.get("reason"), obs: String(fd.get("obs") || "").trim(), when: `${new Date().toLocaleDateString("pt-BR")} ${clockOf(p)}`, by: meLabel() };
        p.doses.forEach((d) => { if (d.itemId === it.id && d.status === "pendente") d.status = "suspensa"; });
        plog(p, "suspensa", `Suspensa: ${drug(it)} — ${it.susp.reason}`);
        liveNote(p, "Medicação suspensa", `${drug(it)} (${it.susp.reason})`);
        save(); render(); toast(`${it.desc} suspensa.`);
      } });
    }
    function saveVitals(p) {
      const g = (k) => { const el = $("#sv-" + k); return el ? String(el.value).replace(",", ".").trim() : ""; };
      const v = { pas: g("pas"), pad: g("pad"), fc: g("fc"), spo2: g("spo2"), fr: g("fr"), temp: g("temp"), o2: !!g("o2"), avpu: g("avpu") || "A" };
      if (!v.pas || !v.pad || !v.fc || !v.spo2) return toast("Preencha PA sistólica, PA diastólica, FC e SpO₂.");
      const lim = { pas: [40, 300], pad: [20, 200], fc: [20, 250], spo2: [50, 100], fr: [4, 70], temp: [30, 43] };
      for (const [k, [a, b]] of Object.entries(lim)) if (v[k] !== "" && (isNaN(+v[k]) || +v[k] < a || +v[k] > b)) return toast(`Valor fora da faixa fisiológica plausível: ${k.toUpperCase()} (${a}–${b}).`);
      if (+v.pad >= +v.pas) return toast("A PA diastólica deve ser menor que a sistólica.");
      ["pas", "pad", "fc", "spo2", "fr", "temp"].forEach((k) => { v[k] = v[k] === "" ? null : +v[k]; });
      const rec = { id: C.uid("sv"), at: Date.now(), clock: clockOf(p), by: meLabel(), ...v, news: HC_CLIN.news2(v) };
      p.vitals.push(rec);
      plog(p, "sv", `Sinais vitais: PA ${v.pas}/${v.pad}, FC ${v.fc}, SpO₂ ${v.spo2}%`);
      liveNote(p, "Sinais vitais registrados", `PA ${v.pas}/${v.pad} · FC ${v.fc} · SpO₂ ${v.spo2}%${rec.news ? " · NEWS2 " + rec.news.score : ""}`);
      save(); render();
      const fl = HC_CLIN.vitalFlags(rec);
      toast(`Sinais vitais registrados${rec.news ? ` · NEWS2 ${rec.news.score} (risco ${rec.news.risk})` : ""}${fl.length ? " · " + fl.join("; ") : ""}.`, 5000);
    }

    // Painel do prontuário dentro da sessão ao vivo
    root.hcLiveEhr = (ses) => {
      const list = DB.patients.filter((p) => !ses.scenarioId || !p.scenarioId || p.scenarioId === ses.scenarioId);
      if (!list.length) return `<div class="empty">Nenhum paciente simulado vinculado ao cenário. Cadastre em Prontuário eletrônico.</div>`;
      let p = list.find((x) => x.id === UI.liveEhrPt) || list.find((x) => x.scenarioId && x.scenarioId === ses.scenarioId) || list[0]; UI.liveEhrPt = p.id;
      const doses = p.doses.filter((d) => d.status !== "suspensa").sort(sortDoses);
      const sos = p.items.filter((i) => i.status === "ativo" && isSOS(i));
      return `<label class="f"><span>Paciente</span><select data-change="ehr-livept">${list.map((x) => opt(x.id, x.name, p.id)).join("")}</select></label>
        <p class="muted small">Hora do cenário <b class="mono">${esc(clockOf(p))}</b>. Cada checagem vira anotação “Prontuário” na linha do tempo.</p>
        <ul class="plain">${doses.map((d) => { const it = itemOf(p, d.itemId), s = dStat(p, d); return `<li class="between" style="margin:0;align-items:center"><span><span class="mono small">${esc(d.time)}</span> <b>${esc(it.desc)}</b> <span class="muted small">${esc([it.dose, it.route].filter(Boolean).join(" "))}</span><br>${doseTag(s, isCont(it))}</span>
          ${d.status === "administrada" ? `<span class="mono small">${esc(d.givenAt)}</span>` : `<button class="btn sm rec-o" data-act="ehr-live-adm" data-pt="${p.id}" data-id="${d.id}">Checar</button>`}</li>`; }).join("")}
        ${sos.map((it) => `<li class="between" style="margin:0;align-items:center"><span><span class="tag info">SOS</span> <b>${esc(it.desc)}</b> <span class="muted small">${esc([it.dose, it.route].filter(Boolean).join(" "))}</span></span><button class="btn sm" data-act="ehr-live-sos" data-pt="${p.id}" data-item="${it.id}">Administrar</button></li>`).join("")}</ul>`;
    };
    const refreshLiveEhr = () => { const el = $("#lt-ehr"); if (el && LIVE.session) el.innerHTML = root.hcLiveEhr(LIVE.session); };
    function giveSOS(p, it) {
      const d = { id: C.uid("d"), itemId: it.id, time: clockOf(p), orig: clockOf(p), status: "pendente", resp: "", delays: [], sos: true };
      p.doses.push(d); administer(p, d, true);
      p.log[0].kind = "sos";
    }

    // ═══════════════════════ HELSE LOG: ALMOXARIFADO ═══════════════════════
    const PIC = {
      torso(sk = "#d4a36a", o = {}) {
        const st = o.stroke || "#8a6a40";
        return `<svg viewBox="0 0 48 66" preserveAspectRatio="xMidYMax meet"><ellipse cx="24" cy="9" rx="8.5" ry="8.5" fill="${sk}" stroke="${st}" stroke-width="1.2"/>
          <path d="M15,19 Q13,19 11,23 L9,60 Q9,64 15,64 L33,64 Q39,64 39,60 L37,23 Q35,19 33,19 Q29,17 24,17 Q19,17 15,19 Z" fill="${sk}" stroke="${st}" stroke-width="1.2"/>
          ${o.stetho ? '<path d="M17,32 Q13,38 16,46 Q18,50 24,50" stroke="#1a1a2e" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="24" cy="51.5" r="3" fill="#1a1a2e"/>' : ""}
          ${o.wounds ? '<ellipse cx="21" cy="32" rx="4" ry="3.5" fill="#dc2626" opacity=".85"/><circle cx="28" cy="40" r="3" fill="#dc2626" opacity=".7"/><rect x="16" y="46" width="12" height="5" rx="2.5" fill="#dc2626" opacity=".65"/>' : ""}</svg>`;
      },
      pelve: (sk = "#c4906a") => `<svg viewBox="0 0 46 44" preserveAspectRatio="xMidYMax meet"><rect x="2" y="3" width="17" height="34" rx="8.5" fill="${sk}" stroke="#8a6040" stroke-width="1.3"/><rect x="27" y="3" width="17" height="34" rx="8.5" fill="${sk}" stroke="#8a6040" stroke-width="1.3"/><rect x="2" y="28" width="42" height="13" rx="6.5" fill="${sk}" stroke="#8a6040" stroke-width="1.3"/></svg>`,
      box: () => `<svg viewBox="0 0 46 34" preserveAspectRatio="xMidYMax meet"><rect x="2" y="10" width="42" height="22" rx="3" fill="#b8883a" stroke="#8b6020" stroke-width="1.3"/><rect x="2" y="5" width="42" height="9" rx="3" fill="#c89848" stroke="#8b6020" stroke-width="1.3"/><rect x="15" y="3" width="16" height="8" rx="2.5" fill="#888" stroke="#666" stroke-width=".9"/></svg>`,
      arm: (sk = "#d4a36a") => `<svg viewBox="0 0 30 56" preserveAspectRatio="xMidYMax meet"><rect x="5" y="2" width="20" height="40" rx="10" fill="${sk}" stroke="#8a6a40" stroke-width="1.3"/><line x1="12" y1="8" x2="12" y2="38" stroke="#4a70b0" stroke-width="1.2" opacity=".6"/><ellipse cx="15" cy="48" rx="11" ry="7.5" fill="${sk}" stroke="#8a6a40" stroke-width="1.3"/></svg>`,
      roll: () => `<svg viewBox="0 0 52 28" preserveAspectRatio="xMidYMax meet"><rect x="7" y="2" width="38" height="24" fill="#38a169" stroke="#2d7a52" stroke-width="1.3"/><ellipse cx="7" cy="14" rx="5" ry="12" fill="#48bb78" stroke="#2d7a52" stroke-width="1.3"/><ellipse cx="45" cy="14" rx="5" ry="12" fill="#48bb78" stroke="#2d7a52" stroke-width="1.3"/></svg>`,
      pbox: (c = "#93c5fd") => `<svg viewBox="0 0 46 34" preserveAspectRatio="xMidYMax meet"><rect x="2" y="5" width="42" height="27" rx="4" fill="${c === "#93c5fd" ? "#dbeafe" : "#d1fae5"}" stroke="${c}" stroke-width="1.3"/><line x1="8" y1="17" x2="38" y2="17" stroke="${c}"/><line x1="8" y1="22" x2="38" y2="22" stroke="${c}"/><line x1="8" y1="27" x2="38" y2="27" stroke="${c}"/></svg>`,
    };
    const PIC_KINDS = { "": "Sem pictograma", torso: "Torso / manequim", "torso-stetho": "Torso com ausculta", "torso-wounds": "Torso com feridas", pelve: "Pelve", arm: "Braço de punção", box: "Caixa / kit", roll: "Rolo / tapete", "pbox-blue": "Caixa organizadora azul", "pbox-green": "Caixa organizadora verde" };
    function picSvg(i) {
      const k = i.pic || "", sk = i.skin || undefined;
      if (k === "torso") return PIC.torso(sk); if (k === "torso-stetho") return PIC.torso(sk, { stetho: true }); if (k === "torso-wounds") return PIC.torso(sk, { wounds: true });
      if (k === "pelve") return PIC.pelve(sk); if (k === "arm") return PIC.arm(sk); if (k === "box") return PIC.box(); if (k === "roll") return PIC.roll();
      if (k === "pbox-blue") return PIC.pbox("#93c5fd"); if (k === "pbox-green") return PIC.pbox("#6ee7b7"); return "";
    }
    const CATS = { simulador: "Simulador", insumo: "Insumo / consumível", kit: "Kit / acessório" };
    const ST_LABEL = { empty: ["Vazio", "bad"], crit: ["Crítico", "bad"], warn: ["Baixo", "warn"], ok: ["Adequado", "ok"] };
    const stTag = (i) => { const [l, c] = ST_LABEL[HC_CLIN.stockStatus(i)]; return `<span class="tag ${c}">${l}</span>`; };
    const allShelves = () => DB.cabinets.flatMap((c) => c.shelves.map((s) => ({ ...s, cab: c })));
    const shelfOf = (id) => allShelves().find((s) => s.id === id);
    const shelfName = (id) => (shelfOf(id) || {}).name || id || "—";
    const byShelf = (id) => DB.stock.filter((i) => i.shelfId === id);
    function mov(type, msg, shelfId, itemId) { DB.movements.unshift({ id: C.uid("mv"), at: Date.now(), type, msg, shelfId: shelfId || "", itemId: itemId || "", by: meLabel() }); if (DB.movements.length > 2000) DB.movements.length = 2000; }
    function nextCode() { const n = DB.stock.reduce((m, i) => Math.max(m, +(String(i.code).match(/\d+/) || [0])[0]), 0) + 1; return "ITM-" + String(n).padStart(3, "0"); }

    root.hcSeedLab = () => {
      if (!Array.isArray(DB.cabinets)) DB.cabinets = []; if (!Array.isArray(DB.stock)) DB.stock = []; if (!Array.isArray(DB.movements)) DB.movements = [];
      if (DB.cabinets.length) return;
      const sh = (id, name, loc) => ({ id, name, loc });
      DB.cabinets.push(
        { id: "A", name: "Armário A", note: "Aberto", row: "sup", closed: false, shelves: [sh("A-P3", "Armário A — prateleira superior", "Superior esquerdo"), sh("A-P2", "Armário A — prateleira média", "Superior esquerdo"), sh("A-P1", "Armário A — prateleira inferior", "Superior esquerdo")] },
        { id: "B", name: "Armário B", note: "Aberto · pelves", row: "sup", closed: false, shelves: [sh("B-P3", "Armário B — prateleira superior (pelves)", "Superior central"), sh("B-P2", "Armário B — prateleira média (pelves)", "Superior central"), sh("B-P1", "Armário B — prateleira inferior (pelves)", "Superior central")] },
        { id: "C", name: "Armário C", note: "Fechado · não catalogado", row: "sup", closed: true, shelves: [] },
        { id: "N", name: "Nichos inferiores", note: "", row: "inf", closed: false, shelves: [sh("N-ESQ", "Nicho inferior esquerdo — torsos RCP", "Inferior esquerdo"), sh("N-CEN", "Nicho inferior central — semiologia", "Inferior central"), sh("N-DIR", "Nicho inferior direito — almoxarifado", "Inferior direito")] });
      const it = (code, shelfId, name, cat, type, stock, min, pic, skin) => ({ id: C.uid("st"), code, shelfId, name, cat, type, stock, min, pic: pic || "", skin: skin || "" });
      DB.stock.push(
        it("ITM-001", "A-P3", "Kit de acessórios de reposição (caixa de madeira)", "kit", "Kit/acessório", 1, 1, "box"),
        it("ITM-002", "A-P2", "Manequim cabeça/torso — semiologia (pele clara)", "simulador", "Manequim de semiologia", 1, 1, "torso", "#e0b888"),
        it("ITM-003", "A-P1", "Torso com feridas e estomias (modelo clínico)", "simulador", "Cuidados com feridas", 1, 1, "torso-wounds", "#d4a36a"),
        it("ITM-004", "B-P3", "Simulador de pelve — tom claro", "simulador", "Cateterismo vesical", 2, 2, "pelve", "#dab880"),
        it("ITM-005", "B-P2", "Simulador de pelve — tom médio", "simulador", "Cateterismo vesical", 3, 2, "pelve", "#c4906a"),
        it("ITM-006", "B-P1", "Simulador de pelve — tom misto", "simulador", "Exame ginecológico", 3, 1, "pelve", "#cba070"),
        it("ITM-007", "N-ESQ", "Torso adulto RCP — pele clara", "simulador", "Reanimação cardiopulmonar", 1, 1, "torso", "#e8c090"),
        it("ITM-008", "N-ESQ", "Torso adulto RCP — pele negra", "simulador", "Reanimação cardiopulmonar", 1, 1, "torso", "#4a2810"),
        it("ITM-009", "N-ESQ", "Torso adulto RCP — pele morena", "simulador", "Reanimação cardiopulmonar", 1, 1, "torso", "#8b5a30"),
        it("ITM-010", "N-CEN", "Torso avançado de semiologia (sons cardíacos e pulmonares)", "simulador", "Clínico/semiologia", 2, 1, "torso-stetho", "#d4a36a"),
        it("ITM-011", "N-CEN", "Estetoscópio de treinamento clínico", "insumo", "Equipamento", 3, 2, ""),
        it("ITM-012", "N-CEN", "Tapete/rolo de simulação postural (verde)", "insumo", "Acessório", 1, 1, "roll"),
        it("ITM-013", "N-DIR", "Agulhas hipodérmicas 20×0,55 mm (cx. 100 un.)", "insumo", "Consumível/perfurocortante", 140, 50, "pbox-blue"),
        it("ITM-014", "N-DIR", "Seringas descartáveis 10 mL (cx. organizadora)", "insumo", "Consumível", 12, 30, "pbox-green"),
        it("ITM-015", "N-DIR", "Simulador de braço/mão para punção venosa", "simulador", "Parcial/venopunção", 2, 1, "arm"));
      mov("sys", "Base do almoxarifado carregada: sala técnica com armários A, B, C e nichos inferiores.");
      DB.stock.filter((i) => i.stock < i.min).forEach((i) => mov("alr", `Estoque crítico: "${i.name}" — ${i.stock}/${i.min} un.`, i.shelfId, i.id));
    };
    root.hcAfterLoad = () => {
      if (!Array.isArray(DB.patients)) DB.patients = [];
      root.hcSeedLab();
    };

    R.almox = () => {
      if (!isAdmin()) return `<h1>Almoxarifado</h1><div class="empty">O almoxarifado é restrito ao administrador.</div>`;
      const tab = S("labTab", "mapa");
      const t = (id, l) => `<button class="${tab === id ? "on" : ""}" data-act="lab-tab" data-t="${id}">${l}</button>`;
      return `<div class="between"><h1 style="margin:0">Almoxarifado <span class="muted" style="font-weight:400">· Helse Log</span></h1><div class="row">
        <input type="search" id="lab-q" placeholder="Buscar item, código, tipo…" value="${esc(UI.labQ || "")}" style="width:220px" aria-label="Buscar no almoxarifado">
        <button class="btn primary" data-act="lab-item">+ Novo item</button><button class="btn" data-act="lab-csv">Exportar CSV</button><button class="btn" data-act="lab-reorder">Lista de reposição</button></div></div>
      <div class="tabs">${t("painel", "Painel")}${t("mapa", "Mapa dos armários")}${t("inv", "Inventário")}${t("mov", `Movimentações (${DB.movements.length})`)}</div>
      ${({ painel: labPainel, mapa: labMapa, inv: labInv, mov: labMov })[tab]()}`;
    };
    AFTER.almox = () => {
      const q = $("#lab-q"); if (!q) return;
      q.oninput = () => { UI.labQ = q.value; if (UI.labTab === "inv") { const pos = q.selectionStart; render(); const n = $("#lab-q"); n.focus(); n.setSelectionRange(pos, pos); } else labHighlight(); };
      labHighlight();
    };
    function labMatch(i) { const q = norm(UI.labQ || "").trim(); return !q || [i.name, i.code, i.type, CATS[i.cat]].some((x) => norm(x).includes(q)); }
    function labHighlight() {
      const q = (UI.labQ || "").trim();
      $$("[data-shelf]").forEach((el) => el.classList.toggle("hit", !!q && byShelf(el.dataset.shelf).some(labMatch)));
    }
    function labPainel() {
      const all = DB.stock, crit = all.filter((i) => i.stock < i.min), sims = all.filter((i) => i.cat === "simulador"), ins = all.filter((i) => i.cat !== "simulador");
      const u = (l) => l.reduce((a, i) => a + i.stock, 0);
      return `<div class="kpis">${kpi(`Itens cadastrados · ${u(all)} un.`, all.length)}${kpi("Simuladores (un.)", u(sims))}${kpi("Insumos e kits (un.)", u(ins))}${kpi("Alertas críticos", crit.length)}</div>
      <div class="cols"><section class="card"><h2>Níveis de estoque</h2><div class="bars">${all.map((i) => { const pct = Math.min(100, i.min ? (i.stock / (i.min * 2.5)) * 100 : 80), s = HC_CLIN.stockStatus(i);
          return `<div class="b"><span title="${esc(i.name)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(i.name)}</span><div class="t"><i style="width:${pct}%;background:var(--${s === "ok" ? "ok" : s === "warn" ? "warn" : "bad"})"></i></div><span class="v">${i.stock}/${i.min}</span></div>`; }).join("")}</div></section>
        <section class="card"><h2>Alertas críticos e reposição sugerida</h2>${crit.length ? `<ul class="plain">${crit.map((i) => `<li class="between" style="margin:0;align-items:center"><span><b>${esc(i.name)}</b><br><span class="muted small">${esc(shelfName(i.shelfId))} · ${i.stock}/${i.min} un. · repor ${HC_CLIN.reorderQty(i)} un.</span></span><button class="btn sm" data-act="lab-locate" data-id="${esc(i.shelfId)}">Localizar</button></li>`).join("")}</ul>` : `<div class="empty">Nenhum alerta crítico no momento.</div>`}
          <p class="muted small" style="margin-top:8px">Crítico: abaixo do mínimo. Baixo: abaixo de 1,5 × o mínimo. A reposição sugerida recompõe o item até 1,5 × o mínimo.</p></section></div>`;
    }
    function cell(s) {
      const its = byShelf(s.id), crit = its.some((i) => i.stock < i.min), warn = its.some((i) => HC_CLIN.stockStatus(i) === "warn");
      return `<button type="button" class="cmp ${UI.labShelf === s.id ? "on" : ""} ${crit ? "crit" : ""}" data-act="lab-shelf" data-id="${esc(s.id)}" data-shelf="${esc(s.id)}" title="${esc(s.name)}">
        <span class="cmp-h"><span class="mono">${esc(s.id.replace("-", "·"))}</span><span class="cnt ${crit ? "bad" : warn ? "warn" : "ok"}">${its.length}</span></span>
        <span class="pics">${its.filter((i) => i.pic).slice(0, 5).map((i) => `<span title="${esc(i.name)} — ${i.stock} un.">${picSvg(i)}</span>`).join("")}</span></button>`;
    }
    function labMapa() {
      const sup = DB.cabinets.filter((c) => c.row !== "inf"), inf = DB.cabinets.filter((c) => c.row === "inf");
      const cab = (c) => c.closed ? `<div class="cab"><div class="cab-l">${esc(c.name)} <span class="muted">(${esc(c.note || "fechado")})</span></div><button type="button" class="cmp closed ${UI.labShelf === "cab:" + c.id ? "on" : ""}" data-act="lab-shelf" data-id="cab:${esc(c.id)}"><span style="font-size:22px">🔒</span><span class="muted small">Conteúdo não catalogado</span></button></div>`
        : `<div class="cab"><div class="cab-l">${esc(c.name)}${c.note ? ` <span class="muted">(${esc(c.note)})</span>` : ""}</div>${c.shelves.map(cell).join("")}</div>`;
      return `<div class="mapa"><section class="card"><div class="between" style="margin:0 0 10px"><h2 style="margin:0">Sala técnica · layout dos armários</h2><div class="legend" style="margin:0"><span><i style="background:var(--ok)"></i>Adequado</span><span><i style="background:var(--warn)"></i>Baixo</span><span><i style="background:var(--bad)"></i>Crítico</span></div></div>
        <div class="cabs" style="grid-template-columns:repeat(${Math.max(1, sup.length)},minmax(0,1fr))">${sup.map(cab).join("")}</div>
        ${inf.map((c) => `<div class="cab-l" style="margin-top:10px">${esc(c.name)}</div><div class="cabs" style="grid-template-columns:repeat(${Math.max(1, c.shelves.length)},minmax(0,1fr))">${c.shelves.map(cell).join("")}</div>`).join("")}
        <p class="muted small" style="margin-top:8px">Clique numa prateleira ou nicho para ver os itens, ajustar quantidades e emitir etiquetas.</p></section>
        <aside class="card insp">${labInspector()}</aside></div>`;
    }
    function labInspector() {
      const id = UI.labShelf;
      if (!id) return `<h2>Inspetor de compartimento</h2><div class="empty">Nenhum compartimento selecionado.</div>`;
      if (id.startsWith("cab:")) {
        const c = DB.cabinets.find((x) => "cab:" + x.id === id);
        if (!c) return "";
        return `<h2>${esc(c.name)} — portas fechadas</h2><p class="muted">Conteúdo não catalogado digitalmente. Abra as portas físicas, confira o conteúdo e catalogue o armário com três prateleiras para cadastrar os itens.</p><button class="btn primary" data-act="lab-catalog" data-id="${esc(c.id)}">Catalogar armário</button>`;
      }
      const s = shelfOf(id); if (!s) return "";
      const its = byShelf(id);
      return `<h2>${esc(s.name)}</h2><p class="muted small">${esc(s.loc || "")} · ID ${esc(s.id)} · ${its.length} item(ns)</p>
        ${its.map((i) => { const pct = Math.min(100, i.min ? (i.stock / (i.min * 2)) * 100 : 80), st = HC_CLIN.stockStatus(i);
          return `<div class="ic"><div class="between" style="margin:0;align-items:flex-start"><div><b>${esc(i.name)}</b><br><span class="muted small">${esc(i.type || "")} · <span class="mono">${esc(i.code)}</span></span></div>${stTag(i)}</div>
            <div class="between" style="margin:6px 0 4px;align-items:center"><span class="muted small">Quantidade em estoque (mín. ${i.min})</span><span class="stepper"><button class="btn sm" data-act="lab-step" data-id="${i.id}" data-d="-1" aria-label="Retirar 1">−</button><b class="mono">${i.stock}</b><button class="btn sm" data-act="lab-step" data-id="${i.id}" data-d="1" aria-label="Repor 1">+</button></span></div>
            <div class="prog"><i style="width:${pct}%;background:var(--${st === "ok" ? "ok" : st === "warn" ? "warn" : "bad"})"></i></div>
            <div class="row" style="margin-top:6px"><button class="btn sm" data-act="lab-move" data-id="${i.id}">Movimentar…</button><button class="btn sm" data-act="lab-label" data-id="${i.id}">Etiqueta QR</button><button class="btn sm ghost" data-act="lab-item" data-id="${i.id}">Editar</button></div></div>`; }).join("") || `<div class="empty">Nenhum item neste compartimento.</div>`}
        <button class="btn" style="width:100%;justify-content:center;margin-top:6px" data-act="lab-item" data-shelf="${esc(id)}">+ Adicionar item aqui</button>`;
    }
    function labInv() {
      let data = DB.stock.filter(labMatch);
      if (UI.labCat) data = data.filter((i) => i.cat === UI.labCat);
      if (UI.labSt === "crit") data = data.filter((i) => i.stock < i.min); if (UI.labSt === "ok") data = data.filter((i) => i.stock >= i.min);
      return `<div class="row" style="margin-bottom:10px"><select data-change="lab-fcat">${opt("", "Todas as categorias", UI.labCat)}${Object.entries(CATS).map(([k, v]) => opt(k, v, UI.labCat)).join("")}</select>
        <select data-change="lab-fst">${opt("", "Todos os status", UI.labSt)}${opt("crit", "Estoque crítico", UI.labSt)}${opt("ok", "Estoque adequado", UI.labSt)}</select><span class="muted small" style="margin-left:auto">${data.length} item(ns)</span></div>
      ${data.length ? `<div class="tbl"><table><tr><th>Código</th><th>Item</th><th>Categoria</th><th>Localização</th><th>Estoque</th><th>Mínimo</th><th>Status</th><th></th></tr>
        ${data.map((i) => `<tr><td class="mono">${esc(i.code)}</td><td class="click" data-act="lab-item" data-id="${i.id}"><b>${esc(i.name)}</b><br><span class="muted small">${esc(i.type || "")}</span></td><td><span class="tag info">${esc(CATS[i.cat] || i.cat)}</span></td><td class="small">${esc(shelfName(i.shelfId))}</td><td class="mono"><b>${i.stock}</b></td><td class="mono">${i.min}</td><td>${stTag(i)}</td><td><button class="btn sm" data-act="lab-locate" data-id="${esc(i.shelfId)}">Localizar</button></td></tr>`).join("")}</table></div>` : `<div class="empty">Nenhum item encontrado.</div>`}`;
    }
    const MOV_ICO = { in: ["Entrada", "ok"], out: ["Saída", "info"], alr: ["Alerta", "bad"], sys: ["Sistema", ""], edit: ["Cadastro", "warn"] };
    function labMov() {
      return `<div class="row end" style="margin-bottom:8px"><button class="btn" data-act="lab-movcsv">Exportar CSV</button><button class="btn" data-act="lab-movclear">Limpar histórico</button></div>
      ${DB.movements.length ? `<section class="card"><ul class="plain">${DB.movements.slice(0, 300).map((m) => { const [l, c] = MOV_ICO[m.type] || MOV_ICO.sys; return `<li><span class="tag ${c}">${l}</span> ${esc(m.msg)}<br><span class="muted small">${m.shelfId ? esc(shelfName(m.shelfId)) + " · " : ""}${esc(fmtDT(m.at))} · ${esc(m.by || "")}</span></li>`; }).join("")}</ul></section>` : `<div class="empty">Nenhuma movimentação registrada.</div>`}`;
    }
    function changeStock(i, delta, reason) {
      const prev = i.stock;
      if (i.stock + delta < 0) return toast("O estoque não pode ficar negativo.");
      i.stock += delta;
      mov(delta > 0 ? "in" : "out", `${delta > 0 ? "Entrada" : "Retirada"} (${delta > 0 ? "+" : "−"}${Math.abs(delta)}): ${i.name} · ${prev} → ${i.stock} un.${reason ? " · " + reason : ""}`, i.shelfId, i.id);
      if (i.stock < i.min && prev >= i.min) { mov("alr", `Estoque crítico: "${i.name}" — ${i.stock} un. (mín. ${i.min}).`, i.shelfId, i.id); setTimeout(() => toast(`Estoque crítico: ${i.name}.`), 900); }
      save(); render(); toast(`${delta > 0 ? "Entrada" : "Retirada"}: ${i.name} (${i.stock} un.)`);
    }
    function openStockItem(i, shelfId) {
      const isNew = !i;
      i = i || { id: C.uid("st"), code: nextCode(), shelfId: shelfId || (allShelves()[0] || {}).id, name: "", cat: "insumo", type: "", stock: 1, min: 1, pic: "", skin: "" };
      modal(isNew ? "Novo item do almoxarifado" : `Editar ${i.code}`, `<label class="f"><span>Nome do item</span><input name="name" required value="${esc(i.name)}" placeholder="Manequim de semiologia adulto — pele clara"></label>
        <div class="fg"><label class="f"><span>Categoria</span><select name="cat">${Object.entries(CATS).map(([k, v]) => opt(k, v, i.cat)).join("")}</select></label><label class="f"><span>Tipo / uso</span><input name="type" value="${esc(i.type)}" placeholder="Reanimação cardiopulmonar"></label>
        <label class="f"><span>Localização</span><select name="shelfId">${allShelves().map((s) => opt(s.id, `${s.id} · ${s.name}`, i.shelfId)).join("")}</select></label><label class="f"><span>Código</span><input name="code" value="${esc(i.code)}"></label>
        <label class="f"><span>Estoque atual</span><input name="stock" type="number" min="0" value="${esc(i.stock)}"></label><label class="f"><span>Estoque mínimo</span><input name="min" type="number" min="0" value="${esc(i.min)}"></label>
        <label class="f"><span>Pictograma no mapa</span><select name="pic">${Object.entries(PIC_KINDS).map(([k, v]) => opt(k, v, i.pic)).join("")}</select></label><label class="f"><span>Tom de pele (torso, pelve, braço)</span><input name="skin" type="color" value="${esc(i.skin || "#d4a36a")}"></label></div>`,
      { extra: isNew ? "" : `<button type="button" class="btn" data-act="lab-del" data-id="${i.id}">Excluir item</button>`, onSubmit: (fd) => {
        const name = String(fd.get("name") || "").trim(); if (!name) { toast("O nome do item é obrigatório."); return false; }
        const prev = i.stock;
        Object.assign(i, { name, cat: fd.get("cat"), type: String(fd.get("type") || "").trim() || "Geral", shelfId: fd.get("shelfId"), code: String(fd.get("code") || "").trim() || nextCode(), stock: Math.max(0, parseInt(fd.get("stock"), 10) || 0), min: Math.max(0, parseInt(fd.get("min"), 10) || 0), pic: fd.get("pic"), skin: fd.get("skin") });
        if (isNew) { DB.stock.push(i); mov("in", `Novo item cadastrado: "${name}" (${i.stock} un.) → ${shelfName(i.shelfId)}`, i.shelfId, i.id); }
        else mov("edit", `Cadastro atualizado: ${name}${prev !== i.stock ? ` · estoque ${prev} → ${i.stock} (ajuste de inventário)` : ""}`, i.shelfId, i.id);
        if (i.stock < i.min) mov("alr", `Estoque crítico: "${name}" — ${i.stock}/${i.min} un.`, i.shelfId, i.id);
        UI.labShelf = i.shelfId; save(); render(); toast(isNew ? "Item cadastrado." : "Item atualizado.");
      } });
    }
    async function openLabel(i) {
      const text = `${i.code} | ${i.name} | ${shelfName(i.shelfId)}`;
      modal(`Etiqueta ${i.code}`, `<div class="lbl-prev"><div id="qr-box" class="qr"></div><div><b class="mono" style="font-size:18px">${esc(i.code)}</b><br>${esc(i.name)}<br><span class="muted small">${esc(shelfName(i.shelfId))}</span><br><span class="muted small">Estoque mínimo: ${i.min} un.</span></div></div><p class="muted small" id="qr-msg">Gerando QR code…</p>`,
        { extra: `<button type="button" class="btn primary" data-act="lab-labelprint" data-id="${i.id}">Imprimir etiqueta</button>` });
      try {
        if (!window.QRCode) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js");
        const box = $("#qr-box"); if (!box) return;
        new window.QRCode(box, { text, width: 120, height: 120, correctLevel: window.QRCode.CorrectLevel.M });
        $("#qr-msg").textContent = "O QR code contém código, nome e localização do item.";
      } catch (e) { const m = $("#qr-msg"); if (m) m.textContent = "QR code indisponível sem internet; a etiqueta sai com o código em texto."; }
    }
    function printLabel(i) {
      const c = $("#qr-box canvas"), img = $("#qr-box img");
      const src = c ? c.toDataURL("image/png") : img && img.src ? img.src : "";
      const w = window.open("", "_blank");
      if (!w) return toast("Permita janelas pop-up para imprimir.");
      w.document.write(`<!doctype html><meta charset="utf-8"><title>Etiqueta ${esc(i.code)}</title><style>body{font:12px system-ui;margin:16px}.l{display:flex;gap:10px;align-items:center;border:1px dashed #555;padding:8px;width:340px}img{width:96px;height:96px}b{font:700 18px ui-monospace,monospace}</style>
        <div class="l">${src ? `<img src="${src}" alt="">` : ""}<div><b>${esc(i.code)}</b><br>${esc(i.name)}<br><small>${esc(shelfName(i.shelfId))}</small></div></div><script>print()<\/script>`);
      w.document.close();
    }

    // ═══════════════════════ OCUPAÇÃO DAS SALAS ═══════════════════════════
    const H0 = 7, H1 = 22;
    R.salas = () => {
      const day = new Date((S("salasDay", isoDate(Date.now()))) + "T00:00"), d0 = +day, d1 = d0 + DAY;
      const occ = occurrencesBetween(d0, d1);
      const today = isoDate(Date.now()) === UI.salasDay, now = Date.now();
      const w0 = d0 + H0 * 3600000, w1 = d0 + H1 * 3600000;
      const rooms = DB.locations.map((l) => {
        const list = occ.filter((o) => o.res.locationId === l.id);
        const busy = today && list.find((o) => o.start <= now && o.end > now);
        const next = today && list.filter((o) => o.start > now).sort((a, b) => a.start - b.start)[0];
        const st = busy ? ["Ocupada agora", "bad"] : next ? [`Próxima às ${fmtHM(next.start)}`, "warn"] : list.length && !today ? [`${list.length} reserva(s)`, "info"] : ["Disponível", "ok"];
        return { l, list, st, occ: HC_CLIN.occupancy(list.map((o) => [o.start, o.end]), w0, w1) };
      });
      const mean = rooms.length ? rooms.reduce((a, r) => a + r.occ, 0) / rooms.length : 0;
      const mode = S("salasMode", "cards");
      const pos = (o) => ({ l: Math.max(0, (o.start - w0) / (w1 - w0)) * 100, w: Math.max(0.8, (Math.min(o.end, w1) - Math.max(o.start, w0)) / (w1 - w0) * 100) });
      const lbl = day.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
      const head = `<div class="between"><h1 style="margin:0">Ocupação das salas</h1><div class="row"><button class="btn" data-act="salas-day" data-d="-1" aria-label="Dia anterior">◀</button>
        <input type="date" data-change="salas-date" value="${esc(UI.salasDay)}"><button class="btn" data-act="salas-day" data-d="1" aria-label="Próximo dia">▶</button><button class="btn" data-act="salas-day" data-d="0">Hoje</button>
        <span class="tabs" style="margin:0;border:0"><button class="${mode === "cards" ? "on" : ""}" data-act="salas-mode" data-m="cards">Salas</button><button class="${mode === "grade" ? "on" : ""}" data-act="salas-mode" data-m="grade">Grade horária</button></span>
        <button class="btn primary" data-act="salas-new">+ Reserva</button></div></div>
        <p class="muted" style="margin-top:-6px">${esc(lbl.charAt(0).toUpperCase() + lbl.slice(1))}</p>
        <div class="kpis">${kpi("Salas cadastradas", rooms.length)}${kpi("Reservas no dia", occ.filter((o) => o.res.locationId).length)}${kpi(`Ocupação média (${H0}h–${H1}h)`, Math.round(mean * 100) + "%")}${kpi("Livres agora", today ? rooms.filter((r) => r.st[0] !== "Ocupada agora").length : "—")}</div>`;
      if (!rooms.length) return head + `<div class="empty">Cadastre as salas em Configurações.</div>`;
      if (mode === "grade") {
        const hours = []; for (let h = H0; h <= H1; h++) hours.push(h);
        const nowTop = today && now > w0 && now < w1 ? ((now - w0) / (w1 - w0)) * 100 : null;
        return head + `<div class="hgrid" style="--n:${rooms.length}"><div class="hg-h"></div>${rooms.map((r) => `<div class="hg-h">${esc(r.l.name)}<br><span class="muted small">${Math.round(r.occ * 100)}% ocupada</span></div>`).join("")}
          <div class="hg-t">${hours.map((h) => `<span style="top:${((h - H0) / (H1 - H0)) * 100}%">${String(h).padStart(2, "0")}:00</span>`).join("")}</div>
          ${rooms.map((r) => `<div class="hg-c">${hours.map((h) => `<i style="top:${((h - H0) / (H1 - H0)) * 100}%"></i>`).join("")}${nowTop != null ? `<b class="now" style="top:${nowTop}%"></b>` : ""}
            ${r.list.map((o) => `<button type="button" class="hg-b ${o.res.status === "pendente" ? "pend" : ""}" style="top:${pos(o).l}%;height:${pos(o).w}%;--c:${esc(o.res.color || "#2F7CC1")}" data-act="res-open" data-id="${o.res.id}" data-idx="${o.index}" title="${esc(o.res.title)}"><b>${fmtHM(o.start)}–${fmtHM(o.end)}</b> ${esc(o.res.title)}</button>`).join("")}</div>`).join("")}</div>`;
      }
      return head + `<div class="rooms">${rooms.map((r) => `<section class="room" style="--c:${esc((r.list[0] || {}).res ? r.list[0].res.color || "#2F7CC1" : "#2F7CC1")}">${r.l.photo ? `<img class="room-img" src="${esc(r.l.photo)}" alt="Foto da sala ${esc(r.l.name)}" loading="lazy">` : ""}
        <div class="between" style="margin:0;align-items:flex-start"><div><b>${esc(r.l.name)}</b><br><span class="muted small">${(r.l.cameras || []).length} câmera(s) fixa(s) · ${Math.round(r.occ * 100)}% do dia ocupado</span></div><span class="tag ${r.st[1]}">${esc(r.st[0])}</span></div>
        <div class="mtl" title="${H0}h às ${H1}h">${r.list.map((o) => `<i style="left:${pos(o).l}%;width:${pos(o).w}%;background:${esc(o.res.color || "#2F7CC1")}" title="${fmtHM(o.start)}–${fmtHM(o.end)} · ${esc(o.res.title)}"></i>`).join("")}${today && now > w0 && now < w1 ? `<b style="left:${((now - w0) / (w1 - w0)) * 100}%"></b>` : ""}</div>
        <div class="mtl-l"><span>${H0}h</span><span>${Math.round((H0 + H1) / 2)}h</span><span>${H1}h</span></div>
        ${r.list.length ? `<ul class="plain">${r.list.map((o) => `<li class="click" data-act="res-open" data-id="${o.res.id}" data-idx="${o.index}" style="cursor:pointer"><span class="mono small">${fmtHM(o.start)}–${fmtHM(o.end)}</span> ${esc(o.res.title)} ${o.res.status === "pendente" ? '<span class="tag warn">pendente</span>' : '<span class="tag ok">confirmada</span>'}<br><span class="muted small">${esc(nameOf("courses", o.res.courseId))} · ${esc(o.res.createdBy || "")}</span></li>`).join("")}</ul>` : `<div class="empty" style="padding:10px">Nenhuma reserva</div>`}
        <button class="btn rec-o" style="width:100%;justify-content:center;margin-top:8px" data-act="salas-new" data-loc="${r.l.id}">+ Reservar esta sala</button></section>`).join("")}</div>`;
    };

    // ═══════════════════════ DADOS DE EXEMPLO ═══════════════════════════
    function demoPatients() {
      const today = isoDate(Date.now());
      const mk = (o) => Object.assign(newPatient(), o);
      const iam = mk({ name: "SILVA, ANTONIO MARCOS DA", encounter: "938475", record: "100293", unit: "UTI cardiovascular", bed: "02", age: "62", sex: "Masculino", weight: "80",
        diagnosis: "Síndrome coronariana aguda sem supradesnivelamento do ST (pós-cateterismo)", allergies: "Dipirona", clock: "06:40", tolerance: 60,
        scenarioId: (DB.scenarios.find((s) => s.libKey === "dor") || {}).id || "" });
      iam.rx = { number: "49201", validUntil: new Date(Date.now() + DAY).toISOString(), status: "liberada", prescriber: "Dr. João Silva (CRM 12345)", releasedBy: "Dr. João Silva", releasedAt: Date.now() - 3 * 3600000 };
      const I = (desc, dose, route, freq, times, obs, extra = {}) => ({ id: C.uid("it"), type: "MED", desc, dose, route, freq, times, obs: obs || "", status: "ativo", start: today, ...extra });
      const aas = I("Ácido acetilsalicílico", "300 mg", "VO", "Dose única", ["06:00"], "Dose de ataque");
      const clo = I("Clopidogrel", "600 mg", "VO", "Dose única", ["06:30"], "Dose de ataque; dupla antiagregação");
      const clo2 = I("Clopidogrel", "75 mg", "VO", "1x/dia", ["19:00"], "Manutenção");
      const eno = I("Enoxaparina", "80 mg", "SC", "12/12h", ["06:00", "18:00"], "1 mg/kg; antitrombótico");
      const ntg = I("Nitroglicerina", "5 mcg/min", "IV contínuo", "Contínuo", ["05:30"], "Titular conforme PA e dor");
      const met = I("Metoprolol", "50 mg", "VO", "1x/dia", ["06:00"], "Suspender se FC <60 ou PAS <100");
      const ena = I("Enalapril", "10 mg", "VO", "1x/dia", ["18:00"]);
      const ato = I("Atorvastatina", "80 mg", "VO", "1x/dia", ["22:00"]);
      const metf = I("Metformina", "850 mg", "VO", "12/12h", ["08:00", "20:00"], "", { status: "suspenso", susp: { reason: "Nefropatia em evolução — usar insulina", obs: "", when: new Date(Date.now() - DAY).toLocaleDateString("pt-BR") + " 09:00", by: "Dr. João Silva" } });
      const para = I("Paracetamol", "750 mg", "VO", "Se necessário (SOS)", [], "Se dor ou T ≥37,8 °C; máx. 4 g/dia");
      iam.items = [aas, clo, clo2, eno, ntg, met, ena, ato, metf, para];
      syncDoses(iam);
      const D = (it, t) => iam.doses.find((d) => d.itemId === it.id && d.orig === t);
      Object.assign(D(clo, "06:30"), { status: "administrada", givenAt: "06:32", givenBy: "Enf. Joana Martins" });
      Object.assign(D(met, "06:00"), { status: "administrada", givenAt: "06:15", givenBy: "Enf. Joana Martins" });
      D(eno, "18:00").resp = "Enf. Joana"; D(ena, "18:00").resp = "Enf. Joana"; D(clo2, "19:00").resp = "Enf. Carlos"; D(ato, "22:00").resp = "Enf. Mariana";
      const at = (hm) => +new Date(`${today}T${hm}`);
      iam.log = [
        { id: C.uid("pl"), at: at("06:32"), clock: "06:32", kind: "adm", text: "Administrada: Clopidogrel 600 mg VO", drug: "Clopidogrel", dose: "600 mg", route: "VO", by: "Enf. Joana Martins", obs: "Paciente aceitou bem, sem queixas" },
        { id: C.uid("pl"), at: at("06:15"), clock: "06:15", kind: "adm", text: "Administrada: Metoprolol 50 mg VO", drug: "Metoprolol", dose: "50 mg", route: "VO", by: "Enf. Joana Martins", obs: "PA 115/75, tolerou bem" },
        { id: C.uid("pl"), at: at("03:00"), clock: "03:00", kind: "liberada", text: "Prescrição Nº 49201 liberada", by: "Dr. João Silva" },
      ];
      iam.vitals = [
        { id: C.uid("sv"), at: at("04:00"), clock: "04:00", pas: 125, pad: 80, fc: 88, fr: 18, spo2: 95, temp: 36.4, o2: false, avpu: "A", by: "Enf. Carlos" },
        { id: C.uid("sv"), at: at("06:00"), clock: "06:00", pas: 115, pad: 75, fc: 82, fr: 16, spo2: 96, temp: 36.6, o2: false, avpu: "A", by: "Enf. Joana" },
      ].map((v) => ({ ...v, news: HC_CLIN.news2(v) }));

      const pe = mk({ name: "SOUZA, MARIANA LIMA", encounter: "940112", record: "100877", unit: "Centro obstétrico", bed: "03", age: "27", sex: "Feminino", weight: "72",
        diagnosis: "G1P0, 34 semanas; pré-eclâmpsia com sinais de gravidade", allergies: "Nega", clock: "10:00", tolerance: 15,
        scenarioId: (DB.scenarios.find((s) => s.libKey === "pe") || {}).id || "" });
      pe.rx = { number: "49388", validUntil: new Date(Date.now() + DAY).toISOString(), status: "liberada", prescriber: "Dra. Helena Prado (CRM 54321)", releasedBy: "Dra. Helena Prado", releasedAt: Date.now() - 1800000 };
      const mg1 = I("Sulfato de magnésio 50%", "4 g", "IV", "Dose única", ["10:00"], "Ataque: diluir em SF 0,9% 100 mL e infundir em 20 min (ACOG, 2020)");
      const mg2 = I("Sulfato de magnésio 50%", "1 g/h", "IV contínuo", "Contínuo", ["10:20"], "Manutenção em bomba de infusão por 24 h; monitorar reflexo patelar, FR e diurese");
      const hid = I("Hidralazina", "5 mg", "IV", "Se necessário (SOS)", [], "Se PAS ≥160 ou PAD ≥110 confirmada em 15 min; repetir a cada 20 min");
      const gca = I("Gluconato de cálcio 10%", "1 g", "IV", "Se necessário (SOS)", [], "Antídoto: FR <12, abolição de reflexos ou sinais de intoxicação por magnésio");
      pe.items = [mg1, mg2, hid, gca];
      syncDoses(pe);
      pe.log = [{ id: C.uid("pl"), at: Date.now() - 1800000, clock: "09:30", kind: "liberada", text: "Prescrição Nº 49388 liberada", by: "Dra. Helena Prado" }];
      pe.vitals = [{ id: C.uid("sv"), at: Date.now() - 600000, clock: "09:50", pas: 168, pad: 112, fc: 96, fr: 18, spo2: 97, temp: 36.8, o2: false, avpu: "A", by: "Enf. Mariana" }].map((v) => ({ ...v, news: HC_CLIN.news2(v) }));
      return [iam, pe];
    }
    root.hcDemoClinico = () => {
      root.hcAfterLoad();
      const add = demoPatients().filter((p) => !DB.patients.some((x) => x.record === p.record));
      DB.patients.push(...add);
      if (add[0] && !UI.ehrPt) UI.ehrPt = add[0].id;
      return add.length;
    };

    // ═══════════════════════ AÇÕES ═══════════════════════════════════════
    const pt = () => curPt();
    const dose = (id) => { const p = pt(); return p && p.doses.find((d) => d.id === id); };
    const A = {
      "ehr-tab": (b) => { UI.ehrTab = b.dataset.t; render(); },
      "ehr-new": () => openPatient(newPatient()),
      "pt-zoom": (b) => { const z = document.createElement("div"); z.className = "ptzoom"; z.innerHTML = `<img src="${b.getAttribute("src")}" alt="${esc(b.alt)}">`; z.onclick = () => z.remove(); document.body.appendChild(z); },
      "pt-photo-del": () => { if (!isAdmin()) return; PT_IMG = ""; const pv = document.getElementById("pt-img-prev"); if (pv) { pv.removeAttribute("src"); pv.hidden = true; } },
      "pt-prompt": () => {
        const f = document.getElementById("mform"), g = (n) => (f && f.querySelector(`[name=${n}]`) ? f.querySelector(`[name=${n}]`).value : "");
        const txt = patientPrompt({ age: g("age"), sex: g("sex"), unit: g("unit"), bed: g("bed"), diagnosis: g("diagnosis") });
        (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast("Prompt copiado. Cole no Gemini e depois use “Escolher foto”."), () => {});
        const box = document.getElementById("pt-prompt-box"); if (box) box.value = txt; else document.getElementById("pt-img-prev").insertAdjacentHTML("beforebegin", `<textarea id="pt-prompt-box" readonly style="min-height:140px;font-size:12px;flex:1">${esc(txt)}</textarea>`);
      },
      "ehr-edit": () => { const p = pt(); if (p) openPatient(p); },
      "ehr-del": async () => { const p = pt(); if (!p || !(await ask(`Excluir o prontuário de ${p.name}? Esta ação não pode ser desfeita.`, "Excluir"))) return; DB.patients = DB.patients.filter((x) => x !== p); UI.ehrPt = ""; save(); render(); toast("Prontuário excluído."); },
      "ehr-demo": () => { const n = root.hcDemoClinico(); save(); render(); toast(n ? `${n} paciente(s) de exemplo carregado(s).` : "Os pacientes de exemplo já estão cadastrados."); },
      "ehr-clock-add": (b) => { const p = pt(); p.clock = fromMin((toMin(clockOf(p)) ?? 0) + +b.dataset.m); save(); render(); },
      "ehr-clock-real": () => { const p = pt(); p.clock = ""; save(); render(); },
      "ehr-undo": (b) => { const p = pt(), d = dose(b.dataset.id); if (d) { administer(p, d, false); render(); toast("Administração desfeita."); } },
      "ehr-apraz": (b) => { const p = pt(), d = dose(b.dataset.id); if (d) openApraz(p, d); },
      "ehr-susp": (b) => { const p = pt(), it = p && p.items.find((i) => i.id === b.dataset.item); if (it) openSusp(p, it); },
      "ehr-react": async (b) => { const p = pt(), it = p.items.find((i) => i.id === b.dataset.item); if (!it || !(await ask(`Reativar ${drug(it)}? Os horários pendentes voltam ao aprazamento.`, "Reativar"))) return;
        it.status = "ativo"; delete it.susp; p.doses.forEach((d) => { if (d.itemId === it.id && d.status === "suspensa") d.status = "pendente"; }); plog(p, "reativada", `Reativada: ${drug(it)}`); save(); render(); toast("Medicação reativada."); },
      "ehr-sos": (b) => { const p = pt(), it = p.items.find((i) => i.id === b.dataset.item); if (it) { giveSOS(p, it); render(); toast(`${it.desc} administrada (SOS) às ${clockOf(p)}.`); } },
      "ehr-turno": () => { const p = pt(), list = p.doses.filter((d) => d.status === "pendente").sort(sortDoses);
        modal("Editar aprazamento do turno", list.length ? `<div class="tbl"><table><tr><th>Horário</th><th>Medicação</th><th>Dose</th><th>Via</th><th></th></tr>${list.map((d) => { const it = itemOf(p, d.itemId); return `<tr><td class="mono">${esc(d.time)}</td><td>${esc(it.desc)}</td><td>${esc(it.dose || "")}</td><td>${esc(it.route || "")}</td><td><button type="button" class="btn sm" data-act="ehr-apraz" data-id="${d.id}">Aprazar</button></td></tr>`; }).join("")}</table></div>` : `<div class="empty">Nenhum horário pendente.</div>`); },
      "ehr-report": () => { const p = pt(), r = reportHtml(p); modal("Relatório de administração de medicações", r.html, { extra: `<button type="button" class="btn" data-act="ehr-reportcsv">Exportar CSV</button>` }); },
      "ehr-reportcsv": () => { const p = pt(); download(`aprazamento-${p.record}.csv`, reportCSV(p), "text/csv;charset=utf-8"); },
      "ehr-rxsel": (b) => { UI.ehrItem = b.dataset.id; render(); },
      "ehr-item": (b) => { const p = pt(); openItem(p, b.dataset.id ? p.items.find((i) => i.id === b.dataset.id) : null); },
      "ehr-release": async () => { const p = pt(); if (!p.items.some((i) => i.status === "ativo")) return toast("Inclua ao menos um item ativo antes de liberar.");
        if (!(await ask(`Liberar a prescrição Nº ${p.rx.number}? Os horários serão aprazados e enviados à checagem de enfermagem.`, "Liberar"))) return;
        const n = syncDoses(p); Object.assign(p.rx, { status: "liberada", releasedAt: Date.now(), releasedBy: meLabel() });
        plog(p, "liberada", `Prescrição Nº ${p.rx.number} liberada (${n} horário(s) aprazado(s))`); liveNote(p, "Prescrição liberada", `Nº ${p.rx.number}`);
        save(); render(); toast(`Prescrição Nº ${p.rx.number} liberada · ${n} novo(s) horário(s) no aprazamento.`); },
      "ehr-rxhead": () => { const p = pt();
        modal("Cabeçalho da prescrição", `<div class="fg"><label class="f"><span>Número</span><input name="number" value="${esc(p.rx.number)}"></label><label class="f"><span>Válida até</span><input type="datetime-local" name="valid" value="${esc(isoDate(+new Date(p.rx.validUntil)) + "T" + isoTime(+new Date(p.rx.validUntil)))}"></label></div><label class="f"><span>Prescritor</span><input name="prescriber" value="${esc(p.rx.prescriber)}"></label>`,
          { onSubmit: (fd) => { p.rx.number = String(fd.get("number") || p.rx.number).trim(); const v = new Date(fd.get("valid")); if (!isNaN(v)) p.rx.validUntil = v.toISOString(); p.rx.prescriber = String(fd.get("prescriber") || "").trim(); save(); render(); } }); },
      "ehr-rxprint": () => rxPrint(pt()),
      "ehr-histcsv": () => { const p = pt(); download(`historico-medicacoes-${p.record}.csv`, C.toCSV(p.log.map((l) => ({ data: new Date(l.at).toLocaleDateString("pt-BR"), hora: l.clock, tipo: l.kind, registro: l.text, medicacao: l.drug || "", dose: l.dose || "", via: l.route || "", por: l.by || "", obs: l.obs || "" }))), "text/csv;charset=utf-8"); },
      "ehr-sv": () => saveVitals(pt()),
      "ehr-svdel": async (b) => { const p = pt(); if (!(await ask("Excluir esta aferição?", "Excluir"))) return; p.vitals = p.vitals.filter((v) => v.id !== b.dataset.id); save(); render(); },
      "ehr-live-adm": (b) => { const p = byId("patients", b.dataset.pt), d = p && p.doses.find((x) => x.id === b.dataset.id); if (d) { administer(p, d, true); refreshLiveEhr(); toast(`${itemOf(p, d.itemId).desc} checada às ${d.givenAt}.`); } },
      "ehr-live-sos": (b) => { const p = byId("patients", b.dataset.pt), it = p && p.items.find((i) => i.id === b.dataset.item); if (it) { giveSOS(p, it); refreshLiveEhr(); toast(`${it.desc} administrada (SOS).`); } },
      "lab-tab": (b) => { UI.labTab = b.dataset.t; render(); },
      "lab-shelf": (b) => { UI.labShelf = UI.labShelf === b.dataset.id ? "" : b.dataset.id; render(); },
      "lab-locate": (b) => { UI.labTab = "mapa"; UI.labShelf = b.dataset.id; render(); const el = $(`[data-shelf="${b.dataset.id}"]`); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); },
      "lab-step": (b) => { const i = byId("stock", b.dataset.id); if (i) changeStock(i, +b.dataset.d); },
      "lab-move": (b) => { const i = byId("stock", b.dataset.id); if (!i) return;
        modal(`Movimentar ${i.code}`, `<p><b>${esc(i.name)}</b> · estoque atual ${i.stock} un. (mín. ${i.min})</p><div class="fg"><label class="f"><span>Tipo</span><select name="kind"><option value="out">Saída / retirada</option><option value="in">Entrada / reposição</option></select></label><label class="f"><span>Quantidade</span><input type="number" name="qty" min="1" value="1" required></label></div><label class="f"><span>Motivo (aula, cenário, compra, perda…)</span><input name="reason"></label>`,
          { submit: "Registrar", onSubmit: (fd) => { const q = parseInt(fd.get("qty"), 10); if (!(q > 0)) { toast("Informe uma quantidade válida."); return false; } if (fd.get("kind") === "out" && q > i.stock) { toast("Quantidade maior que o estoque."); return false; } closeModal(); changeStock(i, fd.get("kind") === "in" ? q : -q, String(fd.get("reason") || "").trim()); } }); },
      "lab-item": (b) => openStockItem(b.dataset.id ? byId("stock", b.dataset.id) : null, b.dataset.shelf),
      "lab-del": async (b) => { const i = byId("stock", b.dataset.id); if (!i || !(await ask(`Excluir ${i.name} do inventário?`, "Excluir"))) return; DB.stock = DB.stock.filter((x) => x !== i); mov("edit", `Item excluído: ${i.name}`, i.shelfId); closeModal(); save(); render(); toast("Item excluído."); },
      "lab-label": (b) => { const i = byId("stock", b.dataset.id); if (i) openLabel(i); },
      "lab-labelprint": (b) => { const i = byId("stock", b.dataset.id); if (i) printLabel(i); },
      "lab-catalog": (b) => { const c = DB.cabinets.find((x) => x.id === b.dataset.id); if (!c) return; c.closed = false; c.note = "Catalogado";
        c.shelves = [3, 2, 1].map((n) => ({ id: `${c.id}-P${n}`, name: `${c.name} — prateleira ${n === 3 ? "superior" : n === 2 ? "média" : "inferior"}`, loc: "Superior direito" }));
        mov("sys", `${c.name} catalogado com ${c.shelves.length} prateleiras.`); UI.labShelf = c.shelves[0].id; save(); render(); toast(`${c.name} catalogado. Cadastre os itens.`); },
      "lab-csv": () => download(`almoxarifado-${isoDate(Date.now())}.csv`, C.toCSV(DB.stock.map((i) => ({ codigo: i.code, nome: i.name, categoria: CATS[i.cat] || i.cat, tipo: i.type, compartimento: i.shelfId, localizacao: shelfName(i.shelfId), estoque: i.stock, minimo: i.min, status: HC_CLIN.stockStatus(i) }))), "text/csv;charset=utf-8"),
      "lab-reorder": () => { const l = DB.stock.filter((i) => HC_CLIN.reorderQty(i) > 0); if (!l.length) return toast("Nenhum item abaixo do mínimo.");
        download(`reposicao-${isoDate(Date.now())}.csv`, C.toCSV(l.map((i) => ({ codigo: i.code, nome: i.name, localizacao: shelfName(i.shelfId), estoque: i.stock, minimo: i.min, repor: HC_CLIN.reorderQty(i) }))), "text/csv;charset=utf-8"); },
      "lab-movcsv": () => download(`movimentacoes-${isoDate(Date.now())}.csv`, C.toCSV(DB.movements.map((m) => ({ data_hora: fmtDT(m.at), tipo: m.type, registro: m.msg, compartimento: m.shelfId, por: m.by }))), "text/csv;charset=utf-8"),
      "lab-movclear": async () => { if (!(await ask("Limpar todo o histórico de movimentações?", "Limpar"))) return; DB.movements = []; save(); render(); toast("Histórico limpo."); },
      "salas-day": (b) => { const d = +b.dataset.d; UI.salasDay = d ? isoDate(+new Date(UI.salasDay + "T12:00") + d * DAY) : isoDate(Date.now()); render(); },
      "salas-mode": (b) => { UI.salasMode = b.dataset.m; render(); },
      "salas-new": (b) => { const d = new Date(UI.salasDay + "T08:00"); if (UI.salasDay === isoDate(Date.now())) { const n = new Date(); n.setMinutes(0, 0, 0); n.setHours(Math.max(8, n.getHours() + 1)); d.setHours(n.getHours()); }
        openReservation({ id: C.uid("r"), title: "", locationId: b.dataset.loc || "", start: d.toISOString(), end: new Date(+d + 2 * 3600000).toISOString(), resourceIds: [], recur: { freq: "nenhuma" } }); },
    };
    const deny = () => toast("Função disponível apenas para docente ou administrador.");
    const denyAdmin = () => toast("O almoxarifado é restrito ao administrador.");
    for (const [k, fn] of Object.entries(A)) ACT[k] = (b, e) => (k.startsWith("lab-") ? (isAdmin() ? fn(b, e) : denyAdmin()) : isStaff() ? fn(b, e) : deny());
    const CH = {
      "ehr-pt": (el) => { UI.ehrPt = el.value; UI.ehrItem = ""; render(); },
      "ehr-clock": (el) => { const p = pt(); p.clock = el.value; save(); render(); },
      "ehr-adm": (el) => { const p = pt(), d = dose(el.dataset.id); if (d) { administer(p, d, el.checked); render(); toast(el.checked ? `${itemOf(p, d.itemId).desc} checada às ${d.givenAt}.` : "Administração desfeita."); } },
      "ehr-resp": (el) => { const d = dose(el.dataset.id); if (d) { d.resp = el.value.trim(); save(); } },
      "ehr-livept": (el) => { UI.liveEhrPt = el.value; refreshLiveEhr(); },
      "pt-photo": (el) => { const f = el.files[0]; el.value = ""; if (!f || !isAdmin()) return; if (f.size > 20e6) return toast("Imagem grande demais.");
        shrinkPatientPhoto(f).then((d) => { PT_IMG = d; const pv = document.getElementById("pt-img-prev"); if (pv) { pv.src = d; pv.hidden = false; } }).catch((e) => toast(e.message)); },
      "lab-fcat": (el) => { UI.labCat = el.value; render(); },
      "lab-fst": (el) => { UI.labSt = el.value; render(); },
      "salas-date": (el) => { if (el.value) { UI.salasDay = el.value; render(); } },
    };
    for (const [k, fn] of Object.entries(CH)) CHG[k] = (el) => (k.startsWith("lab-") ? (isAdmin() ? fn(el) : denyAdmin()) : isStaff() ? fn(el) : deny());

    // ═══════════════════════ MODO DE SENHAS (servidor) ═══════════════════
    const AU = (root.HC_AUTH = { on: false, mail: "", token: "", user: null });
    const RANK = { estudante: 0, docente: 1, admin: 2 };
    const tokGet = () => { try { return localStorage.getItem("hc-auth") || ""; } catch (e) { return ""; } };
    const tokSet = (t) => { try { t ? localStorage.setItem("hc-auth", t) : localStorage.removeItem("hc-auth"); } catch (e) {} };
    async function api(path, body, method) {
      const r = await fetch("/api/auth" + path, { method: method || (body ? "POST" : "GET"), headers: { "Content-Type": "application/json", ...(AU.token ? { Authorization: "Bearer " + AU.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      let j = {}; try { j = await r.json(); } catch (e) {}
      if (!r.ok) { const err = new Error(j.error || `Erro ${r.status}`); err.status = r.status; throw err; }
      return j;
    }
    // com login, ninguém alterna perfis: cada conta fica presa ao próprio perfil e ao próprio nome (a troca só existe na demonstração sem login)
    const canSwitch = () => false;
    const allowed = (role) => !AU.user || (canSwitch() ? RANK[role] <= RANK.admin : role === AU.user.role);
    root.hcAuthGuard = () => { if (AU.on && AU.user && !allowed(UI.role)) UI.role = AU.user.role; };
    root.hcAuthLock = () => {
      if (!AU.on || !AU.user) return;
      $$("#role option").forEach((o) => { o.disabled = !allowed(o.value); o.hidden = !allowed(o.value); });
      $("#role").disabled = !canSwitch();
      { const fixed = !canSwitch(), rl = $("#role") && $("#role").closest("label"), mw = $("#me-wrap");
        if (rl) { rl.hidden = fixed; rl.style.display = fixed ? "none" : ""; } const tb = $(".work > .toolbar"); if (tb) tb.style.display = fixed ? "none" : ""; if (fixed && mw) mw.style.display = "none"; }
      if (UI.role === AU.user.role) {
        let p = DB.people.find((x) => (x.email || "").toLowerCase() === AU.user.email);
        if (!p) { p = { id: C.uid("p"), name: AU.user.name, email: AU.user.email, role: AU.user.role }; DB.people.push(p); save(); }
        if (p.role !== AU.user.role) { p.role = AU.user.role; save(); }
        UI.me = p.id;
        const me = $("#me"); if (me) { if (![...me.options].some((o) => o.value === p.id)) me.insertAdjacentHTML("beforeend", opt(p.id, p.name, p.id)); me.value = p.id; me.disabled = true; }
      } else { const me = $("#me"); if (me) me.disabled = false; }
      const ctx = $(".topbar .ctx");
      if (ctx && !$("#tb-logout")) ctx.insertAdjacentHTML("beforeend", `<button type="button" class="tb-chip" id="tb-logout" data-act="auth-logout" title="Sair">Sair</button>`);
      if (root.hcPaintAvatar) setTimeout(root.hcPaintAvatar, 0);
      if (AU.user.role === "admin" && AU._docFor !== AU.user.id) { AU._docFor = AU.user.id; setTimeout(() => root.hcCheckDocRequests && root.hcCheckDocRequests(), 0); }
      const av = $("#tb-avatar"); if (av) { av.textContent = AU.user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase(); av.title = `${AU.user.name} · ${AU.user.email} · ${ROLES[AU.user.role]}`; }
    };

    let box = null, waitLogin = null;
    const mail = () => (AU.mail === "smtp" ? "" : `<p class="muted small au-dev">Servidor em modo de teste: o e-mail não é enviado, fica salvo na pasta <code>data/outbox</code> do servidor. Configure o SMTP para envio real.</p>`);
    function screen(mode, msg = "", email = "") {
      if (!box) { box = document.createElement("div"); box.id = "auth"; document.body.appendChild(box); }
      box.hidden = false;
      const head = `<div class="au-logo"><span class="tb-logo"></span><b>HEL<span class="sim">SIM</span></b></div>`;
      const err = msg ? `<div class="au-msg ${/enviad|chegar|criad/i.test(msg) ? "ok" : ""}" role="alert">${esc(msg)}</div>` : "";
      const forms = {
        login: `<h2>Entrar</h2>${err}<form data-au="login"><label class="f"><span>E-mail</span><input name="email" type="email" autocomplete="username" required value="${esc(email)}"></label>
          <label class="f"><span>Senha</span><input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary au-go">Entrar</button></form>
          <div class="au-links"><a href="#" data-au-go="register">Primeiro acesso: cadastrar</a><a href="#" data-au-go="forgot">Esqueci minha senha</a></div>`,
        register: `<h2>Cadastro</h2>${err}<p class="muted small">Informe seu nome e e-mail institucional. Uma senha temporária será enviada ao e-mail; no primeiro acesso você cadastra a senha definitiva.</p>
          <form data-au="register"><label class="f"><span>Nome completo</span><input name="name" required autocomplete="name"></label><label class="f"><span>E-mail</span><input name="email" type="email" required autocomplete="email" value="${esc(email)}"></label>
          <div class="f"><span>Sou</span><div class="row" style="gap:14px"><label><input type="radio" name="role" value="estudante" checked> Estudante</label><label><input type="radio" name="role" value="docente"> Docente</label></div><span class="muted small" style="font-weight:400">O perfil de docente é liberado após a aprovação do administrador (até lá o acesso é de estudante).</span></div>
          <button class="btn primary au-go">Enviar senha temporária</button></form>${mail()}<div class="au-links"><a href="#" data-au-go="login">Já tenho a senha</a></div>`,
        forgot: `<h2>Recuperar acesso</h2>${err}<p class="muted small">Enviaremos uma nova senha temporária. A anterior deixa de valer.</p>
          <form data-au="forgot"><label class="f"><span>E-mail</span><input name="email" type="email" required value="${esc(email)}"></label><button class="btn primary au-go">Enviar nova senha</button></form>${mail()}<div class="au-links"><a href="#" data-au-go="login">Voltar</a></div>`,
        change: `<h2>Cadastre sua senha definitiva</h2>${err}<p class="muted small">Por segurança, a senha temporária só serve para este passo.</p>
          <form data-au="change"><label class="f"><span>Senha temporária (do e-mail)</span><input name="current" type="password" required autocomplete="current-password"></label>
          <label class="f"><span>Nova senha</span><input name="password" type="password" required autocomplete="new-password" minlength="10"></label>
          <label class="f"><span>Confirmar nova senha</span><input name="confirm" type="password" required autocomplete="new-password"></label>
          <ul class="au-rules"><li data-r="len">Pelo menos 10 caracteres</li><li data-r="mix">Letras e números</li><li data-r="eq">As duas senhas iguais</li></ul>
          <button class="btn primary au-go">Salvar e entrar</button></form><div class="au-links"><a href="#" data-au-go="logout">Sair</a></div>`,
      };
      box.innerHTML = `<div class="au-card">${head}${forms[mode]}<p class="au-foot">Helse Solutions · ${AU.syncAvail ? "dados sincronizados com o banco central do servidor" : "dados das sessões ficam neste navegador"}</p></div>`;
      const f = $("form", box); const first = f && $("input:not([value]),input[value='']", f); if (first) first.focus();
      if (mode === "change") { const upd = () => { const p = f.password.value, c = f.confirm.value; const ok = { len: p.length >= 10, mix: /[A-Za-zÀ-ÿ]/.test(p) && /\d/.test(p), eq: p && p === c }; $$(".au-rules li", box).forEach((li) => li.classList.toggle("ok", !!ok[li.dataset.r])); }; f.oninput = upd; upd(); }
    }
    function done(user, token) { AU.user = user; AU.token = token; tokSet(token); if (box) box.hidden = true; UI.role = user.role; savePrefs(); if (waitLogin) { const w = waitLogin; waitLogin = null; w(); } else { render(); if (!SY.on && root.hcSyncBoot) root.hcSyncBoot(); else if (SY.on) pull(); } }
    document.addEventListener("click", (e) => {
      const a = e.target.closest("[data-au-go]"); if (!a) return; e.preventDefault();
      const email = (box && $("input[name=email]", box) || {}).value || "";
      if (a.dataset.auGo === "logout") return logout(); screen(a.dataset.auGo, "", email);
    });
    document.addEventListener("submit", async (e) => {
      const f = e.target.closest("form[data-au]"); if (!f) return; e.preventDefault();
      const b = $(".au-go", f); b.disabled = true; const fd = Object.fromEntries(new FormData(f)); const mode = f.dataset.au;
      try {
        if (mode === "login") { const j = await api("/login", fd); AU.token = j.token; if (j.user.mustChange) screen("change"); else done(j.user, j.token); }
        if (mode === "register") { const j = await api("/register", fd); screen("login", j.message + (j.first ? " Este é o primeiro cadastro do servidor: ele terá perfil de administrador." : ""), fd.email); }
        if (mode === "forgot") { const j = await api("/forgot", fd); screen("login", j.message, fd.email); }
        if (mode === "change") { if (fd.password !== fd.confirm) throw new Error("As senhas não conferem."); const j = await api("/change-password", { current: fd.current, password: fd.password }); done(j.user, j.token); toast("Senha definitiva cadastrada."); }
      } catch (x) { const em = fd.email || ""; screen(x.status === 401 && mode === "change" ? "login" : mode, x.message, em); }
    });
    async function logout() { try { await api("/logout", {}); } catch (e) {} AU.user = null; AU.token = ""; tokSet(""); const l = $("#tb-logout"); if (l) l.remove(); screen("login"); }
    ACT["auth-logout"] = () => { if (LIVE.recording) return toast("Encerre a gravação antes de sair."); logout(); };


    // ═══════════════════════ BANCO CENTRAL (sincronização) ═══════════════
    const SY = (root.HC_SYNC = { on: false, rev: 0, base: null, state: "", last: 0, busy: false, pending: false, timer: 0, userChanged: false });
    const clone = (x) => JSON.parse(JSON.stringify(x));
    async function dataFetch(method, path, body, raw) {
      const r = await fetch("/api/data" + path, { method, headers: { Authorization: "Bearer " + AU.token, ...(raw ? {} : { "Content-Type": "application/json" }) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
      return r;
    }
    const pristine = (d) => !d.sessions.length && !d.courses.length && !d.scenarios.length && !d.patients.length && d.people.length <= 1;
    const saveMeta = () => kvPut("sync", { rev: SY.rev, base: SY.base, user: AU.user && AU.user.email, role: SY.role }).catch(() => {});
    // O recorte que o servidor entrega depende do perfil: se o perfil mudou, a cópia local deixa de servir de base.
    function checkRole() {
      if (SY.role === AU.user.role) return;
      const wasStudent = SY.role === "estudante" || AU.user.role === "estudante";
      SY.role = AU.user.role; SY.rev = 0; SY.base = null;
      if (wasStudent) { SY.userChanged = true; if (AU.user.role === "estudante") DB = emptyDB(); }
    }
    const safeToRender = () => $("#modal").hidden && $("#ask").hidden && !LIVE.recording && UI.view !== "aovivo" && UI.view !== "sessao" && !(document.activeElement && $("#main").contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
    function applyDB(merged) {
      const changed = !HC_CLIN.merge3 || JSON.stringify(merged) !== JSON.stringify(DB);
      DB = Object.assign(emptyDB(), merged); DB.settings = Object.assign(emptyDB().settings, DB.settings);
      kvPut("db", DB).catch(() => {});
      if (changed) { if (safeToRender()) render(); else SY.needRender = true; }
    }
    function setState(st) {
      SY.state = st; if (st === "ok") SY.last = Date.now();
      const el = $("#sync-st"); if (el) el.outerHTML = root.hcSyncStatus();
    }
    root.hcSyncStatus = () => {
      if (!SY.on) return "";
      const [c, t] = SY.state === "ok" ? ["var(--ok)", `Banco central sincronizado${SY.last ? " · " + fmtHM(SY.last) : ""}`] : SY.state === "send" ? ["var(--warn)", "Enviando alterações ao servidor…"] : SY.state === "offline" ? ["var(--bad)", "Sem conexão com o servidor: alterações guardadas neste computador"] : ["var(--faint)", "Conectando ao banco central…"];
      return `<span id="sync-st"><i class="dot" style="background:${c}"></i>${esc(t)}</span>`;
    };
    async function pull() {
      if (!SY.on || SY.busy) return;
      checkRole(); SY.busy = true;
      try {
        const r = await dataFetch("GET", `/db${SY.base ? "?rev=" + SY.rev : ""}`);
        if (r.status === 401) { SY.busy = false; return root.hcAuthExpired && root.hcAuthExpired(); }
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        if (j.same) { setState(SY.pendingLocal ? "send" : "ok"); return; }
        if (!j.db) { SY.busy = false; if (AU.user.role !== "estudante") { SY.base = {}; SY.rev = j.rev; return push(); } setState("ok"); return; }
        const merged = !SY.base ? (SY.userChanged || pristine(DB) ? j.db : HC_CLIN.merge3({}, DB, j.db)) : HC_CLIN.merge3(SY.base, DB, j.db);
        SY.userChanged = false;
        applyDB(merged); SY.base = clone(j.db); SY.rev = j.rev; saveMeta();
        SY.busy = false;
        if (JSON.stringify(merged) !== JSON.stringify(j.db)) return push();
        setState("ok");
      } catch (e) { setState("offline"); } finally { SY.busy = false; }
    }
    async function push() {
      if (!SY.on) return;
      if (SY.busy) { SY.pending = true; return; }
      checkRole();
      if (!SY.base) return pull(); // sem base confiável: primeiro busca e mescla, depois envia
      SY.busy = true; setState("send");
      try {
        for (let i = 0; i < 4; i++) {
          const snap = clone(DB);
          const r = await dataFetch("PUT", "/db", { db: snap, baseRev: SY.rev });
          if (r.status === 409) { const j = await r.json(); applyDB(HC_CLIN.merge3(SY.base, DB, j.db)); SY.base = clone(j.db); SY.rev = j.rev; continue; }
          if (r.status === 401) return root.hcAuthExpired && root.hcAuthExpired();
          if (!r.ok) throw new Error(r.status);
          const j = await r.json(); SY.base = snap; SY.pendingLocal = false;
          // o servidor pode ter ajustado o envio (permissões): busca a versão gravada logo em seguida
          SY.rev = j.adjusted ? -1 : j.rev; saveMeta(); setState("ok"); if (j.adjusted) setTimeout(pull, 300); return;
        }
        throw new Error("conflito persistente");
      } catch (e) { SY.pendingLocal = true; setState("offline"); }
      finally { SY.busy = false; if (SY.pending) { SY.pending = false; schedulePush(); } }
    }
    function schedulePush() { clearTimeout(SY.timer); SY.timer = setTimeout(push, 1200); }
    root.hcSyncDirty = () => { if (SY.on) { SY.pendingLocal = true; schedulePush(); } };
    root.hcSyncBoot = async () => {
      if (!AU.on || !AU.user || !AU.syncAvail) return;
      SY.on = true;
      let m = null; try { m = await kvGet("sync"); } catch (e) {}
      if (m && m.user === AU.user.email) { SY.rev = m.rev; SY.base = m.base; SY.role = m.role || AU.user.role; } else { SY.userChanged = true; SY.role = AU.user.role; }
      if (SY.userChanged && AU.user.role === "estudante") { DB = emptyDB(); } // outra conta usou este navegador: não expõe dados alheios
      checkRole();
      await pull();
      setInterval(() => { if (document.visibilityState === "visible") pull(); }, 12000);
      window.addEventListener("focus", () => pull());
      setInterval(() => { if (SY.needRender && safeToRender()) { SY.needRender = false; render(); } }, 2000);
      if (AU.user.role !== "estudante") setTimeout(() => DB.sessions.forEach((s) => root.hcUploadMedia(s, true)), 4000);
    };
    // vídeos: envio após a gravação e busca sob demanda em outros computadores
    root.hcRemoteChunks = async (id) => {
      if (!SY.on) return [];
      try {
        const r = await dataFetch("GET", `/media/${encodeURIComponent(id)}`); if (!r.ok) return [];
        const { chunks } = await r.json(); const out = [];
        for (const seq of chunks) { const x = await dataFetch("GET", `/media/${encodeURIComponent(id)}/${seq}`); if (!x.ok) return []; const b = await x.blob(); out.push(b); putChunk(id, seq, b).catch(() => {}); }
        return out;
      } catch (e) { return []; }
    };
    const uploading = new Set();
    root.hcUploadMedia = async (ses, quiet) => {
      if (!SY.on || AU.user.role === "estudante") return;
      let n = 0;
      for (const m of ses.media || []) {
        if (m.uploaded || m.deleted || uploading.has(m.id)) continue;
        uploading.add(m.id);
        try {
          const ch = await getLocalChunks(m.id); if (!ch.length) continue;
          for (let i = 0; i < ch.length; i++) { const r = await dataFetch("PUT", `/media/${encodeURIComponent(m.id)}/${i}`, ch[i], true); if (!r.ok) throw new Error(r.status); }
          m.uploaded = true; n++; save();
        } catch (e) { if (!quiet) toast("Não foi possível enviar um vídeo ao servidor agora; nova tentativa automática depois."); }
        finally { uploading.delete(m.id); }
      }
      if (n && !quiet) toast(`${n} vídeo(s) enviado(s) ao banco central.`);
    };
    root.hcDeleteRemoteMedia = (id) => { if (SY.on && AU.user.role !== "estudante") dataFetch("DELETE", `/media/${encodeURIComponent(id)}`).catch(() => {}); };
    root.hcAuthExpired = () => { SY.on = false; setState(""); toast("Sua sessão expirou. Entre novamente."); logout(); };
    /** Chamado no início: liga o modo de senhas quando a página é servida pelo servidor do HELSIM. */
    root.hcAuthBoot = async () => {
      if (!/^https?:$/.test(location.protocol)) return;
      try { const r = await fetch("/api/auth/status", { cache: "no-store" }); const j = r.ok ? await r.json() : null; if (!j || j.enabled !== true) return; AU.on = true; AU.mail = j.mail; AU.syncAvail = j.sync !== false; } catch (e) { return; }
      AU.token = tokGet();
      if (AU.token) { try { const j = await api("/me"); AU.user = j.user; UI.role = j.user.role; return; } catch (e) { if (/Troque/.test(e.message)) { await new Promise((res) => { waitLogin = res; screen("change"); }); return; } AU.token = ""; tokSet(""); } }
      await new Promise((res) => { waitLogin = res; screen("login"); });
    };

    // Configurações › Usuários e acesso (administrador)
    const origConfig = R.config, origAfter = AFTER.config;
    R.config = () => origConfig() + (AU.on && AU.user && AU.user.role === "admin" && UI.role === "admin"
      ? `<section class="card"><div class="between"><h2 style="margin:0">Usuários e acesso</h2><span class="row" style="gap:6px"><button class="btn" data-act="au-testmail">Testar e-mail</button><button class="btn" data-act="au-tempnew">+ Acesso temporário</button><button class="btn primary" data-act="au-new">+ Usuário</button></span></div><div id="au-users" class="muted">Carregando…</div>
        <p class="muted small" style="margin-top:8px">Novos cadastros entram como estudante; promova docentes aqui. “Nova senha” envia outra senha temporária e obriga a troca no próximo acesso. E-mail: ${AU.mail === "smtp" ? "SMTP configurado" : "modo de teste (data/outbox)"}.</p></section>`
      : `<section class="card"><h2>Modo de senhas</h2><p class="muted">${AU.on ? "Ativo. Você entrou como " + esc(AU.user ? AU.user.name : "") + "." : "Disponível quando o HELSIM roda pelo servidor (<code>npm start</code>): cadastro por e-mail, senha temporária enviada ao e-mail e troca obrigatória no primeiro acesso. Neste arquivo/link a troca de perfil continua livre."}</p></section>`);
    // pedidos de perfil docente ficam nas contas (fora do banco): o administrador consulta ao entrar e a cada minuto
    async function checkDocRequests() {
      if (!AU.on || !AU.user || AU.user.role !== "admin") { root.HC_PEND_DOCENTES = 0; return; }
      try { const { users } = await api("/users"); setPendDoc(users); } catch (e) {}
    }
    function setPendDoc(users) {
      const n = users.filter((u) => u.requestedRole === "docente").length;
      if (n !== (root.HC_PEND_DOCENTES || 0)) { root.HC_PEND_DOCENTES = n; const md = $("#modal"); if (!md || md.hidden) render(); }
    }
    setInterval(checkDocRequests, 60000);
    root.hcCheckDocRequests = checkDocRequests;
    async function loadUsers() {
      const el = $("#au-users"); if (!el) return;
      try {
        const { users } = await api("/users"); setPendDoc(users);
        el.className = ""; el.innerHTML = `<div class="tbl"><table><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th><th>Último acesso</th><th></th></tr>${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
          <td><select data-au-role="${u.id}" ${u.id === AU.user.id ? "disabled" : ""}>${Object.keys(RANK).reverse().map((r) => opt(r, ROLES[r], u.role)).join("")}</select></td>
          <td>${u.accessUntil ? (u.accessUntil > Date.now() ? `<span class="tag warn">temporário até ${esc(fmtDT(u.accessUntil))}</span>` : '<span class="tag bad">acesso expirado</span>') : u.mustChange ? '<span class="tag warn">aguardando troca de senha</span>' : '<span class="tag ok">ativo</span>'}${u.requestedRole === "docente" ? ` <span class="tag warn">pediu perfil docente</span> <button class="btn sm primary" data-act="au-approve" data-id="${u.id}" data-email="${esc(u.email)}" data-name="${esc(u.name)}">Aprovar docente</button> <button class="btn sm" data-act="au-deny" data-id="${u.id}">Recusar</button>` : ""}</td><td class="small">${u.lastLogin ? esc(fmtDT(u.lastLogin)) : "—"}</td>
          <td class="row" style="gap:4px">${u.role === "docente" ? `<button class="btn sm" data-act="au-areas" data-email="${esc(u.email)}" data-name="${esc(u.name)}">Áreas</button>` : ""}<button class="btn sm" data-act="au-reset" data-id="${u.id}">Nova senha</button>${u.id === AU.user.id ? "" : `<button class="btn sm" data-act="au-del" data-id="${u.id}">Excluir</button>`}</td></tr>`).join("")}</table></div>`;
        $$("[data-au-role]", el).forEach((s) => { s.onchange = async () => { try { await api(`/users/${s.dataset.auRole}/role`, { role: s.value }); toast("Perfil atualizado."); } catch (e) { toast(e.message); loadUsers(); } }; });
      } catch (e) { el.textContent = e.message; }
    }
    AFTER.config = async () => { if (origAfter) await origAfter(); loadUsers(); };
    const adminOnly = (fn) => (b) => (AU.user && AU.user.role === "admin" ? fn(b) : toast("Apenas o administrador."));
    ACT["au-reset"] = adminOnly(async (b) => { if (!(await ask("Enviar uma nova senha temporária? A senha atual deixa de valer.", "Enviar"))) return; try { await api(`/users/${b.dataset.id}/reset`, {}); toast("Nova senha temporária enviada."); loadUsers(); } catch (e) { toast(e.message); } });
    ACT["au-del"] = adminOnly(async (b) => { if (!(await ask("Excluir este acesso? Os registros das sessões não são apagados.", "Excluir"))) return; try { await api(`/users/${b.dataset.id}`, null, "DELETE"); loadUsers(); } catch (e) { toast(e.message); } });
    ACT["au-new"] = adminOnly(() => modal("Cadastrar usuário", `<label class="f"><span>Nome</span><input name="name" required></label><label class="f"><span>E-mail</span><input name="email" type="email" required></label>
      <label class="f"><span>Perfil</span><select name="role" data-change="pm-role">${opt("estudante", ROLES.estudante)}${opt("docente", ROLES.docente)}${opt("admin", ROLES.admin)}</select></label>
      <div data-pm-areas hidden><div class="f"><span>Áreas do conhecimento do docente</span><div class="checks" style="display:grid;gap:6px">${HELSIM_AREAS.AREAS.map((a) => `<label><input type="checkbox" name="areas" value="${esc(a)}"> ${esc(a)}</label>`).join("")}</div></div></div><p class="muted small">A pessoa recebe a senha temporária por e-mail e cadastra a definitiva no primeiro acesso.</p>`,
      { submit: "Cadastrar e enviar", onSubmit: async (fd) => {
        const body = { name: fd.get("name"), email: fd.get("email"), role: fd.get("role") };
        try { await api("/users", body); } catch (e) { toast(e.message); return false; }
        const email = String(body.email).trim().toLowerCase();
        let p = DB.people.find((x) => (x.email || "").toLowerCase() === email);
        if (!p) { p = { id: C.uid("p"), name: String(body.name).trim(), email }; DB.people.push(p); }
        Object.assign(p, { role: body.role, areas: body.role === "docente" ? fd.getAll("areas") : p.areas || [] }); save();
        toast("Usuário cadastrado; senha temporária enviada."); loadUsers();
      } }));
    // acesso temporário: senha única mostrada uma vez ao administrador, sem troca obrigatória
    ACT["au-tempnew"] = adminOnly(() => modal("Acesso temporário", `<label class="f"><span>Nome</span><input name="name" required></label><label class="f"><span>E-mail</span><input name="email" type="email" required></label>
      <div class="row" style="gap:10px"><label class="f" style="flex:1"><span>Perfil</span><select name="role">${opt("estudante", ROLES.estudante)}${opt("docente", ROLES.docente)}${opt("admin", ROLES.admin)}</select></label><label class="f" style="width:140px"><span>Validade (horas)</span><input name="hours" type="number" min="1" max="168" value="48" required></label></div>
      <p class="muted small">Gera uma senha única, sem troca no primeiro acesso. Ela aparece uma só vez para você repassar; depois do prazo o acesso para de funcionar sozinho.</p>`,
      { submit: "Gerar acesso", onSubmit: async (fd) => {
        let j; try { j = await api("/users/temporary", { name: fd.get("name"), email: fd.get("email"), role: fd.get("role"), hours: Number(fd.get("hours")) }); } catch (e) { toast(e.message); return false; }
        loadUsers();
        setTimeout(() => modal("Senha do acesso temporário", `<p>E-mail: <b>${esc(j.user.email)}</b><br>Válido até: <b>${esc(fmtDT(j.user.accessUntil))}</b></p>
          <label class="f"><span>Senha (aparece só agora)</span><input readonly value="${esc(j.password)}" style="font-family:var(--mono,monospace);font-size:18px" onclick="this.select()"></label>
          <button type="button" class="btn" data-act="au-tempcopy" data-pw="${esc(j.password)}">Copiar senha</button>`, { submit: "Fechar", onSubmit: () => {} }), 0);
      } }));
    ACT["au-tempcopy"] = (b) => { navigator.clipboard.writeText(b.dataset.pw).then(() => toast("Senha copiada."), () => toast("Selecione a senha e copie.")); };
    // a escolha do perfil mostra a aba de áreas (no cadastro de usuário e no de pessoa)
    const origPmRole = CHG["pm-role"];
    CHG["pm-role"] = (el) => { const a = $("[data-pm-areas]"); if (a) a.hidden = el.value !== "docente"; if (origPmRole) origPmRole(el); };
    ACT["au-testmail"] = adminOnly(async () => { try { const j = await api("/test-mail", {}); toast(j.mail === "smtp" ? "E-mail de teste enviado para a sua caixa de entrada." : "Servidor em modo de teste: o e-mail foi salvo na pasta data/outbox (SMTP não configurado)."); } catch (e) { toast(e.message); } });
    ACT["au-approve"] = adminOnly(async (b) => {
      try { await api(`/users/${b.dataset.id}/role`, { role: "docente" }); } catch (e) { return toast(e.message); }
      toast("Perfil de docente aprovado. Defina as áreas do conhecimento."); loadUsers(); ACT["au-areas"](b);
    });
    ACT["au-deny"] = adminOnly(async (b) => { try { await api(`/users/${b.dataset.id}/deny-request`, {}); toast("Pedido recusado; a conta continua como estudante."); loadUsers(); } catch (e) { toast(e.message); } });
    ACT["au-areas"] = adminOnly((b) => {
      const email = b.dataset.email; let p = DB.people.find((x) => (x.email || "").toLowerCase() === email);
      if (!p) { p = { id: C.uid("p"), name: b.dataset.name, email, role: "docente", areas: [] }; DB.people.push(p); }
      openPerson(p); const t = $("[data-act=pm-tab][data-t=a]"); if (t) t.click();
    });

    // ═══════════════════════ FOTO DO PERFIL ═══════════════════════
    const myPhoto = () => (AU.on && AU.user ? AU.user.photo || "" : ((DB.people.find((p) => p.id === UI.me) || {}).photo || ""));
    root.hcPaintAvatar = () => {
      const av = $("#tb-avatar"); if (!av) return;
      const ph = myPhoto();
      av.style.backgroundImage = ph ? `url("${ph}")` : ""; av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center";
      av.style.color = ph ? "transparent" : ""; av.setAttribute("role", "button"); av.tabIndex = 0; av.dataset.act = "profile";
    };
    function shrink(file) {
      return new Promise((ok, bad) => {
        const img = new Image(), url = URL.createObjectURL(file);
        img.onload = () => { const S = 256, c = document.createElement("canvas"); c.width = c.height = S; const k = Math.max(S / img.width, S / img.height), w = img.width * k, h = img.height * k;
          c.getContext("2d").drawImage(img, (S - w) / 2, (S - h) / 2, w, h); URL.revokeObjectURL(url); ok(c.toDataURL("image/jpeg", 0.85)); };
        img.onerror = () => { URL.revokeObjectURL(url); bad(new Error("Não foi possível ler a imagem.")); };
        img.src = url;
      });
    }
    async function setPhoto(ph) {
      if (AU.on && AU.user) { const j = await api("/photo", { photo: ph }); AU.user = j.user; }
      else { const p = DB.people.find((x) => x.id === UI.me); if (!p) throw new Error("Selecione quem você é na barra superior para guardar a foto."); if (ph) p.photo = ph; else delete p.photo; save(); }
      root.hcPaintAvatar(); const pv = $("#pf-prev"); if (pv) pv.style.backgroundImage = ph ? `url("${ph}")` : "";
    }
    ACT.profile = () => {
      const ph = myPhoto(), name = AU.on && AU.user ? AU.user.name : meLabel();
      modal("Meu perfil", `<div class="row" style="gap:16px;align-items:center"><div id="pf-prev" style="width:96px;height:96px;border-radius:50%;background:var(--accent-soft) center/cover no-repeat;${ph ? `background-image:url('${ph}')` : ""};flex:none;border:1px solid var(--line)"></div>
        <div><b>${esc(name)}</b><div class="muted small">${esc(AU.on && AU.user ? AU.user.email + " · " + ROLES[AU.user.role] : ROLES[UI.role])}</div>
        <div class="row" style="margin-top:10px"><label class="btn primary">Escolher foto<input type="file" accept="image/png,image/jpeg,image/webp" data-change="photo-file" hidden></label><button type="button" class="btn" data-act="photo-del">Remover foto</button></div>
        <p class="muted small" style="margin-top:6px">A imagem é recortada em quadrado e reduzida para 256 px.</p></div></div>`, { submit: "Fechar" });
    };
    CHG["photo-file"] = (el) => { const f = el.files[0]; el.value = ""; if (!f) return; if (f.size > 15e6) return toast("Imagem grande demais."); shrink(f).then(setPhoto).then(() => toast("Foto atualizada.")).catch((e) => toast(e.message)); };
    ACT["photo-del"] = () => setPhoto("").then(() => toast("Foto removida.")).catch((e) => toast(e.message));
    const origRole = CHG.role;
    CHG.role = (el) => { if (AU.on && AU.user && !allowed(el.value)) { el.value = UI.role; return toast("Perfil não permitido para sua conta."); } origRole(el); };
  };
})(typeof window !== "undefined" ? window : globalThis);
