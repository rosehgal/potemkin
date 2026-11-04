// The check: which functions did the diff change, and does any test turn red when one is gutted?
// Everything runs in a throwaway copy of the repo. The working tree is only ever read.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { canary, JS_FILE, jsFunctions, jsMutant, NOT_SOURCE, PY_FILE, pyFunctions, pyMutant, type Fn, type Mutant } from './functions.ts';
import { pythonFor, relatedPyTests, runnerFor, runTests, stopCurrent, testFile, type Run, type Runner, type Selection } from './runners.ts';

export type Verdict = 'NOTICED' | 'HOLLOW' | 'UNTESTED' | 'UNVERIFIABLE';

export interface Checked {
  file: string;
  name: string;
  line: number;
  verdict: Verdict;
  tests: string[]; // NOTICED: tests that failed with it gutted. HOLLOW: tests that failed when it threw.
  why: string;
}

export interface Skipped {
  file: string;
  name: string;
  line: number;
  why: string;
}

export interface Report {
  root: string;
  base: string; // what was diffed against
  label: string; // how to say it: HEAD, HEAD~1, main, the empty tree
  note?: string;
  functions: Checked[];
  skipped: Skipped[];
  runners: string[];
  configs: string[]; // other test configs Potemkin did not run
  runs: number;
  tests: number; // distinct tests that passed before any change
  excluded: number; // tests that already failed before any change, left out
  ms: number;
}

export interface Options {
  cwd: string;
  base?: string;
  max: number;
  timeoutMs: number;
  deadline?: number; // epoch ms; functions left after it are skipped
  noFallback?: boolean; // do not fall back to HEAD~1 when nothing is uncommitted
  log?: (line: string) => void;
}

/** A problem with the command line or the repo, not with the code under test. */
export class UsageError extends Error {}
/** Nothing could be checked because of the setup (no runner, dependencies missing). */
export class SetupError extends Error {}

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', input, maxBuffer: 256 << 20, stdio: ['pipe', 'pipe', 'pipe'] });
const ok = (fn: () => unknown) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const isCommit = (root: string, ref: string) => ok(() => git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]));
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const isSource = (f: string) => (JS_FILE.test(f) || PY_FILE.test(f)) && !NOT_SOURCE.test(f);
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/** Changed files since `base`: path in the working tree, and its path in `base` (null if new). */
function changedFiles(root: string, base: string): Map<string, string | null> {
  const m = new Map<string, string | null>();
  const parts = git(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', base, '--']).split('\0');
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = parts[i++];
      m.set(parts[i++], status.startsWith('R') ? from : null);
    } else {
      const path = parts[i++];
      if (status !== 'D') m.set(path, status === 'A' ? null : path);
    }
  }
  for (const f of git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0')) if (f) m.set(f, null);
  return m;
}

/** Functions in `file` that are new, or whose structure differs from the same-named function in `base`. */
function changedFunctions(root: string, base: string, files: Map<string, string | null>, skipped: Skipped[]): Fn[] {
  const out: Fn[] = [];
  for (const [file, old] of files) {
    if (!isSource(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    const python = pythonFor(root, file);
    const list = (name: string, text: string, path?: string) => (PY_FILE.test(name) ? pyFunctions(python, file, path ?? '-', path ? undefined : text) : jsFunctions(name, text));
    let now: Fn[];
    try {
      now = list(file, readFileSync(abs, 'utf8'), abs);
    } catch (e) {
      skipped.push({ file, name: '(whole file)', line: 1, why: `could not parse it: ${(e as Error).message.split('\n')[0]}` });
      continue;
    }
    let before = new Map<string, string>();
    if (old !== null) {
      try {
        before = new Map(list(old, git(root, ['show', `${base}:${old}`])).map((f) => [f.name, f.fp]));
      } catch {} // unreadable or unparseable before: every function counts as changed
    }
    out.push(...now.filter((f) => before.get(f.name) !== f.fp));
  }
  return out;
}

/** At most `max` functions, taken round-robin across files so one big file cannot crowd out the rest. */
function pick(fns: Fn[], max: number): [Fn[], Fn[]] {
  const byFile = [...Map.groupBy(fns, (f) => f.file).values()];
  const take: Fn[] = [];
  for (let i = 0; take.length < max && byFile.some((l) => i < l.length); i++) for (const l of byFile) if (i < l.length && take.length < max) take.push(l[i]);
  const keep = new Set(take);
  return [fns.filter((f) => keep.has(f)), fns.filter((f) => !keep.has(f))];
}

// ---- sandbox ---------------------------------------------------------------

interface Sandbox {
  root: string;
  dir: string;
  links: Set<string>; // symlinks Potemkin made (dependencies); removed before the directory is
  copied: Map<string, { size: number; mtimeMs: number }>; // repo files in the sandbox, as copied
  dirs: Set<string>;
  files: string[];
}

let active: Sandbox | undefined;
const CACHES = new Set(['.vite', '.vitest', '.vitest-cache', '.cache', '.jest-cache']);

function makeSandbox(root: string): Sandbox {
  // realpath: on macOS tmpdir() is a symlink, and runners match related files by their real path.
  const sb: Sandbox = { root, dir: realpathSync(mkdtempSync(join(tmpdir(), 'potemkin-'))), links: new Set(), copied: new Map(), dirs: new Set(['']), files: [] };
  active = sb; // set first, so abort() cleans up a half-built sandbox too
  for (const f of git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0')) {
    if (!f) continue;
    const src = join(root, f);
    const dst = join(sb.dir, f);
    try {
      const st = lstatSync(src);
      mkdirSync(dirname(dst), { recursive: true });
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
      else if (st.isDirectory()) cpSync(src, dst, { recursive: true, verbatimSymlinks: true }); // a submodule
      else copyFileSync(src, dst);
    } catch {
      continue; // deleted in the working tree, or unreadable: the tests will not see it either way
    }
    sb.files.push(f);
    sb.copied.set(f, stamp(dst));
    for (let d = dirname(f); d !== '.' && !sb.dirs.has(d); d = dirname(d)) sb.dirs.add(d);
  }
  for (const d of [...sb.dirs]) {
    const nm = join(root, d, 'node_modules');
    if (existsSync(nm) && !existsSync(join(sb.dir, d, 'node_modules'))) linkModules(sb, nm, join(sb.dir, d, 'node_modules'));
    for (const v of ['.venv', 'venv', 'env']) {
      const p = join(root, d, v);
      if (existsSync(join(p, 'pyvenv.cfg')) && !existsSync(join(sb.dir, d, v))) link(sb, p, join(sb.dir, d, v));
    }
  }
  // Local env files are ignored by git. Copy them: a test that rewrites .env must not reach the real one.
  for (const name of readdirSync(root))
    if (/^\.env(?:\..+)?$/.test(name) && !sb.copied.has(name)) {
      try {
        if (statSync(join(root, name)).isFile()) {
          copyFileSync(join(root, name), join(sb.dir, name));
          sb.copied.set(name, stamp(join(sb.dir, name)));
        }
      } catch {}
    }
  mkdirSync(join(sb.dir, '.potemkin'), { recursive: true });
  return sb;
}

const stamp = (p: string) => {
  const s = lstatSync(p);
  return { size: s.size, mtimeMs: s.mtimeMs };
};

function link(sb: Sandbox, from: string, to: string) {
  symlinkSync(from, to);
  sb.links.add(to);
}

// A real node_modules directory of links, so caches land in the sandbox and workspace
// packages (links into the repo) resolve to the sandbox copy, not the original checkout.
function linkModules(sb: Sandbox, from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (CACHES.has(name)) continue;
    const src = join(from, name);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue;
    }
    if (name.startsWith('@') && st.isDirectory()) {
      linkModules(sb, src, join(to, name));
      continue;
    }
    let target = src;
    if (st.isSymbolicLink()) {
      try {
        const real = realpathSync(src);
        if (inside(real, sb.root) && !real.split(sep).includes('node_modules')) {
          const mirror = join(sb.dir, relative(sb.root, real));
          if (existsSync(mirror)) target = mirror;
        }
      } catch {}
    }
    link(sb, target, join(to, name));
  }
}

/** Undoes whatever a test run left in the sandbox: new files go, changed repo files come back. */
function reset(sb: Sandbox) {
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(sb.dir, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && name === '.potemkin') continue;
      const abs = join(sb.dir, r);
      if (name === 'node_modules' && sb.dirs.has(rel)) continue; // ours; runner caches may live there
      const st = lstatSync(abs);
      if (sb.links.has(abs) || sb.copied.has(r)) continue;
      if (st.isDirectory() && !st.isSymbolicLink() && sb.dirs.has(r)) walk(r);
      else rmSync(abs, { recursive: true, force: true });
    }
  };
  walk('');
  for (const [f, was] of sb.copied) {
    const abs = join(sb.dir, f);
    let now;
    try {
      now = stamp(abs);
    } catch {}
    if (now && now.size === was.size && now.mtimeMs === was.mtimeMs) continue;
    try {
      rmSync(abs, { recursive: true, force: true });
      const src = join(sb.root, f);
      const st = lstatSync(src);
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), abs);
      else if (st.isDirectory()) cpSync(src, abs, { recursive: true, verbatimSymlinks: true });
      else copyFileSync(src, abs);
      sb.copied.set(f, stamp(abs));
    } catch {}
  }
}

/** Stops the running test process and deletes the sandbox. Safe to call twice, and from a signal handler. */
export function abort() {
  stopCurrent();
  const sb = active;
  active = undefined;
  if (!sb) return;
  for (const l of sb.links) {
    try {
      unlinkSync(l); // drop our links first, so removal can never reach the real node_modules
    } catch {}
  }
  try {
    rmSync(sb.dir, { recursive: true, force: true });
  } catch {
    try {
      chmodTree(sb.dir); // a read-only directory a test or a nested repo left behind
      rmSync(sb.dir, { recursive: true, force: true });
    } catch {}
  }
}

function chmodTree(dir: string) {
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) chmodTree(p);
  }
}

// ---- the check ---------------------------------------------------------------

export async function check(opt: Options): Promise<Report> {
  const t0 = Date.now();
  const log = opt.log ?? (() => {});
  const root = git(opt.cwd, ['rev-parse', '--show-toplevel']).trim();
  const hasHead = isCommit(root, 'HEAD');
  let base = 'HEAD';
  let label = 'HEAD';
  let note: string | undefined;
  if (opt.base !== undefined) {
    if (!opt.base.trim()) throw new UsageError('--base needs a branch, tag or commit');
    if (!isCommit(root, opt.base)) throw new UsageError(`--base ${opt.base} is not a commit in this repo`);
    label = opt.base;
    base = opt.base;
    // Like a pull request: what changed since the branch left REF, not what REF gained since.
    if (hasHead) {
      try {
        base = git(root, ['merge-base', opt.base, 'HEAD']).trim() || opt.base;
      } catch {}
    }
  } else if (!hasHead) {
    base = git(root, ['hash-object', '-t', 'tree', '--stdin'], '').trim();
    label = 'the empty tree';
    note = 'no commits yet, so every file counts as new';
  }

  const report: Report = { root, base, label, note, functions: [], skipped: [], runners: [], configs: [], runs: 0, tests: 0, excluded: 0, ms: 0 };
  let fns = changedFunctions(root, base, changedFiles(root, base), report.skipped);
  if (!fns.length && !report.skipped.length && opt.base === undefined && hasHead && !opt.noFallback && isCommit(root, 'HEAD~1')) {
    if (isCommit(root, 'HEAD^2')) report.note = 'no uncommitted code changes, and the last commit is a merge: pass --base to choose what to check';
    else {
      report.base = base = 'HEAD~1';
      report.label = label = 'HEAD~1';
      report.note = 'no uncommitted code changes, so checking the functions changed in the last commit';
      fns = changedFunctions(root, base, changedFiles(root, base), report.skipped);
    }
  }
  const [chosen, rest] = pick(fns, opt.max);
  for (const f of rest) report.skipped.push({ file: f.file, name: f.name, line: f.line, why: `over --max ${opt.max}` });
  if (!chosen.length) return { ...report, ms: Date.now() - t0 };

  // Runners first: a setup problem should not cost a copy of the repo.
  const runners = new Map<string, Runner | string>();
  for (const f of chosen) if (!runners.has(f.file)) runners.set(f.file, lstatSync(join(root, f.file)).isSymbolicLink() ? 'it is a symlink, and Potemkin only mutates real files inside its sandbox' : runnerFor(root, f.file));
  const setup = [...runners.values()].filter((r): r is string => typeof r === 'string');
  if (setup.length === runners.size && !/symlink/.test(setup[0])) throw new SetupError(setup[0]);

  log(`Copying ${basename(root)} to a sandbox…`);
  const seen = new Set<string>();
  const left = new Set<string>();
  const full = new Map<string, Promise<Baseline>>(); // whole-suite baseline, once per runner
  let done = 0;
  try {
    const sb = makeSandbox(root);
    const byFile = Map.groupBy(chosen, (f) => f.file);
    for (const [file, list] of byFile) {
      const add = (fn: Fn, verdict: Verdict, tests: string[], why: string) => {
        report.functions.push({ file, name: fn.name, line: fn.line, verdict, tests, why });
        log(`  [${++done}/${chosen.length}] ${verdict.padEnd(12)} ${fn.name}`);
      };
      const late = () => opt.deadline !== undefined && Date.now() > opt.deadline;
      if (late()) {
        for (const fn of list) report.skipped.push({ file, name: fn.name, line: fn.line, why: 'out of time' });
        continue;
      }
      const runner = runners.get(file)!;
      if (typeof runner === 'string') {
        for (const fn of list) add(fn, 'UNVERIFIABLE', [], runner);
        continue;
      }
      if (!report.runners.includes(runner.kind)) report.runners.push(runner.kind);
      for (const c of runner.configs) if (!report.configs.includes(join(runner.dir, c))) report.configs.push(join(runner.dir, c));

      const abs = join(sb.dir, file);
      const out = join(sb.dir, '.potemkin', runner.kind === 'pytest' ? 'results.xml' : 'results.json');
      const marker = join(sb.dir, '.potemkin', 'called');
      const original = readFileSync(abs, 'utf8');
      const write = (text: string) => {
        // The only write to repo content, and only ever to a real file inside the sandbox.
        if (lstatSync(abs).isSymbolicLink() || !inside(realpathSync(abs), sb.dir)) throw new Error(`refusing to write outside the sandbox: ${file}`);
        writeFileSync(abs, text);
      };
      const run = async (sel: Selection, mutant?: string): Promise<Run> => {
        report.runs++;
        if (mutant !== undefined) write(mutant);
        try {
          return await runTests(runner, sb.dir, sel, opt.timeoutMs, out);
        } finally {
          if (mutant !== undefined) {
            write(original);
            sb.copied.set(file, stamp(abs));
          }
          reset(sb);
        }
      };
      const baseline = async (sel: Selection): Promise<Baseline> => {
        const a = await run(sel);
        if (!a.results) return { error: explain(runner, a, opt.timeoutMs, file) };
        const r = new Map(a.results);
        if ([...r.values()].includes('fail')) {
          const b = await run(sel); // flaky or order-dependent: a pass in either run counts
          for (const [id, o] of b.results ?? []) if (o === 'pass' && r.get(id) === 'fail') r.set(id, 'pass');
        }
        const pass = new Set([...r].filter(([, o]) => o === 'pass').map(([id]) => id));
        const fail = new Set([...r].filter(([, o]) => o === 'fail').map(([id]) => id));
        for (const id of pass) seen.add(id);
        for (const id of fail) left.add(id);
        return { pass, fail };
      };
      const red = (r: Run, pass: Set<string>) => (r.results ? [...pass].filter((id) => r.results!.get(id) !== 'pass') : null); // missing counts as red
      const mutant = (fn: Fn, kind: Mutant, mark?: string) =>
        fn.lang === 'py' ? pyMutant(pythonFor(root, file), abs, fn, kind, mark) : jsMutant(original, fn, kind, mark);

      // Phase A: the tests the runner relates to this file. Most functions end here, NOTICED.
      const related = runner.kind === 'pytest' ? relatedPyTests(file, sb.files, (f) => readFileSync(join(sb.dir, f), 'utf8')) : [];
      const relSel: Selection = runner.kind === 'pytest' ? (related.length ? { files: related } : 'all') : { related: [file] };
      log(`${file}: ${plural(list.length, 'function')} · ${runner.kind}, related tests first`);
      const rb = await baseline(relSel);
      if ('error' in rb) {
        for (const fn of list) add(fn, 'UNVERIFIABLE', [], `its related tests could not run before Potemkin changed anything: ${rb.error}`);
        continue;
      }
      const candidates: Fn[] = [];
      const mutants = new Map<Fn, (kind: Mutant, mark?: string) => string>();
      for (const fn of list) {
        if (late()) {
          report.skipped.push({ file, name: fn.name, line: fn.line, why: 'out of time' });
          continue;
        }
        try {
          mutant(fn, 'empty'); // fail early on a mutant that cannot be written
          mutants.set(fn, (kind, mark) => mutant(fn, kind, mark));
        } catch (e) {
          add(fn, 'UNVERIFIABLE', [], `could not write a mutant: ${(e as Error).message}`);
          continue;
        }
        if (!rb.pass.size) {
          candidates.push(fn);
          continue;
        }
        const gone = red(await run(relSel, mutants.get(fn)!('empty')), rb.pass);
        if (gone === null || gone.length) add(fn, 'NOTICED', gone ?? [], gone ? `${plural(gone.length, 'test')} failed with it gutted` : 'the test run crashed or timed out with it gutted');
        else candidates.push(fn);
      }
      if (!candidates.length) continue;

      // Phase B: before accusing anything, ask the whole suite which tests load this file at all.
      // That catches dynamic imports, subprocess tests, fixtures, other packages of a monorepo.
      const key = `${runner.kind}:${runner.dir}`;
      if (!full.has(key)) full.set(key, baseline('all'));
      const fb = await full.get(key)!;
      if ('error' in fb) {
        for (const fn of candidates) add(fn, 'UNVERIFIABLE', [], `no related test noticed it gutted, but the whole suite could not run to confirm: ${fb.error}`);
        continue;
      }
      const loadRun = await run('all', canary(file, original));
      const loaders = red(loadRun, fb.pass);
      const broken = [...rb.fail];
      const brokenNote = broken.length
        ? `${plural(broken.length, 'related test')} already ${broken.length === 1 ? 'fails' : 'fail'} before any change and might check it (${broken[0]})`
        : '';
      if (loaders === null) {
        for (const fn of candidates) add(fn, 'UNVERIFIABLE', [], 'the whole suite crashed when this file threw on import, so Potemkin cannot tell which tests load it');
        continue;
      }
      if (!loaders.length) {
        const importers = importedBy(file, sb.files, (f) => readFileSync(join(sb.dir, f), 'utf8'));
        const failing = new Set([...rb.fail, ...fb.fail].map(testFile));
        const live = importers.filter((f) => !failing.has(f));
        for (const fn of candidates)
          if (live.length) add(fn, 'UNVERIFIABLE', [], `${live[0]} imports this file, yet no test loaded the sandbox copy (a workspace link or an editable install?)`);
          else if (importers.length) add(fn, 'UNVERIFIABLE', [], `the tests that import this file (${importers[0]}) already fail before any change, so they cannot notice anything`);
          else if (brokenNote) add(fn, 'UNVERIFIABLE', [], `no passing test loads this file, and ${brokenNote}`);
          else add(fn, 'UNTESTED', [], 'no test in the suite loads this file');
        continue;
      }
      const files = [...new Set(loaders.map(testFile))];
      const sel: Selection = runner.kind === 'pytest' ? 'all' : { files };
      const pass = runner.kind === 'pytest' ? fb.pass : new Set([...fb.pass].filter((id) => files.includes(testFile(id))));
      for (const fn of candidates) {
        if (late()) {
          report.skipped.push({ file, name: fn.name, line: fn.line, why: 'out of time' });
          continue;
        }
        const make = mutants.get(fn)!;
        const gone = red(await run(sel, make('empty')), pass);
        if (gone === null || gone.length) {
          const extra = gone?.filter((id) => !rb.pass.has(id)) ?? [];
          add(fn, 'NOTICED', gone ?? [], gone ? `${plural(gone.length, 'test')} failed with it gutted${extra.length === gone.length ? ' (found by asking the whole suite)' : ''}` : 'the test run crashed or timed out with it gutted');
          continue;
        }
        rmSync(marker, { force: true });
        const t1 = await run(sel, make('throw', marker));
        const called = existsSync(marker);
        if (!t1.results) {
          add(fn, 'UNVERIFIABLE', [], `every test passed with it gutted, but the run where it threw ${t1.timedOut ? 'timed out (try a larger --timeout)' : 'crashed'}`);
          continue;
        }
        let threw = red(t1, pass)!;
        if (threw.length) {
          const t2 = await run(sel, make('throw')); // a flaky failure must not make a test look like a caller
          const again = new Set(red(t2, pass) ?? []);
          threw = threw.filter((id) => again.has(id));
        }
        if (brokenNote && !threw.length && !called) add(fn, 'UNVERIFIABLE', [], `no passing test calls it, and ${brokenNote}`);
        else if (brokenNote) add(fn, 'UNVERIFIABLE', [], `every passing test stayed green with it gutted, but ${brokenNote}`);
        else if (threw.length) add(fn, 'HOLLOW', threw, `${plural(threw.length, 'test fails', 'tests fail')} when it throws, yet all pass with it gutted`);
        else if (called) add(fn, 'HOLLOW', [], 'tests run it (and catch its errors), yet all pass with it gutted');
        else add(fn, 'UNTESTED', [], 'no test that loads its file calls it');
      }
    }
  } finally {
    abort();
  }
  return { ...report, tests: seen.size, excluded: [...left].filter((id) => !seen.has(id)).length, ms: Date.now() - t0 };
}

type Baseline = { pass: Set<string>; fail: Set<string> } | { error: string };

function explain(r: Runner, run: Run, timeoutMs: number, file: string): string {
  if (run.timedOut) return `${r.kind} timed out after ${Math.round(timeoutMs / 1000)}s (try a larger --timeout)`;
  const lines = run.tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const why = [...lines].reverse().find((l) => /error|cannot|not found|failed|missing|ERR_|exception/i.test(l)) ?? lines.at(-1) ?? 'no output';
  const repro = r.kind === 'vitest' ? `npx vitest related ${file} --run` : r.kind === 'jest' ? `npx jest --findRelatedTests ${file}` : `${r.exe} -m pytest`;
  return `${r.kind} exited ${run.code}: ${why.slice(0, 200)} (reproduce: ${repro})`;
}

/** Test files whose import specifiers point at this file: evidence that some test means to load it. */
function importedBy(file: string, files: string[], read: (f: string) => string): string[] {
  if (PY_FILE.test(file)) return relatedPyTests(file, files, read);
  const target = file.replace(JS_FILE, '');
  const matches = (test: string, spec: string) => {
    const s = spec.replace(JS_FILE, '').replace(/\/index$/, '');
    if (s.startsWith('.')) {
      const p = join(dirname(test), s);
      return p === target || p === target.replace(/\/index$/, '');
    }
    // An alias such as @/lib/money or ~/lib/money: the rest must name the file's path, at least two segments of it.
    const rest = s.replace(/^[@~#$]\//, '');
    return rest.includes('/') && (`/${target}`.endsWith(`/${rest}`) || `/${target}`.endsWith(`/${rest}/index`));
  };
  const SPEC = /(?:from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
  return files.filter((f) => JS_FILE.test(f) && /\.(?:test|spec)\.[^/]+$|(?:^|\/)__tests__\//.test(f) && [...read(f).matchAll(SPEC)].some((m) => matches(f, m[1])));
}

/** What the guard compares between stops: the uncommitted diff, untracked files included. */
export function digest(cwd: string): { root: string; hash: string } {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const h = createHash('sha256').update(root).update(git(root, ['diff', 'HEAD', '--no-ext-diff']));
  for (const f of git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0'))
    if (f) {
      try {
        h.update(f).update(readFileSync(join(root, f)));
      } catch {}
    }
  return { root, hash: h.digest('hex') };
}
