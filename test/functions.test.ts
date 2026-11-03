// The mutator: finds the right functions, and every mutant it writes still parses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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

test('finds named functions, skips constructors, overloads, abstract and ambient ones', () => {
  assert.deepEqual(
    jsFunctions('src/shape.ts', TS).map((f) => `${f.name}@${f.line}`),
    ['Shape.area@6', 'Shape.size@7', 'Shape.size@8', 'Shape.make@10', 'Shape.#secret@11', 'over@14', 'default@16', 'pick@17', 'stream@18', 'get@19', 'post@19', 'del@19', 'module.exports.legacy@20', 'Row@21'],
  );
});

test('every TS mutant parses, keeps the shebang first and turns type checks off', () => {
  for (const fn of jsFunctions('src/shape.ts', TS))
    for (const kind of ['empty', 'throw'] as const) {
      const out = jsMutant(TS, fn, kind);
      assert.ok(out.startsWith('#!/usr/bin/env node\n// @ts-nocheck\n'), `${fn.name} ${kind}`);
      assert.ok(out.includes(kind === 'empty' ? 'undefined' : 'potemkin: function gutted') || (fn.body?.setter && out.includes('{}')), `${fn.name} ${kind}`);
      parse(out, { sourceType: 'unambiguous', plugins: ['typescript', 'decorators'] }); // throws on a syntax error
    }
});

test('the setter is emptied, not made to return', () => {
  const setter = jsFunctions('src/shape.ts', TS).find((f) => f.body?.setter)!;
  assert.match(jsMutant(TS, setter, 'empty'), /set size\(v: number\) \{\}/);
});

test('expression-bodied arrows are swapped for a value, inside their parentheses', () => {
  const make = jsFunctions('src/shape.ts', TS).find((f) => f.name === 'Shape.make')!;
  assert.match(jsMutant(TS, make, 'empty'), /static make = \(\) => \(undefined\);/);
  assert.match(jsMutant(TS, make, 'throw'), /static make = \(\) => \(\(\(\) => \{ throw new Error/);
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

test('the canary throws first, after any shebang', () => {
  assert.equal(canary('src/a.ts', '#!/bin/sh\nexport const x = 1;\n'), '#!/bin/sh\n// @ts-nocheck\nthrow new Error("potemkin canary");\nexport const x = 1;\n');
  assert.equal(canary('src/a.js', 'export const x = 1;\n'), 'throw new Error("potemkin canary");\nexport const x = 1;\n');
  assert.equal(canary('pkg/a.py', 'X = 1\n'), 'raise Exception("potemkin canary")\nX = 1\n');
});

test('tests, mocks, fixtures, configs and type declarations are not source', () => {
  for (const f of ['src/a.test.ts', 'src/__tests__/a.ts', 'test/a.ts', 'tests/helpers.py', 'pkg/test_a.py', 'pkg/a_test.py', 'conftest.py', 'src/types.d.ts', 'vitest.config.ts', 'src/__mocks__/fs.ts', 'fixtures/x.js'])
    assert.ok(NOT_SOURCE.test(f), f);
  for (const f of ['src/a.ts', 'src/testing.ts', 'pkg/contest.py', 'src/attest.js', 'lib/spec_helpers.rb']) assert.ok(!NOT_SOURCE.test(f), f);
});

const python = spawnSync('python3', ['--version']).status === 0;

test('Python: functions, methods, nested and async ones; stubs, __init__ and abstract skipped', { skip: !python && 'python3 not found' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'potemkin-py-'));
  const file = join(dir, 'repo.py');
  writeFileSync(
    file,
    `from __future__ import annotations
from abc import abstractmethod

class Repo:
    def __init__(self):
        self.items = []

    @property
    def size(self):
        """How many."""
        return len(self.items)

    @staticmethod
    def make(): return Repo()

    async def fetch(self, n):
        return n

    def gen(self):
        yield from self.items

    @abstractmethod
    def todo(self): ...

def outer(x):
    def inner(y):
        return y * 2
    return inner(x)

def emoji(s="🎉✓"): return s + "✓"
`,
  );
  const fns = pyFunctions('python3', 'repo.py', file);
  assert.deepEqual(fns.map((f) => `${f.name}@${f.line}`), ['Repo.size@8', 'Repo.make@13', 'Repo.fetch@16', 'Repo.gen@19', 'outer@25', 'outer.inner@26', 'emoji@30']);
  for (const fn of fns) for (const kind of ['empty', 'throw'] as const) pyMutant('python3', file, fn, kind); // the script re-parses every mutant
  const emoji = fns.find((f) => f.name === 'emoji')!;
  assert.match(pyMutant('python3', file, emoji, 'empty'), /def emoji\(s="🎉✓"\): return None\n$/);
  assert.match(pyMutant('python3', file, fns.find((f) => f.name === 'Repo.gen')!, 'empty'), /def gen\(self\):\n {8}return; yield\n/);
  assert.match(pyMutant('python3', file, fns.find((f) => f.name === 'Repo.size')!, 'throw'), /def size\(self\):\n {8}raise Exception\("potemkin: function gutted"\)\n\n/);
});
