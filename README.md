# site-generator-speed-01-run-20261122

`makefun-site` in one dependency-free ES module: `solve.js` exports `run(input)`, which returns make.fun's
`makefun-site 1.0.0` build for that input — a tree of output path to file text — and `main.ts` drives it over the cases
the harness hands it.

Built by reading the reference end to end, writing down its rules (front matter, template dialect, Markdown subset,
slug rule, report), mirroring them, and then making the mirror fast: one scan per string, no regex in a hot path,
templates parsed once, no intermediate block-token objects, and escaping that copies runs instead of characters.

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/AARenor/mf_site_generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/AARenor/mf_site_generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Run: `MAKEFUN_INPUT_DIR=$PWD/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts`, from the kit, on the practice set.

NOTICE: makefun-site 1.0.0 is make.fun's own static site generator (MIT) and is the reference this entry
re-implements; `solve.js` here is written for this entry and follows that reference's semantics — its front matter,
template dialect, Markdown subset, slug rule and report — line for line where they are the specification, without
copying the reference's code or any other entrant's.
