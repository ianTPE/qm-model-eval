# qm-model-eval

Measures what a model **actually did** in a [qm](https://github.com/yc-software/qm)
deployment, by reading the database afterwards — not what its reply claimed.

The gap this exists for: an agent that answers *"Done — your reminder is set for
20 minutes from now"* when no cron was created. The reply is printed next to the
observed outcome so the two can visibly disagree.

## Why bother

The usual advice is to pick a cheap model and hope, or an expensive one and stop
worrying. Neither survives contact: across 12 models, the failures did not track
price. Three models failed outright, and two of them are not the cheap ones.

## Setup

Node 20+, and shell access to the deployment's postgres.

```sh
cp .env.example .env     # then edit
set -a; . ./.env; set +a
node tasks/schedule.mjs  # against the org default model
```

Everything deployment-specific lives in `lib/qm.mjs` and comes from the
environment. `QM_ENV_FILE` points at the deployment's own `.env`, which is where
`CORE_SIGNING_SECRET` comes from — turns are signed the way any surface signs
them, so nothing here needs a back door.

## The tasks

| task | asks | observes |
|---|---|---|
| `schedule.mjs` | schedule a reminder 20 minutes out | a row in `/v1/crons`, its fire time, and whether it was made recurring |
| `memory.mjs` | remember a fact | that it landed in this scope, and did **not** land org-wide |
| `memory-clobber.mjs` | remember a second fact, keep the first | whether the first survived |
| `standing-order-clobber.mjs` | add a channel standing order, keep the existing one | same, over real Slack |

`EVAL_LANG=zh` sends the same request in Traditional Chinese. Tool descriptions
stay English either way, so this measures whether a cross-language gap costs
tool-calling accuracy.

Run one model's full tier 1 battery with `bin/battery.sh <channelRef>`; pin the
scope to the model first (`pinScope` in `lib/qm.mjs`, or a `base_model_configs`
row plus a read through the admin API).

**Tier 1** is a synthesised `POST /v1/turns` and reaches cron, memory and
execute. **Tier 2** (`standing-order-clobber.mjs`) has to post a real Slack
message: surface tools are gated on `input.surfaceTools` plus a resolvable
delivery destination, so a synthesised turn gets `[no channel scope here]` no
matter what the conversation fields say. A bot-token post will not do either —
the agent filters its own messages and no turn happens.

## What the runs showed

294 rows, 12 models, two prompt languages. `results/` holds the raw data.

**Do not use** — measured failures, not inference:

| model | what failed |
|---|---|
| `claude-haiku-4-5` | no cron at all on Chinese prompts, 0/3 — 3/3 in English |
| `openrouter/auto` | 0/3 Chinese, 2/3 English, and unattributable: it picks a model per request while `session_llm_requests` records only `openrouter/auto` |
| `glm-5.3` | schedules the wrong time — 2/3 on time in English, 1/3 in Chinese, worst case 30 hours out; also slowest at 35–52s |

**Passed every task in both languages**, with full coverage of the state-changing
paths: `gpt-5.6-sol`, `gpt-5.6-terra`, `claude-opus-5`, `deepseek-v4-flash`,
`qwen3.8-max`. Passed the scheduling task only: `claude-sonnet-5`,
`gpt-5.6-luna`, `deepseek-v4-pro`, `kimi-k3`.

Since the passing models are indistinguishable here, choose on cost, latency and
where the data lands. Note that "not found wanting" and "verified sound" are
different claims, and the table above keeps them apart.

Two findings that are about qm rather than any model:

- **The clobber hazard did not materialise.** Both tools replace their whole
  target, but no model wiped existing content under an ordinary instruction. The
  negative control (`EVAL_NEGATIVE_CONTROL=1`) confirms they all *will* when
  asked to, so the detector is not blind.
- **qm's security screen quarantines about one standing-order change in five**,
  non-deterministically, and the refusal points at a review flow that does not
  exist ([yc-software/qm#574](https://github.com/yc-software/qm/issues/574)).
  A quarantined run and a model that declined to act are identical in the
  database, so tier 2 reports it as its own column.

## Nine ways these measurements lied

Every one produced a confident wrong conclusion before being caught. They are the
reason to distrust a clean-looking result — including these.

1. **Attributing an environment failure to the model.** An early "GLM is less
   reliable than Claude" came from a period when the sandbox was broken, the
   gateway was serving a different model than configured, and the harness was
   silently substituting the model id.
2. **Concluding from a single run.** "Opus is 13× slower" came from two runs that
   hit a provider 529 and retried. Three clean runs later it was 19–23s.
3. **Planting the probe in the wrong layer.** The first standing-order test
   seeded `channel_policy`, but the model wrote to the soul — `guidance` picks
   conversation scope when channel scope isn't available. All three metrics read
   as failures; nothing had failed.
4. **Letting state carry between runs.** Rollback deleted revisions containing
   the token, but models paraphrase, so the next run started against a notebook
   that already held the answer. Roll back by sequence; judge only what this run
   added.
5. **Starting a run while the last one is still going.** Turns complete
   asynchronously well after the HTTP call returns, so the previous write lands
   on the freshly planted sentinel. This produced clobber failures for four
   models that all vanished on re-run with a quiescence wait, control included.
6. **Asking for the same thing twice in one conversation.** The rollback that
   fixed #4 created this: memory was reset but the transcript was not, so the
   model saw it had already answered and correctly declined — scored as failure.
   Carry a fresh value in the fact itself.
7. **Building the probe out of something a good model should refuse.** The
   sentinel was "the office wifi password is …" and the new fact an "internal
   code". One model deleted the password and refused the code, saying so plainly.
   Scored as clobbering, 4 of 6 runs. It was the most careful model in the set.
8. **Reading the score columns instead of what the agent said.** Tier 2 logged
   "(no reply)" on 25 runs because the operator token lacked `channels:history`.
   The refusals were in `channel_messages` all along.
9. **Sampling "which model ran" before its rows land.** Read 8s after the write,
   it showed only the screen's model — and produced a public claim that nine of
   twelve runs had silently run on the org default. They had not.

Traps 4 and 6 are one mistake seen from both sides: a task that reads existing
state has *two* histories to control, and cleaning one desynchronises it from the
other. The safe shape is a fresh one-shot marker every run, which is why
scheduling and memory-write never produced a retraction and the clobber task
produced two.

Order matters as much as isolation. An early batch loop ran `for lang in en zh`,
so English always went first against a clean channel and Chinese always followed
nine turns of history — every apparent language effect on a state-reading task
was confounded with transcript depth.

Six of the nine point the same way: environment, timing and probe problems get
charged to the model. None ever made a bad model look good. When a measurement
breaks, "this model is weak" is the cheapest available explanation and it needs
no further evidence to feel finished.

## If you only run one

`schedule.mjs`. It is the only task here that has ever separated one model from
another, because it asks for three things at once — understand a non-English
instruction, do arithmetic on it, actually call a tool — and every observed
failure was there. The clobber tasks found nothing in any model once their probes
were fixed. That is a real result, and it cost far more than it returned.

## License

MIT.
