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
  env: Record<string, string>; // from the package's test script: NODE_OPTIONS, TZ=UTC and the like
  configs: string[]; // other test configs and suites in that directory, which Potemkin does not run
  noCov?: boolean; // pytest-cov is installed: pass --no-cov so a coverage threshold cannot fail the run
}

export type Outcome = 'pass' | 'fail' | 'skip';
export type Results = Map<string, Outcome>; // test id -> outcome

export interface Run {
  results: Results | null; // null: no readable results (crash, timeout, missing output)
  messages: Map<string, string>; // failure text per failed test id, where the runner gives one
  code: number | null; // exit code, null on timeout
  timedOut: boolean;
  tail: string; // the runner's output, for diagnostics
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
const readText = (file: string) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const up = (d: string) => (d === '' || d === '.' ? undefined : dirname(d) === '.' ? '' : dirname(d));
const VITEST_CONFIG = /^vitest\.(?:config|workspace|projects)\.[cm]?[jt]s$|^vite\.config\.[cm]?[jt]s$/;
const JEST_CONFIG = /^jest\.config\.[cm]?[jt]s$|^jest\.config\.json$/;

function jsRunner(root: string, file: string): Runner | string {
  let found: { kind: 'vitest' | 'jest'; dir: string } | undefined;
  let depOnly: { kind: 'vitest' | 'jest'; dir: string } | undefined;
  for (let d: string | undefined = up(file) ?? ''; d !== undefined; d = up(d)) {
    const abs = join(root, d);
    const names = existsSync(abs) ? readdirSync(abs) : [];
    const pkg = names.includes('package.json') ? readJson(join(abs, 'package.json')) : undefined;
    // A config file decides. A dependency alone only counts if no folder above has a config.
    const config = names.some((n) => VITEST_CONFIG.test(n)) && (deps(pkg).vitest || findUp(root, d, join('node_modules', '.bin', 'vitest'))) ? 'vitest' : names.some((n) => JEST_CONFIG.test(n)) || pkg?.jest ? 'jest' : undefined;
    if (config && !found) found = { kind: config, dir: d };
    // An umbrella config above it (vitest projects/workspace, jest projects) runs every package's tests.
    if (config && found && d !== found.dir && config === found.kind && umbrella(abs, names, pkg, config)) found = { kind: config, dir: d };
    if (!found && !depOnly && pkg) {
      const kind = deps(pkg).vitest ? 'vitest' : deps(pkg).jest ? 'jest' : undefined;
      if (kind) depOnly = { kind, dir: d };
    }
  }
  const use = found ?? depOnly;
  if (!use) return 'no vitest or jest setup found (Potemkin supports vitest, jest and pytest)';
  const abs = join(root, use.dir);
  return make(root, use.kind, use.dir, readdirSync(abs), readJson(join(abs, 'package.json')));
}

function umbrella(abs: string, names: string[], pkg: any, kind: 'vitest' | 'jest'): boolean {
  if (kind === 'vitest') {
    if (names.some((n) => /^vitest\.(?:workspace|projects)\./.test(n))) return true;
    return names.filter((n) => VITEST_CONFIG.test(n)).some((n) => /\b(?:projects|workspace)\s*:/.test(readText(join(abs, n))));
  }
  if (Array.isArray(pkg?.jest?.projects)) return true;
  return names.filter((n) => JEST_CONFIG.test(n)).some((n) => /\bprojects\b/.test(readText(join(abs, n))));
}

function make(root: string, kind: 'vitest' | 'jest', dir: string, names: string[], pkg: any): Runner | string {
  const bin = findUp(root, dir, join('node_modules', '.bin', kind));
  if (!bin) return `${kind} is set up in ${dir || 'the repo root'}, but node_modules/.bin/${kind} is missing (install dependencies first)`;
  const ver = readJson(join(root, bin, '..', '..', kind, 'package.json'))?.version ?? '';
  return { kind, dir, exe: bin, major: Number(ver.split('.')[0]) || 0, env: scriptEnv(pkg?.scripts?.test ?? '', kind), configs: otherConfigs(names, pkg, kind) };
}

// What the test script sets up that a bare run would miss: `TZ=UTC NODE_OPTIONS=--experimental-vm-modules jest`,
// or `node --experimental-vm-modules node_modules/.bin/jest`.
function scriptEnv(script: string, kind: string): Record<string, string> {
  const env: Record<string, string> = {};
  const m = /^(?:\s*(?:env\s+|cross-env(?:-shell)?\s+)?(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]*)\s*))+/.exec(script);
  for (const kv of (m?.[0] ?? '').matchAll(/([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|]*)/g)) {
    if (['PATH', 'HOME', 'CI'].includes(kv[1])) continue;
    const v = kv[2].replace(/^["']|["']$/g, '').replace(/\$\{?NODE_OPTIONS\}?/g, '').trim();
    if (v) env[kv[1]] = v;
  }
  // `node --experimental-vm-modules node_modules/.bin/jest`, `node -r dotenv/config …jest`
  const flags = new RegExp(`\\bnode\\s+((?:(?:-r|--require|--import|--loader|--experimental-loader)\\s+\\S+\\s+|--?[\\w-]+(?:=\\S+)?\\s+)+)\\S*${kind}`).exec(script);
  if (flags) env.NODE_OPTIONS = [env.NODE_OPTIONS, flags[1].trim()].filter(Boolean).join(' ');
  return env;
}

// Other configs and suites in this directory: Potemkin runs the default one and names the rest.
function otherConfigs(names: string[], pkg: any, kind: 'vitest' | 'jest'): string[] {
  const main = kind === 'vitest' ? VITEST_CONFIG : JEST_CONFIG;
  const out = new Set<string>();
  for (const n of names)
    if (!main.test(n) && /^(?:vitest|jest)\.config\.[\w-]+\.[\w]+$|^(?:playwright|cypress)\.config\.[cm]?[jt]s$|^wdio\.conf(?:ig)?\.[cm]?[jt]s$/.test(n)) out.add(n);
  for (const script of Object.values(pkg?.scripts ?? {}) as string[]) {
    if (!/\b(?:vitest|jest|playwright|cypress|mocha|wdio)\b/.test(script)) continue;
    for (const m of script.matchAll(/(?:--config|-c)[=\s]+([^\s'"&;|]+)/g)) {
      const v = m[1];
      if (/\.(?:config|conf)\.|\.(?:[cm]?[jt]s|json)$/.test(v) && !main.test(v.split('/').at(-1)!)) out.add(v);
    }
  }
  return [...out];
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

const probes = new Map<string, { pytest: boolean; cov: boolean }>();
/** `tests`: the repo's Python test files, so pytest starts where they are, not only where the source is. */
export function runnerFor(root: string, file: string, tests: string[] = []): Runner | string {
  if (!file.endsWith('.py')) return jsRunner(root, file);
  const python = pythonFor(root, file);
  if (!probes.has(python)) {
    const ok = (code: string) => spawnSync(python, ['-I', '-c', code], { stdio: 'ignore', cwd: tmpdir() }).status === 0;
    probes.set(python, { pytest: ok('import pytest'), cov: ok('import pytest_cov') });
  }
  const p = probes.get(python)!;
  if (!p.pytest) return `pytest is not installed for ${python}`;
  // pytest reads its config from the nearest ini-style file above the source, so start there,
  // unless the tests live elsewhere: then the repo root, where a whole-suite run collects them.
  const INI = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'];
  let dir = '';
  for (let d: string | undefined = up(file) ?? ''; d !== undefined; d = up(d))
    if (INI.some((n) => existsSync(join(root, d!, n)))) {
      dir = d;
      break;
    }
  if (dir && tests.length && !tests.some((t) => t.startsWith(`${dir}/`))) dir = '';
  const ini = INI.map((n) => readText(join(root, dir, n))).join('\n');
  return { kind: 'pytest', dir, exe: python, major: 0, env: {}, configs: [], noCov: p.cov && !/-p\s*no:(?:cov|pytest_cov)\b/.test(ini) };
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

export function command(r: Runner, sandbox: string, work: string, sel: Selection, out: string): string[] {
  const abs = (fs: string[]) => fs.map((f) => join(sandbox, f));
  if (r.kind === 'vitest') {
    const pick = sel === 'all' ? ['run'] : 'related' in sel ? ['related', ...abs(sel.related), '--run'] : ['run', ...abs(sel.files)];
    // No result or module caches: they would outlive the sandbox or serve a stale transform.
    const caches = r.major >= 5 ? ['--no-cache', '--fsModuleCache=false'] : [];
    return [join(sandbox, r.exe), ...pick, '--reporter=json', `--outputFile=${out}`, '--passWithNoTests', '--coverage.enabled=false', ...caches];
  }
  if (r.kind === 'jest') {
    const pick = sel === 'all' ? [] : 'related' in sel ? ['--findRelatedTests', ...abs(sel.related)] : ['--runTestsByPath', ...abs(sel.files)];
    return [join(sandbox, r.exe), ...pick, '--json', `--outputFile=${out}`, '--passWithNoTests', '--ci', '--coverage=false', '--no-watchman', '--forceExit', `--cacheDirectory=${join(work, 'jest-cache')}`];
  }
  const pick = sel === 'all' ? [] : 'related' in sel ? abs(sel.related) : abs(sel.files);
  // rootdir at the sandbox: junit file= attributes come out repo-relative, whatever directory pytest starts in.
  return [r.exe, '-m', 'pytest', '-q', `--rootdir=${sandbox}`, '-o', `cache_dir=${join(work, 'pytest-cache')}`, '-o', 'junit_family=xunit1', `--junitxml=${out}`, ...(r.noCov ? ['--no-cov'] : []), ...pick];
}

export async function runTests(r: Runner, sandbox: string, work: string, sel: Selection, timeoutMs: number): Promise<Run> {
  const out = join(work, r.kind === 'pytest' ? 'results.xml' : 'results.json');
  rmSync(out, { force: true });
  // Every run gets a fresh temp directory, so state a test leaves in os.tmpdir() cannot carry over.
  const temp = join(work, 'tmp');
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  const [exe, ...args] = command(r, sandbox, work, sel, out);
  const env: NodeJS.ProcessEnv = { ...process.env, ...r.env, NO_COLOR: '1', TMPDIR: temp, TMP: temp, TEMP: temp };
  delete env.FORCE_COLOR; // Node warns when both are set
  if (r.env.NODE_OPTIONS) env.NODE_OPTIONS = [process.env.NODE_OPTIONS, r.env.NODE_OPTIONS].filter(Boolean).join(' ');
  if (r.kind === 'pytest') {
    // Sandbox first, so an editable install of the original checkout cannot shadow the mutant,
    // and no bytecode cache, so a stale .pyc cannot either.
    const here = join(sandbox, r.dir);
    env.PYTHONPATH = [...new Set([here, join(here, 'src'), sandbox, join(sandbox, 'src')]), process.env.PYTHONPATH].filter(Boolean).join(':');
    env.PYTHONDONTWRITEBYTECODE = '1';
  }
  const chunks: string[] = [];
  let size = 0;
  const keep = (d: Buffer) => {
    chunks.push(d.toString());
    size += d.length;
    while (size > 16000 && chunks.length > 1) size -= chunks.shift()!.length;
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
  const text = chunks.join('').trim();
  let results: Results | null = null;
  const messages = new Map<string, string>();
  if (!timedOut && existsSync(out)) {
    try {
      results = r.kind === 'pytest' ? junit(readFileSync(out, 'utf8'), messages) : jestJson(readFileSync(out, 'utf8'), sandbox, messages);
    } catch {}
  }
  // Exited non-zero but no test failed (globalSetup threw, unhandled error, ESM loader…): unreadable.
  if (results && code !== 0 && ![...results.values()].includes('fail') && !(r.kind === 'pytest' && code === 5)) results = null;
  return { results, messages, code, timedOut, tail: text };
}

const RANK: Record<Outcome, number> = { pass: 0, skip: 1, fail: 2 };
const set = (m: Results, id: string, o: Outcome) => {
  const prev = m.get(id);
  if (!prev || RANK[o] > RANK[prev]) m.set(id, o); // the same name twice: the worse outcome wins
};
const SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled']);

// vitest's json reporter writes jest's format.
function jestJson(text: string, sandbox: string, messages: Map<string, string>): Results {
  const m: Results = new Map();
  for (const f of JSON.parse(text).testResults ?? []) {
    const file = relative(sandbox, f.name);
    const tests = f.assertionResults ?? [];
    // A failed file with no failed test in it: it did not load, or a beforeAll threw and skipped the rest.
    const setup = f.status === 'failed' && !tests.some((a: any) => a.status === 'failed');
    for (const a of tests) {
      const o: Outcome = a.status === 'passed' ? 'pass' : SKIPPED.has(a.status) ? (setup ? 'fail' : 'skip') : 'fail';
      const id = `${file} › ${a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' ')}`;
      set(m, id, o);
      if (o === 'fail') messages.set(id, [...(a.failureMessages ?? []), setup ? f.message ?? '' : ''].join('\n'));
    }
    if (setup) {
      const id = `${file} › (the file failed to load or set up)`;
      set(m, id, 'fail');
      messages.set(id, f.message ?? '');
    }
  }
  return m;
}

const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// pytest junit (xunit1): ids start with the test file, like vitest's and jest's, so testFile() works for all three.
function junit(xml: string, messages: Map<string, string>): Results {
  const m: Results = new Map();
  for (const t of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (k: string) => unxml(new RegExp(`\\b${k}="([^"]*)"`).exec(t[1])?.[1] ?? '');
    const body = t[2] ?? '';
    const id = `${attr('file')} › ${attr('classname')}::${attr('name')}`;
    const o: Outcome = /<(?:failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    set(m, id, o);
    if (o === 'fail') messages.set(id, unxml(body));
  }
  return m;
}

/** The repo-relative test file a result id belongs to ('' for a collection error that has none). */
export const testFile = (id: string) => id.split(' › ')[0];
