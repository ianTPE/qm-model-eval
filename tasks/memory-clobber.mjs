#!/usr/bin/env node
// Does adding a second remembered fact destroy the first?
//
// `memory` action=rewrite replaces the whole notebook — the tool says so, and
// tells the model to read first and write back the full corrected notebook,
// never a fragment. A model that rewrites with only the new line wipes
// everything else and reports success.
//
// Plant a sentinel through the database, ask for an unrelated second fact, check
// whether the sentinel survived.
//
// Result so far: nothing. Every model passes once the probes below are neutral
// and the run is isolated. Each of the three "failures" this task once reported
// was an artefact — see the traps in the README. Kept because a task that cannot
// fail is indistinguishable from a task that is blind, and `negative-control`
// mode proves this one still sees a real clobber.
//
//   memory-clobber.mjs <channelRef>
//   EVAL_NEGATIVE_CONTROL=1 memory-clobber.mjs <channelRef>   sentinel SHOULD vanish

import { randomUUID } from "node:crypto";
import { turn, psql, q, scopeLabel, servedModel, quiesce } from "../lib/qm.mjs";

const channelRef = process.argv[2];
const scope = scopeLabel(channelRef);

if (!(await quiesce())) console.log("  (warning: never went idle — result may overlap a previous run)");

// The sentinel has to be something a model has no reason to remove. It used to
// read "The office wifi password is …", and a security-minded model deleted it
// on purpose — 「我不會把內部代碼、密碼或其他敏感憑證存入長期記憶」 — which this
// task scored as clobbering, four runs out of six. A meeting room is not a
// secret. Nothing in this task should look like a credential.
const SENTINEL = `ROOM-${randomUUID().slice(0, 4).toUpperCase()}`;

// Plant a fixed baseline rather than appending to whatever is there. A turn's
// memory write can land after the run's own rollback, so appending accumulates
// earlier runs' facts, and the model then correctly declines to write again.
const planted = `# Memory\n\n- The team retrospective is held in meeting room ${SENTINEL}`;
const nextSeq = Number(psql(`SELECT coalesce(max(seq),0)+1 FROM memory_revisions WHERE scope_id=${q(scope)};`));
psql(
  `INSERT INTO memory_revisions (scope_id, seq, op, body, author, at)
   VALUES (${q(scope)}, ${nextSeq}, 'replace', ${q(planted)}, 'eval', ${Date.now()});`,
);

console.log(`scope    : ${scope}`);
console.log(`planted  : ${SENTINEL}`);

// The second fact carries a fresh ticket number every run. Asking for the *same*
// fact each time let the model read the channel transcript, see it had already
// answered this, and skip the write — a correct refusal scored as a failure. It
// has to be a ticket number rather than a "code", or a careful model refuses to
// store it as a credential.
const FACT = `OPS-${Math.floor(1000 + Math.random() * 9000)}`;
const zh = process.env.EVAL_LANG === "zh";
const ask = process.env.EVAL_NEGATIVE_CONTROL
  ? zh
    ? `忘掉你之前記住的所有內容。從現在起記憶裡只保留這一件事：部署時間是每週二早上九點，追蹤工單是 ${FACT}。`
    : `Forget everything you have remembered so far. From now on keep only this one fact in memory: the deploy window is Tuesdays at 9am, tracked in ticket ${FACT}.`
  : zh
    ? `另外記住：我們的部署時間是每週二早上九點，追蹤工單是 ${FACT}。其他你已經記得的事情都保留。`
    : `Also remember: our deploy window is Tuesdays at 9am, tracked in ticket ${FACT}. Keep everything else you already remember.`;

const t = await turn(ask, channelRef);
const after = psql(`SELECT coalesce(body,'') FROM memory_revisions WHERE scope_id=${q(scope)} ORDER BY seq DESC LIMIT 1;`);

console.log(`model    : ${servedModel(scope) || "(none)"}`);
console.log(`asked    : ${FACT}${process.env.EVAL_NEGATIVE_CONTROL ? "  (negative control — sentinel SHOULD vanish)" : ""}`);
console.log(`reply    : ${t.reply.slice(0, 160)}\n`);

// Judge only what this run added. The notebook carries whatever earlier runs
// left behind, so testing the whole text reports success for a model that wrote
// nothing at all.
const added = after.startsWith(planted) ? after.slice(planted.length) : after === planted ? "" : after;

console.log("--- observed ---");
console.log(`  changed        : ${after !== planted ? "yes" : "no"}`);
console.log(`  sentinel kept  : ${after.includes(SENTINEL) ? "yes" : "NO — clobbered"}`);
console.log(`  new fact added : ${added.includes(FACT) ? "yes" : "no"}`);
if (process.env.EVAL_DUMP) console.log(`\n--- notebook after ---\n${after}\n--- end ---`);

psql(`DELETE FROM memory_revisions WHERE scope_id=${q(scope)} AND seq >= ${nextSeq};`);
console.log(`  rolled back    : revisions from seq ${nextSeq}`);
process.exit(0);
