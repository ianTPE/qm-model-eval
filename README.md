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

### What they cost

List prices as of August 2026, USD per million tokens, alongside what this
deployment measured. `calls` is the mean number of model calls one turn took —
a real multiplier on the token price, and the closest cost signal available,
because qm keeps no token counts you can read. Input tokens are captured per
call but held in a 1,000-entry in-memory ring that a restart drops; output
tokens are never measured at all.

| model | input | output | calls/turn | median turn |
|---|---|---|---|---|
| `gpt-5.6-luna` | $0.20 | $1.20 | 3.1 | 14.0s |
| `deepseek-v4-flash` | $0.22–0.44 | $0.66–1.32 | 2.3 | 12.2s |
| `deepseek-v4-pro` | $0.66–1.32 | $1.98–3.96 | 2.3 | 15.4s |
| `claude-sonnet-5` | $2 | $10 | 2.2 | 8.0s |
| `qwen3.8-max` | $2 | $6 | 2.5 | 36.1s |
| `gpt-5.6-terra` | $2 | $12 | 2.3 | 10.0s |
| `kimi-k3` | $3 | $15 | 2.2 | 28.3s |
| `claude-opus-5` | $5 | $25 | 2.3 | 9.6s |
| `gpt-5.6-sol` | $5 | $30 | 2.8 | 16.7s |

The DeepSeek ranges are off-peak to peak — the API halves its rates outside
01:00–04:00 and 06:00–10:00 UTC, which is worth knowing if your background work
runs on crons you control. Claude prices are what the API charges; this
deployment ran the Claude models on a subscription instead, where the marginal
cost of a turn is zero until the plan's limit.

DeepSeek's weights are open, and third-party hosts on OpenRouter serve
`deepseek-v4-flash` from about $0.07/$0.17 — a further 4x under the official
off-peak rate. **These results do not transfer to those hosts.** Everything here
was measured against the vendor's own endpoint; a different host is different
infrastructure, possibly different quantisation, and a different answer to where
the data goes. If you intend to run one, that is exactly the case for pointing
this harness at it first.

The spread across models that behave identically is roughly 25× on input and
25× on output. `gpt-5.6-luna` is the cheapest by a wide margin but takes the
most model calls per turn, which claws some of it back; `deepseek-v4-flash` is
close behind on price with fewer calls and a faster turn. Speed does not follow
price either — `claude-sonnet-5` is the fastest in the set at 8s and sits in the
middle of it.

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

Traps 4 and 6 are really one mistake seen from both sides: a task that reads
existing state has *two* histories to control, and cleaning one desynchronises
it from the other. The safe shape is a fresh one-shot marker every run, which is
why scheduling and memory-write never produced a retraction and the clobber task
produced two.

Order matters as much as isolation. An early batch loop ran `for lang in en zh`,
so English always went first against a clean channel and Chinese always followed
nine turns of history — every apparent language effect on a state-reading task
was confounded with transcript depth.

Six of the nine point the same way: environment, timing and probe problems get
charged to the model. None ever made a bad model look good. When a measurement
breaks, "this model is weak" is the cheapest available explanation, and it needs
no further evidence to feel finished.

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
