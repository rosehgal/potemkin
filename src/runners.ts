// Test runners: find the one that owns a file, run its related tests in the sandbox,
// and read back one pass/fail per test. Unreadable output is null, never "all passed".
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface Runner {
  kind: 'vitest' | 'jest' | 'pytest';
  dir: string; // repo-relative directory the runner starts in ('' is the root)
  exe: string; // repo-relative bin (vitest, jest) or a python interpreter
}

export type Results = Map<string, boolean>; // test id -> passed

const deps = (pkg: any) => ({ ...pkg?.dependencies, ...pkg?.devDependencies });
const readJson = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

function jsRunner(root: string, file: string): Runner | string {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const d = dir === '.' ? '' : dir;
    const abs = join(root, d);
    const names = existsSync(abs) ? readdirSync(abs) : [];
    const pkg = names.includes('package.json') ? readJson(join(abs, 'package.json')) : undefined;
    const has = (re: RegExp) => names.some((n) => re.test(n));
    const vitest = has(/^vitest\.(?:config|workspace|projects)\.[cm]?[jt]s$/) || (!!deps(pkg).vitest && !has(/^jest\.config\./));
    const jest = has(/^jest\.config\./) || !!pkg?.jest || !!deps(pkg).jest;
    const kind = vitest ? 'vitest' : jest ? 'jest' : undefined;
    if (kind) {
      const bin = findBin(root, d, kind);
      return bin ? { kind, dir: d, exe: bin } : `${kind} is set up in ${d || 'the repo root'}, but node_modules/.bin/${kind} is missing (install dependencies first)`;
    }
    if (!d) return 'no vitest or jest setup found (Potemkin supports vitest, jest and pytest)';
  }
}

function findBin(root: string, dir: string, kind: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    const rel = join(d === '.' ? '' : d, 'node_modules', '.bin', kind);
    if (existsSync(join(root, rel))) return rel;
    if (d === '' || d === '.') return undefined;
  }
}

const pytestOk = new Map<string, boolean>();
export function pythonFor(root: string): string {
  for (const v of ['.venv', 'venv', 'env']) {
    const p = join(root, v, 'bin', 'python');
    if (existsSync(p)) return p;
  }
  return 'python3';
}

export function runnerFor(root: string, file: string): Runner | string {
  if (!file.endsWith('.py')) return jsRunner(root, file);
  const python = pythonFor(root);
  if (!pytestOk.has(python)) pytestOk.set(python, spawnSync(python, ['-m', 'pytest', '--version'], { stdio: 'ignore' }).status === 0);
  return pytestOk.get(python) ? { kind: 'pytest', dir: '', exe: python } : `pytest is not installed for ${python}`;
}

// Python has no import graph to ask, so related tests are the test files that import the module.
export function relatedPyTests(file: string, files: string[], read: (f: string) => string): string[] {
  const stem = file.endsWith('/__init__.py') ? dirname(file).split('/').at(-1)! : file.split('/').at(-1)!.replace(/\.py$/, '');
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const imports = new RegExp(`^\\s*(?:import\\s+[\\w., ]*\\b${esc}\\b|from\\s+[\\w.]*\\b${esc}\\b[\\w.]*\\s+import|from\\s+[\\w.]+\\s+import\\s+[^\\n]*\\b${esc}\\b)`, 'm');
  return files.filter((f) => /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(f) && imports.test(read(f)));
}

let current: ReturnType<typeof spawn> | undefined;
export const stopCurrent = () => {
  if (current?.pid) {
    try {
      process.kill(-current.pid, 'SIGKILL');
    } catch {}
  }
};

/** Runs the tests related to `targets` (source files for vitest/jest, test files for pytest; none = whole suite). */
export async function runTests(r: Runner, sandbox: string, targets: string[], timeoutMs: number, out: string): Promise<Results | null> {
  rmSync(out, { force: true });
  const abs = targets.map((t) => join(sandbox, t));
  const args =
    r.kind === 'vitest'
      ? ['related', ...abs, '--run', '--reporter=json', `--outputFile=${out}`, '--passWithNoTests', '--coverage.enabled=false']
      : r.kind === 'jest'
        ? ['--findRelatedTests', ...abs, '--json', `--outputFile=${out}`, '--passWithNoTests', '--ci', '--coverage=false', '--no-watchman']
        : ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', `--junitxml=${out}`, ...abs];
  const exe = r.kind === 'pytest' ? r.exe : join(sandbox, r.exe);
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  if (r.kind === 'pytest') {
    // Sandbox first, so an editable install of the original checkout cannot shadow the mutant,
    // and no bytecode cache, so a stale .pyc cannot either.
    env.PYTHONPATH = [sandbox, join(sandbox, 'src'), process.env.PYTHONPATH].filter(Boolean).join(':');
    env.PYTHONDONTWRITEBYTECODE = '1';
  }
  const ok = await new Promise<boolean>((done) => {
    const child = spawn(exe, args, { cwd: join(sandbox, r.dir), env, stdio: 'ignore', detached: true });
    current = child;
    const timer = setTimeout(() => {
      stopCurrent();
      done(false);
    }, timeoutMs);
    child.on('error', () => (clearTimeout(timer), done(false)));
    child.on('exit', () => (clearTimeout(timer), done(true)));
  });
  current = undefined;
  if (!ok || !existsSync(out)) return null;
  try {
    return r.kind === 'pytest' ? junit(readFileSync(out, 'utf8')) : jestJson(readFileSync(out, 'utf8'), sandbox);
  } catch {
    return null;
  }
}

const set = (m: Results, id: string, passed: boolean) => m.set(id, (m.get(id) ?? true) && passed); // same name twice: both must pass

const SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled']); // neither passing nor failing: left out

// vitest's json reporter writes jest's format.
function jestJson(text: string, sandbox: string): Results {
  const m: Results = new Map();
  for (const f of JSON.parse(text).testResults ?? [])
    for (const a of f.assertionResults ?? [])
      if (!SKIPPED.has(a.status)) set(m, `${relative(sandbox, f.name)} › ${a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' ')}`, a.status === 'passed');
  return m;
}

const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function junit(xml: string): Results {
  const m: Results = new Map();
  for (const t of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k: string) => unxml(new RegExp(`\\b${k}="([^"]*)"`).exec(t[1])?.[1] ?? '');
    if (!/<skipped\b/.test(t[2] ?? '')) set(m, `${attr('classname')} › ${attr('name')}`, t[2] === undefined || !/<(?:failure|error)\b/.test(t[2]));
  }
  return m;
}
