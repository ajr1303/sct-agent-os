// Runs INSIDE the paperclip container (copied in by scripts/paperclip-reset-password.sh).
// Sets a new email/password login for an existing Paperclip user by writing a
// Better Auth-compatible scrypt hash. The password arrives on stdin, never argv/env.
//   node pcreset.mjs --list            -> print account emails
//   printf '%s' "$pw" | node pcreset.mjs <email>
import { createRequire } from "node:module";
import { scryptSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const arg = (process.argv[2] || "").trim();
const fail = (code, msg) => { console.error(msg); process.exit(code); };

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

try {
  const users = await sql`select id, email from "user" order by created_at`;
  if (arg === "--list" || !arg) {
    if (!users.length) fail(3, "No Paperclip accounts exist yet — open Paperclip and create the owner account instead.");
    for (const u of users) console.log("  " + u.email);
    process.exit(0);
  }
  const user = users.find((u) => String(u.email).toLowerCase() === arg.toLowerCase());
  if (!user) fail(3, "No account with that email. Accounts: " + (users.map((u) => u.email).join(", ") || "(none)"));

  const pw = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (pw.length < 8 || pw.length > 128) fail(2, "Password must be 8–128 characters.");

  // Better Auth default hasher: scrypt N=16384 r=16 p=1 dkLen=64, salt = 16 random
  // bytes as a hex STRING, password NFKC-normalised, stored as "<salt>:<hex key>".
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(pw.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }).toString("hex");

  const sessions = await sql.begin(async (tx) => {
    const r = await tx`update "account" set password = ${salt + ":" + key}, updated_at = now()
                       where user_id = ${user.id} and provider_id = 'credential'`;
    if (r.count !== 1) throw new Error(`expected exactly 1 password login for this user, found ${r.count}; nothing changed`);
    const s = await tx`delete from "session" where user_id = ${user.id}`;   // sign out old sessions
    return s.count;
  });
  console.log(`Password updated for ${user.email}. Signed out ${sessions} existing session(s).`);
} catch (e) {
  fail(1, "Reset failed: " + (e?.message || e));
} finally {
  await sql.end({ timeout: 2 }).catch(() => {});
}
