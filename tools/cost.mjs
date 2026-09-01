#!/usr/bin/env node
// Turns the measured token usage into dollars, per provider's own cache rules.
//
// qm records usage but cannot price it across providers: `usage_json.costUsd`
// is populated only where the harness gets a cost back from the provider, which
// on this deployment is Anthropic and native OpenAI — 0 for qwen, deepseek,
// kimi, glm. So the arithmetic happens here, outside qm, against list prices on
// a stated date. Tokens do not go stale; prices do. Re-run with new prices, not
// with new tokens.
//
//   node tools/cost.mjs          # reads tools/usage.sql against the deployment
//
// The one thing that makes this comparison possible is that `cacheWrite: 0` on
// four of the providers is not "no caching" — it is a different caching
// architecture. Anthropic and OpenAI cache on client direction, so the tokens
// that go into the cache are reported separately. DeepSeek, Moonshot, DashScope
// and Z.ai cache server-side on a prefix match, so a miss is reported in
// `input` at the ordinary rate and there is no write to bill. Structurally,
// deepseek's `input` 8,628 sits where anthropic's `input + cacheWrite` 5,567
// sits. Comparing the `input` columns directly would say the opposite.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PG = process.env.QM_PG_CONTAINER ?? "qm-authikey-pg";
const PRICED_ON = "2026-08";

// input/output USD per million tokens, and how each provider bills the cache.
//
//   anthropic : cacheWrite billed at 1.25x input, cacheRead at 0.10x
//   openai    : qm reports uncached input under cacheWrite; cacheRead at 0.10x
//   prefix    : server-side; cacheWrite is structurally 0, cacheRead discounted
const PRICES = {
  "claude-opus-5":     { in: 5,    out: 25,   cache: "anthropic" },
  "claude-sonnet-5":   { in: 2,    out: 10,   cache: "anthropic" },
  "claude-haiku-4-5":  { in: 1,    out: 5,    cache: "anthropic" },
  "gpt-5.6-sol":       { in: 5,    out: 30,   cache: "openai" },
  "gpt-5.6-terra":     { in: 2,    out: 12,   cache: "openai" },
  "gpt-5.6-luna":      { in: 0.20, out: 1.20, cache: "openai" },
  // DeepSeek halves its rates outside 01:00–04:00 and 06:00–10:00 UTC; the
  // off-peak figure is the lower bound, and background work on a cron you
  // control can be scheduled into it.
  "deepseek-v4-flash": { in: 0.44, out: 1.32, cache: "prefix", hit: 0.1, offPeak: 0.5 },
  "deepseek-v4-pro":   { in: 1.32, out: 3.96, cache: "prefix", hit: 0.1, offPeak: 0.5 },
  "kimi-k3":           { in: 3,    out: 15,   cache: "prefix", hit: 0.1 },
  // DashScope's cache-hit discount is the least certain number here; 0.4 is a
  // conservative reading and the figure most likely to move.
  "qwen3.8-max":       { in: 2,    out: 6,    cache: "prefix", hit: 0.4, soft: true },
  // Not priced: no list price I am willing to state for glm-5.3, and
  // openrouter/auto picks a model per request while qm records only the alias,
  // so there is no rate to apply.
  "glm-5.3":           null,
  "openrouter/auto":   null,
};

// Scheduling passes out of six runs (3 en + 3 zh), from "What the runs showed".
const PASSED = {
  "claude-opus-5": 6, "claude-sonnet-5": 6, "claude-haiku-4-5": 3,
  "gpt-5.6-sol": 6, "gpt-5.6-terra": 6, "gpt-5.6-luna": 6,
  "deepseek-v4-flash": 6, "deepseek-v4-pro": 6, "kimi-k3": 6,
  "qwen3.8-max": 6, "glm-5.3": 3, "openrouter/auto": 2,
};

const rows = execFileSync(
  "docker",
  ["exec", "-i", PG, "psql", "-U", "postgres", "-d", "qm", "-tA", "-F", "\t"],
  { input: readFileSync(new URL("./usage.sql", import.meta.url), "utf8"), encoding: "utf8" },
)
  .trim()
  .split("\n")
  .map((line) => {
    const [model, turns, input, cacheWrite, cacheRead, output, median, p95] = line.split("\t");
    return { model, turns: +turns, input: +input, cacheWrite: +cacheWrite, cacheRead: +cacheRead, output: +output, median: +median, p95: +p95 };
  });

const usd = (r, p, offPeak = false) => {
  if (!p) return null;
  const scale = offPeak && p.offPeak ? p.offPeak : 1;
  const inRate = (p.in * scale) / 1e6;
  const outRate = (p.out * scale) / 1e6;
  const write = p.cache === "anthropic" ? 1.25 : p.cache === "openai" ? 1 : 0;
  const read = p.cache === "prefix" ? p.hit : 0.1;
  return r.input * inRate + r.cacheWrite * write * inRate + r.cacheRead * read * inRate + r.output * outRate;
};

const fmt = (n) => (n === null ? "—" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);

console.log(`list prices as of ${PRICED_ON}; computed outside qm — see the header of this file\n`);
console.log("| model | turns | input | cacheWrite | cacheRead | output | USD/turn | USD/passing run |");
console.log("|---|---|---|---|---|---|---|---|");
// Cheapest first, unpriced last — the point of the table is the spread.
rows.sort((a, b) => {
  const ca = usd(a, PRICES[a.model]);
  const cb = usd(b, PRICES[b.model]);
  if (ca === null) return cb === null ? 0 : 1;
  if (cb === null) return -1;
  return ca - cb;
});

for (const r of rows) {
  const p = PRICES[r.model];
  const perTurn = usd(r, p);
  const low = usd(r, p, true);
  const cell =
    perTurn === null
      ? "—"
      : p.offPeak
        ? `${fmt(low)}–${fmt(perTurn)}`
        : p.soft
          ? `${fmt(perTurn)} *`
          : fmt(perTurn);
  // Six scheduling runs per model. A model that passes three of them costs two
  // turns per passing run, before anything else it might cost you.
  const scale = 6 / PASSED[r.model];
  const perPass =
    perTurn === null
      ? "—"
      : p.offPeak
        ? `${fmt(low * scale)}–${fmt(perTurn * scale)}`
        : fmt(perTurn * scale);
  console.log(
    `| \`${r.model}\` | ${r.turns} | ${r.input.toLocaleString()} | ${r.cacheWrite.toLocaleString()} | ${r.cacheRead.toLocaleString()} | ${r.output.toLocaleString()} | ${cell} | ${perPass} |`,
  );
}
console.log("\n* DashScope cache-hit rate is the least certain input here.");
