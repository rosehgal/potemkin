import { writeFileSync } from 'node:fs';
import { pyFunctions, pyMutant } from '../src/functions.ts';
const f = '/private/tmp/claude-502/-Users-rohit-rsehgal-github/6edfebee-9bf7-485b-9772-d16cb43826c9/scratchpad/p.py';
const src = '﻿' + [
  'SEP = "a b"\f',
  'import functools',
  'def outer(f):',
  '    @functools.wraps(f)',
  '    def inner(): return 1',
  '    return inner',
  'class C:',
  '    @property',
  '    def size(self):',
  '        """How many."""',
  '        return 3',
  '    @size.setter',
  '    def size(self, v):',
  '        self.v = v',
  '    def boom(self):',
  '        """Never."""',
  '        raise NotImplementedError',
  'def g(): return 2',
].join('\r\n') + '\r\n';
writeFileSync(f, src);
const fns = pyFunctions('python3', 'p.py', f);
console.log(fns.map((x) => `${x.name}@${x.line}-${x.end}`).join(' '));
const base = pyFunctions('python3', 'p.py', f, src);
console.log('stdin same fps:', JSON.stringify(base.map((x) => x.fp)) === JSON.stringify(fns.map((x) => x.fp)));
for (const fn of fns) for (const k of ['empty', 'throw'] as const) {
  try { const m = pyMutant('python3', f, fn, k, '/tmp/mark'); if (fn.name === 'outer' || fn.name === 'C.size' || fn.name === 'g') console.log('---', fn.name, k, JSON.stringify(m.split('\r\n').slice(2, 12).join(' | ')).slice(0, 300), 'crlf kept:', m.includes('\r\n')); }
  catch (e) { console.log('FAIL', fn.name, k, (e as Error).message); }
}
