/* Copia o servidor do HELSIM (pasta acima) para desktop/server e instala só as dependências de produção.
 * O aplicativo leva essa cópia junto e a usa quando não encontra um servidor já rodando na porta 3000. */
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");
const root = path.join(__dirname, ".."), out = path.join(__dirname, "server");
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
for (const f of ["server.js", "auth.js", "store.js", "tls.js", "package.json"]) fs.copyFileSync(path.join(root, f), path.join(out, f));
if (fs.existsSync(path.join(root, "package-lock.json"))) fs.copyFileSync(path.join(root, "package-lock.json"), path.join(out, "package-lock.json"));
fs.cpSync(path.join(root, "public"), path.join(out, "public"), { recursive: true });
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: out, stdio: "inherit" });
console.log("Servidor preparado em", out);
