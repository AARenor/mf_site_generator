// makefun-site 1.0.0's driver, unchanged: `node main.ts` reads /input/cases.json (a JSON array of {id, input}), calls
// run() from solve.js on each case's input alone, and writes /output/answers.json, a JSON array of the answers in the
// cases' order. MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output outside a container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it.
setFlagsFromString('--no-incremental-marking');

// One build of the practice set is a quarter second of work: Turbofan's optimisation, compiled on background threads
// inside that window, costs more CPU than it saves, so the optimising tier is off and Maglev runs the build. Guarded so
// a runtime that no longer knows the flag keeps the driver's behaviour.
try {
  setFlagsFromString('--no-turbofan');
} catch {
  // no such flag: run whatever tier the runtime has
}

// Maglev's own compile is part of that quarter second too: the two passes that cost the most to compile and buy least in
// a run this short are off, which measured a few percent faster. Guarded the same way, and flags change no output.
for (const flag of ['--no-maglev-inlining', '--no-maglev-loop-peeling']) {
  try {
    setFlagsFromString(flag);
  } catch {
    // no such flag: Maglev compiles as it pleases
  }
}

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
