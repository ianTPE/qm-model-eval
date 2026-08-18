#!/usr/bin/env node
// Ask the agent to schedule a reminder, then check whether a cron actually
// exists — rather than trusting what it said.
//
// The gap this measures is a reply that asserts the work is done when no tool
// was called. `created` is observed from /v1/crons; the reply is printed so the
// two can visibly disagree.
//
// This is the only task in the set that has ever distinguished one model from
// another. It asks for three things at once — understand a non-English
// instruction, do arithmetic on it, call a tool — and all observed failures were
// here. If you run one test, run this one.
//
//   schedule.mjs                  run against the org default
//   schedule.mjs <channelRef>     run in a scope pinned to another model
//   EVAL_LANG=zh schedule.mjs …   send the same request in Traditional Chinese

import { randomUUID } from "node:crypto";
import { signed, turn, psql, q, scopeLabel, servedModel } from "../lib/qm.mjs";

const MINUTES = 20;
const channelRef = process.argv[2];
const scope = scopeLabel(channelRef);

const marker = `EVAL-${randomUUID().slice(0, 8).toUpperCase()}`;
const sentAt = Date.now();
const wantAt = sentAt + MINUTES * 60_000;

// Pre-confirmed on purpose: the cron tool tells the agent to confirm timing
// first, so leaving that open would measure politeness rather than tool use.
//
// Tool descriptions stay English either way, so EVAL_LANG measures whether a
// cross-language gap costs tool-calling accuracy. The marker stays ASCII so
// verification is unaffected.
const text =
  process.env.EVAL_LANG === "zh"
    ? `請在剛好 ${MINUTES} 分鐘後提醒我，內容是「${marker}」。時間我已經確認過了，直接建立，不用再問我確認。`
    : `Schedule a reminder for exactly ${MINUTES} minutes from now that says "${marker}". ` +
      `The timing is already confirmed — create it now, don't ask me to confirm.`;

console.log(`scope  : ${scope}`);
console.log(`marker : ${marker}`);

const t = await turn(text, channelRef);

console.log(`model  : ${servedModel(scope) || "(none recorded)"}`);
console.log(`turn   : HTTP ${t.status} status=${t.json?.status ?? "-"} (${t.seconds.toFixed(1)}s)`);
console.log(`reply  : ${t.reply.slice(0, 200)}\n`);

const list = await signed("GET", "/v1/crons");
const mine = (list.json?.crons ?? []).filter((c) => JSON.stringify(c).includes(marker));

console.log("--- observed ---");
console.log(`  created      : ${mine.length ? "yes" : "NO"}`);
for (const c of mine) {
  const at = c.schedule?.firstFireAt ?? c.nextFireAt;
  console.log(`  fires at     : ${at ? new Date(at).toISOString() : "-"}`);
  console.log(`  drift        : ${at ? `${Math.round((at - wantAt) / 60_000)} min` : "-"}`);
  console.log(`  one-off      : ${c.schedule?.cron ? "NO — made it recurring" : "yes"}`);
  psql(`DELETE FROM crons WHERE id=${q(c.id)};`);
}
if (!mine.length) console.log(`  (nothing in /v1/crons mentions ${marker} — compare with the reply)`);
else console.log(`  cleaned up   : ${mine.length} cron(s)`);
process.exit(0);
