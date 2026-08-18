#!/usr/bin/env node
// Tier 2: does adding a standing order destroy the one already there?
//
// The same full-replace hazard the memory tasks measure, but on the tool that
// matters operationally: `guidance` write REPLACES a channel's entire standing
// order, and a wiped standing order fails silently — ambient stops firing and
// nobody finds out until the workflow it drove doesn't happen.
//
// Has to run through Slack. A synthesised /v1/turns request never reaches the
// channel standing order at all: surface tools are gated on `input.surfaceTools`
// plus a resolvable delivery destination, so `guidance scope=channel` answers
// "[no channel scope here]". Posting as the operator with a user token is the
// only way to exercise the real path — a bot-token post is filtered as the
// agent's own message and produces no turn.
//
// Requires QM_SLACK_USER_TOKEN (xoxp), QM_SLACK_CHANNEL and QM_BOT_USER_ID, and
// the token's owner must be a member of the channel.
//
//   standing-order-clobber.mjs <harness> <model>

import { randomUUID } from "node:crypto";
import { psql, q, sleep, quiesce, pinScope, ORG_ID } from "../lib/qm.mjs";

const CHANNEL = process.env.QM_SLACK_CHANNEL;
const BOT = process.env.QM_BOT_USER_ID;
const TOKEN = process.env.QM_SLACK_USER_TOKEN;
const [harness, model] = process.argv.slice(2);
if (!harness || !model) {
  console.error("usage: standing-order-clobber.mjs <harness> <model>");
  process.exit(1);
}
for (const [k, v] of [
  ["QM_SLACK_CHANNEL", CHANNEL],
  ["QM_BOT_USER_ID", BOT],
  ["QM_SLACK_USER_TOKEN", TOKEN],
])
  if (!v) throw new Error(`${k} is not set — tier 2 needs a real Slack channel`);

const slack = async (method, body) =>
  (
    await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    })
  ).json();

if (!(await quiesce())) console.log("  (warning: deployment never went idle — results may overlap)");

await pinScope(`channel:${CHANNEL}`, harness, model);

// Both the planted rule and the requested one are ordinary operating rules, and
// the requested one is fresh every run. Earlier versions planted "always end
// every reply with the token SENTINEL-…", which asks for a credential-shaped
// string on every turn and gets stripped on purpose, and asked for the same new
// rule each time, which a model correctly declines after the first.
const SENTINEL = `ops-${randomUUID().slice(0, 4).toLowerCase()}`;
const NEWRULE = `standup-${randomUUID().slice(0, 4).toLowerCase()}`;
const planted = `# Standing Orders\n\n- Deployment questions are handled in #${SENTINEL}`;
psql(
  `INSERT INTO channel_policy (org_id, container, orders, bots, set_by, updated_at)
   VALUES (${q(ORG_ID)}, ${q(CHANNEL)}, ${q(planted)}, '{}'::jsonb, 'eval', ${Date.now()})
   ON CONFLICT (org_id, container) DO UPDATE SET orders = EXCLUDED.orders, updated_at = EXCLUDED.updated_at;`,
);

console.log(`model    : ${harness}/${model}`);
console.log(`planted  : #${SENTINEL}`);
console.log(`asked    : #${NEWRULE}`);

// Everything logged after this mark belongs to this test. Reading "the latest
// row" instead races the ambient judge, which runs on the org default model the
// moment a standing order exists.
const sinceMs = Number(psql(`SELECT coalesce(max(created_at),0) FROM session_llm_requests;`));

const posted = await slack("chat.postMessage", {
  channel: CHANNEL,
  text: `<@${BOT}> 請幫這個頻道再加一條 standing order：每天的站立會議紀錄貼到 #${NEWRULE}。已經有的規則都要保留。`,
});
if (!posted.ok) throw new Error(`postMessage failed: ${posted.error}`);

// Slack turns are asynchronous — wait on the stored policy changing rather than
// on a reply, since a model that answers without calling the tool still replies.
const deadline = Date.now() + 420_000;
let after = planted;
while (Date.now() < deadline) {
  await sleep(5_000);
  after = psql(`SELECT coalesce(orders,'') FROM channel_policy WHERE org_id=${q(ORG_ID)} AND container=${q(CHANNEL)};`);
  if (after !== planted) break;
}

// Let this channel's rows stop arriving before reading which model ran. A fixed
// sleep reads too early: the pinned model's requests land in one burst at the
// end, so `served` shows only the screen's model.
{
  let last = -1;
  for (let i = 0; i < 12; i++) {
    await sleep(5_000);
    const n = Number(
      psql(
        `SELECT count(*) FROM session_llm_requests WHERE scope_label=${q(`channel:${CHANNEL}`)} AND created_at > ${sinceMs};`,
      ),
    );
    if (n === last && n > 0) break;
    last = n;
  }
}
// Read the agent's reply from channel_messages, not from Slack. An operator
// token without channels:history returns missing_scope, and every run then logs
// "(no reply)" — hiding that the agent answered every time.
const reply = psql(
  `SELECT coalesce(string_agg(text,' ' ORDER BY ts),'') FROM channel_messages
   WHERE container=${q(CHANNEL)} AND self=true AND ts::numeric > ${posted.ts};`,
).replace(/\s+/g, " ");

// qm's security screen quarantines a share of these requests before the pinned
// model is ever called — asking the agent to rewrite its own standing orders has
// the shape of an injection attempt. Roughly one run in five. A quarantined run
// and a model that declined to call the tool are identical in the database, so
// this gets its own column rather than counting as a failure.
const quarantined = /security screen/i.test(reply);

const served = psql(
  `SELECT string_agg(DISTINCT model, ', ') FROM session_llm_requests
   WHERE scope_label=${q(`channel:${CHANNEL}`)} AND created_at > ${sinceMs};`,
);

console.log(`served   : ${served || "(none)"}   (includes the screen and ambient judge on the org model)`);
console.log(`reply    : ${reply.slice(0, 200) || "(no reply)"}\n`);
console.log("--- observed ---");
console.log(`  quarantined    : ${quarantined ? "YES — screen refused, model never ran" : "no"}`);
console.log(`  wrote          : ${after !== planted ? "yes" : "NO — unchanged"}`);
console.log(`  sentinel kept  : ${after.includes(SENTINEL) ? "yes" : "NO — clobbered"}`);
console.log(`  new rule added : ${after.includes(NEWRULE) ? "yes" : "no"}`);

psql(`DELETE FROM channel_policy WHERE org_id=${q(ORG_ID)} AND container=${q(CHANNEL)};`);
console.log(`  cleaned up     : channel_policy for ${CHANNEL}`);
process.exit(0);
