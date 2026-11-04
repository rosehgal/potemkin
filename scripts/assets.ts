// Regenerates the README images in docs/ from the sample repo in scripts/demo.ts.
// Usage: node scripts/assets.ts   (the terminal GIF comes from `vhs scripts/demo.tape`)
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { facade, FONTS, MONO, SANS } from '../src/card.ts';

const root = join(import.meta.dirname, '..');
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });

for (const [variant, out] of [['', 'card.png'], ['--fixed', 'card-clean.png']]) {
  const dir = mkdtempSync(join(tmpdir(), 'potemkin-demo-'));
  spawnSync(process.execPath, ['scripts/demo.ts', dir, ...(variant ? [variant] : [])], { cwd: root, stdio: 'inherit' });
  const r = spawnSync(process.execPath, [join(root, 'src', 'cli.ts'), '--share', '--out', join(docs, out)], { cwd: join(dir, 'checkout'), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  if (r.status) throw new Error(r.stderr);
}

// Banner, also used as the GitHub social preview (1280×640).
const div = (style: Record<string, unknown>, ...children: unknown[]) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });
const INK = '#1f1a17', PAPER = '#f6f1e7', WOOD = '#8a6a48', RED = '#c2362b', GREEN = '#2f7d4a', AMBER = '#b07a12';
const chip = (label: string, color: string) =>
  div({ padding: '8px 16px', borderRadius: 10, border: `2px solid ${color}`, color, fontFamily: MONO, fontSize: 22, marginRight: 14 }, label);

const banner = div(
  { width: 1280, height: 640, boxSizing: 'border-box', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 80px', background: PAPER, color: INK, fontFamily: SANS },
  div({ fontSize: 30, fontWeight: 800, letterSpacing: 8, color: WOOD }, 'POTEMKIN'),
  div(
    { alignItems: 'center', justifyContent: 'space-between' },
    div(
      { flexDirection: 'column', width: 700, minWidth: 0, flexShrink: 1 },
      div({ fontSize: 52, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.1 }, 'Your agent’s tests are green.'),
      div({ fontSize: 52, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1.1, color: RED }, 'Are they testing anything?'),
      div({ fontSize: 26, lineHeight: 1.35, marginTop: 24, maxWidth: 660 }, 'Potemkin guts every function your agent changed and runs the tests again. The ones that stay green are a facade.'),
    ),
    facade(true),
  ),
  div(
    { alignItems: 'center', justifyContent: 'space-between' },
    div({}, chip('NOTICED', GREEN), chip('HOLLOW', RED), chip('UNTESTED', AMBER)),
    div({ fontFamily: MONO, fontSize: 30 }, 'npx potemkin-cli'),
  ),
);
const svg = await satori(banner as any, { width: 1280, height: 640, fonts: FONTS() });
writeFileSync(join(docs, 'banner.png'), new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng());
console.log('docs/card.png, docs/card-clean.png, docs/banner.png');
