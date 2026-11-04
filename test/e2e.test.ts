// End to end: real git repos with real vitest tests, the real CLI, and proof the repo is never written.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const made: string[] = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratch = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
};
const MODULES = join(import.meta.dirname, '..', 'node_modules'); // vitest is a devDependency

type Files = Record<string, string>;
const put = (dir: string, files: Files) => {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
};

/** A git repo with `base` committed, `edit` applied on top, and node_modules made of links into ours. */
function repo(base: Files, edit: Files | ((dir: string) => void), extraModules: Record<string, string> = {}) {
  const dir = scratch('potemkin-e2e-');
  const sh = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 'test');
  put(dir, { 'package.json': '{ "type": "module", "devDependencies": { "vitest": "*" } }\n', '.gitignore': 'node_modules\n.env\n', ...base });
  // A real directory of links, like a package manager makes, so a test can add workspace links.
  mkdirSync(join(dir, 'node_modules'));
  for (const name of readdirSync(MODULES)) if (!name.startsWith('.')) symlinkSync(join(MODULES, name), join(dir, 'node_modules', name));
  symlinkSync(join(MODULES, '.bin'), join(dir, 'node_modules', '.bin'));
  for (const [name, target] of Object.entries(extraModules)) {
    mkdirSync(join(dir, 'node_modules', name, '..'), { recursive: true });
    symlinkSync(join(dir, target), join(dir, 'node_modules', name));
  }
  sh('add', '-A');
  sh('commit', '-qm', 'base');
  if (typeof edit === 'function') edit(dir);
  else put(dir, edit);
  return dir;
}

// Hash of every file git can see, so any write to the repo shows up.
function fingerprint(dir: string) {
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(lstatSync(join(dir, f)).isSymbolicLink() ? 'link' : readFileSync(join(dir, f)));
  return h.digest('hex');
}

const tmp = () => scratch('potemkin-tmp-'); // the CLI's TMPDIR, to prove the sandbox is gone
const cli = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1', ...env } });
const verdicts = (dir: string, args: string[] = []) => {
  const r = cli(dir, ['--json', ...args]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  return { out, v: Object.fromEntries(out.functions.map((f: any) => [f.name, f])) as Record<string, { verdict: string; tests: string[]; why: string }> };
};

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
const BASE = { 'src/math.ts': MATH, 'test/math.test.ts': TESTS };
// Real code edits to four functions (comments alone would not count as changes).
const touchAll = (dir: string) => {
  const f = join(dir, 'src', 'math.ts');
  writeFileSync(
    f,
    readFileSync(f, 'utf8')
      .replace('return a + b;', 'return a + b + 0;')
      .replace('toFixed(2)}`;', 'toFixed(2)}`.trim();')
      .replace('(x: number) => x * 2', '(x: number) => x * 2 + 0')
      .replace('s + x, 0);', 's + x + 0, 0);'),
  );
};

test('labels each changed function and never writes to the repo', () => {
  const dir = repo(BASE, touchAll);
  const before = fingerprint(dir);
  const t = tmp();
  const r = cli(dir, ['--json'], { TMPDIR: t });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const v = Object.fromEntries(out.functions.map((f: any) => [f.name, f]));
  assert.deepEqual(Object.keys(v).sort(), ['Cart.total', 'add', 'format', 'unused']); // `untouched` is not in the diff
  assert.equal(v.add.verdict, 'NOTICED');
  assert.deepEqual(v.add.tests, ['test/math.test.ts › adds']);
  assert.equal(v.format.verdict, 'HOLLOW');
  assert.deepEqual(v.format.tests, ['test/math.test.ts › formats']);
  assert.equal(v['Cart.total'].verdict, 'HOLLOW');
  assert.equal(v.unused.verdict, 'UNTESTED');
  assert.equal(out.survive, 3);
  assert.equal(out.testsSeen, 4); // the skipped test does not count
  assert.equal(out.schemaVersion, 1);
  assert.equal(fingerprint(dir), before);
  assert.deepEqual(readdirSync(t), []); // sandbox removed
});

test('a comment-only edit, a deleted neighbour or a sibling on the same line is not a change', () => {
  const dir = repo(
    { 'src/a.ts': `export function keep() {\n  return 1;\n}\nexport function gone() {\n  return 2;\n}\n// old note\nexport function tail() {\n  return 3;\n}\nexport const api = { ping: () => 'pong', double: (n: number) => n * 2 };\n` },
    { 'src/a.ts': `export function keep() {\n  return 1;\n}\n// new note\nexport function tail() {\n  return 3; // reformatted\n}\nexport const api = { ping: () => 'pong', double: (n: number) => n * 3 };\n` },
  );
  const out = JSON.parse(cli(dir, ['--json']).stdout);
  assert.deepEqual(out.functions.map((f: any) => f.name), ['api.double']);
});

test('moved files, renamed classes and reordered same-named functions are not changes; an emptied function is', () => {
  const dir = repo(
    {
      'src/old.ts': 'export function slugify(s: string) {\n  return s.toLowerCase();\n}\nexport function legacyEscape(s: string) {\n  return s.replace(/&/g, "&amp;");\n}\n',
      'src/shapes.ts': 'export class Shape {\n  area(r: number) {\n    return r * r;\n  }\n}\n',
      'src/routes.ts': 'export const users = { create: (x: number) => x + 1 };\nexport const posts = { create: (x: number) => x + 2 };\n',
      'src/clear.ts': 'export function clear(xs: number[]) {\n  xs.length = 0;\n  return xs;\n}\n',
      'test/all.test.ts': "import { expect, test } from 'vitest';\nimport { clear } from '../src/clear';\ntest('clears', () => {\n  clear([1]);\n  expect(true).toBe(true);\n});\n",
    },
    (d) => {
      spawnSync('mv', [join(d, 'src/old.ts'), join(d, 'src/strings.ts')]);
      writeFileSync(join(d, 'src/shapes.ts'), 'export class Square {\n  area(r: number) {\n    return r * r;\n  }\n}\n');
      writeFileSync(join(d, 'src/routes.ts'), 'export const comments = { create: (x: number) => x + 3 };\nexport const posts = { create: (x: number) => x + 2 };\nexport const users = { create: (x: number) => x + 1 };\n');
      writeFileSync(join(d, 'src/clear.ts'), 'export function clear(xs: number[]) {}\n'); // the agent gutted it
    },
  );
  const { v, out } = verdicts(dir);
  assert.deepEqual(Object.keys(v).sort(), ['clear', 'comments.create']);
  assert.equal(v.clear.verdict, 'HOLLOW'); // the test runs it and asserts nothing
  assert.equal(out.survive, 2);
});

test('falls back to the last commit when nothing is uncommitted; --base diffs from the branch point', () => {
  const dir = repo(BASE, (d) => {
    touchAll(d);
    spawnSync('git', ['commit', '-qam', 'edit'], { cwd: d });
  });
  const r = JSON.parse(cli(dir, ['--json']).stdout);
  assert.equal(r.label, 'HEAD~1');
  assert.equal(r.functions.length, 4);
  assert.equal(JSON.parse(cli(dir, ['--json', '--base', 'HEAD']).stdout).functions.length, 0);
  // main gained four edits after the feature branch left it: they are not this branch's change.
  spawnSync('git', ['checkout', '-qb', 'feature', 'HEAD~1'], { cwd: dir });
  writeFileSync(join(dir, 'src', 'extra.ts'), 'export const extra = () => 1;\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-qm', 'feature'], { cwd: dir });
  const f = JSON.parse(cli(dir, ['--json', '--base', 'main']).stdout);
  assert.deepEqual(f.functions.map((x: any) => x.name), ['extra']);
  const bad = cli(dir, ['--base', 'nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--base nope is not a commit/);
  assert.equal(cli(dir, ['--base', '']).status, 2);
  assert.equal(cli(dir, ['--max', 'abc']).status, 2);
});

test('a file no test loads is UNTESTED; dynamic imports are found by asking the whole suite', () => {
  const dir = repo(
    {
      'src/lonely.ts': 'export const lonely = () => 1;\n',
      'src/plugins/greet.ts': 'export function run(name: string) { return `hi ${name}`; }\n',
      // A path vite cannot see at build time, so `vitest related` misses the test.
      'test/plugins.test.ts': `import { expect, test } from 'vitest';\ntest('loads a plugin by name', async () => {\n  const url = new URL('../src/plugins/' + ['gr', 'eet'].join('') + '.ts', import.meta.url).href;\n  const mod = await import(/* @vite-ignore */ url);\n  expect(mod.run('a')).toBe('hi a');\n});\n`,
    },
    { 'src/lonely.ts': 'export const lonely = () => 2;\n', 'src/plugins/greet.ts': 'export function run(name: string) { return `hi ${name}`.trim(); }\n' },
  );
  const { v } = verdicts(dir);
  assert.equal(v.lonely.verdict, 'UNTESTED');
  assert.equal(v.lonely.why, 'no test in the suite loads this file');
  assert.equal(v.run.verdict, 'NOTICED');
  assert.match(v.run.why, /found by asking the whole suite/);
});

test('errors swallowed by a caller still count as "tests run it"', () => {
  const dir = repo(
    {
      'src/config.ts': 'export function parseConfig(s: string) {\n  return JSON.parse(s);\n}\nexport function loadConfig(s: string) {\n  try {\n    return parseConfig(s) ?? {};\n  } catch {\n    return {};\n  }\n}\n',
      'test/config.test.ts': "import { expect, test } from 'vitest';\nimport { loadConfig } from '../src/config';\ntest('loads', () => {\n  expect(loadConfig('{}')).toEqual({});\n});\n",
    },
    (d) => writeFileSync(join(d, 'src/config.ts'), readFileSync(join(d, 'src/config.ts'), 'utf8').replace('return JSON.parse(s);', 'return JSON.parse(s.trim());')),
  );
  const { v } = verdicts(dir);
  assert.equal(v.parseConfig.verdict, 'HOLLOW');
  assert.match(v.parseConfig.why, /catch its errors/);
});

test('a related test that already fails turns accusations into UNVERIFIABLE', () => {
  const dir = repo(BASE, (d) => {
    const f = join(d, 'src', 'math.ts');
    writeFileSync(f, readFileSync(f, 'utf8').replace('return a + b;', 'return a + b + 1;'));
  });
  const { v, out } = verdicts(dir);
  assert.equal(v.add.verdict, 'UNVERIFIABLE');
  assert.match(v.add.why, /already fails on the current code, before Potemkin changed anything \(test\/math\.test\.ts › adds\)/);
  assert.equal(out.testsExcluded, 1);
});

test('state a test leaves behind is reset between runs', () => {
  const dir = repo(
    {
      'src/db.ts': "import { existsSync, writeFileSync } from 'node:fs';\nexport function migrate() {\n  if (!existsSync('db.txt')) writeFileSync('db.txt', 'v1');\n}\n",
      'test/db.test.ts': "import { existsSync } from 'node:fs';\nimport { expect, test } from 'vitest';\nimport { migrate } from '../src/db';\ntest('migrates', () => {\n  migrate();\n  expect(existsSync('db.txt')).toBe(true);\n});\n",
    },
    (d) => writeFileSync(join(d, 'src/db.ts'), readFileSync(join(d, 'src/db.ts'), 'utf8').replace("'v1'", "'v2'")),
  );
  assert.equal(verdicts(dir).v.migrate.verdict, 'NOTICED');
});

test('monorepo: a workspace link resolves to the sandbox copy', () => {
  const dir = repo(
    {
      'packages/core/package.json': '{ "name": "@acme/core", "type": "module", "main": "src/slug.ts" }\n',
      'packages/core/src/slug.ts': "export function slug(s: string) {\n  return s.toLowerCase().replace(/ /g, '-');\n}\n",
      'packages/app/test/post.test.ts': "import { expect, test } from 'vitest';\nimport { slug } from '@acme/core';\ntest('slugs a title', () => {\n  expect(slug('Hello World')).toBe('hello-world');\n});\n",
    },
    (d) => writeFileSync(join(d, 'packages/core/src/slug.ts'), "export function slug(s: string) {\n  return s.trim().toLowerCase().replace(/ /g, '-');\n}\n"),
    { '@acme/core': 'packages/core' },
  );
  assert.equal(verdicts(dir).v.slug.verdict, 'NOTICED');
});

test('symlinked source files are never written through; .env is copied, not linked', () => {
  const outside = scratch('potemkin-outside-');
  writeFileSync(join(outside, 'real.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  const dir = repo(
    { 'test/linked.test.ts': "import { expect, test } from 'vitest';\nimport { writeFileSync } from 'node:fs';\nimport { other } from '../src/other';\ntest('other', () => {\n  writeFileSync('.env', 'API_KEY=test');\n  expect(other()).toBe(1);\n});\n" },
    (d) => {
      mkdirSync(join(d, 'src'), { recursive: true });
      symlinkSync(join(outside, 'real.ts'), join(d, 'src', 'linked.ts'));
      writeFileSync(join(d, '.env'), 'API_KEY=real');
      writeFileSync(join(d, 'src', 'other.ts'), 'export const other = () => 1;\n');
    },
  );
  const before = readFileSync(join(outside, 'real.ts'), 'utf8');
  const { v } = verdicts(dir);
  assert.equal(v.add, undefined); // a symlink is not a file of this repo
  assert.equal(v.other.verdict, 'NOTICED');
  assert.equal(readFileSync(join(outside, 'real.ts'), 'utf8'), before);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'API_KEY=real');
});

test('--out implies --share and renders a PNG card; --strict fails on hollow functions', () => {
  const dir = repo(BASE, touchAll);
  const out = join(dir, 'card.png');
  const r = cli(dir, ['--out', out, '--strict']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /3 of 4 functions could be gutted, and every test would still pass\./);
  assert.deepEqual([...readFileSync(out).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('Ctrl-C mid-run kills the tests, deletes the sandbox and leaves the repo alone', async () => {
  const slow = TESTS.replace("test('adds', () => {", "test('adds', async () => {\n  await new Promise((r) => setTimeout(r, 4000));");
  const dir = repo({ ...BASE, 'test/math.test.ts': slow }, touchAll);
  const before = fingerprint(dir);
  const t = tmp();
  const child = spawn(process.execPath, [CLI], { cwd: dir, env: { ...process.env, TMPDIR: t, NO_COLOR: '1' } });
  let err = '';
  await new Promise<void>((done) =>
    child.stderr.on('data', (d) => {
      err += d;
      if (err.includes('related tests first')) done();
    }),
  );
  await new Promise((r) => setTimeout(r, 800)); // vitest is mid-run now
  child.kill('SIGINT');
  const code = await new Promise((done) => child.on('exit', (c) => done(c)));
  assert.equal(code, 130);
  assert.deepEqual(readdirSync(t), []);
  assert.equal(fingerprint(dir), before);
  assert.ok(existsSync(join(MODULES, 'vitest', 'package.json')), 'the real node_modules survived');
});

test('guard blocks on hollow tests once per diff, stands down on retry, and never fails on bad input', () => {
  const dir = repo(BASE, touchAll);
  const t = tmp();
  const r = cli(dir, ['guard'], { TMPDIR: t }, JSON.stringify({ cwd: dir, stop_hook_active: false }));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /2 functions you changed have tests that run them/);
  assert.match(out.reason, /src\/math\.ts:4 format/);
  assert.match(out.reason, /Do not delete or skip the tests/);
  assert.equal(cli(dir, ['guard'], { TMPDIR: t }, JSON.stringify({ cwd: dir })).stdout, ''); // same diff: already said
  assert.equal(cli(dir, ['guard'], { TMPDIR: tmp() }, JSON.stringify({ cwd: dir, stop_hook_active: true })).stdout, '');
  for (const input of ['not json', '[1]', JSON.stringify({ cwd: '/nonexistent' })]) {
    const g = cli(dir, ['guard'], { TMPDIR: tmp() }, input);
    assert.equal(g.status, 0, input);
    assert.ok(!g.stdout.includes('block'), input);
  }
});

test('install and uninstall are idempotent and leave everything else alone', () => {
  const home = scratch('potemkin-claude-');
  const dotfiles = join(home, 'dotfiles.json');
  const file = join(home, 'settings.json');
  const mine = { type: 'command', command: '~/bin/potemkin-village guard --strict' };
  writeFileSync(
    dotfiles,
    `{ "model": "opus", "id": 12345678901234567890, "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "pinocchio guard" }] }, { "matcher": "", "hooks": [] }], "PreToolUse": [{ "hooks": [${JSON.stringify(mine)}] }] } }`,
  );
  chmodSync(dotfiles, 0o600);
  symlinkSync(dotfiles, file);
  const env = { CLAUDE_CONFIG_DIR: home };
  assert.match(cli(home, ['install'], env).stdout, /Added the Potemkin Stop hook/);
  assert.match(cli(home, ['install'], env).stdout, /Already installed/);
  assert.ok(lstatSync(file).isSymbolicLink(), 'the dotfiles link survives');
  assert.equal(statSync(dotfiles).mode & 0o777, 0o600);
  const text = readFileSync(dotfiles, 'utf8');
  assert.match(text, /"id": 12345678901234567890/);
  let s = JSON.parse(text);
  assert.deepEqual(
    s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    ['pinocchio guard', 'npx -y potemkin-cli guard'],
  );
  assert.equal(s.hooks.Stop[2].hooks[0].timeout, 300);
  assert.match(cli(home, ['uninstall'], env).stdout, /Removed/);
  assert.match(cli(home, ['uninstall'], env).stdout, /nothing to remove/);
  s = JSON.parse(readFileSync(dotfiles, 'utf8'));
  assert.equal(s.hooks.Stop.length, 2); // the user's empty group stays
  assert.deepEqual(s.hooks.PreToolUse[0].hooks[0], mine);
  writeFileSync(dotfiles, '{ "hooks": { "Stop": { "hooks": [] } } }');
  assert.equal(cli(home, ['install'], env).status, 1);
  assert.equal(readFileSync(dotfiles, 'utf8'), '{ "hooks": { "Stop": { "hooks": [] } } }');
  writeFileSync(dotfiles, '{ broken');
  const bad = cli(home, ['install'], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot parse .*settings\.json/);
  assert.equal(readFileSync(dotfiles, 'utf8'), '{ broken');
});

test('setup problems and wrong places say so in one line', () => {
  const r = cli(tmp(), []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside a git repo/);
  const dir = repo({ 'src/a.ts': 'export const a = () => 1;\n' }, { 'src/a.ts': 'export const a = () => 2;\n' });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  const s = cli(dir, []);
  assert.equal(s.status, 1);
  assert.match(s.stderr, /nothing could be checked: no vitest or jest setup found/);
});
