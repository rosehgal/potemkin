// The check: which functions did the diff touch, and does any related test turn red when one is gutted?
// Everything runs in a throwaway copy of the repo. The working tree is only ever read.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canary, JS_FILE, jsFunctions, jsMutant, NOT_SOURCE, PY_FILE, pyFunctions, pyMutant, type Fn, type Mutant } from './functions.ts';
import { pythonFor, relatedPyTests, runnerFor, runTests, stopCurrent, type Results } from './runners.ts';

export type Verdict = 'NOTICED' | 'HOLLOW' | 'UNTESTED' | 'UNVERIFIABLE';

export interface Checked {
  file: string;
  name: string;
  line: number;
  verdict: Verdict;
  tests: string[]; // NOTICED: tests that failed with it gutted. HOLLOW: tests that call it and passed anyway.
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
  base: string;
  note?: string;
  functions: Checked[];
  skipped: Skipped[];
  runners: string[];
  runs: number;
  tests: number; // distinct related tests that passed before any change
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

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const isCommit = (root: string, ref: string) => {
  try {
    git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

type Lines = Set<number> | 'all';

/** Changed lines per file, on the working-tree side of `git diff <base>`, plus untracked files. */
function changes(root: string, base: string): Map<string, Lines> {
  const m = new Map<string, Lines>();
  let file: string | undefined;
  let prev = '';
  for (const line of git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=d', base, '--']).split('\n')) {
    if (line.startsWith('+++ ') && prev.startsWith('--- ')) {
      const p = line.slice(4);
      file = p === '/dev/null' ? undefined : (p.startsWith('"') ? JSON.parse(p) : p).replace(/^b\//, '');
      if (file) m.set(file, new Set());
    } else if (file) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      const set = m.get(file) as Set<number>;
      if (h) {
        const start = Number(h[1]);
        const n = h[2] === undefined ? 1 : Number(h[2]);
        if (n === 0) set.add(Math.max(1, start)); // pure deletion: blame the line above the gap
        for (let i = 0; i < n; i++) set.add(start + i);
      }
    }
    prev = line;
  }
  for (const f of git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0')) if (f) m.set(f, 'all');
  return m;
}

const isSource = (f: string) => (JS_FILE.test(f) || PY_FILE.test(f)) && !NOT_SOURCE.test(f);

/** A JS test file whose imports name this file, if any. */
function importedBy(file: string, files: string[], read: (f: string) => string): string | undefined {
  const name = basename(file).replace(JS_FILE, '');
  const stem = name === 'index' ? basename(dirname(file)) : name;
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*)['"][^'"]*\\b${esc}(?:/index)?(?:\\.[cm]?[jt]sx?)?['"]`);
  return files.find((f) => JS_FILE.test(f) && /\.(?:test|spec)\.[^/]+$|(?:^|\/)__tests__\//.test(f) && re.test(read(f)));
}

/** The innermost named function around each changed line. */
function touched(root: string, files: Map<string, Lines>, python: string, skipped: Skipped[]): Fn[] {
  const out: Fn[] = [];
  for (const [file, lines] of files) {
    const abs = join(root, file);
    if (!isSource(file) || !existsSync(abs)) continue;
    let all: Fn[];
    try {
      all = PY_FILE.test(file) ? pyFunctions(python, file, abs) : jsFunctions(file, readFileSync(abs, 'utf8'));
    } catch (e) {
      skipped.push({ file, name: '(whole file)', line: 1, why: `could not parse it: ${(e as Error).message.split('\n')[0]}` });
      continue;
    }
    if (lines === 'all') {
      out.push(...all);
      continue;
    }
    const hit = new Set<Fn>();
    for (const n of lines) {
      let best: Fn | undefined;
      for (const f of all) if (f.line <= n && n <= f.end && (!best || f.end - f.line < best.end - best.line)) best = f;
      if (best) hit.add(best);
    }
    out.push(...all.filter((f) => hit.has(f)));
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---- sandbox ---------------------------------------------------------------

interface Sandbox {
  dir: string;
  links: string[];
  files: string[];
}

let active: Sandbox | undefined;

function makeSandbox(root: string): Sandbox {
  // realpath: on macOS tmpdir() is a symlink, and runners match related files by their real path.
  const sb: Sandbox = { dir: realpathSync(mkdtempSync(join(tmpdir(), 'potemkin-'))), links: [], files: [] };
  active = sb;
  const dirs = new Set(['']);
  for (const f of git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0')) {
    if (!f) continue;
    const src = join(root, f);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue; // deleted in the working tree
    }
    mkdirSync(join(sb.dir, dirname(f)), { recursive: true });
    cpSync(src, join(sb.dir, f), { recursive: st.isDirectory(), verbatimSymlinks: true });
    sb.files.push(f);
    for (let d = dirname(f); d !== '.' && !dirs.has(d); d = dirname(d)) dirs.add(d);
  }
  // Installed dependencies and local env files are ignored by git, so link them in.
  const link = (from: string, to: string) => {
    if (!existsSync(from) || existsSync(to)) return;
    symlinkSync(from, to);
    sb.links.push(to);
  };
  for (const d of dirs) for (const name of ['node_modules', '.venv', 'venv']) link(join(root, d, name), join(sb.dir, d, name));
  for (const name of readdirSync(root)) if (/^\.env(?:\..+)?$/.test(name)) link(join(root, name), join(sb.dir, name));
  mkdirSync(join(sb.dir, '.potemkin'));
  return sb;
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
  rmSync(sb.dir, { recursive: true, force: true });
}

// ---- the check ---------------------------------------------------------------

export async function check(opt: Options): Promise<Report> {
  const t0 = Date.now();
  const log = opt.log ?? (() => {});
  const root = git(opt.cwd, ['rev-parse', '--show-toplevel']).trim();
  let base = opt.base ?? 'HEAD';
  let note: string | undefined;
  if (opt.base && !isCommit(root, opt.base)) throw new Error(`--base ${opt.base} is not a commit in this repo`);
  if (!opt.base && !isCommit(root, 'HEAD')) {
    base = git(root, ['hash-object', '-t', 'tree', '--stdin']).trim(); // the empty tree: every file is new
    note = 'no commits yet, so every file counts as changed';
  }
  let files = new Map([...changes(root, base)].filter(([f]) => isSource(f)));
  if (!files.size && !opt.base && !opt.noFallback && base === 'HEAD' && isCommit(root, 'HEAD~1')) {
    base = 'HEAD~1';
    note = 'nothing uncommitted, so checking the last commit';
    files = new Map([...changes(root, base)].filter(([f]) => isSource(f)));
  }

  const report: Report = { root, base, note, functions: [], skipped: [], runners: [], runs: 0, tests: 0, ms: 0 };
  const python = pythonFor(root);
  const fns = touched(root, files, python, report.skipped);
  for (const f of fns.splice(opt.max)) report.skipped.push({ file: f.file, name: f.name, line: f.line, why: `over --max ${opt.max}` });
  if (!fns.length) return { ...report, ms: Date.now() - t0 };

  log(`Copying ${root} to a sandbox…`);
  const sb = makeSandbox(root);
  const seen = new Set<string>();
  try {
    const byFile = Map.groupBy(fns, (f) => f.file);
    for (const [file, list] of byFile) {
      const add = (fn: Fn, verdict: Verdict, tests: string[], why: string) =>
        report.functions.push({ file, name: fn.name, line: fn.line, verdict, tests, why });
      const late = () => opt.deadline !== undefined && Date.now() > opt.deadline;
      if (late()) {
        for (const fn of list) report.skipped.push({ file, name: fn.name, line: fn.line, why: 'out of time' });
        continue;
      }
      const runner = runnerFor(root, file);
      if (typeof runner === 'string') {
        for (const fn of list) add(fn, 'UNVERIFIABLE', [], runner);
        continue;
      }
      if (!report.runners.includes(runner.kind)) report.runners.push(runner.kind);
      const targets = runner.kind === 'pytest' ? relatedPyTests(file, sb.files, (f) => readFileSync(join(sb.dir, f), 'utf8')) : [file];
      const out = join(sb.dir, '.potemkin', runner.kind === 'pytest' ? 'results.xml' : 'results.json');
      const abs = join(sb.dir, file);
      const original = readFileSync(abs, 'utf8');
      const run = async (src?: string): Promise<Results | null> => {
        report.runs++;
        if (src === undefined) return runTests(runner, sb.dir, targets, opt.timeoutMs, out);
        writeFileSync(abs, src);
        try {
          return await runTests(runner, sb.dir, targets, opt.timeoutMs, out);
        } finally {
          writeFileSync(abs, original);
        }
      };

      log(`${file}: ${list.length} function${list.length === 1 ? '' : 's'} · running its related tests (${runner.kind})`);
      const baseline = await run();
      if (!baseline) {
        for (const fn of list) add(fn, 'UNVERIFIABLE', [], 'its related tests crashed or timed out before Potemkin changed anything');
        continue;
      }
      if (!baseline.size) {
        // Cross-check the runner's import graph before calling a whole file untested.
        const importer = runner.kind === 'pytest' ? undefined : importedBy(file, sb.files, (f) => readFileSync(join(sb.dir, f), 'utf8'));
        for (const fn of list)
          if (importer) add(fn, 'UNVERIFIABLE', [], `${runner.kind} found no related tests, yet ${importer} imports this file`);
          else add(fn, 'UNTESTED', [], 'no test imports this file');
        continue;
      }
      const passing = [...baseline].filter(([, ok]) => ok).map(([id]) => id);
      if (!passing.length) {
        for (const fn of list) add(fn, 'UNVERIFIABLE', [], 'every related test already fails');
        continue;
      }
      for (const id of passing) seen.add(id);
      // Tests that fail before any change (no database, say) cannot notice anything. Say so.
      const failing = baseline.size - passing.length;
      const broken = failing ? ` (${plural(failing, 'related test')} already ${failing === 1 ? 'fails' : 'fail'}, so ${failing === 1 ? 'it was' : 'they were'} left out)` : '';
      const red = (r: Results | null) => (r ? passing.filter((id) => r.get(id) !== true) : null); // missing counts as red
      const mutant = (fn: Fn, kind: Mutant) => (fn.lang === 'py' ? pyMutant(python, abs, fn, kind) : jsMutant(original, fn, kind));
      const start = report.functions.length;

      for (const fn of list) {
        if (late()) {
          report.skipped.push({ file, name: fn.name, line: fn.line, why: 'out of time' });
          continue;
        }
        let empty: string, thrown: string;
        try {
          empty = mutant(fn, 'empty');
          thrown = mutant(fn, 'throw');
        } catch (e) {
          add(fn, 'UNVERIFIABLE', [], `could not write a mutant: ${(e as Error).message}`);
          continue;
        }
        const gutted = red(await run(empty));
        if (gutted === null || gutted.length) {
          add(fn, 'NOTICED', gutted ?? [], gutted ? `${plural(gutted.length, 'test')} failed with it gutted` : 'the test run crashed or timed out with it gutted');
        } else {
          const calls = red(await run(thrown));
          if (calls === null) add(fn, 'HOLLOW', [], `every test passed with it gutted; the run where it threw crashed, so which tests call it is unknown${broken}`);
          else if (calls.length) add(fn, 'HOLLOW', calls, `${plural(calls.length, 'test')} call it, and all passed with it gutted${broken}`);
          else add(fn, 'UNTESTED', [], broken ? `no passing related test calls it${broken}` : 'no related test calls it');
        }
        const c = report.functions.at(-1)!;
        log(`  ${c.verdict.padEnd(9)} ${fn.name}`);
      }

      // UNTESTED only means something if the tests really load the sandbox copy.
      const mine = report.functions.slice(start);
      const loaded = mine.some((c) => c.verdict === 'NOTICED' || (c.verdict === 'HOLLOW' && c.tests.length));
      if (!loaded && mine.some((c) => c.verdict !== 'UNVERIFIABLE')) {
        const r = red(await run(canary(file, original)));
        if (!r?.length)
          for (const c of mine)
            if (c.verdict !== 'UNVERIFIABLE')
              Object.assign(c, {
                verdict: 'UNVERIFIABLE',
                tests: [],
                why: 'its tests do not load the sandbox copy of this file (a workspace link or an editable install?), so Potemkin cannot see them react',
              });
      }
    }
  } finally {
    abort();
  }
  return { ...report, tests: seen.size, ms: Date.now() - t0 };
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
