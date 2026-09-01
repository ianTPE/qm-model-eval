-- Per-turn token usage for the benchmarked models, from qm's own record.
--
-- Source is `session_llm_requests.usage_json`, written by `recordLlmRequest` on
-- the turn path. Not `modelGateway`'s in-memory ring — see trap 13.
--
--   docker exec <pg> psql -U postgres -d qm -f tools/usage.sql
--
-- Two filters carry the weight, and both are necessary:
--
--   scope AND model must match. Grouping by model alone puts the org default
--   (here claude-opus-5) at 356 turns of 5,640 tokens, because it also serves
--   the security screen and history compaction inside *other* models' eval
--   channels. Those are real platform cost, but they are not the pinned model's
--   usage. Requiring the pair to agree isolates the model under test.
--
--   The same filter also removes every auxiliary row from qm/#889, where a
--   one-shot classifier call writes under the caller's session_id but the
--   one-shot's own coordinates, always (turn_seq 1, step 0). After the filter
--   this set is 908 rows, 908 distinct (session_id, turn_seq, step), none at
--   (1, 0) — so no deduplication is applied, and none is needed.
--
-- A turn is one (session_id, turn_seq). The claude harness writes one row per
-- turn with usage reduced over its model calls; the pi harness writes one row
-- per step. Summing per turn makes the two comparable; a per-*row* mean would
-- not be.

WITH matched AS (
  SELECT session_id, turn_seq, model,
         (usage_json::jsonb->>'input')::numeric      AS inp,
         (usage_json::jsonb->>'output')::numeric     AS outp,
         (usage_json::jsonb->>'cacheRead')::numeric  AS cache_read,
         (usage_json::jsonb->>'cacheWrite')::numeric AS cache_write
  FROM session_llm_requests
  WHERE usage_json IS NOT NULL AND (
       (scope_label = 'channel:eval-sol'       AND model = 'gpt-5.6-sol')
    OR (scope_label = 'channel:eval-luna'      AND model = 'gpt-5.6-luna')
    OR (scope_label = 'channel:eval-terra'     AND model = 'gpt-5.6-terra')
    OR (scope_label = 'channel:eval-qwen'      AND model = 'qwen3.8-max')
    OR (scope_label = 'channel:eval-ds-flash'  AND model = 'deepseek-v4-flash')
    OR (scope_label = 'channel:eval-ds-pro'    AND model = 'deepseek-v4-pro')
    OR (scope_label LIKE 'channel:eval-kimi%'  AND model = 'kimi-k3')
    OR (scope_label = 'channel:eval-glm'       AND model = 'glm-5.3')
    OR (scope_label = 'channel:eval-opus-5'    AND model = 'claude-opus-5')
    OR (scope_label = 'channel:eval-sonnet-5'  AND model = 'claude-sonnet-5')
    OR (scope_label = 'channel:eval-haiku-4-5' AND model = 'claude-haiku-4-5')
    OR (scope_label = 'channel:eval-orauto'    AND model = 'openrouter/auto'))
), per_turn AS (
  SELECT model, session_id, turn_seq,
         sum(inp) inp, sum(outp) outp, sum(cache_read) cache_read, sum(cache_write) cache_write
  FROM matched GROUP BY 1, 2, 3
)
SELECT model,
       count(*)                       AS turns,
       round(avg(inp))                AS input,
       round(avg(cache_write))        AS cache_write,
       round(avg(cache_read))         AS cache_read,
       round(avg(outp))               AS output,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY inp + cache_write + cache_read + outp)) AS median_total,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY inp + cache_write + cache_read + outp)) AS p95_total
FROM per_turn GROUP BY model ORDER BY avg(inp + cache_write + cache_read + outp) DESC;
