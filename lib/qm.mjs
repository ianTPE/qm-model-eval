// Everything the tasks need to talk to a qm deployment and read back what it
// actually did. Deployment-specific paths live here and nowhere else, so a task
// file is only the behaviour it measures.
//
// Configure through the environment (see .env.example):
//
//   QM_ENV_FILE    path to the deployment's .env, for CORE_SIGNING_SECRET/ORG_ID
//   QM_CORE_URL    default http://127.0.0.1:8080
//   QM_PG_CONTAINER  docker container running postgres  (either this…)
//   QM_PSQL        full psql command, e.g. "psql postgresql://…"  (…or this)
//   QM_ACTOR       actor external id; defaults to the first ADMIN_GRANTS entry
//   QM_SLACK_USER_TOKEN, QM_SLACK_CHANNEL, QM_BOT_USER_ID   tier 2 only

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ENV_FILE = process.env.QM_ENV_FILE ?? "/home/ianc/GitHub/qm/.env";

export const deploymentEnv = (() => {
  const map = new Map();
  let text = "";
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    throw new Error(`cannot read QM_ENV_FILE=${ENV_FILE} — set it to your deployment's .env`);
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
})();

export const CORE_URL = process.env.QM_CORE_URL ?? "http://127.0.0.1:8080";
export const ORG_ID = process.env.QM_ORG_ID ?? deploymentEnv.get("ORG_ID") ?? "default";
export const ACTOR =
  process.env.QM_ACTOR ?? (deploymentEnv.get("ADMIN_GRANTS") ?? "").split(",")[0]?.split(":")[0] ?? "";

const SECRET = deploymentEnv.get("CORE_SIGNING_SECRET");
if (!SECRET) throw new Error(`CORE_SIGNING_SECRET missing from ${ENV_FILE}`);

// ---------------------------------------------------------------- database

const PG_CONTAINER = process.env.QM_PG_CONTAINER ?? "qm-authikey-pg";
const PSQL_CMD = process.env.QM_PSQL;

/** Run SQL and return the result as trimmed text (psql -tA). */
export function psql(sql) {
  if (PSQL_CMD) {
    const [cmd, ...args] = PSQL_CMD.split(/\s+/);
    return execFileSync(cmd, [...args, "-tA", "-c", sql], { encoding: "utf8" }).trim();
  }
  return execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "qm", "-tA", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

/** Single-quote a value for interpolation into SQL. */
export const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------- core API

/** Signed request against core. Source auth is HMAC over method, path and body. */
export async function signed(method, path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${method}\n${path}\n${payload}`).digest("hex")}`;
  const res = await fetch(`${CORE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-signature": sig,
      "x-event-id": randomUUID(),
      "x-admin-actor": `${ACTOR}@${ORG_ID}`,
    },
    ...(payload ? { body: payload } : {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, text };
  }
}

/** One synthesised turn. `channelRef` picks a channel scope; omit for a DM. */
export async function turn(text, channelRef) {
  const started = Date.now();
  const res = await signed("POST", "/v1/turns", {
    surface: "eval",
    actor: { externalId: ACTOR, displayName: "eval" },
    conversation: channelRef
      ? { kind: "channel", threadRef: `eval:${randomUUID()}`, channelRef, channelName: "#eval" }
      : { kind: "dm", threadRef: `eval:${randomUUID()}` },
    text,
  });
  return {
    ...res,
    seconds: (Date.now() - started) / 1000,
    reply: String(res.json?.reply ?? res.json?.reason ?? res.text ?? "").replace(/\s+/g, " "),
  };
}

export const scopeLabel = (channelRef) => (channelRef ? `channel:${channelRef}` : `personal:${ACTOR}`);

/** Which model actually served the last turn in this scope. Configuration is not evidence. */
export const servedModel = (scope) =>
  psql(`SELECT model FROM session_llm_requests WHERE scope_label=${q(scope)} ORDER BY created_at DESC LIMIT 1;`);

// ---------------------------------------------------------------- timing

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the deployment to go idle.
 *
 * Turns complete asynchronously long after the HTTP call returns. A run started
 * while the previous one is still working has that turn's late write land on top
 * of whatever this run just planted, which reads back as "the model didn't
 * write" or "the model clobbered it". Every state-reading task must call this
 * before touching anything; batches run without it produced failures for four
 * different models that all vanished on re-run.
 */
export async function quiesce(idleMs = 20_000, timeoutMs = 180_000) {
  const started = Date.now();
  let last = Number(psql(`SELECT coalesce(max(created_at),0) FROM session_llm_requests;`));
  let quietSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(5_000);
    const now = Number(psql(`SELECT coalesce(max(created_at),0) FROM session_llm_requests;`));
    if (now !== last) {
      last = now;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= idleMs) return true;
  }
  return false;
}

// ---------------------------------------------------------------- scopes

/**
 * Pin a scope to a model. The harness must also appear in
 * approved_harness_configs or the router silently falls back to the org default.
 *
 * `baseModels` is an in-memory map hydrated at boot, so a direct database write
 * is not enough on paths that do not create a session — reading the scope back
 * through the admin API forces the reconcile.
 */
export function pinScope(scope, harnessId, modelId) {
  psql(
    `INSERT INTO base_model_configs (id, json) VALUES (${q(scope)},
       ${q(JSON.stringify({ scopeId: scope, modelId, harnessId, orgRevision: 0 }))}::jsonb)
     ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json;`,
  );
  return signed("GET", `/v1/admin/scopes/${encodeURIComponent(scope)}`);
}
