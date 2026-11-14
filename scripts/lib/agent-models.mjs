// Runs INSIDE the paperclip container (copied in by scripts/agent-models.sh).
// For every agent that runs on a Hermes gateway, ask that gateway which model and
// provider it is configured to use, and print one JSON line per agent on stdout.
//
// Why here: asking needs the gateway's key, and Paperclip already holds each key in
// its encrypted secret store. This script reads the key in place, uses it for one
// read-only request, and never prints, stores or forwards it. Only model names leave.
//
// A key is only ever sent over HTTPS, or over plain HTTP to a gateway on this same
// Docker network / loopback (the box's own Hermes).
import { createRequire } from "node:module";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const TIMEOUT_MS = Number(process.env.AGENT_MODELS_TIMEOUT_MS || 12000);
const note = (...a) => console.error(...a);

export function decodeMasterKey(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(t)) return Buffer.from(t, "hex");
  try { const b = Buffer.from(t, "base64"); if (b.length === 32) return b; } catch {}
  return Buffer.byteLength(t, "utf8") === 32 ? Buffer.from(t, "utf8") : null;
}
export function loadMasterKey(env = process.env) {
  if (env.PAPERCLIP_SECRETS_MASTER_KEY && env.PAPERCLIP_SECRETS_MASTER_KEY.trim()) return decodeMasterKey(env.PAPERCLIP_SECRETS_MASTER_KEY);
  const home = env.PAPERCLIP_HOME || "/paperclip", inst = env.PAPERCLIP_INSTANCE_ID || "default";
  for (const p of [env.PAPERCLIP_SECRETS_MASTER_KEY_FILE, `${home}/instances/${inst}/secrets/master.key`]) {
    if (p && existsSync(p)) return decodeMasterKey(readFileSync(p, "utf8"));
  }
  return null;
}
// Paperclip's local_encrypted_v1: AES-256-GCM, base64 iv / tag / ciphertext.
export function decryptMaterial(masterKey, material, expectedSha256) {
  if (!material || material.scheme !== "local_encrypted_v1") throw new Error("unsupported secret scheme");
  const d = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(material.iv, "base64"));
  d.setAuthTag(Buffer.from(material.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(material.ciphertext, "base64")), d.final()]).toString("utf8");
  if (expectedSha256 && createHash("sha256").update(plain).digest("hex") !== expectedSha256) throw new Error("secret checksum mismatch");
  return plain;
}
export function keyMayBeSentTo(urlStr) {
  let u; try { u = new URL(urlStr); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || !h.includes(".");   // loopback or a Docker service name
}
async function getJson(url, key) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + key, Accept: "application/json", "User-Agent": "agent-os-models/1.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  return r.json();
}
const short = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
export async function probe(baseUrl, key) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const out = { model: null, provider: null, hermes_version: null, ok: false, error: null, options: [] };
  try {
    const d = await getJson(base + "/api/model/options?include_unconfigured=false", key);
    out.model = short(d && d.model); out.provider = short(d && d.provider);
    // Providers this machine holds credentials for, with the models it lists for each:
    // the only choices a "change model" control should offer.
    const opts = [];
    for (const r of Array.isArray(d && d.providers) ? d.providers : []) {
      if (!r || !r.authenticated || !Array.isArray(r.models) || !r.models.length) continue;
      const ids = r.models.map((m) => short(typeof m === "string" ? m : m && (m.id || m.name))).filter(Boolean).slice(0, 80);
      if (short(r.slug) && ids.length) opts.push({ slug: short(r.slug), name: short(r.name) || short(r.slug), models: ids });
      if (opts.length >= 12) break;
    }
    out.options = opts;
  } catch (e) {
    out.error = e.status === 401 || e.status === 403 ? "The gateway refused the stored key."
      : e.status === 404 ? "This Hermes version does not report its model." : "Could not reach the gateway (" + String(e.message || e).slice(0, 60) + ").";
  }
  try { const hd = await getJson(base + "/health", key); out.hermes_version = short(hd && hd.version); } catch {}
  if (out.model) { out.ok = true; out.error = null; }
  else if (!out.error) out.error = "The gateway did not name a model.";
  return out;
}

async function main() {
  let port = 54329;
  try {
    const cfg = JSON.parse(readFileSync(process.env.PAPERCLIP_CONFIG || "/paperclip/instances/default/config.json", "utf8"));
    port = cfg?.database?.embeddedPostgresPort ?? port;
  } catch {}
  const url = process.env.DATABASE_URL || `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  const require = createRequire(process.env.PC_DB_PKG || "/app/packages/db/package.json");
  const mod = require("postgres");
  const postgres = typeof mod === "function" ? mod : mod.default;
  const sql = postgres(url, { max: 1, onnotice() {} });
  let masterKey = null, n = 0, good = 0;
  try {
    const agents = await sql`select id, company_id, name, adapter_config from agents
                             where adapter_type = 'hermes_gateway' and status <> 'terminated' order by name`;
    for (const a of agents) {
      const cfg = a.adapter_config || {}, base = typeof cfg.apiBaseUrl === "string" ? cfg.apiBaseUrl.trim() : "";
      const row = { agent_id: a.id, name: a.name, model: null, provider: null, hermes_version: null, ok: false, error: null,
                    checked_at: new Date().toISOString() };
      try {
        if (!base) throw new Error("No gateway address is set for this agent.");
        if (!keyMayBeSentTo(base)) throw new Error("The gateway address is not HTTPS, so its key was not sent.");
        let key = null;
        const ref = cfg.apiKey;
        if (typeof ref === "string" && ref.trim()) key = ref.trim();
        else if (ref && typeof ref === "object" && ref.type === "secret_ref" && ref.secretId) {
          const [s] = await sql`select id, provider, latest_version from company_secrets
                                where id = ${ref.secretId} and company_id = ${a.company_id} and deleted_at is null`;
          if (!s) throw new Error("The gateway key is missing from Paperclip's secret store.");
          if (s.provider !== "local_encrypted") throw new Error("The gateway key is held by an external secret provider.");
          const ver = Number.isInteger(ref.version) ? ref.version : s.latest_version;
          const [v] = await sql`select material, value_sha256 from company_secret_versions
                                where secret_id = ${s.id} and version = ${ver} and revoked_at is null`;
          if (!v) throw new Error("The gateway key has no usable version in Paperclip.");
          masterKey = masterKey || loadMasterKey();
          if (!masterKey) throw new Error("Paperclip's secret key file could not be read.");
          key = decryptMaterial(masterKey, v.material, v.value_sha256);
        }
        if (!key) throw new Error("No gateway key is set for this agent.");
        Object.assign(row, await probe(base, key));
        key = null;
      } catch (e) { row.error = String(e.message || e).slice(0, 160); }
      n++; if (row.ok) good++;
      process.stdout.write(JSON.stringify(row) + "\n");
    }
    note(`agent models: ${good} of ${n} gateways reported a model`);
  } finally { await sql.end({ timeout: 2 }).catch(() => {}); }
}
if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((e) => { note("agent models: failed: " + String(e?.message || e).slice(0, 200)); process.exit(1); });
}
