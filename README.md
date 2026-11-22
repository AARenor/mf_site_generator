# site-generator-speed-01-run-20261122

`makefun-site` in one dependency-free ES module: `solve.js` exports `run(input)`, which returns make.fun's
`makefun-site 1.0.0` build for that input — a tree of output path to file text — and `main.ts` drives it over the cases
the harness hands it.

Built by reading the reference end to end, writing down its rules (front matter, template dialect, Markdown subset,
slug rule, report), mirroring them, and then making the mirror fast: one scan per string through a character table
instead of a regex, escaping and inline Markdown copying whole runs instead of characters, Markdown rendered straight
off its lines with no block-token objects, templates parsed once and rendered over a stack of scopes rather than a
chain of scope objects, and a loop's `loop` object built only when its body reads it. The driver also turns V8's
optimising tier off before the import: a quarter second of work cannot repay the compilation that tier does inside it.

A second pass took it further: a partial that can only render the same text on every page of a build (the header, the
footer, the recent-notes list, the filler widgets — proved from the parse tree, not assumed) is rendered once and
pushed whole from then on, pages and Markdown blocks are built as flat pieces joined once instead of ropes of appends,
inline Markdown renders a nested run in place rather than slicing it out first, slugs and word counts are made of
character tables rather than regexes, and the driver turns off Maglev's two costliest compile passes as well — which
together measured about 20% off the practice set's CPU time on top of the first pass.

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/AARenor/mf_site_generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/AARenor/mf_site_generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Run: `MAKEFUN_INPUT_DIR=$PWD/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts`, from the kit, on the practice set.

NOTICE: makefun-site 1.0.0 is make.fun's own static site generator (MIT) and is the reference this entry
re-implements; `solve.js` here is written for this entry and follows that reference's semantics — its front matter,
template dialect, Markdown subset, slug rule and report — line for line where they are the specification, without
copying the reference's code or any other entrant's.
