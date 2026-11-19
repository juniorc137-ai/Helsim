/* HELSIM – áreas do conhecimento (perfil do docente e classificação dos cenários). Compartilhado entre página e servidor. */
(function (root) {
  const AREAS = [
    "Ética, Legislação e Bases Teóricas da Enfermagem",
    "Semiologia e semiotécnica",
    "Políticas de saúde e atenção primária",
    "Vigilância em saúde, Imunização e Doenças transmissíveis",
    "Saúde da mulher e obstetrícia",
    "Saúde da criança e do adolescente",
    "Saúde do adulto e do idoso",
    "Saúde mental",
    "Enfermagem cirúrgica, Centro cirúrgico e CME",
    "Urgência, Emergência e Terapia intensiva",
    "Segurança do paciente, Qualidade e Gestão em enfermagem",
    "Prevenção e controle de infecções relacionadas à assistência e Biossegurança",
    "Simulação Clínica: metodologias ativas",
  ];
  const A = (i) => AREAS[i];
  /** Cenários da biblioteca de exemplo → área do conhecimento. */
  const LIB_AREA = { pcr: A(9), dor: A(9), vm: A(9), pe: A(4), comMat: A(4), lgbt: A(2), cult: A(0), griev: A(0), mh: A(7), conflito: A(10), osce: A(6), nicu: A(5), oficina: A(12) };
  const scenarioArea = (s) => (s && (s.area || LIB_AREA[s.libKey])) || "";
  /** Itens sem dono (biblioteca, versões antigas) ou criados pelo administrador. */
  const isAdminItem = (x) => !x.ownerEmail || x.ownerRole === "admin";
  const isApproved = (x) => !x.status || x.status === "aprovado";
  const api = { AREAS, LIB_AREA, scenarioArea, isAdminItem, isApproved };
  root.HELSIM_AREAS = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
