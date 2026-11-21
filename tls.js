// Certificado próprio para o HTTPS da rede local (necessário para a câmera do celular).
// Gera com o openssl do sistema (o macOS já traz) em <dados>/tls e refaz quando o IP do computador muda.
// Regras que o iPhone exige: RSA 2048, SHA-256, validade de até 825 dias, nome alternativo (SAN) e uso serverAuth.
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");

const localIps = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);

function ensureCert(dataDir) {
  const dir = path.join(dataDir, "tls"), keyF = path.join(dir, "key.pem"), certF = path.join(dir, "cert.pem"), metaF = path.join(dir, "ips.json");
  const ips = localIps();
  try {
    const meta = JSON.parse(fs.readFileSync(metaF, "utf8"));
    const fresh = Date.now() - meta.created < 800 * 86400000 && ips.every((ip) => meta.ips.includes(ip));
    if (fresh && fs.existsSync(keyF) && fs.existsSync(certF)) return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF), ips: meta.ips };
  } catch (e) { /* ainda não existe */ }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const san = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((ip) => "IP:" + ip)].join(",");
    const base = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825", "-subj", "/CN=HELSIM rede local", "-keyout", keyF, "-out", certF];
    try { execFileSync("openssl", [...base, "-addext", "subjectAltName=" + san, "-addext", "extendedKeyUsage=serverAuth"], { stdio: "ignore" }); }
    catch (e) { execFileSync("openssl", base, { stdio: "ignore" }); } // openssl antigo sem -addext
    fs.chmodSync(keyF, 0o600);
    fs.writeFileSync(metaF, JSON.stringify({ ips, created: Date.now() }));
    return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF), ips };
  } catch (e) {
    console.log("Não foi possível criar o certificado HTTPS (" + e.message + "); o celular como câmera fica desligado.");
    return null;
  }
}
module.exports = { ensureCert, localIps };
