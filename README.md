# qm-model-eval

Deciding which AI model to run in [qm](https://github.com/yc-software/qm)
shouldn't come down to price or reputation. This harness measures what a model
actually does in your own deployment, so you have something real to judge by —
before you start using a model, and again before you switch to a new one.

The reason qm in particular needs this: it is a work tool, not a chatbot. It has
to understand an instruction precisely, do arithmetic on times, call tools that
change real state. A model that only mostly understands the request will quietly
do the wrong thing and report success. That is a higher bar for language
understanding than most chat uses, and price does not predict it — in the runs
below, some cheap models passed everything and some expensive ones failed. Cost
is still a real constraint, though, so "just buy the expensive one and stop
worrying" is not an answer either. The way through is to measure.

## The idea

Don't grade what the model said. Send a task through a normal qm turn, then read
the database afterwards and see what actually happened, and print the reply next
to the observed outcome.

The gap this targets is an agent that answers *"Done — your reminder is set for
20 minutes from now"* when no cron was ever created. When the two disagree, the
output shows it.

Every task drives the direct path — an explicit prompt to the model the scope is
pinned to. Slack has a second path that a different model gates; `ambient-reply.mjs`
covers it, and is scored separately for that reason — see [the ambient
path](#the-ambient-path-a-different-model-decides-whether-you-get-an-answer).

## Setup

Node 20+, and shell access to the deployment's postgres.

```sh
cp .env.example .env     # then edit
set -a; . ./.env; set +a
node tasks/schedule.mjs  # against the org default model
```

Line by line:

1. `cp .env.example .env` creates your config from the template. Edit it: set
   `QM_ENV_FILE` to the qm deployment's own `.env`, and check
   `QM_PG_CONTAINER` matches the docker container running its postgres.
2. `set -a; . ./.env; set +a` reads that file into shell variables and exports
   them. This line is not optional: the harness has zero dependencies and no
   dotenv, so tasks only see config through `process.env`. Without sourcing,
   every run fails as if unset.
3. `node tasks/schedule.mjs` runs the first task. There is no `npm install` —
   package.json declares no dependencies. The real prerequisites are Node 20+
   and a running qm deployment whose postgres this shell can reach.

Note there are **two `.env` files**, doing different jobs: this repo's `.env`
configures the harness itself, and `QM_ENV_FILE` points at the deployment's
`.env`, from which `CORE_SIGNING_SECRET` is read — turns are signed the same way
any surface signs them, so the harness needs no back door.

One quoting trap: if you later set `QM_PSQL` and the value contains spaces
(`psql postgresql://…`), quote it in `.env`. Unquoted, sourcing executes it as a
command instead.

### Against a deployment on Fly or AWS

The harness runs from your own machine either way — what changes is that a hosted
deployment hands you no `.env` file and no local postgres. Leave `QM_ENV_FILE`
unset and supply the three values it would have provided:

```sh
# Two tunnels, each in its own shell.
fly proxy 15432:5432 -a your-qm-db
fly proxy 18080:8080 -a your-qm

export CORE_SIGNING_SECRET=...        # from fly secrets / AWS Secrets Manager
export ORG_ID=your-org
export QM_ACTOR=you@example.com       # an org admin
export QM_CORE_URL=http://127.0.0.1:18080
export QM_PSQL="psql postgresql://postgres:PASSWORD@127.0.0.1:15432/qm"
```

`QM_CORE_URL` also accepts a public `https://` host if core is reachable that
way; the signature travels in headers and doesn't care about the transport.

One thing to know before pointing this at a deployment people use: the tasks
write to the database. They plant a memory notebook, add and remove a channel
standing order, and delete the crons they create. Each task rolls back what it
planted, and everything stays inside the scope you pin — but give the candidate
its own scope rather than aiming at a live channel.

## The tasks

| task | asks | observes |
|---|---|---|
| `schedule.mjs` | schedule a reminder 20 minutes out | a row in `/v1/crons`, its fire time, and whether it was made recurring |
| `memory.mjs` | remember a fact | that it landed in this scope, and did **not** land org-wide |
| `memory-clobber.mjs` | remember a second fact, keep the first | whether the first survived |
| `standing-order-clobber.mjs` | add a channel standing order, keep the existing one | same, over real Slack |
| `ambient-reply.mjs` | answer a question qm asked, in-thread, with no `@`-mention | whether the promised report arrives carrying the answer — and if not, whether the turn was dropped at the gate as `react`/`silent` |

`ambient-reply.mjs` is scored differently from the rest and belongs to whoever
sets the **org** model, not the channel model — see [the ambient
path](#the-ambient-path-a-different-model-decides-whether-you-get-an-answer).

`EVAL_LANG=zh` sends the same request in Traditional Chinese. Tool descriptions
stay English either way, so this measures whether the cross-language gap costs
tool-calling accuracy.

Run one model's full tier 1 battery with `bin/battery.sh <channelRef>`; pin the
scope to the model first (`pinScope` in `lib/qm.mjs`, or a `base_model_configs`
row plus a read through the admin API).

Tier 1 is a synthesised `POST /v1/turns` and reaches cron, memory and execute.
Tier 2 (`standing-order-clobber.mjs`) has to post a real Slack message: surface
tools are gated on `input.surfaceTools` plus a resolvable delivery destination,
so a synthesised turn gets `[no channel scope here]` no matter what the
conversation fields say. A bot-token post won't do either — the agent filters
its own messages and no turn happens.

## Trying a model out

About half an hour, and nothing in production changes — pinning a channel scope
overrides the org default inside that scope only.

```sh
# Give the candidate its own scope, so live channels keep what they use now.
node -e 'import("./lib/qm.mjs").then(m=>m.pinScope("channel:eval-candidate","pi","the-model-id"))'

# Three runs of each task in both languages, around 25 turns.
bin/battery.sh eval-candidate 3

# Check the instrument still catches a real failure before you trust a pass.
EVAL_NEGATIVE_CONTROL=1 node tasks/memory-clobber.mjs eval-candidate
```

Reading what comes back:

- One `created: NO` on scheduling is enough to rule a model out. That is the
  agent telling you it did work it never did, and it's the failure you are least
  likely to notice in normal use.
- Drift beyond a minute or two rules it out as well. A reminder at the wrong hour
  isn't a reminder.
- `written to org: YES` rules it out for anything confidential — that memory is
  readable from every other conversation in the org.
- Read the replies, not only the columns. A refusal that gives a reason is a
  different thing from silence, and a model that won't store a credential is
  behaving correctly rather than failing (see the traps below).
- Passing doesn't make one model better than another that also passed. Choose on
  cost, latency, and where the data ends up.

Run it again when you switch models, when a provider ships a new version behind
the same id, or when you start working in another language. All three of those
changed a result here.

## What the runs showed

294 turns, 12 models, two prompt languages. The raw data is in `results/`.
Failures did not track price: three models failed outright, and two of them are
not the cheap ones.

What failed, and I would not use these for qm on this evidence (measured
failures, not inference):

| model | what failed |
|---|---|
| `claude-haiku-4-5` | reports success on Chinese prompts and does nothing. Six of seven runs wrong: most created no cron while replying 「建立完成。20 分鐘後會提醒你」; one scheduled the reminder 56 years in the past. 3/3 in English |
| `openrouter/auto` | 0/3 Chinese, 2/3 English, and unattributable: it picks a model per request while `session_llm_requests` records only `openrouter/auto` |
| `glm-5.3` | schedules the wrong time — 2/3 on time in English, 1/3 in Chinese, worst case 30 hours out; also the slowest at 35–52s |

Everything tested, and how far each was exercised:

| model | harness / route | schedule en · zh | state-changing paths |
|---|---|---|---|
| `claude-opus-5` | claude · subscription | 3/3 · 3/3 | full |
| `claude-sonnet-5` | claude · subscription | 3/3 · 3/3 | full |
| `claude-haiku-4-5` | claude · subscription | 3/3 · **0/3** | schedule only |
| `gpt-5.6-sol` | pi · OpenAI | 3/3 · 3/3 | full |
| `gpt-5.6-terra` | pi · OpenAI | 3/3 · 3/3 | full |
| `gpt-5.6-luna` | pi · OpenAI | 3/3 · 3/3 | full |
| `deepseek-v4-flash` | pi · DeepSeek, anthropic-compatible | 3/3 · 3/3 | full |
| `deepseek-v4-pro` | pi · DeepSeek, anthropic-compatible | 3/3 · 3/3 | full |
| `kimi-k3` | pi · Moonshot, anthropic-compatible | 3/3 · 3/3 | full |
| `qwen3.8-max` | pi · DashScope, **openai**-compatible | 3/3 · 3/3 | full |
| `glm-5.3` | pi · Z.ai, anthropic-compatible | **2/3** · **1/3** on time | schedule only |
| `openrouter/auto` | pi · OpenRouter | **2/3** · **0/3** | schedule only |

"Full" means the memory-write, memory-clobber and Slack standing-order tasks as
well, with the corrected probes. The three models still marked "schedule only"
are the three that failed scheduling — they were not pursued further because
that result already rules them out, not because anything else was found.

Every model that passed scheduling has now been through all four tasks, and all
nine passed every one. That is worth saying plainly: on these tasks the
state-changing paths did not separate any model from any other. Only scheduling
did.

Four custom providers were exercised along the way — DeepSeek, Moonshot and Z.ai
through the anthropic-compatible path, DashScope through the OpenAI one — so both
of qm's custom-provider protocols are covered.

The passing models are indistinguishable here, so choose between them on cost,
latency and where the data lands. And keep in mind the difference between "not
found wanting" and "verified sound" — the table above is the first, not the
second.

### What this doesn't cover

**Two languages.** English and Chinese, and that is a narrow claim for software
people run everywhere. It matters more than a coverage gap usually would, because
the second language did not just add data — **it changed the verdict.** English
alone passes `claude-haiku-4-5` 3/3 and this repo would have called it fine.
Chinese is what exposed it, and what it exposed was not "weaker": a model that
replies 「建立完成。20 分鐘後會提醒你」and creates no cron. A model that reports
success while doing nothing is green on every dashboard you have. There is no
reason to assume Japanese, Korean, Spanish or Arabic are free of their own version
of that, and nobody has looked.

It is also not evenly bilingual, which is worth stating plainly. Three of the five
task files take a language — `schedule`, `memory` and `memory-clobber` read `EVAL_LANG`
and carry both prompts ([`tasks/schedule.mjs:35`](tasks/schedule.mjs)). The other
two, `standing-order-clobber` and `ambient-reply`, are written in Chinese only and
have no English form at all.

What makes adding a language cheap anyway is that **no grader depends on the
language of the reply.** Every check runs against Postgres — did a cron row appear,
at what time, did the memory line survive, did a turn get dispatched — and the one
check that does look at reply text (`ambient-reply.mjs:192`) searches for an ASCII
marker, not prose. So a language is a set of translated prompts and no change to
the checking. Tool descriptions stay English on purpose, so what is measured is
whether a cross-language gap costs tool-calling accuracy rather than whether the
model can read its own tools. If you read a language that isn't here, that is an
afternoon of prompt-writing, and the results compose with these.

**One deployment, one operator.** Everything here ran against a single
self-hosted qm on one machine, driven by one person who also wrote the harness.
The traps section is the honest account of what that costs.

**Four comparison tasks, all state-changing.** Scheduling, memory write, memory
clobber, and a Slack standing order — chosen because they either happen or they
don't, which is what makes them gradeable from Postgres. (The fifth task file,
`ambient-reply`, measures the reply gate rather than the pinned model, and is not
part of the comparison.) Nothing here measures reasoning
quality, long-context behaviour, code, or anything where the answer is a matter of
degree. A model can pass every task here and still be the wrong choice for work
this repo doesn't touch.

**About twenty-five turns per model.** Enough to catch a model that fails
outright, not enough to separate models that don't. That is why the results table
says three failed rather than ranking the nine that didn't.

**The three failures were not pursued.** `claude-haiku-4-5`, `openrouter/auto`
and `glm-5.3` stop at scheduling. That result already rules them out for this
purpose, so nothing was learned about how they behave on the other three tasks.

### What they cost

> **Correction, 2026-09-02.** This section previously said qm keeps no token
> counts you can read, that input tokens live only in an in-memory ring, and that
> output tokens are never measured — and used `calls/turn` as a cost proxy on
> that basis. All of it was false, and the table below is measured instead. See
> [trap 13](#what-the-measurements-got-wrong-along-the-way) for how the claim
> survived as long as it did, which is the part worth reading.

qm records what every turn spent. `recordLlmRequest` writes `input`, `output`,
`cacheRead`, `cacheWrite` and `totalTokens` per call into
`session_llm_requests.usage_json`, and has since before the first run here.

Tokens below are means per turn, measured; dollars are computed outside qm from
list prices as of August 2026. The query is [`tools/usage.sql`](tools/usage.sql)
and the pricing is [`tools/cost.mjs`](tools/cost.mjs), so both halves are
re-runnable and the price assumptions are readable rather than implied.

| model | turns | input | cacheWrite | cacheRead | output | USD/turn | USD/passing run |
|---|---|---|---|---|---|---|---|
| `gpt-5.6-luna` | 37 | 9 | 10,311 | 21,135 | 127 | $0.0026 | $0.0026 |
| `deepseek-v4-flash` | 47 | 8,628 | 0 | 19,105 | 583 | $0.0027–$0.0054 | $0.0027–$0.0054 |
| `claude-haiku-4-5` | 33 | 18 | 5,255 | 26,752 | 5 | $0.0093 | $0.019 |
| `kimi-k3` | 39 | 1,795 | 0 | 22,147 | 250 | $0.016 | $0.016 |
| `deepseek-v4-pro` | 31 | 8,720 | 0 | 18,985 | 471 | $0.0079–$0.016 | $0.0079–$0.016 |
| `claude-sonnet-5` | 40 | 4 | 5,563 | 32,396 | 13 | $0.021 | $0.021 |
| `gpt-5.6-terra` | 39 | 7 | 9,884 | 12,270 | 105 | $0.023 | $0.023 |
| `qwen3.8-max` | 41 | 2,842 | 0 | 28,088 | 1,303 | $0.036 * | $0.036 |
| `claude-opus-5` | 42 | 4 | 6,130 | 28,471 | 11 | $0.053 | $0.053 |
| `gpt-5.6-sol` | 45 | 8 | 10,350 | 17,688 | 178 | $0.066 | $0.066 |
| `glm-5.3` | 24 | 2,408 | 0 | 25,267 | 96 | — | — |
| `openrouter/auto` | 24 | 9,408 | 0 | 9,845 | 155 | — | — |

**`cacheWrite: 0` is not "no caching."** It is a different caching architecture,
and reading the `input` column across providers without knowing that inverts the
answer. Anthropic and OpenAI cache on client direction, so tokens entering the
cache are reported separately and billed separately — Anthropic at 1.25× input
for a write and 0.1× for a read. DeepSeek, Moonshot, DashScope and Z.ai cache
server-side on a prefix match: a miss is reported in `input` at the ordinary rate
and there is no write to bill. Structurally, `deepseek-v4-flash`'s input of 8,628
sits where `claude-sonnet-5`'s `input + cacheWrite` of 5,567 sits. Comparing the
raw `input` columns would say deepseek sends the larger prompt. It does not.

**The bill is mostly cache reads** — between half and nine-tenths of every turn,
across all twelve. For a small team the cost decision is a prompt-caching-policy
decision before it is a model-price decision, and `qm`'s own cache boundary moves
that number more than the choice between two adjacent models does.

`USD/passing run` is `USD/turn` divided by the model's scheduling pass rate out of
six. It matters for exactly three rows. `claude-haiku-4-5` is the second-cheapest
model here per turn and still burns a full 32k-token turn on each Chinese prompt
it silently fails, so its real price doubles. `glm-5.3` fails at the same rate and
`openrouter/auto` worse, and both are unpriced, so the column cannot show what
they would cost — which is its own answer. The cheapest model is not the cheapest
row; it is the cheapest row that passes.

Two rows are unpriced on purpose. `openrouter/auto` picks a model per request
while qm records only the alias, so there is no rate to apply — the same
unattributability that disqualified it above. For `glm-5.3` I have no list price
I am willing to state.

The DeepSeek ranges are off-peak to peak — the API halves its rates outside
01:00–04:00 and 06:00–10:00 UTC, which is worth knowing if your background work
runs on crons you control. The Claude rows are what the API would charge; this
deployment ran them on a subscription, where the marginal cost of a turn is zero
until the plan's limit.

DeepSeek's weights are open, and third-party hosts on OpenRouter serve
`deepseek-v4-flash` from about $0.07/$0.17 — a further 4x under the official
off-peak rate. **These results do not transfer to those hosts.** Everything here
was measured against the vendor's own endpoint; a different host is different
infrastructure, possibly different quantisation, and a different answer to where
the data goes. If you intend to run one, that is exactly the case for pointing
this harness at it first.

**What the measurement still does not include.** The ambient reply gate runs a
model call on every un-mentioned message and is handed `recordModelCall` but not
`recordLlmRequest`, so it leaves no usage row anywhere
([qm#609](https://github.com/yc-software/qm/issues/609)). No task here goes
through that path, so these figures are unaffected — but a deployment where
people talk in threads is paying for it, and cannot see it. Separately, the
figures are the *evaluated model's* usage, not the platform's: the security
screen and history compaction run on the org default model and are filtered out
by the scope∧model condition in `usage.sql`. On this deployment that filter moved
`claude-opus-5` from 356 turns of 5,640 tokens to 42 turns of 34,616 — most of
what it was doing in other models' channels was screening their inputs. That is
real cost, attributable to those turns, and it is not in this table.

Across the ten priced models the spread is about 25× — `gpt-5.6-luna` at
$0.0026 a turn to `gpt-5.6-sol` at $0.066 — and none of the four tasks separates
them. That is the finding worth carrying, and it is stronger than "the cheap ones
are also fine": on the work qm actually asks of a model, 25× buys nothing this
harness can measure.

The table is ordered by what a turn actually costs, and that is not the order
list prices imply. `gpt-5.6-sol` and `claude-opus-5` share a $5 input price, but
sol costs 25% more per turn, because OpenAI bills qm's `cacheWrite` at the full
input rate while Anthropic's cache read is a tenth of it.
`claude-sonnet-5` and `gpt-5.6-terra` are within 10% of each other despite terra
listing at half sonnet's output price. Price per million tokens ranks the
providers' rate cards; it does not rank what a turn costs you.

`calls/turn` — 2.0 to 3.1 across the set, from `turn_metrics.model_calls` — is
kept out of this section deliberately. It is a real signal about loop shape and
latency, and it was never a cost signal: each call re-sends the context, which is
why cache reads dominate every row above. Using it as a proxy was the mistake in
the correction at the top.

Speed follows neither. `claude-sonnet-5` is the fastest here at 8s and sits
mid-table on cost, while `qwen3.8-max` costs fourteen times what `gpt-5.6-luna`
does per turn and is two and a half times slower.

Two findings that are about qm rather than any model:

- The clobber hazard did not materialise. Both tools replace their whole
  target, but no model wiped existing content under an ordinary instruction.
  The negative control (`EVAL_NEGATIVE_CONTROL=1`) confirms they all *will*
  when asked to, so the detector is not blind.
- qm's security screen quarantines about one standing-order change in six (14 of 80),
  non-deterministically, and the refusal points at a review flow that does not
  exist ([yc-software/qm#574](https://github.com/yc-software/qm/issues/574)).
  A quarantined run and a model that declined to act look identical in the
  database, so tier 2 reports quarantine as its own column.

## What the measurements got wrong along the way

Every one of these produced a confident wrong conclusion before it was caught.
They are the reason to distrust a clean-looking result — including these.

1. **Charging an environment failure to the model.** An early "GLM is less
   reliable than Claude" came from a period when the sandbox was broken, the
   gateway was serving a different model than configured, and the harness was
   silently substituting the model id.
2. **Concluding from a single run.** "Opus is 13× slower" came from two runs
   that hit a provider 529 and retried. Three clean runs later it was 19–23s.
3. **Planting the probe in the wrong layer.** The first standing-order test
   seeded `channel_policy`, but the model wrote to the soul — `guidance` picks
   conversation scope when channel scope isn't available. All three metrics
   read as failures; nothing had failed.
4. **Letting state carry between runs.** Rollback deleted revisions containing
   the token, but models paraphrase, so the next run started against a notebook
   that already held the answer. Roll back by sequence; judge only what this
   run added.
5. **Starting a run while the last one was still going.** Turns complete
   asynchronously well after the HTTP call returns, so the previous write
   landed on the freshly planted sentinel. This produced clobber failures for
   four models that all vanished on re-run with a quiescence wait, control
   included.
6. **Asking for the same thing twice in one conversation.** The rollback that
   fixed #4 created this: memory was reset but the transcript was not, so the
   model saw it had already answered and correctly declined — and got scored
   as a failure. Carry a fresh value in the fact itself.
7. **Building the probe out of something a good model should refuse.** The
   sentinel was "the office wifi password is …" and the new fact an "internal
   code". One model deleted the password and refused the code, saying so
   plainly. Scored as clobbering, 4 of 6 runs. It was the most careful model
   in the set.
8. **Reading the score columns instead of what the agent said.** Tier 2 logged
   "(no reply)" on 25 runs because the operator token lacked
   `channels:history`. The refusals were in `channel_messages` all along.
9. **Sampling "which model ran" before its rows landed.** Read 8s after the
   write, it showed only the screen's model — and produced a public claim that
   nine of twelve runs had silently run on the org default. They had not.
10. **Scoring a run whose setup never happened.** `ambient-reply.mjs` needs qm
   to ask a question before anything can answer it. On its very first run the
   security screen quarantined that setup, so the task posted an answer into a
   thread containing nothing but a refusal — and the gate declined it, correctly.
   Reported `FAIL`. The task now aborts as `INCONCLUSIVE` when the setup is
   quarantined or when qm never asks. Written by the person who wrote this list,
   on the first run of the task built to avoid exactly this.
11. **Waiting with an instrument blind to what you're measuring.** `quiesce()`
   decides the deployment is idle by watching `session_llm_requests` stop
   growing. A turn the ambient gate declines may write no row there at all — the
   detection call goes to an in-memory ring and never reaches the table — so
   quiesce declared idle 15s after the probe was posted, before the run row
   existed, and the task printed `(no run)`. The verdict it fell through to was
   still `FAIL`, and the true stored status was `react`, also a failure. Right
   answer, wrong reason, and nothing in the output said so. `ambient-reply.mjs`
   now waits on the run row itself.
12. **Grading the internal status instead of the observable effect.** The first
   scoring pass on `ambient-reply.mjs` read `runs.result.status` and called
   anything but `ok` a failure. But `silent` is returned both when the gate
   declines a turn and when a turn completes and delivers through a surface
   tool, which is how every ordinary Slack answer comes back
   ([qm#609](https://github.com/yc-software/qm/issues/609)). So the `@`-mentioned
   control — the run that worked — was scored `FAIL` with `carries date: yes`
   printed two lines above it. The verdict is now whether the report arrived
   carrying the answer; the status stays as the explanation for a failure, never
   as the test for one.
13. **Proving an absence from the first recorder I found, then not propagating
   my own correction.** This section previously justified `calls/turn` as a cost
   proxy with the claim that qm keeps no readable token counts. I had found
   `recordModelCall` — an in-memory ring, capped at 1,000, input tokens only —
   verified it, and generalised to the system. There is a second path,
   `recordLlmRequest`, writing full usage to `session_llm_requests.usage_json`,
   and it had been there since before the first run in this repo. An absence
   claim is a claim about *every* writer; verifying it means enumerating writers,
   not reading the one store you already know about.

   That much is an ordinary research error. The part that is not: I found the
   second path on 2026-08-18 and wrote it into
   [qm#586](https://github.com/yc-software/qm/issues/586) — *"I charted
   `model_calls` out of `turn_metrics` as a cost proxy and thought the numbers
   weren't derivable. They were one table over the whole time."* Then I left the
   false sentence standing here for two more weeks. The failure was not finding
   the error; it was publishing the correction in one venue and not auditing the
   others. Anything asserting an absence has more than one home, and a correction
   that reaches only the place you happened to be editing is not a correction.

   Two smaller versions of the same thing surfaced while writing this up. I said
   `turn_metrics` has no token columns — it has `cache_read`, `cache_write` and
   `uncached_input`, populated on all 637 rows; what it lacks is output tokens and
   cost, which is what #586 already said precisely. And I attributed a set of
   duplicate usage rows to the pi harness; all 137 of them are the claude
   harness's one-shot path
   ([qm#889](https://github.com/yc-software/qm/issues/889)). Both were stated
   confidently, from one look, in the middle of writing up a trap about stating
   things confidently from one look.

   A third turned up a week later, writing "What this doesn't cover" above. I
   claimed every task takes `EVAL_LANG` and that no grader reads the reply, having
   opened one task file. Two of the five have no language parameter at all and no
   English form; one grader does read the reply, for an ASCII marker. Caught before
   publishing — which is the only thing separating it from the twelve entries above
   it, and not a difference in kind.

Traps 4 and 6 are really one mistake seen from both sides: a task that reads
existing state has *two* histories to control, and cleaning one desynchronises
it from the other. The safe shape is a fresh one-shot marker every run, which is
why scheduling and memory-write never produced a retraction and the clobber task
produced two.

Order matters as much as isolation. An early batch loop ran `for lang in en zh`,
so English always went first against a clean channel and Chinese always followed
nine turns of history — every apparent language effect on a state-reading task
was confounded with transcript depth.

Eight of the thirteen point the same way: environment, timing, probe and setup
problems get charged to the model. None ever made a bad model look good. When a
measurement breaks, "this model is weak" is the cheapest available explanation,
and it needs no further evidence to feel finished. Traps 10, 11 and 12 are the
clearest cases that knowing this does not stop it: all three happened while
building one task, written to avoid exactly this, with the list already sitting
above it. Three consecutive runs, three different instrument faults, before a
single number in this section was true. 11 and 12 are the pair worth
re-reading — one produced the right verdict for the wrong reason, the other the
wrong verdict with the right evidence printed directly above it.

Trap 13 is the one that breaks the pattern, and it is the reason this list is
worth keeping rather than a nice gesture. The first twelve are all a measurement
lying to me. The thirteenth is me lying to a reader — a claim about someone
else's software, published, load-bearing, and false — and it is the only one on
this list I had already caught, written up, and filed upstream before leaving it
standing here. Traps you have not yet found are ordinary. A correction you have
already made, in a place you then failed to look, is not.

### Corrections

| date | what changed |
|---|---|
| 2026-09-02 | "What they cost" — the claim that qm keeps no readable token counts was false; the section is rebuilt on measured usage and `calls/turn` is no longer a cost basis. Trap 13. |
| 2026-09-02 | Trap 12 was referenced by this section's closing paragraph but had never been written. Added. |

## The ambient path: a different model decides whether you get an answer

Every task here posts to `/v1/turns` with an explicit prompt. That is the direct
path: qm hands the text to the model the scope is pinned to, and what comes back
is what this harness scores.

In Slack there is a second path, and a model that passes everything above can
still fail on it — because on that path the model you pinned is not the one that
decides anything.

A message that does **not** `@`-mention qm is marked *ambient*
(`src/core/orchestrator.ts:398`) and routed through an extra model call before
any work happens (`:1540`). If that call returns `respond: false`, the turn ends
at `:1565` with an emoji reaction or nothing at all. The call runs on
`judgeModelId` — an auxiliary model, not the scope's. So the model an admin
evaluated and selected governs the answer, and a different one governs whether
there is an answer.

The gate also fails closed in two ways. `pi-harness.ts:188` tells it *"When
genuinely unsure, prefer NO."* And in `claude-harness.ts:896` a failed detection
call is caught and turned into `return { respond: false }` — a provider hiccup
becomes a decision not to reply, indistinguishable from a considered one.

### What that looked like in practice

Not a benchmark, one live scenario, but it is the failure this gap produces.
A colleague asked qm to chase someone and report back within the hour. qm posted
the question in a channel thread and committed to reporting. The reply arrived
in that thread 73 minutes later, without an `@`-mention — which is what qm's own
message had asked for ("just reply in this thread"). Postgres shows the message
was ingested (`handled = t`) and the turn returned:

```json
{"status":"react","reactions":["+1"]}
```

qm read the answer to its own question, gave it a thumbs-up, and never reported.
Forty-two minutes later, asked about it in a DM — a different session — it
stated with a reconstructed timeline that no reply had come, in the thread or
anywhere else. The person who had answered was implicitly reported as
unresponsive and had to come back and say so.

The detection prompt already covers the case explicitly, twice
(`pi-harness.ts:140` and `:159`), and ships a near-identical worked example. It
was not a missing rule. A deterministic condition — *qm asked a question here
and has no answer recorded* — was delegated to a probabilistic call, and the
call was wrong. Filed upstream as
[#607](https://github.com/yc-software/qm/issues/607) and
[#608](https://github.com/yc-software/qm/issues/608).

### What it means for a result from this repo

A pass here is a statement about the pinned model on the direct path. It is not
a statement about whether qm will answer an unmentioned message, because a
different model makes that call. Two consequences worth carrying:

- **Changing a scope's model does not change its ambient behaviour.** If replies
  go missing in a channel, re-pinning the model will not fix it, and the model
  is not what to suspect.
- **`@`-mentioning qm skips the gate entirely.** For any hand-off you actually
  depend on, that is the difference between one probabilistic decision and two.

### Measuring it

`ambient-reply.mjs` drives the path end to end, over real Slack:

```sh
node tasks/ambient-reply.mjs claude claude-sonnet-5        # ambient — no mention
EVAL_MENTION=1 node tasks/ambient-reply.mjs claude claude-sonnet-5   # control
```

It posts a mentioned message asking qm to put a question to the room and report
the answer back, waits for qm to actually ask, then answers in that thread
**without a mention** — the exact shape qm's own message invites.

The verdict is whether the report qm promised arrives carrying the date. That is
the thing the requester was owed, and it is the only signal that means the same
thing on both paths. The turn's stored status is printed too, but as the
diagnosis when no report came, never as the test:

| status | meaning when nothing was reported |
|---|---|
| `react` | the gate declined and left an emoji |
| `silent` | the gate declined and left nothing |
| `ok` | the turn ran; the model is what fell short, not the gate |

`silent` is ambiguous on its own — it is also what a turn returns when the agent
has already delivered through a surface tool, which is how a *successful* report
comes back. Reading it as a verdict marked a working control run as a failure
(trap 12). Reading the Slack transcript alone has the mirror-image problem: it
cannot tell a gate that declined from a model that ran and chose to say nothing,
which is why the original incident was so hard to see. Both are needed, in that
order.

`EVAL_MENTION=1` runs the identical exchange with the mention restored, which
skips the gate. The contrast is the measurement — a run where both forms report
the date shows nothing, and should be repeated rather than reported.

Two guards matter, and both were added after the first run got them wrong.
The security screen quarantines a share of Slack requests, and a quarantined
setup leaves a thread whose only bot message is the refusal; answering into it
gets declined *correctly*, and the first version of this task scored that as a
gate failure. It now reports `INCONCLUSIVE`, as it does when qm replies without
actually asking anything. That is trap 1 from the list above, reproduced by the
person who wrote the list, on the first run of the task written to avoid it.

The wait condition is the other one, and it is worth copying if you write
anything against this path. `quiesce()` cannot be used here: it infers idleness
from `session_llm_requests`, and a turn the gate declines can write nothing
there, so it reports idle before the run row exists. The task waits on the run
row for the thread instead. Traps 10 and 11 below have the detail; both were
found by running this task, not by reading the code.

### What it showed

Five runs against this deployment, org default `claude-sonnet-5`, channel pinned
to the same. Small n, and reported as such — but the two forms never crossed.

| run | form | turn status | report arrived | verdict |
|---|---|---|---|---|
| 1 | ambient | — | — | inconclusive: screen quarantined the setup |
| 2 | ambient | `react` | no | **FAIL** |
| 3 | ambient | `react` | no | **FAIL** |
| 4 | `@`-mentioned | `silent` | yes, with the date | **PASS** |
| 5 | `@`-mentioned | `silent` | yes, with the date | **PASS** |

The mentioned control, verbatim from `channel_messages`:

```
qm   請問負責機房維護的同仁：MAINT-9593 的維護要排哪一天？麻煩在這裡回覆，謝謝。
you  @qm MAINT-9593 的維護排 9/23，已經跟廠商確認過了。
qm   收到，MAINT-9593 的機房維護已排定 9/23，已和廠商確認過。
```

Drop the `@` from the middle line and the third line becomes a 👍. Same channel,
same model, same exchange, same wording otherwise. Note what qm's own question
asks for — *麻煩在這裡回覆*, "please just reply here" — which is the form it then
declines to act on.

Which model declined it is not recorded anywhere. `judgeModelId` resolves to
`auxiliaryModelFor(org base model)`, and for an Anthropic org model the registry
answers `claude-haiku-4-5` — the one model in the results table above that this
repo says not to run, on the strength of 6 wrong answers in 7 Chinese scheduling
runs. That derivation is read from qm's source, not observed: the detection call
is recorded only in an in-memory ring, so nothing durable says who made the
decision.

Which is the wider problem. A turn the gate declines writes **no row in
`session_llm_requests` and no row in `turn_metrics`** — 1,196 metrics rows on
this deployment carry only `capture` and `ok`, never `react` or `silent`, and
`detect_ms` is populated in exactly one of them. Its only durable trace is
`runs.result`. Anyone building an operational dashboard on `turn_metrics`, which
is the obvious table for it, gets a view in which the messages qm chose not to
answer do not exist.

The other ambient. `ambientEnabled` and the org-wide ambient switch in
`src/api/app-ambient.ts` govern a *different* mechanism — a judged sweep over
channel messages, driven by standing orders and bot policies, which defaults off
when a channel has neither. The thread-follow path this task measures is in
`src/slack/events.ts` and does not consult either setting. The incident happened
in a channel with no standing order, where that first mechanism was switched
off, and the message was still ingested.

## If you only run one

`schedule.mjs`. It is the only task here that has ever separated one model from
another, because it asks for three things at once — understand a non-English
instruction, do arithmetic on it, actually call a tool — and every observed
failure was there. The clobber tasks found nothing in any model once their
probes were fixed. That is a real result, and it cost far more than it returned.

## Turning this into an acceptance suite

This battery is the core layer — the behaviours any candidate must show, at any
price. Two layers on top turn a pass into an adoption decision:

1. **Core golden tasks** — the four here, in every language you work in. A model
   that fails one is out, whatever it costs.
2. **Customer golden tasks** — five to fifteen cases lifted from the real work:
   turn meeting notes into tracked tasks, update a project rule, look something
   up and notify the right person. This is where a model can pass the core and
   still be wrong for you.
3. **Regression runs** — the whole set again on a model switch, a provider
   update behind the same id, a prompt or runtime change, or a new working
   language — the triggers listed above, plus a runtime change.

Every case, core or customer, carries the same fields:

| field | what it pins down |
|---|---|
| initial state | what the database and channel look like before the turn |
| instruction | the sentence a user would actually send |
| must happen | the state change you will check for, and where |
| must not happen | clobbered data, wrong scope, extra side effects |
| observe | the table or endpoint to read afterwards; the reply is checked against it, not instead of it |
| cleanup | how to put the state back before the next run |
| language & surface | which languages; Web, Slack, or both |
| repeats & threshold | how many runs, and the pass bar |

Models are stochastic, so one run is an anecdote. 3/3 is the floor for core
tasks; a case that deletes anything, notifies anyone outside the conversation,
or touches sensitive data should be held to 10/10, with a person reading the
failures rather than only the counts.

What the layers decide between them: when every required task passes, choose on
cost, latency and where the data is allowed to go. The only sufficient reason to
pay for a more expensive model is a customer-critical case that it alone passes
reliably.

## License

MIT.
