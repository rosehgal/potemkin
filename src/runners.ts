// Test runners: find the one that owns a file, run a selection of its tests in the sandbox,
// and read back one result per test. A run that cannot be read is null, never "all passed".
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface Runner {
  kind: 'vitest' | 'jest' | 'pytest';
  dir: string; // repo-relative directory the runner starts in ('' is the root)
  exe: string; // repo-relative bin (vitest, jest) or a python interpreter
  major: number; // vitest/jest major version, 0 if unknown
  nodeOptions?: string; // from the package's test script, e.g. --experimental-vm-modules for jest ESM
  configs: string[]; // other runner configs in that directory, which Potemkin does not run
}

export type Outcome = 'pass' | 'fail' | 'skip';
export type Results = Map<string, Outcome>; // test id -> outcome

export interface Run {
  results: Results | null; // null: no readable results (crash, timeout, missing output)
  code: number | null; // exit code, null on timeout
  timedOut: boolean;
  tail: string; // last lines of the runner's output, for diagnostics
}

/** Which tests to run: those the runner relates to these source files, these test files, or all. */
export type Selection = { related: string[] } | { files: string[] } | 'all';

const deps = (pkg: any) => ({ ...pkg?.dependencies, ...pkg?.devDependencies });
const readJson = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};
const up = (d: string) => (d === '' || d === '.' ? undefined : dirname(d) === '.' ? '' : dirname(d));

function jsRunner(root: string, file: string): Runner | string {
  let depOnly: { kind: 'vitest' | 'jest'; dir: string } | undefined;
  for (let d: string | undefined = up(file) ?? ''; d !== undefined; d = up(d)) {
    const abs = join(root, d);
    const names = existsSync(abs) ? readdirSync(abs) : [];
    const pkg = names.includes('package.json') ? readJson(join(abs, 'package.json')) : undefined;
    const has = (re: RegExp) => names.some((n) => re.test(n));
    // A config file decides. A dependency alone only counts if no folder above has a config.
    const config = has(/^vitest\.(?:config|workspace|projects)\.[cm]?[jt]s$/) ? 'vitest' : has(/^jest\.config\./) || pkg?.jest ? 'jest' : undefined;
    if (config) return make(root, config, d, names, pkg);
    if (!depOnly && pkg) {
      const kind = deps(pkg).vitest ? 'vitest' : deps(pkg).jest ? 'jest' : undefined;
      if (kind) depOnly = { kind, dir: d };
    }
  }
  if (depOnly) {
    const abs = join(root, depOnly.dir);
    return make(root, depOnly.kind, depOnly.dir, readdirSync(abs), readJson(join(abs, 'package.json')));
  }
  return 'no vitest or jest setup found (Potemkin supports vitest, jest and pytest)';
}

function make(root: string, kind: 'vitest' | 'jest', dir: string, names: string[], pkg: any): Runner | string {
  const bin = findUp(root, dir, join('node_modules', '.bin', kind));
  if (!bin) return `${kind} is set up in ${dir || 'the repo root'}, but node_modules/.bin/${kind} is missing (install dependencies first)`;
  const ver = readJson(join(root, bin, '..', '..', kind, 'package.json'))?.version ?? '';
  const script: string = pkg?.scripts?.test ?? '';
  const nodeOptions = /\bNODE_OPTIONS=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(script)?.slice(1).find(Boolean);
  const main = kind === 'vitest' ? /^vitest\.config\./ : /^jest\.config\./;
  const other = kind === 'vitest' ? /^vite(?:st)?\.[\w-]+\.config\.[cm]?[jt]s$|^vitest\.[\w-]+\.[cm]?[jt]s$/ : /^jest\.[\w-]+\.config\./;
  const configs = names.filter((n) => other.test(n) && !main.test(n) && !/^vitest\.(?:workspace|projects)\./.test(n));
  return { kind, dir, exe: bin, major: Number(ver.split('.')[0]) || 0, nodeOptions, configs };
}

function findUp(root: string, dir: string, rel: string): string | undefined {
  for (let d: string | undefined = dir; d !== undefined; d = up(d)) {
    const p = join(d, rel);
    if (existsSync(join(root, p))) return p;
  }
  return undefined;
}

/** The interpreter for a Python file: an active virtualenv, then a venv folder next to it or above. */
export function pythonFor(root: string, file = ''): string {
  const venv = process.env.VIRTUAL_ENV;
  if (venv && existsSync(join(venv, 'bin', 'python'))) return join(venv, 'bin', 'python');
  for (let d: string | undefined = up(file) ?? ''; d !== undefined; d = up(d))
    for (const v of ['.venv', 'venv', 'env']) {
      const p = join(root, d, v, 'bin', 'python');
      if (existsSync(p)) return p;
    }
  return 'python3';
}

const pytestOk = new Map<string, boolean>();
export function runnerFor(root: string, file: string): Runner | string {
  if (!file.endsWith('.py')) return jsRunner(root, file);
  const python = pythonFor(root, file);
  if (!pytestOk.has(python)) pytestOk.set(python, spawnSync(python, ['-m', 'pytest', '--version'], { stdio: 'ignore', cwd: tmpdir() }).status === 0);
  return pytestOk.get(python) ? { kind: 'pytest', dir: '', exe: python, major: 0, configs: [] } : `pytest is not installed for ${python}`;
}

// Python has no import graph to ask, so related tests are the test files that name the module.
// Missing a few is fine: before Potemkin accuses a function, it asks the whole suite.
export function relatedPyTests(file: string, files: string[], read: (f: string) => string): string[] {
  const parts = file.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/');
  const names = [...new Set([parts.at(-1)!, parts.slice(-2).join('.')])].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`^\\s*(?:import|from)\\s[^\\n]*\\b(?:${names.join('|')})\\b`, 'm');
  return files.filter((f) => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(f) && re.test(read(f)));
}

let current: ReturnType<typeof spawn> | undefined;
export const stopCurrent = () => {
  if (current?.pid) {
    try {
      process.kill(-current.pid, 'SIGKILL');
    } catch {}
  }
};

export function command(r: Runner, sandbox: string, sel: Selection, out: string): string[] {
  const abs = (fs: string[]) => fs.map((f) => join(sandbox, f));
  if (r.kind === 'vitest') {
    const pick = sel === 'all' ? ['run'] : 'related' in sel ? ['related', ...abs(sel.related), '--run'] : ['run', ...abs(sel.files)];
    // No result or module caches: they would outlive the sandbox or serve a stale transform.
    const caches = r.major >= 5 ? ['--no-cache', '--fsModuleCache=false'] : [];
    return [join(sandbox, r.exe), ...pick, '--reporter=json', `--outputFile=${out}`, '--passWithNoTests', '--coverage.enabled=false', ...caches];
  }
  if (r.kind === 'jest') {
    const pick = sel === 'all' ? [] : 'related' in sel ? ['--findRelatedTests', ...abs(sel.related)] : ['--runTestsByPath', ...abs(sel.files)];
    return [join(sandbox, r.exe), ...pick, '--json', `--outputFile=${out}`, '--passWithNoTests', '--coverage=false', '--no-watchman'];
  }
  const pick = sel === 'all' ? [] : 'related' in sel ? abs(sel.related) : abs(sel.files);
  return [r.exe, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${out}`, ...pick];
}

export async function runTests(r: Runner, sandbox: string, sel: Selection, timeoutMs: number, out: string): Promise<Run> {
  rmSync(out, { force: true });
  const [exe, ...args] = command(r, sandbox, sel, out);
  // Temp files go inside the sandbox too, so a killed runner cannot litter the real temp directory.
  const temp = join(sandbox, '.potemkin', 'tmp');
  mkdirSync(temp, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TMPDIR: temp, TMP: temp, TEMP: temp };
  delete env.FORCE_COLOR; // Node warns when both are set
  if (r.nodeOptions) env.NODE_OPTIONS = [process.env.NODE_OPTIONS, r.nodeOptions].filter(Boolean).join(' ');
  if (r.kind === 'pytest') {
    // Sandbox first, so an editable install of the original checkout cannot shadow the mutant,
    // and no bytecode cache, so a stale .pyc cannot either.
    env.PYTHONPATH = [sandbox, join(sandbox, 'src'), process.env.PYTHONPATH].filter(Boolean).join(':');
    env.PYTHONDONTWRITEBYTECODE = '1';
  }
  const tail: string[] = [];
  const keep = (d: Buffer) => {
    tail.push(d.toString());
    while (tail.join('').length > 8000) tail.shift();
  };
  const { code, timedOut } = await new Promise<{ code: number | null; timedOut: boolean }>((done) => {
    const child = spawn(exe, args, { cwd: join(sandbox, r.dir), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    current = child;
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      stopCurrent();
      done({ code: null, timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      keep(Buffer.from(e.message));
      done({ code: -1, timedOut: false });
    });
    child.on('close', (c) => {
      clearTimeout(timer);
      done({ code: c, timedOut: false });
    });
  });
  current = undefined;
  const text = tail.join('').trim();
  let results: Results | null = null;
  if (!timedOut && existsSync(out)) {
    try {
      results = r.kind === 'pytest' ? junit(readFileSync(out, 'utf8')) : jestJson(readFileSync(out, 'utf8'), sandbox);
    } catch {}
  }
  // Exited non-zero but no test failed (globalSetup threw, unhandled error, ESM loader…): unreadable.
  if (results && code !== 0 && ![...results.values()].includes('fail') && !(r.kind === 'pytest' && code === 5)) results = null;
  return { results, code, timedOut, tail: text.slice(-1500) };
}

const RANK: Record<Outcome, number> = { pass: 0, skip: 1, fail: 2 };
const set = (m: Results, id: string, o: Outcome) => {
  const prev = m.get(id);
  if (!prev || RANK[o] > RANK[prev]) m.set(id, o); // the same name twice: the worse outcome wins
};
const SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled']);

// vitest's json reporter writes jest's format.
function jestJson(text: string, sandbox: string): Results {
  const m: Results = new Map();
  for (const f of JSON.parse(text).testResults ?? []) {
    const file = relative(sandbox, f.name);
    const tests = f.assertionResults ?? [];
    // A failed file with no failed test in it: it did not load, or a beforeAll threw and skipped the rest.
    const setup = f.status === 'failed' && !tests.some((a: any) => a.status === 'failed');
    for (const a of tests) {
      const o: Outcome = a.status === 'passed' ? 'pass' : SKIPPED.has(a.status) ? (setup ? 'fail' : 'skip') : 'fail';
      set(m, `${file} › ${a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' ')}`, o);
    }
    if (setup) set(m, `${file} › (the file failed to load or set up)`, 'fail');
  }
  return m;
}

const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function junit(xml: string): Results {
  const m: Results = new Map();
  for (const t of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k: string) => unxml(new RegExp(`\\b${k}="([^"]*)"`).exec(t[1])?.[1] ?? '');
    const body = t[2] ?? '';
    set(m, `${attr('classname')} › ${attr('name')}`, /<(?:failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass');
  }
  return m;
}

/** The repo-relative test file a result id belongs to (vitest and jest ids start with it). */
export const testFile = (id: string) => id.split(' › ')[0];
