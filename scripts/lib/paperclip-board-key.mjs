// Runs INSIDE the paperclip container (copied in by scripts/paperclip-connect.sh).
// Issues a board API key for an existing Paperclip user and prints ONLY the key on
// stdout, so the wrapper can pipe it straight into the dashboard's key store. This
// Paperclip version has an API for board keys but no screen to create one.
// Mirrors Paperclip's own format: token "pcp_board_<48 hex>", stored as sha256 hex.
// The key does not expire (Paperclip's default would end it after 30 days and
// silently disconnect the dashboard); older keys this script issued are revoked.
//   node pckey.mjs --list      -> print account emails (stderr)
//   node pckey.mjs [email]     -> print a new key for that user (or the only user)
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

// PCKEY_NAME lets an operator issue a separately named key (for a one-off admin task)
// without revoking the dashboard's own key, which is matched by name below.
const NAME = (process.env.PCKEY_NAME || "Agent OS dashboard").slice(0, 80);
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
  if (!users.length) fail(3, "No Paperclip account exists yet. Open Paperclip, create the owner account, then run this again.");
  if (arg === "--list") { for (const u of users) console.error("  " + u.email); process.exit(0); }
  let user;
  if (arg) user = users.find((u) => String(u.email).toLowerCase() === arg.toLowerCase());
  else if (users.length === 1) user = users[0];
  if (!user) fail(4, "Which account? " + users.map((u) => u.email).join(", "));

  const token = "pcp_board_" + randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql.begin(async (tx) => {
    await tx`update board_api_keys set revoked_at = now()
             where user_id = ${user.id} and name = ${NAME} and revoked_at is null`;
    await tx`insert into board_api_keys (user_id, name, key_hash, expires_at)
             values (${user.id}, ${NAME}, ${hash}, null)`;
  });
  console.error("Issued a dashboard key for " + user.email + ".");
  process.stdout.write(token);
} catch (e) {
  fail(1, "Could not issue a key: " + (e?.message || e));
} finally {
  await sql.end({ timeout: 2 }).catch(() => {});
}
