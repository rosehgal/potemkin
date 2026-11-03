import { jsFunctions, jsMutant } from '../src/functions.ts';
import { parse } from '@babel/parser';
const cases: [string, string][] = [
  ['a.ts', `export async function act(x: number) { 'use server'\n  return x * 2;\n}\nexport function b() { "use strict"; return 1 }\n`],
  ['b.tsx', `export const Row = memo(forwardRef((p: P, r) => <div ref={r}>{p.x}</div>));\nexport const total = sum(prices.map((p) => p.x));\nconst h = useCallback(() => go(), []);\nconst Foo = class { m() { return 1 } };\nexport default class { n() { return 2 } }\nconst c = { get v() { return 1 }, set v(x) { this.x = x } };\nconst f = ((x: number) => x) satisfies F;\nclass A { accessor y = 1; z = () => ({ a: 1 }) }\n`],
  ['c.ts', `export function noop() {}\nexport const nothing = () => undefined;\nexport function assertNever(x: never): never { throw new Error('x') }\nexport function real() { return 1 }\n`],
];
for (const [file, src] of cases) {
  const fns = jsFunctions(file, src);
  console.log(file, fns.map((f) => `${f.name}@${f.line}-${f.end}`).join(' '));
  for (const f of fns) for (const k of ['empty', 'throw'] as const) {
    const m = jsMutant(src, f, k, '/tmp/x');
    try { parse(m, { sourceType: 'module', plugins: ['typescript', 'decorators', 'decoratorAutoAccessors', ...(file.endsWith('x') ? ['jsx' as const] : [])] }); } catch (e) { console.log('  PARSE FAIL', f.name, k, (e as Error).message, '\n', m); }
  }
  if (file === 'a.ts') console.log(jsMutant(src, fns[0], 'empty'), '\n', jsMutant(src, fns[0], 'throw', '/tmp/m'));
}
