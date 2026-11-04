// The check: which functions did the diff change, and does any test turn red when one is gutted?
// Everything runs in a throwaway copy of the repo. The working tree is only ever read.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
  configs: string[]; // other test configs and suites Potemkin did not run
  runs: number;
  tests: number; // distinct tests that passed before any change
  excluded: number; // tests that already fail on the current code, left out
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
const EMPTY_TREE = (root: string) => git(root, ['hash-object', '-t', 'tree', '--stdin'], '').trim();

/** Changed files since `base`: working-tree path -> path in `base` (null if new), plus the paths deleted since. */
function changedFiles(root: string, base: string): { files: Map<string, string | null>; deleted: string[] } {
  const files = new Map<string, string | null>();
  const deleted: string[] = [];
  // diff-index: plumbing, so it never rewrites the index. Stat-only changes may show up; fingerprints sort those out.
  const parts = git(root, ['diff-index', '--name-status', '-z', '-M', base, '--']).split('\0');
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = parts[i++];
      files.set(parts[i++], status.startsWith('R') ? from : null);
    } else {
      const path = parts[i++];
      if (status === 'D') deleted.push(path);
      else files.set(path, status === 'A' ? null : path);
    }
  }
  for (const f of git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0')) if (f) files.set(f, null);
  return { files, deleted };
}

const baseName = (name: string) => name.replace(/#\d+$/, '');
const leaf = (name: string) => baseName(name).split('.').at(-1)!;

/**
 * Functions whose code changed since `base`: new ones, and ones whose structure differs from the
 * same-named function in `base`. A function that only moved (another file, another position, a renamed
 * class) keeps its fingerprint, so it does not count. Neither do comments, formatting or docstrings.
 */
function changedFunctions(root: string, base: string, diff: { files: Map<string, string | null>; deleted: string[] }, skipped: Skipped[]): Fn[] {
  const out: Fn[] = [];
  const list = (file: string, name: string, text: string, path?: string) =>
    PY_FILE.test(name) ? pyFunctions(pythonFor(root, file), file, path ?? '-', path ? undefined : text) : jsFunctions(name, text);
  const atBase = (file: string, path: string): Fn[] => {
    try {
      return list(file, path, git(root, ['show', `${base}:${path}`]));
    } catch {
      return []; // unreadable or unparseable before: every function counts as changed
    }
  };
  let gone: Fn[] | undefined; // functions of deleted files, for moves: parsed once, on demand
  const fromDeleted = () => (gone ??= diff.deleted.filter(isSource).flatMap((p) => atBase(p, p)));
  for (const [file, old] of diff.files) {
    if (!isSource(file)) continue;
    const abs = join(root, file);
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) continue;
    let now: Fn[];
    try {
      now = list(file, file, readFileSync(abs, 'utf8'), abs);
    } catch (e) {
      skipped.push({ file, name: '(whole file)', line: 1, why: `could not parse it: ${(e as Error).message.split('\n')[0]}` });
      continue;
    }
    const before = old === null ? [] : atBase(file, old);
    const free = new Set([...before, ...fromDeleted()]);
    const take = (pred: (f: Fn) => boolean) => {
      for (const f of free)
        if (pred(f)) {
          free.delete(f);
          return f;
        }
      return undefined;
    };
    for (const f of now) {
      const same = take((b) => b.file === file && baseName(b.name) === baseName(f.name) && b.fp === f.fp); // unchanged, maybe reordered
      if (same) continue;
      const moved = take((b) => leaf(b.name) === leaf(f.name) && b.fp === f.fp); // another file, a renamed class
      if (moved) continue;
      if (f.inert) {
        // Gutted by the diff itself: a real change. New and empty, or empty before too: nothing to test.
        const was = before.filter((b) => baseName(b.name) === baseName(f.name));
        if (!was.length || was.every((b) => b.inert)) continue;
      }
      out.push(f);
    }
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
  base: string; // the temp directory: everything of Potemkin's lives under it
  dir: string; // the copy of the repo, base/repo
  work: string; // results, markers, runner caches and temp files, base/work: never inside the copy
  links: Set<string>; // symlinks Potemkin made; removed before the directory is, never followed
  copied: Map<string, { size: number; mtimeMs: number }>; // repo files in the sandbox, as copied
  dirs: Set<string>;
  files: string[];
}

let active: Sandbox | undefined;
const CACHES = new Set(['.vite', '.vite-temp', '.vitest', '.vitest-cache', '.cache', '.jest-cache']);

const stamp = (p: string) => {
  const s = lstatSync(p);
  return { size: s.size, mtimeMs: s.mtimeMs };
};

/** True when `p` (which must exist) is reached without crossing a symlink, and sits under the copy. */
const plain = (sb: Sandbox, p: string) => {
  try {
    return realpathSync(p) === p && inside(p, sb.dir);
  } catch {
    return false;
  }
};

function makeSandbox(root: string): Sandbox {
  // realpath: on macOS tmpdir() is a symlink, and runners match related files by their real path.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'potemkin-')));
  const sb: Sandbox = { root, base, dir: join(base, 'repo'), work: join(base, 'work'), links: new Set(), copied: new Map(), dirs: new Set(['']), files: [] };
  active = sb; // set first, so abort() cleans up a half-built sandbox too
  mkdirSync(sb.dir);
  mkdirSync(sb.work);
  for (const entry of git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0')) {
    const f = entry.replace(/\/$/, ''); // a nested repo is listed with a trailing slash
    if (!f || f.split('/').includes('node_modules')) continue; // dependencies are linked below
    const src = join(root, f);
    const dst = join(sb.dir, f);
    try {
      const st = lstatSync(src);
      mkdirSync(dirname(dst), { recursive: true });
      // Never write through a symlink: an entry under a directory that is now a link (a dev-linked
      // package) would land outside the copy, and so would its restore.
      if (!plain(sb, dirname(dst))) continue;
      if (st.isSymbolicLink()) {
        if (!copyLink(sb, src, dst)) continue;
      } else if (st.isDirectory()) cpSync(src, dst, { recursive: true, verbatimSymlinks: true }); // a submodule
      else copyFileSync(src, dst);
    } catch {
      continue; // deleted in the working tree, or unreadable: the tests will not see it either way
    }
    if (sb.links.has(dst)) continue;
    sb.files.push(f);
    sb.copied.set(f, stamp(dst));
    for (let d = dirname(f); d !== '.' && !sb.dirs.has(d); d = dirname(d)) sb.dirs.add(d);
  }
  for (const d of [...sb.dirs]) {
    const nm = join(root, d, 'node_modules');
    if (existsSync(nm) && statSync(nm).isDirectory() && !existsSync(join(sb.dir, d, 'node_modules'))) linkModules(sb, nm, join(sb.dir, d, 'node_modules'));
    for (const v of ['.venv', 'venv', 'env']) {
      const p = join(root, d, v);
      if (existsSync(join(p, 'pyvenv.cfg')) && !existsSync(join(sb.dir, d, v))) link(sb, p, join(sb.dir, d, v));
    }
  }
  // Local env files are ignored by git. Copy them: a test that rewrites .env must not reach the real one.
  for (const name of readdirSync(root))
    if (/^\.env(?:\..+)?$/.test(name) && !sb.copied.has(name) && !existsSync(join(sb.dir, name))) {
      try {
        if (statSync(join(root, name)).isFile()) {
          copyFileSync(join(root, name), join(sb.dir, name));
          sb.copied.set(name, stamp(join(sb.dir, name)));
        }
      } catch {}
    }
  return sb;
}

// A symlink in the repo: inside the repo it points at the copy; a file outside is copied, so a test
// that rewrites it cannot reach the original; a directory outside stays a link that is never followed.
function copyLink(sb: Sandbox, src: string, dst: string): boolean {
  const target = readlinkSync(src);
  let real: string | undefined;
  try {
    real = realpathSync(resolve(dirname(src), target));
  } catch {}
  if (real === undefined) {
    symlinkSync(target, dst); // dangling: harmless either way
    return true;
  }
  if (inside(real, sb.root)) {
    link(sb, join(sb.dir, relative(sb.root, real)), dst);
    return false;
  }
  if (statSync(real).isFile()) {
    copyFileSync(real, dst);
    return true;
  }
  link(sb, real, dst);
  return false;
}

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
          // Only when the package resolves there: a build output ignored by git stays in the original.
          if (existsSync(mirror) && entryExists(mirror, real)) target = mirror;
        }
      } catch {}
    }
    link(sb, target, join(to, name));
  }
}

function entryExists(mirror: string, real: string): boolean {
  const pkg = JSON.parse(readFileSync(join(mirror, 'package.json'), 'utf8').toString() || '{}');
  const first = (x: any): string | undefined => (typeof x === 'string' ? x : x && typeof x === 'object' ? Object.values(x).map(first).find(Boolean) : undefined);
  const entry = first(pkg.exports) ?? pkg.main ?? pkg.module ?? 'index.js';
  return existsSync(join(mirror, entry)) || !existsSync(join(real, entry));
}

function rmHard(p: string) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    chmodTree(p); // a read-only directory a test or a nested repo left behind
    rmSync(p, { recursive: true, force: true });
  }
}

/** Undoes whatever a test run left in the copy: new files go, changed repo files come back. */
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
      const abs = join(sb.dir, r);
      if (name === 'node_modules' && sb.dirs.has(rel)) continue; // ours
      if (sb.links.has(abs) || sb.copied.has(r)) continue;
      const st = lstatSync(abs);
      if (st.isDirectory() && sb.dirs.has(r)) walk(r);
      else rmHard(abs); // a symlink is removed as a link; nothing behind it is touched
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
    mkdirSync(dirname(abs), { recursive: true });
    if (!plain(sb, dirname(abs))) throw new Error(`cannot restore ${f} in the sandbox: its directory is a symlink now`);
    rmHard(abs);
    const src = join(sb.root, f);
    const st = lstatSync(src);
    if (st.isSymbolicLink()) copyLink(sb, src, abs);
    else if (st.isDirectory()) cpSync(src, abs, { recursive: true, verbatimSymlinks: true });
    else copyFileSync(src, abs);
    sb.copied.set(f, stamp(abs));
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
    rmHard(sb.base);
  } catch {}
}

function chmodTree(dir: string) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) chmodTree(join(dir, name));
}

// ---- the check ---------------------------------------------------------------

type Baseline = { pass: Set<string>; fail: Set<string>; skip: Set<string>; messages: Map<string, string> } | { error: string };

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
    if (!isCommit(root, opt.base)) throw new UsageError(`--base ${opt.base} is not a commit in this repo (in a shallow clone, fetch it first: in GitHub Actions use actions/checkout with fetch-depth: 0)`);
    label = opt.base;
    base = opt.base;
    // Like a pull request: what changed since the branch left REF, not what REF gained since.
    if (hasHead) {
      let mb = '';
      try {
        mb = git(root, ['merge-base', opt.base, 'HEAD']).trim();
      } catch {}
      if (!mb) throw new UsageError(`cannot find where this branch left ${opt.base}: the clone is too shallow (in GitHub Actions use actions/checkout with fetch-depth: 0)`);
      base = mb;
    }
  } else if (!hasHead) {
    base = EMPTY_TREE(root);
    label = 'the empty tree';
    note = 'no commits yet, so every file counts as new';
  }

  const report: Report = { root, base, label, note, functions: [], skipped: [], runners: [], configs: [], runs: 0, tests: 0, excluded: 0, ms: 0 };
  let fns = changedFunctions(root, base, changedFiles(root, base), report.skipped);
  if (!fns.length && !report.skipped.length && opt.base === undefined && hasHead && !opt.noFallback) {
    if (isCommit(root, 'HEAD^2')) report.note = 'no uncommitted code changes, and the last commit is a merge: pass --base to choose what to check';
    else {
      const parent = isCommit(root, 'HEAD~1');
      report.base = base = parent ? 'HEAD~1' : EMPTY_TREE(root);
      report.label = label = parent ? 'HEAD~1' : 'the empty tree';
      report.note = `no uncommitted code changes, so checking the functions changed in the ${parent ? 'last' : 'first'} commit`;
      fns = changedFunctions(root, base, changedFiles(root, base), report.skipped);
    }
  }
  const [chosen, rest] = pick(fns, opt.max);
  for (const f of rest) report.skipped.push({ file: f.file, name: f.name, line: f.line, why: `over --max ${opt.max}` });
  if (!chosen.length) return { ...report, ms: Date.now() - t0 };

  // Runners first: a setup problem should not cost a copy of the repo.
  const runners = new Map<string, Runner | string>();
  for (const f of chosen) if (!runners.has(f.file)) runners.set(f.file, runnerFor(root, f.file));
  const setup = [...runners.values()].filter((r): r is string => typeof r === 'string');
  if (setup.length === runners.size) throw new SetupError(setup[0]);

  log(`Copying ${basename(root)} to a sandbox…`);
  const seen = new Set<string>();
  const left = new Set<string>();
  const full = new Map<string, Promise<Baseline>>(); // whole-suite baseline, once per runner
  let done = 0;
  try {
    const sb = makeSandbox(root);
    const marker = join(sb.work, 'called');
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
      if (!sb.copied.has(file)) {
        for (const fn of list) add(fn, 'UNVERIFIABLE', [], 'Potemkin could not copy this file into its sandbox (a symlink, or under a linked directory)');
        continue;
      }

      const abs = join(sb.dir, file);
      const original = readFileSync(abs, 'utf8');
      const write = (text: string) => {
        // The only write to repo content, and only ever to a real file inside the sandbox.
        if (lstatSync(abs).isSymbolicLink() || !plain(sb, dirname(abs))) throw new Error(`refusing to write outside the sandbox: ${file}`);
        writeFileSync(abs, text);
      };
      const run = async (sel: Selection, mutant?: string): Promise<Run> => {
        report.runs++;
        if (mutant !== undefined) write(mutant);
        try {
          return await runTests(runner, sb.dir, sb.work, sel, opt.timeoutMs);
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
        if (!a.results) return { error: explain(runner, a, opt.timeoutMs, sel) };
        const r = new Map(a.results);
        if ([...r.values()].includes('fail')) {
          const b = await run(sel); // flaky or order-dependent: a pass in either run counts
          for (const [id, o] of b.results ?? []) if (o === 'pass' && r.get(id) === 'fail') r.set(id, 'pass');
        }
        const of = (o: string) => new Set([...r].filter(([, x]) => x === o).map(([id]) => id));
        const out = { pass: of('pass'), fail: of('fail'), skip: of('skip'), messages: a.messages };
        for (const id of out.pass) seen.add(id);
        for (const id of out.fail) left.add(id);
        return out;
      };
      const red = (r: Run, pass: Set<string>) => (r.results ? [...pass].filter((id) => r.results!.get(id) !== 'pass') : null); // missing counts as red
      const mutant = (fn: Fn, kind: Mutant, mark?: string) => (fn.lang === 'py' ? pyMutant(pythonFor(root, file), abs, fn, kind, mark) : jsMutant(original, fn, kind, mark));
      // A crash or timeout once could be the mutant, or bad luck: ask again before calling it noticed.
      const gutted = async (sel: Selection, src: string, pass: Set<string>) => {
        let r = red(await run(sel, src), pass);
        if (r === null) r = red(await run(sel, src), pass);
        return r;
      };

      // Phase A: the tests the runner relates to this file. Most functions end here, NOTICED.
      const related = runner.kind === 'pytest' ? relatedPyTests(file, sb.files, (f) => readFileSync(join(sb.dir, f), 'utf8')) : [];
      const relSel: Selection = runner.kind === 'pytest' ? (related.length ? { files: related } : 'all') : { related: [file] };
      log(`${file}: ${plural(list.length, 'function')} · ${runner.kind}, related tests first`);
      const key = `${runner.kind}:${runner.dir}`;
      const rp = relSel === 'all' ? (full.get(key) ?? full.set(key, baseline('all')).get(key)!) : baseline(relSel);
      const rb = await rp;
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
        const gone = await gutted(relSel, mutants.get(fn)!('empty'), rb.pass);
        if (gone === null || gone.length) add(fn, 'NOTICED', gone ?? [], gone ? `${plural(gone.length, 'test')} failed with it gutted` : 'the test run crashed or timed out with it gutted, twice');
        else candidates.push(fn);
      }
      if (!candidates.length) continue;

      // Phase B: before accusing anything, ask the whole suite which tests load this file at all.
      // That catches dynamic imports, subprocess tests, fixtures, other packages of a monorepo.
      if (!full.has(key)) full.set(key, baseline('all'));
      const fb = await full.get(key)!;
      if ('error' in fb) {
        for (const fn of candidates) add(fn, 'UNVERIFIABLE', [], `no related test noticed it gutted, but the whole suite could not run to confirm: ${fb.error}`);
        continue;
      }
      rmSync(marker, { force: true });
      const loadRun = await run('all', canary(file, original, marker));
      const loadedQuietly = existsSync(marker); // loaded, but every error was caught by a fallback
      let loaders = red(loadRun, fb.pass);
      // Tests that already fail might check this function: the ones whose failure now mentions the canary load it.
      const brokenLoaders = loadRun.results ? [...fb.fail].filter((id) => /potemkin canary/.test(loadRun.messages.get(id) ?? '')) : [...fb.fail];
      const brokenRelated = relSel === 'all' ? [] : [...rb.fail]; // runner-related failures; a name grep is not evidence
      const broken = [...new Set([...brokenRelated, ...brokenLoaders])];
      const brokenNote = broken.length
        ? `${plural(broken.length, 'test')} that might check it already ${broken.length === 1 ? 'fails' : 'fail'} on the current code, before Potemkin changed anything (${broken[0]})`
        : '';
      if (loaders === null && runner.kind === 'pytest' && !loadedQuietly) loaders = [...fb.pass]; // a conftest imports it: pytest aborts at collection, so every test counts as a loader
      if (loaders === null) {
        for (const fn of candidates) add(fn, 'UNVERIFIABLE', [], 'the whole suite crashed when this file threw on import, so Potemkin cannot tell which tests load it');
        continue;
      }
      if (!loaders.length && !loadedQuietly) {
        const importers = importedBy(file, sb.files, (f) => readFileSync(join(sb.dir, f), 'utf8'));
        const failing = new Set([...rb.fail, ...fb.fail].map(testFile));
        const skipping = new Set([...rb.skip, ...fb.skip].map(testFile));
        const live = importers.filter((f) => !failing.has(f) && !skipping.has(f));
        for (const fn of candidates)
          if (live.length) add(fn, 'UNVERIFIABLE', [], `${live[0]} imports this file, yet no test loaded the sandbox copy (a workspace link or an editable install?)`);
          else if (importers.some((f) => failing.has(f))) add(fn, 'UNVERIFIABLE', [], `the tests that import this file (${importers.find((f) => failing.has(f))}) already fail on the current code, before Potemkin changed anything`);
          else if (importers.length) add(fn, 'UNVERIFIABLE', [], `every test in ${importers[0]}, which imports this file, is skipped`);
          else if (brokenNote) add(fn, 'UNVERIFIABLE', [], `no passing test loads this file, and ${brokenNote}`);
          else add(fn, 'UNTESTED', [], 'no test in the suite loads this file');
        continue;
      }
      const files = [...new Set(loaders.map(testFile))].filter(Boolean);
      const whole = loadedQuietly || !files.length;
      const sel: Selection = whole ? 'all' : { files };
      const pass = whole ? fb.pass : new Set([...fb.pass].filter((id) => files.includes(testFile(id))));
      for (const fn of candidates) {
        if (late()) {
          report.skipped.push({ file, name: fn.name, line: fn.line, why: 'out of time' });
          continue;
        }
        const make = mutants.get(fn)!;
        const gone = await gutted(sel, make('empty'), pass);
        if (gone === null || gone.length) {
          const extra = gone?.filter((id) => !rb.pass.has(id)) ?? [];
          add(fn, 'NOTICED', gone ?? [], gone ? `${plural(gone.length, 'test')} failed with it gutted${extra.length === gone.length ? ' (found by asking the whole suite)' : ''}` : 'the test run crashed or timed out with it gutted, twice');
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
        const one = threw.length === 1;
        if (brokenNote && !threw.length && !called) add(fn, 'UNVERIFIABLE', [], `no passing test calls it, and ${brokenNote}`);
        else if (brokenNote) add(fn, 'UNVERIFIABLE', [], `every passing test stayed green with it gutted, but ${brokenNote}`);
        else if (threw.length) add(fn, 'HOLLOW', threw, `${plural(threw.length, 'test fails', 'tests fail')} when it throws, yet ${one ? 'passes' : 'all pass'} with it gutted`);
        else if (called) add(fn, 'HOLLOW', [], 'tests run it (and catch its errors), yet all pass with it gutted');
        else add(fn, 'UNTESTED', [], 'no test that loads its file calls it');
      }
    }
  } finally {
    abort();
  }
  return { ...report, tests: seen.size, excluded: [...left].filter((id) => !seen.has(id)).length, ms: Date.now() - t0 };
}

function explain(r: Runner, run: Run, timeoutMs: number, sel: Selection): string {
  if (run.timedOut) return `${r.kind} timed out after ${Math.round(timeoutMs / 1000)}s (try a larger --timeout)`;
  const lines = run.tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const why = lines.find((l) => /error|cannot|not found|failed|missing|ERR_|exception/i.test(l) && !/^at\s|JSON report written/i.test(l)) ?? lines.at(-1) ?? 'no output';
  const files = sel === 'all' ? '' : 'related' in sel ? sel.related.join(' ') : sel.files.join(' ');
  const repro =
    r.kind === 'vitest'
      ? sel === 'all' || 'files' in sel
        ? `npx vitest run ${files}`.trim()
        : `npx vitest related ${files} --run`
      : r.kind === 'jest'
        ? sel === 'all' || 'files' in sel
          ? `npx jest ${files}`.trim()
          : `npx jest --findRelatedTests ${files}`
        : `${r.exe} -m pytest ${files}`.trim();
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
  return files.filter((f) => {
    if (!JS_FILE.test(f) || !/\.(?:test|spec)\.[^/]+$|(?:^|\/)__tests__\//.test(f)) return false;
    const text = read(f);
    const specs = [...text.matchAll(SPEC)].map((m) => m[1]).filter((spec) => matches(f, spec));
    // Mocked with a factory: the test never loads the real file.
    return specs.some((spec) => !new RegExp(`\\b(?:vi|jest)\\.mock\\(\\s*['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*,`).test(text));
  });
}

/** What the guard compares between stops: the uncommitted diff, untracked files included. */
export function digest(cwd: string): { memo: string; hash: string } {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const gitDir = resolve(root, git(root, ['rev-parse', '--git-dir']).trim());
  const h = createHash('sha256').update(root).update(git(root, ['diff-index', '-p', '--no-ext-diff', 'HEAD', '--']));
  for (const f of git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0'))
    if (f) {
      try {
        h.update(f).update(readFileSync(join(root, f)));
      } catch {}
    }
  return { memo: join(gitDir, 'potemkin-guard'), hash: h.digest('hex') };
}
