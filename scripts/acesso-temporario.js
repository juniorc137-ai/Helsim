#!/usr/bin/env node
/* Cria (ou renova) um acesso temporário com senha única, sem troca obrigatória.
 * Uso, com o servidor PARADO (ele guarda as contas na memória):
 *   node scripts/acesso-temporario.js <email> "<nome>" [perfil=admin|docente|estudante] [horas=48] [arquivo-de-saída]
 * A senha é gravada só no arquivo de saída (permissão 600), nunca na tela. */
const fs = require("fs"), path = require("path");
const { createAuth } = require("../auth");
const [email, name, role = "estudante", hours = "48", out] = process.argv.slice(2);
if (!email || !name || !out) { console.error("Uso: node scripts/acesso-temporario.js <email> \"<nome>\" [perfil] [horas] <arquivo-de-saída>"); process.exit(1); }
const auth = createAuth({ dataDir: process.env.HC_DATA_DIR || path.join(__dirname, "..", "data"), mailer: { kind: "none", send: async () => ({}) } });
const r = auth.createTemporary({ email, name, role, hours: Number(hours) });
if (r.error) { console.error(r.error); process.exit(2); }
const until = new Date(r.user.accessUntil).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
fs.writeFileSync(out, `HELSIM · acesso temporário\n\nE-mail: ${r.user.email}\nSenha: ${r.password}\nPerfil: ${role}\nVálido até: ${until} (horário de Brasília)\n\nNão é preciso trocar a senha. Depois desse horário o acesso para de funcionar sozinho.\nApague este arquivo depois de repassar a senha.\n`, { mode: 0o600 });
console.log(`Acesso criado para ${r.user.email} até ${until}. Senha gravada em ${out}.`);
