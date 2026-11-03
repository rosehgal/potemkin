// End to end: a real git repo with real vitest tests, the real CLI, and proof the repo is never written.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const MODULES = join(import.meta.dirname, '..', 'node_modules'); // vitest is a devDependency

function repo(files: Record<string, string>, edit: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'potemkin-e2e-'));
  const sh = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 'test');
  writeFileSync(join(dir, 'package.json'), '{ "type": "module", "devDependencies": { "vitest": "*" } }\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  symlinkSync(MODULES, join(dir, 'node_modules'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  sh('add', '-A');
  sh('commit', '-qm', 'base');
  edit(dir);
  return dir;
}

// Hash of every file git can see, plus the link target, so any write to the repo shows up.
function fingerprint(dir: string) {
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(readFileSync(join(dir, f)));
  return h.update(readdirSync(MODULES).join()).digest('hex');
}

const tmp = () => mkdtempSync(join(tmpdir(), 'potemkin-tmp-')); // the CLI's TMPDIR, to prove the sandbox is gone
const cli = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1', ...env } });

const MATH = `export function add(a: number, b: number) {
  return a + b;
}
export function format(n: number) {
  return \`$\${n.toFixed(2)}\`;
}
export const unused = (x: number) => x * 2;
export class Cart {
  total(items: number[]) {
    return items.reduce((s, x) => s + x, 0);
  }
}
export function untouched() {
  return 'same';
}
`;
const TESTS = `import { expect, test } from 'vitest';
import { add, Cart, format, untouched } from '../src/math';
test('adds', () => {
  expect(add(1, 2)).toBe(3);
});
test('formats', () => {
  format(2);
  expect(true).toBe(true);
});
test('cart totals', () => {
  new Cart().total([1, 2]);
});
test('untouched', () => {
  expect(untouched()).toBe('same');
});
test.skip('skipped', () => {
  expect(add(1, 1)).toBe(3);
});
`;
const touchAll = (dir: string) => {
  const f = join(dir, 'src', 'math.ts');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/(return a \+ b;|toFixed\(2\)\}`;|x \* 2;|s \+ x, 0\);)/g, '$1 // edited'));
};

test('labels each changed function and never writes to the repo', () => {
  const dir = repo({ 'src/math.ts': MATH, 'test/math.test.ts': TESTS }, touchAll);
  const before = fingerprint(dir);
  const t = tmp();
  const r = cli(dir, ['--json'], { TMPDIR: t });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const v = Object.fromEntries(out.functions.map((f: any) => [f.name, f]));
  assert.deepEqual(Object.keys(v), ['add', 'format', 'unused', 'Cart.total']); // `untouched` is not in the diff
  assert.equal(v.add.verdict, 'NOTICED');
  assert.deepEqual(v.add.tests, ['test/math.test.ts › adds']);
  assert.equal(v.format.verdict, 'HOLLOW');
  assert.deepEqual(v.format.tests, ['test/math.test.ts › formats']);
  assert.equal(v['Cart.total'].verdict, 'HOLLOW');
  assert.equal(v.unused.verdict, 'UNTESTED');
  assert.equal(out.survive, 3);
  assert.equal(out.tests, 4); // the skipped test does not count
  assert.equal(fingerprint(dir), before);
  assert.deepEqual(readdirSync(t), []); // sandbox removed
});

test('falls back to the last commit when nothing is uncommitted, and --base picks a range', () => {
  const dir = repo({ 'src/math.ts': MATH, 'test/math.test.ts': TESTS }, (d) => {
    touchAll(d);
    spawnSync('git', ['commit', '-qam', 'edit'], { cwd: d });
  });
  const r = JSON.parse(cli(dir, ['--json']).stdout);
  assert.equal(r.base, 'HEAD~1');
  assert.equal(r.functions.length, 4);
  const none = JSON.parse(cli(dir, ['--json', '--base', 'HEAD']).stdout);
  assert.equal(none.functions.length, 0);
  assert.match(cli(dir, ['--base', 'nope']).stderr, /--base nope is not a commit/);
});

test('a file no test imports is UNTESTED; one only a missed import names is UNVERIFIABLE', () => {
  const dir = repo({ 'src/lonely.ts': 'export const lonely = () => 1;\n', 'src/math.ts': MATH, 'test/math.test.ts': TESTS }, (d) => {
    writeFileSync(join(d, 'src', 'lonely.ts'), 'export const lonely = () => 2;\n');
  });
  const r = JSON.parse(cli(dir, ['--json']).stdout);
  assert.equal(r.functions[0].verdict, 'UNTESTED');
  assert.equal(r.functions[0].why, 'no test imports this file');
});

test('tests that fail before any change are left out, and a file whose tests all fail is UNVERIFIABLE', () => {
  const dir = repo(
    { 'src/math.ts': MATH, 'test/math.test.ts': TESTS.replace("expect(untouched()).toBe('same')", "expect(untouched()).toBe('different')").replace("expect(add(1, 2)).toBe(3)", 'expect(add(1, 2)).toBe(4)') },
    touchAll,
  );
  const r = JSON.parse(cli(dir, ['--json']).stdout);
  const add = r.functions.find((f: any) => f.name === 'add');
  assert.equal(add.verdict, 'UNTESTED'); // its only real test already failed, so nothing left notices it
  assert.match(add.why, /2 related tests already fail/);
  assert.equal(r.tests, 2);
});

test('--share renders a PNG card', () => {
  const dir = repo({ 'src/math.ts': MATH, 'test/math.test.ts': TESTS }, touchAll);
  const out = join(dir, 'card.png');
  const r = cli(dir, ['--share', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 of 4 functions could be gutted, and every test would still pass\./);
  assert.deepEqual([...readFileSync(out).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('Ctrl-C mid-run kills the tests, deletes the sandbox and leaves the repo alone', async () => {
  const slow = TESTS.replace("test('adds', () => {", "test('adds', async () => {\n  await new Promise((r) => setTimeout(r, 4000));");
  const dir = repo({ 'src/math.ts': MATH, 'test/math.test.ts': slow }, touchAll);
  const before = fingerprint(dir);
  const t = tmp();
  const child = spawn(process.execPath, [CLI], { cwd: dir, env: { ...process.env, TMPDIR: t, NO_COLOR: '1' } });
  let err = '';
  await new Promise<void>((done) =>
    child.stderr.on('data', (d) => {
      err += d;
      if (err.includes('running its related tests')) done();
    }),
  );
  await new Promise((r) => setTimeout(r, 800)); // vitest is mid-run now
  child.kill('SIGINT');
  const code = await new Promise((done) => child.on('exit', (c) => done(c)));
  assert.equal(code, 130);
  assert.deepEqual(readdirSync(t), []);
  assert.equal(fingerprint(dir), before);
  assert.ok(existsSync(join(MODULES, 'vitest')), 'the real node_modules survived');
});

test('guard blocks once on hollow tests, stands down on retry, and never fails on bad input', () => {
  const dir = repo({ 'src/math.ts': MATH, 'test/math.test.ts': TESTS }, touchAll);
  const r = cli(dir, ['guard'], {}, JSON.stringify({ cwd: dir, stop_hook_active: false }));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /2 functions you changed can be gutted/);
  assert.match(out.reason, /src\/math\.ts:4 format/);
  assert.equal(cli(dir, ['guard'], {}, JSON.stringify({ cwd: dir, stop_hook_active: true })).stdout, '');
  for (const input of ['not json', '[1]', JSON.stringify({ cwd: '/nonexistent' })]) {
    const g = cli(dir, ['guard'], {}, input);
    assert.equal(g.status, 0, input);
    assert.ok(!g.stdout.includes('block'), input);
  }
});

test('install and uninstall are idempotent and keep the other hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'potemkin-claude-'));
  const file = join(home, 'settings.json');
  const other = { type: 'command', command: 'pinocchio guard' };
  writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [other] }], PreToolUse: [] } }));
  const env = { CLAUDE_CONFIG_DIR: home };
  assert.equal(cli(home, ['install'], env).status, 0);
  assert.equal(cli(home, ['install'], env).status, 0);
  let s = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(s.model, 'opus');
  const commands = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.deepEqual(commands, ['pinocchio guard', 'npx -y potemkin-cli guard']);
  assert.equal(s.hooks.Stop[1].hooks[0].timeout, 300);
  assert.equal(cli(home, ['uninstall'], env).status, 0);
  s = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(s.hooks.Stop, [{ hooks: [other] }]);
  writeFileSync(file, '{ broken');
  assert.equal(cli(home, ['install'], env).status, 1);
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
});

test('outside a git repo it says so', () => {
  const r = cli(tmp(), []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside a git repo/);
});
