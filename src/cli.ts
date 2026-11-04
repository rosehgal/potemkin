#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import type { CardData } from './card.ts';
import { abort, check, digest, plural, SetupError, UsageError, type Checked, type Report, type Verdict } from './potemkin.ts';

const HELP = `Potemkin guts every function your coding agent changed and reruns the tests.
Tests that stay green anyway are a facade.

Usage
  npx potemkin-cli [--base REF] [--share] [--json]   check the functions changed since REF
  npx potemkin-cli install                          add the Claude Code Stop hook (potemkin guard)
  npx potemkin-cli uninstall                        remove it

Verdicts
  NOTICED        a test failed with the function gutted
  HOLLOW         tests run it, yet all of them pass with it gutted
  UNTESTED       no test that loads its file calls it
  UNVERIFIABLE   Potemkin could not tell, and says why

Options
  --base REF       compare with REF; with a branch, only what changed since you left it
                   (default: your uncommitted work, or the last commit if there is none)
  --max N          check at most N functions (default 40; guard 10)
  --timeout S      seconds per test run (default 120)
  --share          also render a PNG card (implied by --out)
  --out FILE       card path (default ./potemkin-card.png)
  --json           print every function, verdict and test as JSON
  --strict         exit 1 if any function is HOLLOW or UNTESTED (for CI)
  -v, --version    print the version
  -h, --help       print this help

Runs vitest, jest or pytest in a throwaway copy of the repo. Your source files are never modified.
Docs: https://github.com/rosehgal/potemkin`;

const ROWS: [Verdict, 'green' | 'red' | 'yellow' | 'gray', string][] = [
  ['NOTICED', 'green', 'a test failed with it gutted'],
  ['HOLLOW', 'red', 'tests run it, yet all pass with it gutted'],
  ['UNTESTED', 'yellow', 'no test that loads its file calls it'],
  ['UNVERIFIABLE', 'gray', 'Potemkin could not tell'],
];

const out = (format: Parameters<typeof styleText>[0], text: string) => styleText(format, text, { stream: process.stdout });
const err = (format: Parameters<typeof styleText>[0], text: string) => styleText(format, text, { stream: process.stderr });
const count = (r: Report, v: Verdict) => r.functions.filter((c) => c.verdict === v).length;
const judged = (r: Report) => r.functions.length - count(r, 'UNVERIFIABLE');
const survive = (r: Report) => count(r, 'HOLLOW') + count(r, 'UNTESTED');
const unchecked = (r: Report) => count(r, 'UNVERIFIABLE') + r.skipped.length;
const label = (r: Report) => (/^[0-9a-f]{40,64}$/.test(r.label) ? r.label.slice(0, 12) : r.label);
const time = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 1 ? '<1s' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const where = (c: { file: string; line: number }) => `${c.file}:${c.line}`;

function headline(r: Report): string {
  const n = judged(r);
  const every = r.configs.length ? 'every test Potemkin ran' : 'every test';
  if (!n) return 'Nothing could be judged.';
  if (survive(r)) return n === 1 ? `The changed function could be gutted, and ${every} would still pass.` : `${survive(r) === n ? 'All' : survive(r) + ' of'} ${n} functions could be gutted, and ${every} would still pass.`;
  return n === 1 ? 'The changed function is pinned: gut it and a test turns red.' : `All ${n} functions are pinned: gut any of them and a test turns red.`;
}

function render(r: Report, card?: string): string {
  const lines = [''];
  const total = r.functions.length + r.skipped.length;
  const head = `${out('bold', 'Potemkin')} · ${plural(total, 'function')} changed since ${label(r)}`;
  if (!total) {
    lines.push(head);
    if (r.note) lines.push(out('dim', `(${r.note})`));
    lines.push('', 'No changed functions to check (JavaScript, TypeScript or Python).');
    return lines.join('\n');
  }
  lines.push(`${head} · ${r.runners.join(', ') || 'no test runner'} · ${plural(r.tests, 'test')} · ${plural(r.runs, 'run')} in ${time(r.ms)}`);
  if (r.note) lines.push(out('dim', `(${r.note})`));
  lines.push('');
  for (const [v, color, meaning] of ROWS) {
    const n = count(r, v);
    if (v === 'UNVERIFIABLE' && !n) continue;
    lines.push(`  ${out(color, v.padEnd(14))}${String(n).padStart(3)}  ${out('dim', meaning)}`);
  }
  lines.push('', out('bold', headline(r)));
  const notes: string[] = [];
  if (unchecked(r) && judged(r)) notes.push(`${plural(unchecked(r), 'more function')} could not be checked (below).`);
  if (r.excluded) notes.push(`${plural(r.excluded, 'test')} already ${r.excluded === 1 ? 'fails' : 'fail'} on the current code and ${r.excluded === 1 ? 'was' : 'were'} left out.`);
  if (r.configs.length) notes.push(`Not run: ${r.configs.join(', ')} (other test configs or suites).`);
  for (const n of notes) lines.push(out('dim', n));

  const section = (title: string, v: Verdict, detail: (c: Checked) => string[]) => {
    const cs = r.functions.filter((c) => c.verdict === v);
    if (!cs.length) return;
    lines.push('', title);
    for (const c of cs.slice(0, 15)) lines.push(`  ${where(c)}  ${out('bold', c.name)}`, ...detail(c));
    if (cs.length > 15) lines.push(out('dim', `  …and ${cs.length - 15} more (--json lists all)`));
  };
  const tests = (c: Checked) => [...c.tests.slice(0, 3).map((t) => out('dim', `    ← ${t}`)), ...(c.tests.length > 3 ? [out('dim', `    ← …${c.tests.length - 3} more`)] : [])];
  section(out('red', 'Hollow: tests run it, yet all pass with it gutted'), 'HOLLOW', (c) => (c.tests.length ? tests(c) : [out('dim', `    ${c.why}`)]));
  section(out('yellow', 'Untested: no test that loads its file calls it'), 'UNTESTED', (c) => (c.why === 'no test that loads its file calls it' ? [] : [out('dim', `    ${c.why}`)]));
  // Unverifiable: one reason per file, not one per function.
  const unv = Map.groupBy(
    r.functions.filter((c) => c.verdict === 'UNVERIFIABLE'),
    (c) => `${c.file}\0${c.why}`,
  );
  if (unv.size) {
    lines.push('', out('gray', 'Could not tell'));
    for (const cs of [...unv.values()].slice(0, 10)) lines.push(`  ${cs[0].file}  ${cs.map((c) => c.name).join(', ')}`, out('dim', `    ${cs[0].why}`));
    if (unv.size > 10) lines.push(out('dim', `  …and ${unv.size - 10} more (--json lists all)`));
  }
  if (r.skipped.length) {
    const why = [...new Set(r.skipped.map((s) => (s.name === '(whole file)' ? `${s.file} ${s.why}` : s.why)))];
    const raise = why.some((w) => w.startsWith('over --max')) ? ' Raise --max to include them.' : '';
    lines.push('', `Not checked: ${plural(r.skipped.length, 'function')} (${why.slice(0, 3).join('; ')}).${raise}`);
  }
  lines.push('', card ? `Card: ${card}` : out('dim', judged(r) ? 'Card: --share · Every verdict: --json' : 'Every verdict: --json'));
  return lines.join('\n');
}

function card(r: Report): CardData {
  const worst = r.functions
    .filter((c) => c.verdict === 'HOLLOW' || c.verdict === 'UNTESTED')
    .sort((a, b) => b.tests.length - a.tests.length)
    .map((c) => ({
      name: c.name,
      why: c.verdict === 'UNTESTED' ? 'no test calls it' : c.tests.length ? `${plural(c.tests.length, 'test')}, still green` : 'tests run it, still green',
    }));
  const extra = [unchecked(r) ? `${unchecked(r)} not checked` : '', r.excluded ? `${plural(r.excluded, 'failing test')} left out` : '', r.configs.length ? `not run: ${r.configs.join(', ')}` : ''].filter(Boolean);
  const folder = basename(r.root).length > 28 ? `${basename(r.root).slice(0, 27)}…` : basename(r.root);
  return {
    survive: survive(r),
    total: judged(r),
    unchecked: unchecked(r),
    worst,
    meta: `${folder} · changes since ${label(r)} · ${r.runners.join(', ')}`,
    stats: [`${count(r, 'NOTICED')} noticed · ${count(r, 'HOLLOW')} hollow · ${count(r, 'UNTESTED')} untested`, ...extra].join(' · '),
  };
}

function json(r: Report, file: string | undefined) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      root: r.root,
      base: r.base,
      label: r.label,
      note: r.note ?? null,
      runners: r.runners,
      configsNotRun: r.configs,
      summary: Object.fromEntries(ROWS.map(([v]) => [v, count(r, v)])),
      survive: survive(r),
      judged: judged(r),
      unchecked: unchecked(r),
      testsSeen: r.tests,
      testsExcluded: r.excluded,
      runs: r.runs,
      ms: r.ms,
      card: file ?? null,
      functions: r.functions,
      skipped: r.skipped,
    },
    null,
    2,
  );
}

// ---- guard: Claude Code Stop hook ----------------------------------------

async function guard(max: number, timeoutMs: number) {
  let input: any;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  // A second block in a row could loop forever; Claude Code sets this flag on the retry.
  if (typeof input !== 'object' || !input || Array.isArray(input) || input.stop_hook_active) return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  // Same uncommitted diff as last time: nothing new to check, and no reason to block again.
  // The memo lives in the repo's .git directory, which nobody else can plant a file in.
  const d = digest(cwd);
  if (existsSync(d.memo) && readFileSync(d.memo, 'utf8') === d.hash) return;
  const r = await check({ cwd, max, timeoutMs, deadline: Date.now() + 200_000, noFallback: true });
  writeFileSync(d.memo, d.hash);
  const hollow = r.functions.filter((c) => c.verdict === 'HOLLOW');
  if (!hollow.length) return;
  const reason = [
    `Potemkin: ${plural(hollow.length, 'function')} you changed ${hollow.length === 1 ? 'has' : 'have'} tests that run ${hollow.length === 1 ? 'it' : 'them'}, yet every test still passes with ${hollow.length === 1 ? 'it' : 'them'} gutted (made to return nothing):`,
    ...hollow.flatMap((c) => [`- ${where(c)} ${c.name}: ${c.why}`, ...c.tests.slice(0, 3).map((t) => `    ${t}`)]),
    '',
    'Those tests run the code but never check what it returns or does. Strengthen them so they fail when the function is gutted: assert on its result or its effect. Do not delete or skip the tests, and do not change the function to get around this. Then run `npx -y potemkin-cli`: each of these should come back NOTICED. If that is not worth doing, tell the user plainly which functions only have hollow tests.',
  ].join('\n');
  console.log(JSON.stringify({ decision: 'block', reason }));
}

// ---- install / uninstall ---------------------------------------------------

const HOOK = 'npx -y potemkin-cli guard';
const ours = (h: any) => h?.command === HOOK;
const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
// Integers past 2^53 would be rounded on the way through; keep their exact text.
const exact = (_k: string, v: unknown, ctx?: { source?: string }) =>
  typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source && (JSON as any).rawJSON ? (JSON as any).rawJSON(ctx.source) : v;

function install(remove: boolean) {
  const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  // Write through a dotfiles symlink (even a dangling one), never replace it.
  let real = file;
  for (let i = 0; i < 8; i++) {
    let st;
    try {
      st = lstatSync(real);
    } catch {
      break;
    }
    if (!st.isSymbolicLink()) break;
    real = resolve(dirname(real), readlinkSync(real));
  }
  const text = existsSync(real) ? readFileSync(real, 'utf8') : '';
  let s: any;
  try {
    s = text.trim() ? JSON.parse(text, exact as any) : {};
  } catch (e) {
    throw new Error(`cannot parse ${file} (${(e as Error).message}); fix it, or add the hook by hand (see the README)`);
  }
  if (!isObject(s)) throw new Error(`${file} is not a JSON object; add the hook by hand (see the README)`);
  if (s.hooks !== undefined && !isObject(s.hooks)) throw new Error(`"hooks" in ${file} is not an object; add the hook by hand (see the README)`);
  const hooks = s.hooks ?? {};
  if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop)) throw new Error(`"hooks.Stop" in ${file} is not a list; add the hook by hand (see the README)`);
  const stop: any[] = hooks.Stop ?? [];
  const had = stop.some((g) => Array.isArray(g?.hooks) && g.hooks.some(ours));
  if (remove && !had) return console.log(`No Potemkin hook in ${file}; nothing to remove.`);
  if (!remove && had) return console.log(`Already installed in ${file}.`);
  if (remove) {
    hooks.Stop = stop.filter((g) => {
      if (!Array.isArray(g?.hooks) || !g.hooks.some(ours)) return true;
      g.hooks = g.hooks.filter((h: any) => !ours(h));
      return g.hooks.length > 0; // drop only the groups Potemkin emptied
    });
    if (!hooks.Stop.length) delete hooks.Stop;
  } else hooks.Stop = [...stop, { hooks: [{ type: 'command', command: HOOK, timeout: 300 }] }];
  if (Object.keys(hooks).length) s.hooks = hooks;
  else delete s.hooks;
  mkdirSync(dirname(real), { recursive: true });
  const tmp = `${real}.potemkin-tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: existsSync(real) ? statSync(real).mode & 0o777 : 0o600 });
  renameSync(tmp, real);
  console.log(
    remove
      ? `Removed the Potemkin Stop hook from ${file}.`
      : `Added the Potemkin Stop hook to ${file}.\nWhen Claude Code finishes a turn, it guts up to 10 functions in your uncommitted work and sends Claude back once if their tests stay green. New sessions pick it up. Undo: npx potemkin-cli uninstall`,
  );
}

// ---- main ----------------------------------------------------------------

for (const stream of [process.stdout, process.stderr])
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
    abort();
    process.exit(0); // `potemkin | head`
  });
process.on('exit', abort); // last line of defence: never leave a sandbox behind
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGQUIT', 131]] as const)
  process.on(sig, () => {
    abort(); // kill the test run and delete the sandbox before exiting
    process.exit(code);
  });

const options = {
  base: { type: 'string' },
  max: { type: 'string' },
  timeout: { type: 'string' },
  json: { type: 'boolean' },
  share: { type: 'boolean' },
  out: { type: 'string' },
  strict: { type: 'boolean' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

const COMMANDS = ['guard', 'install', 'uninstall'];

async function main(argv: string[]) {
  const command = COMMANDS.includes(argv[0]) ? argv[0] : undefined;
  let parsed;
  try {
    parsed = parseArgs({ args: command ? argv.slice(1) : argv, options, allowPositionals: false });
  } catch (e) {
    if (command === 'guard') return; // a broken hook must never trap the agent
    throw new UsageError(`${(e as Error).message.split('\n')[0].replace(/\.$/, '')}. See --help.`);
  }
  const opt = parsed.values;
  if (opt.help) return console.log(HELP);
  if (opt.version) return console.log(createRequire(import.meta.url)('../package.json').version);
  const max = opt.max === undefined ? (command === 'guard' ? 10 : 40) : Number(opt.max);
  const timeout = opt.timeout === undefined ? 120 : Number(opt.timeout);
  if (command === 'guard') {
    if (!(Number.isInteger(max) && max > 0) || !(timeout >= 1 && timeout <= 3600)) return;
    try {
      await guard(max, timeout * 1000);
    } catch {} // a broken hook must never trap the agent
    return;
  }
  if (!(Number.isInteger(max) && max > 0)) throw new UsageError(`--max must be a whole number above 0 (got "${opt.max}")`);
  if (!(timeout >= 1 && timeout <= 3600)) throw new UsageError(`--timeout must be a number of seconds between 1 and 3600 (got "${opt.timeout}")`);
  if (command) return install(command === 'uninstall');

  // On a terminal, progress is one line that rewrites itself; in a log file, one line per step.
  const tty = process.stderr.isTTY;
  const log = !opt.json || tty
    ? (line: string) => {
        if (!tty) return void process.stderr.write(`${line}\n`);
        const width = (process.stderr.columns || 80) - 1;
        process.stderr.write(`\r\x1b[2K${err('dim', line.length > width ? `${line.slice(0, width - 1)}…` : line)}`);
      }
    : undefined;
  const r = await check({ cwd: process.cwd(), base: opt.base, max, timeoutMs: timeout * 1000, log });
  if (tty && log) process.stderr.write('\r\x1b[2K');
  let file: string | undefined;
  let cardNote = '';
  if (opt.share || opt.out) {
    if (!judged(r)) cardNote = 'No card: nothing was judged.';
    else {
      try {
        const { renderCard } = await import('./card.ts');
        const target = resolve(opt.out ?? 'potemkin-card.png');
        writeFileSync(target, await renderCard(card(r)));
        file = target;
      } catch (e) {
        cardNote = `Card not written: ${(e as Error).message.split('\n')[0]}`;
      }
    }
  }
  console.log(opt.json ? json(r, file) : render(r, file));
  if (cardNote) console.error(cardNote);
  if (opt.strict && (survive(r) || (!judged(r) && r.functions.length))) process.exitCode = 1; // hollow, untested, or nothing Potemkin could vouch for
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  abort();
  const msg = (e as Error).message;
  if (e instanceof UsageError) {
    console.error(`potemkin: ${msg}`);
    process.exitCode = 2;
  } else {
    const text = /not a git repository/i.test(msg) ? 'run it inside a git repo: Potemkin checks the functions your diff changed' : e instanceof SetupError ? `nothing could be checked: ${msg}` : msg.split('\n')[0];
    console.error(`potemkin: ${text}`);
    if (process.env.DEBUG) console.error(e);
    process.exitCode = 1;
  }
}
