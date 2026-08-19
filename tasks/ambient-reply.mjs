#!/usr/bin/env node
// Does an answer to qm's own question, posted without an @-mention, get answered?
//
// This is the one task here that does not measure the scope's model. A Slack
// message that omits the mention is marked *ambient* and routed through a
// separate model call that decides whether to respond at all; only if that call
// says yes does the pinned model see the message. The gate runs on
// `judgeModelId`, which is `auxiliaryModelFor(org base model)` — the first
// registry entry flagged `auxiliary` for the org model's provider. Today that is
// `claude-haiku-4-5` for anthropic and `gpt-5.6-luna` for openai. Pinning a
// channel changes who answers; it does not change who decides whether to.
//
// So this task is scored per *org* model, not per channel model, and the pin
// below exists only to keep the answering half consistent across runs.
//
// The failure it reproduces: qm asks a colleague a question in a thread and
// commits to reporting back, the colleague answers in that thread without a
// mention — which is what qm's own message asked for — and the turn ends at the
// gate with an emoji instead of the report.
//
// One deliberate simplification: the answer comes from the same person who gave
// the instruction, because one user token is all this repo assumes. In the
// incident it was a second colleague. Nothing in the detection prompt's YES
// rules turns on who the answerer is — they turn on the message answering a
// question the assistant asked in a thread it is part of — so the shape holds,
// but a run here is a floor on the failure rate, not a reproduction of it.
//
// Requires QM_SLACK_USER_TOKEN (xoxp), QM_SLACK_CHANNEL and QM_BOT_USER_ID, and
// the token's owner must be a member of the channel.
//
//   ambient-reply.mjs <harness> <model>
//
//   EVAL_MENTION=1   put the mention back on the answer — the control. The gate
//                    is skipped entirely, so this should always come back `ok`.
//                    A run where both forms come back `ok` proves nothing; the
//                    contrast is the measurement.

import { psql, q, sleep, quiesce, pinScope } from "../lib/qm.mjs";

const CHANNEL = process.env.QM_SLACK_CHANNEL;
const BOT = process.env.QM_BOT_USER_ID;
const TOKEN = process.env.QM_SLACK_USER_TOKEN;
const MENTION = process.env.EVAL_MENTION === "1";
const [harness, model] = process.argv.slice(2);
if (!harness || !model) {
  console.error("usage: ambient-reply.mjs <harness> <model>");
  process.exit(1);
}
for (const [k, v] of [
  ["QM_SLACK_CHANNEL", CHANNEL],
  ["QM_BOT_USER_ID", BOT],
  ["QM_SLACK_USER_TOKEN", TOKEN],
])
  if (!v) throw new Error(`${k} is not set — the ambient path needs a real Slack channel`);

const slack = async (method, body) =>
  (
    await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    })
  ).json();

const selfSince = (ts) =>
  psql(
    `SELECT coalesce(string_agg(text,' ' ORDER BY ts),'') FROM channel_messages
     WHERE container=${q(CHANNEL)} AND self=true AND ts::numeric > ${ts};`,
  ).replace(/\s+/g, " ");

if (!(await quiesce())) console.log("  (warning: deployment never went idle — results may overlap)");

await pinScope(`channel:${CHANNEL}`, harness, model);

// A fresh fact each run. Asking the same question twice lets a model answer from
// the transcript instead of from the reply we are testing, which is trap 6 in
// the README wearing different clothes.
const TICKET = `MAINT-${Math.floor(1000 + Math.random() * 9000)}`;
const ANSWER = `9/${10 + Math.floor(Math.random() * 18)}`;

console.log(`model    : ${harness}/${model}   (answering half only — the gate runs on the org's auxiliary model)`);
console.log(`ticket   : ${TICKET}`);
console.log(`answer   : ${ANSWER}`);
console.log(`form     : ${MENTION ? "WITH mention (control — gate skipped)" : "no mention (ambient path)"}`);

// Step 1. Get qm to ask a question in a thread and commit to reporting back.
// The mention here is deliberate: this half must not be gated, or a failure at
// step 1 would be indistinguishable from the failure we are measuring.
const opened = await slack("chat.postMessage", {
  channel: CHANNEL,
  text:
    `<@${BOT}> 這個 thread 裡的人負責機房維護（案號 ${TICKET}）。` +
    `請你在這一串問他們：${TICKET} 的維護要排哪一天？` +
    `問完就等他們回覆，收到日期之後回報給我，不要自己猜。`,
});
if (!opened.ok) throw new Error(`postMessage failed: ${opened.error}`);
const threadTs = opened.ts;

// Step 2. Wait for qm to actually ask. If it never does, the run is
// inconclusive — not a pass and not a failure of the gate.
let asked = "";
{
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    asked = selfSince(threadTs);
    if (asked) break;
  }
}
if (!asked) {
  console.log("\n--- observed ---");
  console.log("  outcome        : INCONCLUSIVE — qm never posted the question, so there was nothing to answer");
  process.exit(0);
}
console.log(`asked    : ${asked.slice(0, 160)}`);

// qm's security screen quarantines a share of Slack requests before the model
// runs — asking it to interrogate the room has an injection-ish shape, and the
// rate is non-deterministic. A quarantined setup leaves a thread whose only bot
// message is the refusal, so step 3 posts an answer to a question nobody asked,
// and the gate declines it *correctly*. Scoring that as a gate failure is the
// same mistake as every trap in the README: a broken setup charged to the thing
// under test. The first version of this task did exactly that on its first run.
if (/security screen|quarantine/i.test(asked)) {
  console.log("\n--- observed ---");
  console.log("  outcome        : INCONCLUSIVE — security screen quarantined the setup; qm never asked anything");
  process.exit(0);
}
// The question also has to actually be a question. A model that acknowledges
// the instruction without asking leaves the same empty thread.
if (!asked.includes(TICKET) && !/[?？]/.test(asked)) {
  console.log("\n--- observed ---");
  console.log("  outcome        : INCONCLUSIVE — qm replied but never put the question in the thread");
  process.exit(0);
}

await quiesce(10_000, 120_000);

// Step 3. Answer in the same thread. No mention unless the control is on. This
// is the exact shape qm's own message asks for when it says to reply in-thread.
const beforeAnswer = Date.now();
const answered = await slack("chat.postMessage", {
  channel: CHANNEL,
  thread_ts: threadTs,
  text: `${MENTION ? `<@${BOT}> ` : ""}${TICKET} 的維護排 ${ANSWER}，已經跟廠商確認過了。`,
});
if (!answered.ok) throw new Error(`postMessage failed: ${answered.error}`);

// Step 4. Read the turn's own verdict. `react` and `silent` are what the gate
// returns when it decides not to respond; `ok` means the pinned model ran.
// Reading the reply text alone cannot tell those apart from a model that ran
// and chose to say nothing.
//
// Wait on the run row itself, not on `quiesce()`. quiesce watches
// `session_llm_requests`, and a turn the gate declines may never write a row
// there — the detection call is recorded only in an in-memory ring, so the
// judge is invisible in the durable record. On the first clean run that made
// quiesce report "idle" 15s after the answer was posted, before the run row
// existed, and the task printed `(no run)` for a turn that had come back
// `react`. The harness's own idle detector is blind to exactly the turns this
// task exists to catch.
let raw = "";
{
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    raw = psql(
      `SELECT coalesce(result,'') FROM runs
       WHERE session_id=${q(`ch:${CHANNEL}:${threadTs}`)} AND created_at >= ${beforeAnswer}
       ORDER BY created_at DESC LIMIT 1;`,
    );
    if (raw) break;
  }
}
let status = "(no run)";
try {
  if (raw) status = JSON.parse(raw).status ?? "(no status)";
} catch {
  status = "(unparseable)";
}

// Was the message even ingested? A thread reply that qm never took up is a
// different failure from one it took up and discarded, and only this tells them
// apart. `handled` is written by the Slack plugin at dispatch time.
const handled = psql(
  `SELECT coalesce(bool_or(handled),false) FROM channel_messages
   WHERE container=${q(CHANNEL)} AND ts::numeric > ${threadTs} AND self=false
     AND text LIKE ${q(`%${TICKET}%${ANSWER}%`)};`,
);

const reported = selfSince(answered.ts);
const carriesDate = reported.includes(ANSWER);

console.log(`report   : ${reported.slice(0, 200) || "(qm posted nothing)"}\n`);
console.log("--- observed ---");
console.log(`  ingested       : ${handled === "t" ? "yes" : "NO — never dispatched a turn"}`);
console.log(`  turn status    : ${status}`);
console.log(`  reported back  : ${reported ? "yes" : "NO — silent"}`);
console.log(`  carries date   : ${carriesDate ? "yes" : "no"}`);
console.log(
  `  outcome        : ${
    status === "ok" && carriesDate
      ? "PASS — the answer reached the model and came back as a report"
      : status === "react"
        ? "FAIL — gate acknowledged with an emoji and dropped the commitment"
        : status === "silent"
          ? "FAIL — gate discarded the answer with no trace in Slack"
          : handled !== "t"
            ? "FAIL — the reply never became a turn at all"
            : "FAIL — turn ran but no report carrying the date came back"
  }`,
);
process.exit(0);
