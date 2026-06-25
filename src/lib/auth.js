/**
 * Autenticación simple para el equipo (3 personas, todos los roles).
 * Sin dependencias extra: token firmado con HMAC-SHA256 (estilo JWT).
 *
 * Variables de entorno (se configuran en Railway):
 *   JWT_SECRET  = una cadena larga y aleatoria (firma de los tokens)
 *   APP_USERS   = "usuario1:clave1,usuario2:clave2,usuario3:clave3"
 *
 * Si NO se configuran, la autenticación queda DESACTIVADA (la app sigue
 * abierta) — así se puede desplegar sin romper nada y activarla después
 * poniendo las dos variables.
 */
const crypto = require("crypto");

const SECRET = process.env.JWT_SECRET || "";

function parseUsers() {
  const raw = process.env.APP_USERS || "";
  const m = {};
  raw.split(",").forEach((par) => {
    const i = par.indexOf(":");
    if (i > 0) m[par.slice(0, i).trim()] = par.slice(i + 1);
  });
  return m;
}
const USERS = parseUsers();
const AUTH_ENABLED = !!(SECRET && Object.keys(USERS).length);

const VIGENCIA_MS = 12 * 60 * 60 * 1000; // 12 horas

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function firmar(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verificar(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const esperado = b64url(crypto.createHmac("sha256", SECRET).update(body).digest());
  // comparación en tiempo constante
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()); }
  catch (e) { return null; }
  if (p.exp && Date.now() > p.exp) return null;
  return p;
}
function login(usuario, clave) {
  if (USERS[usuario] !== undefined && USERS[usuario] === clave) {
    return firmar({ user: usuario, exp: Date.now() + VIGENCIA_MS });
  }
  return null;
}
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const p = verificar(token);
  if (!p) return res.status(401).json({ error: "No autorizado" });
  req.user = p.user;
  next();
}

module.exports = { AUTH_ENABLED, login, requireAuth };
