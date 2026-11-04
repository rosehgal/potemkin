// Finds the named functions in a file, fingerprints each one, and writes two mutants:
// EMPTY guts the body (it returns nothing, does nothing), THROW makes it throw.
// JS and TS go through @babel/parser; Python through Python's own ast module.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse, type ParserPlugin } from '@babel/parser';

export type Mutant = 'empty' | 'throw';

export interface Fn {
  file: string; // repo-relative path
  name: string; // unique within the file: duplicates get #2, #3…
  line: number; // first line, 1-based (decorators included)
  end: number; // last line
  lang: 'js' | 'py';
  fp: string; // structure of the function, without positions, comments or nested functions
  inert: boolean; // already does nothing, or only throws: the EMPTY mutant is the code itself
  body?: { start: number; end: number; expr: boolean; setter: boolean; keep: number }; // js: span to replace; keep = directive prefix
  index?: number; // py: position in the Python script's list
}

export const JS_FILE = /\.[cm]?[jt]sx?$/;
export const PY_FILE = /\.py$/;
const TS_FILE = /\.[cm]?tsx?$/;
// Tests, mocks, fixtures, stories, configs and type declarations are not code under test.
export const NOT_SOURCE =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|__fixtures__)\/|\.(?:test|spec|stories|story)\.[^/]+$|(?:^|\/)(?:test_[^/]*|[^/]*_test|conftest)\.py$|\.d\.[cm]?ts$|(?:^|\/)[^/]*\.config\.[^/]+$/;

// ---- JavaScript / TypeScript ---------------------------------------------

function parseJs(file: string, src: string) {
  const ts = TS_FILE.test(file);
  // Plain .js may hold JSX; .ts never may (it clashes with <T>(x) => x).
  const jsx = /x$/.test(file) || /\.[cm]?js$/.test(file);
  const common: ParserPlugin[] = ['decoratorAutoAccessors', 'deferredImportEvaluation', 'sourcePhaseImports'];
  const tries: ParserPlugin[][] = [];
  for (const dec of ['decorators', 'decorators-legacy'] as const) {
    const base: ParserPlugin[] = [...(ts ? (['typescript'] as const) : []), dec, ...common];
    tries.push(jsx ? [...base, 'jsx'] : base);
    if (jsx && !/x$/.test(file)) tries.push(base);
  }
  let err: unknown;
  for (const plugins of tries) {
    try {
      return parse(src, { sourceType: 'unambiguous', plugins, allowReturnOutsideFunction: true, errorRecovery: false });
    } catch (e) {
      if (e instanceof RangeError) throw new Error('an expression is nested too deeply for the parser'); // Babel recurses per operand
      err = e;
    }
  }
  throw err;
}

const FN_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
const TS_WRAP = /^TS(?:AsExpression|SatisfiesExpression|NonNullExpression|TypeAssertion)$|^ParenthesizedExpression$/;
const unwrap = (n: any): any => (TS_WRAP.test(n?.type) ? unwrap(n.expression) : n);
// A function, or the first function handed to a wrapper: memo(…), forwardRef(…), useCallback(…), React.memo(…).
// Calls on values (items.map(…), arr.reduce(…)) are not wrappers: their callbacks are not the variable's function.
const wrapper = (c: any) => c?.type === 'Identifier' || (c?.type === 'MemberExpression' && c.object?.type === 'Identifier' && /^[A-Z]/.test(c.object.name));
function fnIn(n: any, depth = 0): any {
  n = unwrap(n);
  if (FN_TYPES.has(n?.type)) return n;
  if (n?.type !== 'CallExpression' || depth > 3 || !wrapper(n.callee)) return undefined;
  for (const a of n.arguments) {
    const f = fnIn(a, depth + 1);
    if (f) return f;
  }
  return undefined;
}
const keyName = (k: any, src: string): string =>
  k?.type === 'Identifier' ? k.name : k?.type === 'PrivateName' ? `#${k.id?.name ?? k.name}` : k?.type === 'StringLiteral' ? k.value : src.slice(k.start, k.end);
const SKIP_KEYS = new Set(['loc', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens', 'start', 'end', 'range']);

// Bodies that already do nothing (or only throw): gutting them changes nothing worth reporting.
function inert(body: any): boolean {
  if (body.type !== 'BlockStatement') return body.type === 'Identifier' ? body.name === 'undefined' : body.type === 'UnaryExpression' && body.operator === 'void';
  if (body.body.length === 0) return true;
  if (body.body.length !== 1) return false;
  const s = body.body[0];
  return s.type === 'ThrowStatement' || (s.type === 'ReturnStatement' && (!s.argument || (s.argument.type === 'Identifier' && s.argument.name === 'undefined')));
}

export function jsFunctions(file: string, src: string): Fn[] {
  const ast = parseJs(file, src);
  const nl: number[] = []; // line breaks as git counts them: \n only (Babel also counts U+2028, U+2029, lone \r)
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) nl.push(i);
  const lineAt = (pos: number) => {
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (nl[m] < pos) lo = m + 1;
      else hi = m;
    }
    return lo + 1;
  };
  const found: { name: string; outer: any; fn: any }[] = [];
  const claimed = new Set<any>();
  const scopes = new Map<any, string>(); // a function or class node -> its qualified name, for what sits inside it
  // Names are qualified by what encloses them: Cart.total, api.get, outer.inner. Siblings with the
  // same name are matched by structure, so reordering them never counts as a change.
  const add = (name: string, outer: any, fn: any, scope: string) => {
    if (!fn || claimed.has(fn)) return;
    claimed.add(fn);
    const full = scope ? `${scope}.${name}` : name;
    scopes.set(fn, full);
    if (fn.body?.start != null) found.push({ name: full, outer, fn });
  };
  // Iterative walk: deep expression chains must not overflow the stack.
  const stack: [any, string][] = [[ast.program, '']];
  while (stack.length) {
    const [n, outerScope] = stack.pop()!;
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push([n[i], outerScope]);
      continue;
    }
    if (typeof n.type !== 'string') continue;
    let scope = outerScope;
    const kind = (k: string) => (k === 'get' || k === 'set' ? `${k} ` : '');
    switch (n.type) {
      case 'ClassDeclaration':
      case 'ClassExpression':
        scope = n.id?.name ?? n.__name ?? (n.type === 'ClassDeclaration' ? 'default' : 'class');
        break;
      case 'FunctionDeclaration':
        add(n.id?.name ?? 'default', n, n, outerScope);
        break;
      case 'ClassMethod':
      case 'ClassPrivateMethod':
        if (n.kind !== 'constructor') add(`${kind(n.kind)}${keyName(n.key, src)}`, n, n, outerScope);
        break;
      case 'ObjectMethod':
        add(`${kind(n.kind)}${keyName(n.key, src)}`, n, n, outerScope);
        break;
      case 'ClassProperty':
      case 'ClassPrivateProperty':
      case 'ClassAccessorProperty':
      case 'ObjectProperty':
        if (unwrap(n.value)?.type === 'ObjectExpression') unwrap(n.value).__name = keyName(n.key, src); // api.nested.get
        else add(keyName(n.key, src), n, fnIn(n.value), outerScope);
        break;
      case 'VariableDeclarator':
        if (n.id?.type === 'Identifier') {
          const init = unwrap(n.init);
          if (init?.type === 'ClassExpression' || init?.type === 'ObjectExpression') init.__name = n.id.name;
          else add(n.id.name, n, fnIn(n.init), outerScope);
        }
        break;
      case 'AssignmentExpression':
        add(src.slice(n.left.start, n.left.end), n, fnIn(n.right), outerScope);
        break;
      case 'ExportDefaultDeclaration':
        add('default', n, fnIn(n.declaration), outerScope);
        break;
      case 'TSExportAssignment':
        add('export=', n, fnIn(n.expression), outerScope);
        break;
      case 'FunctionExpression':
        if (n.id) add(n.id.name, n, n, outerScope); // memo(function Row() {…})
        break;
      case 'ObjectExpression':
        if (n.__name) scope = outerScope ? `${outerScope}.${n.__name}` : n.__name;
        break;
    }
    if (scopes.has(n)) scope = scopes.get(n)!; // inside a named function: outer.inner
    const kids: [any, string][] = [];
    for (const k in n) if (!SKIP_KEYS.has(k) && k !== '__name') kids.push([n[k], scope]);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }

  const seen = new Map<string, number>();
  const out: Fn[] = [];
  for (const { name, outer, fn } of found.sort((a, b) => a.outer.start - b.outer.start)) {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    const expr = fn.body.type !== 'BlockStatement';
    const directives = expr ? [] : (fn.body.directives ?? []);
    out.push({
      file,
      name: n > 1 ? `${name}#${n}` : name,
      line: lineAt(outer.start),
      end: lineAt(outer.end - 1),
      lang: 'js',
      fp: fingerprint(outer, fn, claimed, src),
      inert: inert(fn.body),
      body: { start: fn.body.start, end: fn.body.end, expr, setter: fn.kind === 'set', keep: directives.length ? directives.at(-1).end : fn.body.start + 1 },
    });
  }
  return out;
}

// Structural fingerprint: positions, comments, quotes and formatting are ignored, and nested
// named functions are placeholders, so an edit counts only against the function it is in.
function fingerprint(outer: any, self: any, fns: Set<any>, src: string): string {
  const jsxText = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean).join(' '); // what React renders
  try {
    const noise = (x: any) => (x?.type === 'JSXText' && !jsxText(x.value)) || (x?.type === 'JSXExpressionContainer' && x.expression?.type === 'JSXEmptyExpression'); // whitespace, {/* comment */}
    return JSON.stringify(outer, (k, v) => {
      if (SKIP_KEYS.has(k) || k === '__name') return undefined;
      if (!v || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.filter((x) => !noise(x));
      if (v !== self && fns.has(v)) return 'fn';
      if (v.type === 'JSXText') return { type: 'JSXText', value: jsxText(v.value) };
      return v;
    });
  } catch {
    return src.slice(outer.start, outer.end); // too deep to stringify: fall back to the text
  }
}

const THROW = 'throw new Error("potemkin: function gutted");';
// The THROW mutant first leaves a mark, so "tests ran it" is known even when a caller swallows the error.
const mark = (marker?: string) => (marker ? `try { globalThis.process?.getBuiltinModule?.("node:fs")?.appendFileSync(${JSON.stringify(marker)}, "1"); } catch {} ` : '');

export function jsMutant(src: string, fn: Fn, kind: Mutant, marker?: string): string {
  if (fn.inert && kind === 'empty') return src; // it already does nothing: the baseline is the gutted run
  const b = fn.body!;
  // In TS, `as any` keeps the inferred return type, so typed callers in tests still compile (ts-jest typechecks).
  const any = TS_FILE.test(fn.file) ? ' as any' : '';
  let repl: string;
  if (b.expr) repl = kind === 'empty' ? `(undefined${any})` : `((() => { ${mark(marker)}${THROW} })()${any})`;
  else {
    const head = src.slice(b.start, b.keep) + (b.keep > b.start + 1 ? ';' : ''); // "{" plus any 'use server' directives, closed
    repl = kind === 'empty' ? (b.setter ? `${head} }` : `${head} return undefined${any}; }`) : `${head} ${mark(marker)}return (() => { ${THROW} })()${any}; }`;
  }
  return nocheck(fn.file, src.slice(0, b.start) + repl + src.slice(b.end));
}

// A throw at the top of the file. If tests that import the file still pass,
// they are not loading the sandbox copy.
// (Above a `from __future__` import it is a SyntaxError instead, which fails the import just the same.)
// It leaves a mark first, so a load that some fallback swallows still shows up.
export function canary(file: string, src: string, marker?: string): string {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  if (PY_FILE.test(file)) {
    const note = marker ? `__import__("builtins").open(${JSON.stringify(marker)}, "a").write("1")${eol}` : '';
    return `${note}raise Exception("potemkin canary")${eol}${src}`;
  }
  return nocheck(file, afterShebang(src, `${mark(marker)}throw new Error("potemkin canary");${eol}`));
}

function afterShebang(src: string, text: string): string {
  if (!src.startsWith('#!')) return text + src;
  const nl = src.indexOf('\n');
  return nl < 0 ? `${src}\n${text}` : src.slice(0, nl + 1) + text + src.slice(nl + 1);
}

// Belt and braces with `as any`: some setups typecheck the mutated file itself.
const nocheck = (file: string, src: string) => (TS_FILE.test(file) ? afterShebang(src, `// @ts-nocheck${src.includes('\r\n') ? '\r\n' : '\n'}`) : src);

// ---- Python ----------------------------------------------------------------
// One script lists the functions and writes mutants, so offsets never cross between
// Python's UTF-8 columns and JavaScript's UTF-16 strings. It verifies every mutant:
// apart from the target's body, the module must be unchanged.
const PY = String.raw`
import ast, copy, hashlib, json, sys
mode, path = sys.argv[1], sys.argv[2]
raw = sys.stdin.buffer.read() if path == "-" else open(path, "rb").read()
src = raw.decode("utf-8-sig")
tree = ast.parse(src)

def is_stub(fn):
    return all(isinstance(s, ast.Pass) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant)) for s in fn.body)

def only_raises(fn):
    body = fn.body[1:] if len(fn.body) > 1 and is_docstring(fn.body[0]) else fn.body
    return len(body) == 1 and isinstance(body[0], ast.Raise)

def is_docstring(s):
    return isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant) and isinstance(s.value.value, str)

def deco_names(fn):
    out = []
    for d in fn.decorator_list:
        d = d.func if isinstance(d, ast.Call) else d
        out.append(d.id if isinstance(d, ast.Name) else d.attr if isinstance(d, ast.Attribute) else "")
    return out

def collect(tree):
    fns, stack = [], [(tree, "")]
    while stack:
        node, prefix = stack.pop()
        kids = list(ast.iter_child_nodes(node))
        for child in reversed(kids):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                names = deco_names(child)
                suffix = ".setter" if "setter" in names else ".deleter" if "deleter" in names else ""
                name = prefix + child.name + suffix
                skip = child.name == "__init__" or "abstractmethod" in names or "overload" in names
                fns.append((name, child, skip))
                stack.append((child, name + "."))
            elif isinstance(child, ast.ClassDef):
                stack.append((child, prefix + child.name + "."))
            else:
                stack.append((child, prefix))
    fns.sort(key=lambda f: (f[1].lineno, f[1].col_offset))
    return fns

class Strip(ast.NodeTransformer):
    def __init__(self, root):
        self.root = root
    def visit_FunctionDef(self, node):
        if node is self.root:
            return self.generic_visit(node)
        return ast.Name(id="def " + node.name)
    visit_AsyncFunctionDef = visit_FunctionDef

def fingerprint(fn):
    c = copy.deepcopy(fn)
    if len(c.body) > 1 and is_docstring(c.body[0]):
        c.body = c.body[1:]  # a reworded docstring is not a code change
    return hashlib.sha1(ast.dump(Strip(c).visit(c)).encode()).hexdigest()

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

fns = collect(tree)
if mode == "list":
    seen, out = {}, []
    for index, (name, fn, skip) in enumerate(fns):
        seen[name] = seen.get(name, 0) + 1
        if skip:
            continue
        start = min([fn.lineno] + [d.lineno for d in fn.decorator_list])
        out.append({"name": name if seen[name] == 1 else name + "#" + str(seen[name]), "line": start, "end": fn.end_lineno, "index": index, "fp": fingerprint(fn), "inert": is_stub(fn) or only_raises(fn)})
    sys.stdout.write(json.dumps(out))
else:
    idx, kind, marker = int(sys.argv[3]), sys.argv[4], sys.argv[5] if len(sys.argv) > 5 else ""
    fn = fns[idx][1]
    if kind == "empty" and (is_stub(fn) or only_raises(fn)):
        sys.stdout.buffer.write(raw)  # it already does nothing: the baseline is the gutted run
        raise SystemExit(0)
    lines = [l + "\n" for l in src.split("\n")]  # ast counts \n only; splitlines() would also split on \f,  …
    def off(lineno, col):  # col is a UTF-8 byte offset
        return sum(len(l) for l in lines[: lineno - 1]) + len(lines[lineno - 1].encode("utf-8")[:col].decode("utf-8"))
    body = fn.body[1:] if is_docstring(fn.body[0]) and len(fn.body) > 1 else fn.body  # keep the docstring: help text reads it
    first = body[0]
    a = off(min([first.lineno] + [d.lineno for d in getattr(first, "decorator_list", [])]), first.col_offset)
    b = off(body[-1].end_lineno, body[-1].end_col_offset)
    if kind == "empty":
        new = "return; yield" if is_generator(fn) else "return None"
    else:
        note = '__import__("builtins").open(%s, "a").write("1"); ' % json.dumps(marker) if marker else ""
        new = note + 'raise Exception("potemkin: function gutted")'
    out = src[:a] + new + src[b:]
    # Verify: same module once both versions of the target have an empty body.
    before, after = copy.deepcopy(tree), ast.parse(out)
    tb, ta = collect(before)[idx][1], collect(after)[idx][1]
    tb.body = ta.body = [ast.Pass()]
    if ast.dump(before) != ast.dump(after):
        raise SystemExit("mutant would change code outside " + fns[idx][0])
    sys.stdout.buffer.write(out.encode("utf-8"))
`;

function py(python: string, args: string[], input?: string): string {
  // -I: isolated, so a json.py or ast.py in the user's repo cannot shadow the stdlib here.
  const r = spawnSync(python, ['-I', '-c', PY, ...args], { encoding: 'utf8', input, cwd: tmpdir(), maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`${python}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').at(-1) || `${python} exited ${r.status}`);
  return r.stdout;
}

/** `abs` is a file path, or pass the source text as `text` (for the base version of a file). */
export function pyFunctions(python: string, file: string, abs: string, text?: string): Fn[] {
  const list = JSON.parse(py(python, ['list', text === undefined ? abs : '-'], text)) as { name: string; line: number; end: number; index: number; fp: string; inert: boolean }[];
  return list.map((f) => ({ file, name: f.name, line: f.line, end: f.end, lang: 'py', index: f.index, fp: f.fp, inert: f.inert }));
}

export const pyMutant = (python: string, abs: string, fn: Fn, kind: Mutant, marker?: string) =>
  py(python, ['mutate', abs, String(fn.index), kind, ...(marker ? [marker] : [])]);
