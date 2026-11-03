#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import type { CardData } from './card.ts';
import { abort, check, plural, type Checked, type Report, type Verdict } from './potemkin.ts';

const HELP = `Potemkin guts every function your coding agent changed and reruns the tests.
Tests that stay green anyway are a facade.

Usage
  npx potemkin-cli [--base REF] [--share] [--json]   check the functions changed since REF
  potemkin guard                                    Claude Code Stop hook (hook JSON on stdin)
  potemkin install | uninstall                      add or remove that hook in ~/.claude/settings.json

Options
  --base REF       compare with REF (default HEAD: your uncommitted work, or the last commit if there is none)
  --max N          check at most N functions (default 40; guard 10)
  --timeout S      seconds per test run before it counts as noticed (default 120)
  --share          also render a PNG card
  --out FILE       card path (default ./potemkin-card.png)
  --json           print every function, verdict and test as JSON
  -v, --version    print the version
  -h, --help       print this help

Runs vitest, jest or pytest in a throwaway copy of the repo. Your files are only read.
Docs: https://github.com/rosehgal/potemkin`;

const ROWS: [Verdict, 'green' | 'red' | 'yellow' | 'gray', string][] = [
  ['NOTICED', 'green', 'a test failed with it gutted'],
  ['HOLLOW', 'red', 'tests call it, and all still pass with it gutted'],
  ['UNTESTED', 'yellow', 'no related test calls it'],
  ['UNVERIFIABLE', 'gray', 'Potemkin could not tell (reasons below)'],
];

const count = (r: Report, v: Verdict) => r.functions.filter((c) => c.verdict === v).length;
const judged = (r: Report) => r.functions.filter((c) => c.verdict !== 'UNVERIFIABLE').length;
const survive = (r: Report) => count(r, 'HOLLOW') + count(r, 'UNTESTED');
const since = (r: Report) => (r.base.length === 40 || r.base.length === 64 ? 'the empty tree' : r.base);
const time = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const where = (c: { file: string; line: number }) => `${c.file}:${c.line}`;

function render(r: Report, share?: string): string {
  const out = [''];
  const head = `${styleText('bold', 'Potemkin')} · ${plural(r.functions.length + r.skipped.length, 'function')} changed since ${since(r)}`;
  if (r.note) out.push(styleText('dim', `(${r.note})`));
  if (!r.functions.length) {
    out.push(head, '', r.skipped.length ? 'Nothing was checked:' : 'No changed functions to check (JS, TS or Python).');
    for (const s of r.skipped.slice(0, 10)) out.push(`  ${where(s)}  ${s.name}  ${styleText('dim', s.why)}`);
    return out.join('\n');
  }
  out.push(`${head} · ${r.runners.join(', ') || 'no runner'} · ${plural(r.tests, 'test')} · ${plural(r.runs, 'run')} in ${time(r.ms)}`, '');
  for (const [v, color, meaning] of ROWS) out.push(`  ${styleText(color, v.padEnd(13))}${String(count(r, v)).padStart(4)}  ${styleText('dim', meaning)}`);
  const n = judged(r);
  out.push('');
  if (n) out.push(styleText('bold', survive(r) ? `${survive(r)} of ${n} functions could be gutted, and every test would still pass.` : `All ${n} functions are pinned: gut any of them and a test turns red.`));

  const section = (title: string, v: Verdict, detail: (c: Checked) => string[]) => {
    const cs = r.functions.filter((c) => c.verdict === v);
    if (!cs.length) return;
    out.push('', title);
    for (const c of cs.slice(0, 15)) out.push(`  ${where(c)}  ${styleText('bold', c.name)}`, ...detail(c));
    if (cs.length > 15) out.push(styleText('dim', `  …and ${cs.length - 15} more (--json lists all)`));
  };
  section(styleText('red', 'Hollow: these tests run it and stay green with it gutted'), 'HOLLOW', (c) =>
    c.tests.length ? [...c.tests.slice(0, 3).map((t) => styleText('dim', `    ← ${t}`)), ...(c.tests.length > 3 ? [styleText('dim', `    ← …${c.tests.length - 3} more`)] : [])] : [styleText('dim', `    ${c.why}`)],
  );
  section(styleText('yellow', 'Untested: no passing related test calls it'), 'UNTESTED', (c) => (c.why === 'no related test calls it' ? [] : [styleText('dim', `    ${c.why}`)]));
  section(styleText('gray', 'Could not tell'), 'UNVERIFIABLE', (c) => [styleText('dim', `    ${c.why}`)]);
  if (r.skipped.length) {
    const why = [...new Set(r.skipped.map((s) => s.why))].slice(0, 3).join('; ');
    out.push('', styleText('dim', `Not checked: ${plural(r.skipped.length, 'function')} (${why})`));
  }
  out.push('', share ? `Card: ${share}` : styleText('dim', 'Card: --share · Every verdict: --json'));
  return out.join('\n');
}

function card(r: Report): CardData {
  const worst = r.functions
    .filter((c) => c.verdict === 'HOLLOW' || c.verdict === 'UNTESTED')
    .sort((a, b) => b.tests.length - a.tests.length)
    .map((c) => (c.verdict === 'HOLLOW' && c.tests.length ? `${c.name} · ${plural(c.tests.length, 'test')} ran it, all stayed green` : `${c.name} · no test calls it`));
  return {
    survive: survive(r),
    total: judged(r),
    worst,
    meta: `${basename(r.root)} · changes since ${since(r)} · ${r.runners.join(', ')}`,
    stats: `${count(r, 'NOTICED')} noticed · ${count(r, 'HOLLOW')} hollow · ${count(r, 'UNTESTED')} untested · ${plural(r.tests, 'test')}, ${plural(r.runs, 'run')}`,
  };
}

function json(r: Report) {
  return JSON.stringify(
    {
      root: r.root,
      base: r.base,
      note: r.note,
      summary: Object.fromEntries(ROWS.map(([v]) => [v, count(r, v)])),
      survive: survive(r),
      judged: judged(r),
      tests: r.tests,
      runs: r.runs,
      ms: r.ms,
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
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  // Only this turn's uncommitted work, and well inside the hook's 300 s timeout.
  const r = await check({ cwd, max, timeoutMs, deadline: Date.now() + 200_000, noFallback: true });
  const hollow = r.functions.filter((c) => c.verdict === 'HOLLOW');
  if (!hollow.length) return;
  const reason = [
    `Potemkin: ${plural(hollow.length, 'function')} you changed can be gutted (made to return nothing) and every test still passes:`,
    ...hollow.flatMap((c) => [`- ${where(c)} ${c.name}: ${c.why}`, ...c.tests.slice(0, 3).map((t) => `    ${t}`)]),
    '',
    'Those tests run the code but never check what it returns or does. Make them assert on the result, so they fail when the function is gutted, or tell the user plainly that these functions are only covered by hollow tests.',
  ].join('\n');
  console.log(JSON.stringify({ decision: 'block', reason }));
}

// ---- install / uninstall ---------------------------------------------------

const HOOK = 'npx -y potemkin-cli guard';
const ours = (h: any) => typeof h?.command === 'string' && /\bpotemkin(?:-cli)?\b.*\bguard\b/.test(h.command);

function install(remove: boolean) {
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const s = text.trim() ? JSON.parse(text) : {}; // unreadable JSON throws: never overwrite what we cannot parse
  if (typeof s !== 'object' || Array.isArray(s)) throw new Error(`${file} is not a JSON object`);
  const hooks = (s.hooks ??= {});
  const stop: any[] = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const had = stop.some((g) => g?.hooks?.some?.(ours));
  for (const g of stop) if (Array.isArray(g?.hooks)) g.hooks = g.hooks.filter((h: any) => !ours(h));
  hooks.Stop = stop.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
  if (!remove) hooks.Stop.push({ hooks: [{ type: 'command', command: HOOK, timeout: 300 }] });
  if (!hooks.Stop.length) delete hooks.Stop;
  if (!Object.keys(hooks).length) delete s.hooks;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.potemkin-tmp`, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(`${file}.potemkin-tmp`, file);
  console.log(
    remove
      ? had
        ? `Removed the Potemkin Stop hook from ${file}`
        : `No Potemkin hook in ${file}; nothing to remove`
      : `${had ? 'Updated' : 'Added'} the Potemkin Stop hook in ${file}: \`${HOOK}\``,
  );
}

// ---- main ----------------------------------------------------------------

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0); // `potemkin | head`
  throw e;
});
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const)
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
    console.error(`potemkin: ${(e as Error).message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  const opt = parsed.values;
  if (opt.help) return console.log(HELP);
  if (opt.version) return console.log(createRequire(import.meta.url)('../package.json').version);
  const max = opt.max === undefined ? (command === 'guard' ? 10 : 40) : Number(opt.max);
  const timeout = opt.timeout === undefined ? 120 : Number(opt.timeout);
  if (!(Number.isInteger(max) && max > 0) || !(timeout > 0)) {
    if (command === 'guard') return;
    console.error(`potemkin: --max needs a whole number above 0 and --timeout a number of seconds above 0`);
    process.exitCode = 2;
    return;
  }
  if (command === 'guard') {
    try {
      await guard(max, timeout * 1000);
    } catch {} // a broken hook must never trap the agent
    return;
  }
  if (command) return install(command === 'uninstall');

  const log = opt.json ? undefined : (line: string) => process.stderr.write(`${styleText('dim', line)}\n`);
  const r = await check({ cwd: process.cwd(), base: opt.base, max, timeoutMs: timeout * 1000, log });
  let file: string | undefined;
  if (opt.share && judged(r)) {
    const { renderCard } = await import('./card.ts');
    file = resolve(opt.out ?? 'potemkin-card.png');
    writeFileSync(file, await renderCard(card(r)));
  }
  console.log(opt.json ? json(r) : render(r, file));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  abort();
  const msg = (e as Error).message;
  console.error(`potemkin: ${/not a git repository/i.test(msg) ? 'run it inside a git repo: Potemkin checks the functions your diff changed' : msg.split('\n')[0]}`);
  if (process.env.DEBUG) console.error(e);
  process.exitCode = 1;
}
