// Finds the named functions in a file and writes two mutants for each:
// EMPTY guts the body (it returns nothing, does nothing), THROW makes it throw.
// JS and TS go through @babel/parser; Python through Python's own ast module.
import { spawnSync } from 'node:child_process';
import { parse, type ParserPlugin } from '@babel/parser';

export type Mutant = 'empty' | 'throw';

export interface Fn {
  file: string; // repo-relative path
  name: string;
  line: number; // first line, 1-based (decorators included)
  end: number; // last line
  lang: 'js' | 'py';
  body?: { start: number; end: number; expr: boolean; setter: boolean }; // js: the span to replace
  index?: number; // py: position in the Python script's list
}

export const JS_FILE = /\.[cm]?[jt]sx?$/;
export const PY_FILE = /\.py$/;
const TS_FILE = /\.[cm]?tsx?$/;
// Tests, mocks, fixtures, configs and type declarations are not code under test.
export const NOT_SOURCE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$|\.d\.[cm]?ts$|(?:^|\/)[^/]*\.config\.[^/]+$/;

// ---- JavaScript / TypeScript ---------------------------------------------

function parseJs(file: string, src: string) {
  const ts = TS_FILE.test(file);
  // Plain .js may hold JSX; .ts never may (it clashes with <T>(x) => x).
  const jsx = /x$/.test(file) || /\.[cm]?js$/.test(file);
  const tries: ParserPlugin[][] = [];
  for (const dec of ['decorators', 'decorators-legacy'] as const) {
    const base: ParserPlugin[] = [...(ts ? (['typescript'] as const) : []), dec];
    tries.push(jsx ? [...base, 'jsx'] : base);
    if (jsx && !/x$/.test(file)) tries.push(base);
  }
  let err: unknown;
  for (const plugins of tries) {
    try {
      return parse(src, { sourceType: 'unambiguous', plugins, errorRecovery: false });
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

const isFn = (n: any) => n?.type === 'ArrowFunctionExpression' || n?.type === 'FunctionExpression';
const keyName = (k: any, src: string): string =>
  k?.type === 'Identifier' ? k.name : k?.type === 'PrivateName' ? `#${k.id?.name ?? k.name}` : k?.type === 'StringLiteral' ? k.value : src.slice(k.start, k.end);
const SKIP_KEYS = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

export function jsFunctions(file: string, src: string): Fn[] {
  const ast = parseJs(file, src);
  const out: Fn[] = [];
  const claimed = new Set<any>();
  const add = (name: string, outer: any, fn: any) => {
    claimed.add(fn);
    if (!fn.body || fn.body.start == null) return;
    const expr = fn.body.type !== 'BlockStatement';
    out.push({
      file,
      name,
      line: outer.loc.start.line,
      end: outer.loc.end.line,
      lang: 'js',
      body: { start: fn.body.start, end: fn.body.end, expr, setter: fn.kind === 'set' },
    });
  };
  const visit = (n: any, cls: string) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c, cls);
      return;
    }
    if (typeof n.type !== 'string') return;
    switch (n.type) {
      case 'ClassDeclaration':
      case 'ClassExpression':
        cls = n.id?.name ?? 'class';
        break;
      case 'FunctionDeclaration':
        add(n.id?.name ?? 'default', n, n);
        break;
      case 'ClassMethod':
      case 'ClassPrivateMethod':
        if (n.kind !== 'constructor') add(`${cls}.${keyName(n.key, src)}`, n, n);
        break;
      case 'ObjectMethod':
        add(keyName(n.key, src), n, n);
        break;
      case 'ClassProperty':
      case 'ClassPrivateProperty':
      case 'ClassAccessorProperty':
        if (isFn(n.value)) add(`${cls}.${keyName(n.key, src)}`, n, n.value);
        break;
      case 'ObjectProperty':
        if (isFn(n.value)) add(keyName(n.key, src), n, n.value);
        break;
      case 'VariableDeclarator':
        if (isFn(n.init) && n.id?.type === 'Identifier') add(n.id.name, n, n.init);
        break;
      case 'AssignmentExpression':
        if (isFn(n.right)) add(src.slice(n.left.start, n.left.end), n, n.right);
        break;
      case 'ExportDefaultDeclaration':
        if (isFn(n.declaration)) add('default', n, n.declaration);
        break;
      case 'FunctionExpression':
        if (n.id && !claimed.has(n)) add(n.id.name, n, n); // memo(function Row() {…})
        break;
    }
    for (const k in n) if (!SKIP_KEYS.has(k)) visit(n[k], cls);
  };
  visit(ast.program, 'class');
  return out;
}

const THROW_JS = 'throw new Error("potemkin: function gutted");';

export function jsMutant(src: string, fn: Fn, kind: Mutant): string {
  const b = fn.body!;
  const repl = b.expr
    ? kind === 'empty'
      ? 'undefined'
      : `(() => { ${THROW_JS} })()`
    : kind === 'empty'
      ? b.setter
        ? '{}'
        : '{ return undefined; }'
      : `{ ${THROW_JS} }`;
  return nocheck(fn.file, src.slice(0, b.start) + repl + src.slice(b.end));
}

// A throw at the top of the file. If tests that import the file still pass,
// they are not loading the sandbox copy.
// (Above a `from __future__` import it is a SyntaxError instead, which fails the import just the same.)
export function canary(file: string, src: string): string {
  if (PY_FILE.test(file)) return `raise Exception("potemkin canary")\n${src}`;
  return nocheck(file, afterShebang(src, 'throw new Error("potemkin canary");\n'));
}

function afterShebang(src: string, text: string): string {
  if (!src.startsWith('#!')) return text + src;
  const nl = src.indexOf('\n');
  return nl < 0 ? `${src}\n${text}` : src.slice(0, nl + 1) + text + src.slice(nl + 1);
}

// ts-jest and friends typecheck; a gutted `(): number` must not fail on types instead of behavior.
const nocheck = (file: string, src: string) => (TS_FILE.test(file) ? afterShebang(src, '// @ts-nocheck\n') : src);

// ---- Python ----------------------------------------------------------------
// One script both lists the functions and writes a mutant, so offsets never cross
// between Python's UTF-8 columns and JavaScript's UTF-16 strings.
const PY = String.raw`
import ast, json, sys
mode, path = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
tree = ast.parse(src)
fns = []

def is_stub(fn):
    return all(isinstance(s, ast.Pass) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant)) for s in fn.body)

def is_abstract(fn):
    return any((isinstance(d, ast.Name) and d.id in ("abstractmethod", "overload")) or (isinstance(d, ast.Attribute) and d.attr in ("abstractmethod", "overload")) for d in fn.decorator_list)

def walk(node, prefix):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            name = prefix + child.name
            if child.name != "__init__" and not is_stub(child) and not is_abstract(child):
                start = min([child.lineno] + [d.lineno for d in child.decorator_list])
                fns.append((name, start, child.end_lineno, child))
            walk(child, name + ".")
        elif isinstance(child, ast.ClassDef):
            walk(child, prefix + child.name + ".")
        else:
            walk(child, prefix)

def is_generator(fn):
    stack = list(fn.body)
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.Yield, ast.YieldFrom)):
            return True
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        stack.extend(ast.iter_child_nodes(n))
    return False

walk(tree, "")
if mode == "list":
    print(json.dumps([{"name": n, "line": s, "end": e} for n, s, e, _ in fns]))
else:
    fn = fns[int(sys.argv[3])][3]
    lines = src.splitlines(keepends=True)
    def off(lineno, col):  # col is a UTF-8 byte offset
        return sum(len(l) for l in lines[: lineno - 1]) + len(lines[lineno - 1].encode("utf-8")[:col].decode("utf-8"))
    a = off(fn.body[0].lineno, fn.body[0].col_offset)
    b = off(fn.body[-1].end_lineno, fn.body[-1].end_col_offset)
    if sys.argv[4] == "empty":
        new = "return; yield" if is_generator(fn) else "return None"
    else:
        new = 'raise Exception("potemkin: function gutted")'
    out = src[:a] + new + src[b:]
    ast.parse(out)
    sys.stdout.write(out)
`;

function py(python: string, args: string[]): string {
  const r = spawnSync(python, ['-c', PY, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`${python}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) || `${python} exited ${r.status}`);
  return r.stdout;
}

export function pyFunctions(python: string, file: string, abs: string): Fn[] {
  const list = JSON.parse(py(python, ['list', abs])) as { name: string; line: number; end: number }[];
  return list.map((f, index) => ({ file, name: f.name, line: f.line, end: f.end, lang: 'py', index }));
}

export const pyMutant = (python: string, abs: string, fn: Fn, kind: Mutant) => py(python, ['mutate', abs, String(fn.index), kind]);
