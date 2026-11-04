// The mutator: finds the right functions, fingerprints them, and every mutant it writes still parses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const TQ = '"'.repeat(3); // a Python docstring quote
import { parse } from '@babel/parser';
import { canary, jsFunctions, jsMutant, NOT_SOURCE, pyFunctions, pyMutant } from '../src/functions.ts';

const TS = `#!/usr/bin/env node
"use client";
@sealed
abstract class Shape extends Base {
  constructor() { super(); }
  @log area(): number { return 1; }
  get size() { return 2; }
  set size(v: number) { this.v = v; }
  abstract draw(): void;
  static make = () => ({ kind: 'shape' });
  #secret = function () { return 3; };
}
function over(a: string): void;
function over(a: any) { return a; }
declare function ambient(): void;
export default async () => 42;
const pick = <T,>(xs: T[]) => xs[0];
export async function* stream() { yield 1; }
const api = { get() { return 1; }, post: async (x: number) => x, ['del']: function* () { yield 2; } };
module.exports.legacy = function () { return 'old'; };
const Row = memo(function Row() { return null; });
`;
const PLUGINS = ['typescript', 'decorators', 'decoratorAutoAccessors'] as const;

test('finds named functions, skips constructors, overloads, abstract and ambient ones', () => {
  assert.deepEqual(
    jsFunctions('src/shape.ts', TS).map((f) => `${f.name}@${f.line}`),
    ['Shape.area@6', 'Shape.get size@7', 'Shape.set size@8', 'Shape.make@10', 'Shape.#secret@11', 'over@14', 'default@16', 'pick@17', 'stream@18', 'api.get@19', 'api.post@19', 'api.del@19', 'module.exports.legacy@20', 'Row@21'],
  );
});

test('every TS mutant parses, keeps the shebang first, and keeps types loose', () => {
  for (const fn of jsFunctions('src/shape.ts', TS))
    for (const kind of ['empty', 'throw'] as const) {
      const out = jsMutant(TS, fn, kind, '/tmp/marker');
      assert.ok(out.startsWith('#!/usr/bin/env node\n// @ts-nocheck\n'), `${fn.name} ${kind}`);
      if (kind === 'throw') assert.ok(out.includes('potemkin: function gutted') && out.includes('"/tmp/marker"'), fn.name);
      else if (!fn.body!.setter) assert.ok(out.includes('undefined as any'), fn.name);
      parse(out, { sourceType: 'unambiguous', plugins: [...PLUGINS] }); // throws on a syntax error
    }
});

test('setters are emptied, expression arrows swapped inside their parentheses, directives kept', () => {
  const fns = jsFunctions('src/shape.ts', TS);
  assert.match(jsMutant(TS, fns.find((f) => f.body?.setter)!, 'empty'), /set size\(v: number\) \{ \}/);
  const make = fns.find((f) => f.name === 'Shape.make')!;
  assert.match(jsMutant(TS, make, 'empty'), /static make = \(\) => \(\(undefined as any\)\);/);
  assert.match(jsMutant(TS, make, 'throw'), /static make = \(\) => \(\(\(\(\) => \{ throw new Error/);
  const action = `export async function act(x: number) { 'use server'\n  return x * 2;\n}\n`;
  const out = jsMutant(action, jsFunctions('a.ts', action)[0], 'empty');
  assert.match(out, /\{ 'use server'; return undefined as any; \}/);
  parse(out, { sourceType: 'module', plugins: ['typescript'] });
  const js = `export function f() { return 1; }\n`;
  assert.equal(jsMutant(js, jsFunctions('a.js', js)[0], 'empty'), 'export function f() { return undefined; }\n'); // no TS in JS
});

test('wrapper calls name their function; callbacks on values do not', () => {
  const src = `export const Row = memo(forwardRef((p: P, r) => <div ref={r}>{p.x}</div>));
export const total = sum(prices.map((p) => p.x));
const h = useCallback(() => go(), []);
const Card = React.memo(function Card() { return null; });
const f = ((x: number) => x * 2) satisfies F;
const g = ((x: number) => x + 1) as F;
const Foo = class { m() { return 1; } };
export default class { n() { return 2; } }
class A { accessor y = 1; z = () => ({ a: 1 }); }
`;
  assert.deepEqual(jsFunctions('b.tsx', src).map((f) => f.name), ['Row', 'h', 'Card', 'f', 'g', 'Foo.m', 'default.n', 'A.z']);
});

test('functions that already do nothing are flagged inert, and their EMPTY mutant is the code itself', () => {
  const src = `export function noop() {}\nexport const nothing = () => undefined;\nexport function bare() { return; }\nexport function assertNever(x: never): never { throw new Error('x'); }\nclass L { debug(_m: string): void {} }\nexport function real() { return 1; }\n`;
  const fns = jsFunctions('c.ts', src);
  assert.deepEqual(fns.map((f) => `${f.name}${f.inert ? '!' : ''}`), ['noop!', 'nothing!', 'bare!', 'assertNever', 'L.debug!', 'real']); // a throw is behaviour
  assert.equal(jsMutant(src, fns[0], 'empty'), src);
  assert.notEqual(jsMutant(src, fns[0], 'throw'), src);
  const voids = `export const a = () => void 0;\nexport const b = () => void save();\nexport const c = () => undefined;\n`;
  assert.deepEqual(jsFunctions('v.ts', voids).map((f) => `${f.name}${f.inert ? '!' : ''}`), ['a!', 'b', 'c!']);
});

test('nested functions are named by what encloses them, and siblings get #2', () => {
  const src = `function outer() {\n  const inner = () => 1;\n  return inner();\n}\nconst api = { get() { return 1; }, nested: { get() { return 2; } } };\nexport const create = (x) => x;\nexport const create2 = { create: () => 1 };\n`;
  assert.deepEqual(jsFunctions('a.ts', src).map((f) => f.name), ['outer', 'outer.inner', 'api.get', 'api.nested.get', 'create', 'create2.create']);
  const dup = `router.get('/a', function handler() { return 1; });\nrouter.get('/b', function handler() { return 2; });\n`;
  assert.deepEqual(jsFunctions('b.js', dup).map((f) => f.name), ['handler', 'handler#2']);
});

test('fingerprints ignore formatting and comments, and a nested edit only changes the nested function', () => {
  const fp = (src: string) => Object.fromEntries(jsFunctions('a.ts', src).map((f) => [f.name, f.fp]));
  const a = fp(`export function outer(x) {\n  const inner = (y) => y * 2;\n  return inner(x) + 1;\n}\n`);
  const b = fp(`// reworded comment\nexport function outer(x) { const inner = (y) => y * 2; /* note */ return inner(x) + 1 }\n`);
  const c = fp(`export function outer(x) {\n  const inner = (y) => y * 3;\n  return inner(x) + 1;\n}\n`);
  assert.deepEqual(a, b);
  assert.equal(a.outer, c.outer);
  assert.notEqual(a['outer.inner'], c['outer.inner']);
  assert.notEqual(fp(`export function outer(x) { const inner = (y) => y * 2; return inner(x) + 2 }`).outer, a.outer);
  // JSX: re-indenting, collapsing lines and {/* comments */} render the same
  const j = (src: string) => jsFunctions('a.tsx', src)[0].fp;
  assert.equal(j(`export const Card = () => <div className="c">\n  {/* title */}\n  Hello\n</div>;\n`), j(`export const Card = () => (\n  <div className="c">Hello</div>\n);\n`));
  assert.notEqual(j(`export const Card = () => <div className="c">Hello</div>;`), j(`export const Card = () => <div className="c">Hi</div>;`));
  assert.notEqual(j(`export const T = () => <b>x y</b>;`), j(`export const T = () => <b>x  y</b>;`)); // React keeps spaces inside a line
  // Types, bigint literals and TS wrappers: only runtime structure counts
  assert.equal(fp(`export function add(a: number, b: number): number { return a + b; }`).add, fp(`export function add(a, b) { return a + b; }`).add);
  assert.equal(fp(`export function big(xs: bigint[]) { return xs.reduce((s, x) => s + x, 0n); }`).big, fp(`// note\nexport function big(xs) { return xs.reduce((s, x) => s + x, 0n) }`).big);
  assert.notEqual(fp(`export function big() { return 1n; }`).big, fp(`export function big() { return 2n; }`).big);
});

test('line numbers count \\n only, as git does', () => {
  const src = `const SEP = "x y z";\nexport function a() { return 1; }\nexport function b() { return 2; }\n`;
  assert.deepEqual(jsFunctions('a.ts', src).map((f) => `${f.name}@${f.line}`), ['a@2', 'b@3']);
});

test('JSX in .jsx and plain .js files, and legacy decorators', () => {
  const JSX = `export const Card = ({ title }) => <div className="card">{title}</div>;\nexport function List({ xs }) { return <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>; }\n`;
  for (const file of ['src/card.jsx', 'src/card.js', 'src/card.tsx']) {
    const fns = jsFunctions(file, JSX);
    assert.deepEqual(fns.map((f) => f.name), ['Card', 'List'], file);
    for (const fn of fns) parse(jsMutant(JSX, fn, 'throw'), { sourceType: 'module', plugins: file.endsWith('x') ? ['jsx', 'typescript'] : ['jsx'] });
  }
  const legacy = `class A { @Input() name: string; @HostListener('click', ['$event']) onClick(e) { return e; } }`;
  assert.deepEqual(jsFunctions('src/a.ts', legacy).map((f) => f.name), ['A.onClick']);
});

test('deep expression chains do not overflow the stack', () => {
  const src = `export function big() { return ${Array.from({ length: 1500 }, (_, i) => `"s${i}"`).join(' + ')}; }\n`; // Babel's own limit is lower on some platforms
  assert.deepEqual(jsFunctions('a.js', src).map((f) => f.name), ['big']);
});

test('the canary throws first, after any shebang, with the file’s line endings', () => {
  assert.equal(canary('src/a.ts', '#!/bin/sh\nexport const x = 1;\n'), '#!/bin/sh\n// @ts-nocheck\nthrow new Error("potemkin canary");\nexport const x = 1;\n');
  assert.equal(canary('src/a.js', 'export const x = 1;\r\n'), 'throw new Error("potemkin canary");\r\nexport const x = 1;\r\n');
  assert.equal(canary('pkg/a.py', 'X = 1\n'), 'raise Exception("potemkin canary")\nX = 1\n');
});

test('tests, mocks, fixtures, stories, configs and type declarations are not source', () => {
  for (const f of ['src/a.test.ts', 'src/__tests__/a.ts', 'test/a.ts', 'tests/helpers.py', 'pkg/test_a.py', 'pkg/a_test.py', 'conftest.py', 'src/types.d.ts', 'vitest.config.ts', 'src/__mocks__/fs.ts', 'fixtures/x.js', 'src/Button.stories.tsx'])
    assert.ok(NOT_SOURCE.test(f), f);
  for (const f of ['src/a.ts', 'src/testing.ts', 'pkg/contest.py', 'src/attest.js', 'src/history.ts']) assert.ok(!NOT_SOURCE.test(f), f);
});

const python = spawnSync('python3', ['--version']).status === 0;
const made: string[] = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const pyFile = (name: string, text: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'potemkin-py-'));
  made.push(dir);
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

test('Python: methods, nested, async; stubs, __init__, abstract and raise-only skipped', { skip: !python && 'python3 not found' }, () => {
  const file = pyFile(
    'repo.py',
    `from __future__ import annotations
from abc import abstractmethod

class Repo:
    def __init__(self):
        self.items = []

    @property
    def size(self):
        """How many."""
        return len(self.items)

    @size.setter
    def size(self, v):
        self.items = [None] * v

    @staticmethod
    def make(): return Repo()

    async def fetch(self, n):
        return n

    def gen(self):
        yield from self.items

    @abstractmethod
    def todo(self): ...

    def never(self):
        """Not yet."""
        raise NotImplementedError

def outer(x):
    def inner(y):
        return y * 2
    return inner(x)

def emoji(s="🎉✓"): return s + "✓"
`,
  );
  const fns = pyFunctions('python3', 'repo.py', file);
  assert.deepEqual(fns.map((f) => `${f.name}@${f.line}${f.inert ? '!' : ''}`), ['Repo.size@8', 'Repo.size.setter@13', 'Repo.make@17', 'Repo.fetch@20', 'Repo.gen@23', 'Repo.never@29', 'outer@33', 'outer.inner@34', 'emoji@38']);
  const stubs = pyFunctions('python3', 's.py', '-', 'def a():\n    pass\ndef b():\n    return None\ndef c():\n    return\ndef d(x: int) -> int:\n    return x\n');
  assert.deepEqual(stubs.map((f) => `${f.name}${f.inert ? '!' : ''}`), ['a!', 'b!', 'c!', 'd']);
  assert.equal(stubs[3].fp, pyFunctions('python3', 's.py', '-', 'def d(x):\n    return x\n')[0].fp); // annotations are not behaviour
  const doc = (text: string) => pyFunctions('python3', 'x.py', '-', text)[0].fp; // a reworded docstring is not a change
  assert.equal(doc('def f():\n    DOC_ONE\n    return 1\n'.replace('DOC_ONE', TQ + 'One.' + TQ)), doc('def f():\n    DOC_TWO\n    return 1\n'.replace('DOC_TWO', TQ + 'Two, reworded.' + TQ)));
  for (const fn of fns) for (const kind of ['empty', 'throw'] as const) pyMutant('python3', file, fn, kind, '/tmp/m'); // the script verifies every mutant
  const get = (n: string) => fns.find((f) => f.name === n)!;
  assert.match(pyMutant('python3', file, get('emoji'), 'empty'), /def emoji\(s="🎉✓"\): return None\n$/);
  assert.match(pyMutant('python3', file, get('Repo.gen'), 'empty'), /def gen\(self\):\n {8}return; yield\n/);
  assert.match(pyMutant('python3', file, get('Repo.size'), 'throw', '/tmp/m'), /"""How many\."""\n {8}__import__\("builtins"\)\.open\("\/tmp\/m", "a"\)\.write\("1"\); raise Exception\("potemkin: function gutted"\)\n/);
});

test('Python: decorated inner defs, \\u2028 and form feeds, BOM and CRLF', { skip: !python && 'python3 not found' }, () => {
  const src = '﻿' + ['SEP = "a b"\f', 'import functools', 'def deco(f):', '    @functools.wraps(f)', '    def inner(): return 1', '    return inner', 'def g(): return 2', ''].join('\r\n');
  const file = pyFile('d.py', src);
  const fns = pyFunctions('python3', 'd.py', file);
  assert.deepEqual(fns.map((f) => `${f.name}@${f.line}`), ['deco@3', 'deco.inner@4', 'g@7']);
  const deco = pyMutant('python3', file, fns[0], 'empty');
  assert.ok(deco.includes('def deco(f):\r\n    return None\r\ndef g(): return 2'), deco);
  assert.ok(pyMutant('python3', file, fns[2], 'empty').includes('def g(): return None'));
  assert.deepEqual(pyFunctions('python3', 'd.py', '-', src).map((f) => f.fp), fns.map((f) => f.fp)); // the same from stdin
});
