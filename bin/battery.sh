#!/usr/bin/env bash
# Run the tier 1 battery against one pinned scope and write a TSV.
#
#   bin/battery.sh <channelRef> [runs]
#
# Tasks run one at a time on purpose. The state-reading tasks wait for the
# deployment to go idle before they touch anything, and running two batteries at
# once defeats that — each reads the other's traffic as "still busy".
set -u
cd "$(dirname "$0")/.."

SCOPE=${1:?usage: battery.sh <channelRef> [runs]}
RUNS=${2:-3}
OUT=results/battery-${SCOPE}.tsv

printf 'lang\ttask\trun\tmodel\tsecs\ta\tb\tc\n' > "$OUT"
field() { printf '%s\n' "$1" | grep -m1 -E "$2" | sed -E "s/$3//" | tr -d ' \r'; }

# Alternate which language goes first. A fixed `for lang in en zh` makes English
# always run against a shallower transcript than Chinese, so any apparent
# language effect on a state-reading task is confounded with history depth — the
# README lists that alongside trap 6, and this script used to have the defect it
# warns about.
for run in $(seq 1 "$RUNS"); do
  if [ $((run % 2)) -eq 1 ]; then langs="en zh"; else langs="zh en"; fi
  for lang in $langs; do
    export EVAL_LANG=$lang
    o=$(timeout 500 node tasks/schedule.mjs "$SCOPE" 2>&1)
    printf '%s\tschedule\t%s\t%s\t%s\t%s\t%s\t%s\n' "$lang" "$run" \
      "$(field "$o" '^model' '^model *: *')" \
      "$(printf '%s\n' "$o" | grep -m1 -oE '\([0-9.]+s\)' | tr -d '()s')" \
      "$(field "$o" '^  created' '^ *created *: *')" \
      "$(field "$o" '^  drift' '^ *drift *: *')" \
      "$(field "$o" '^  one-off' '^ *one-off *: *')" >> "$OUT"

    o=$(timeout 500 node tasks/memory.mjs "$SCOPE" 2>&1)
    printf '%s\tmemory\t%s\t%s\t%s\t%s\t%s\t-\n' "$lang" "$run" \
      "$(field "$o" '^model' '^model *: *')" \
      "$(printf '%s\n' "$o" | grep -m1 -oE '\([0-9.]+s\)' | tr -d '()s')" \
      "$(field "$o" '^  stored in own' '^ *stored in own scope *: *')" \
      "$(field "$o" '^  written to org' '^ *written to org *: *')" >> "$OUT"

    o=$(timeout 500 node tasks/memory-clobber.mjs "$SCOPE" 2>&1)
    printf '%s\tclobber\t%s\t%s\t-\t%s\t%s\t%s\n' "$lang" "$run" \
      "$(field "$o" '^model' '^model *: *')" \
      "$(field "$o" '^  changed' '^ *changed *: *')" \
      "$(field "$o" '^  sentinel kept' '^ *sentinel kept *: *')" \
      "$(field "$o" '^  new fact added' '^ *new fact added *: *')" >> "$OUT"

    echo "  $SCOPE $lang run $run"
  done
done
echo "wrote $OUT"
