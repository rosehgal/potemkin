// Share card: satori lays out the tree as SVG, resvg rasterizes it. Fully local.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

export interface CardData {
  survive: number; // functions that could be gutted with every test still green
  total: number; // functions with a verdict
  worst: string[]; // up to 3 lines, e.g. "formatPrice · 3 tests call it, all stayed green"
  meta: string; // project · base · runner
  stats: string; // one line of totals
}

const require = createRequire(import.meta.url);
const font = (pkg: string, weight: 400 | 800, name: string) => ({
  name,
  weight,
  style: 'normal' as const,
  data: readFileSync(require.resolve(`@fontsource/${pkg}/files/${pkg}-latin-${weight}-normal.woff`)),
});

const div = (style: Record<string, unknown>, ...children: unknown[]) => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children },
});

const INK = '#1f1a17', PAPER = '#f6f1e7', WALL = '#e0a93b', WINDOW = '#27435f', WOOD = '#8a6a48', RED = '#c2362b', GREEN = '#2f7d4a';

// A building front. Hollow: wooden props hold it up and there is nothing behind it.
function facade(hollow: boolean) {
  const win = () => div({ width: 46, height: 62, background: WINDOW, borderRadius: 4, border: `5px solid ${PAPER}` });
  const row = () => div({ justifyContent: 'space-between', width: 220 }, win(), win(), win());
  const front = div(
    { width: 280, height: 330, background: WALL, flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '34px 0 0', borderTop: `18px solid ${INK}` },
    row(),
    row(),
    div({ width: 70, height: 100, background: INK, borderRadius: '35px 35px 0 0' }),
  );
  if (!hollow) return div({ alignItems: 'flex-end' }, front, div({ width: 90, height: 348, background: '#c48f2c' }));
  const prop = (h: number, deg: number) => div({ position: 'absolute', left: 0, bottom: 0, width: 12, height: h, background: WOOD, transformOrigin: 'bottom left', transform: `rotate(${deg}deg)` });
  return div(
    { alignItems: 'flex-end' },
    front,
    div(
      { width: 150, height: 348, position: 'relative', borderBottom: `6px solid ${WOOD}` },
      prop(330, 22),
      prop(250, 38),
      div({ position: 'absolute', right: 0, top: 120, fontFamily: 'Mono', fontSize: 18, color: WOOD }, 'nothing here'),
    ),
  );
}

export async function renderCard(d: CardData): Promise<Buffer> {
  const hollow = d.survive > 0;
  const headline = hollow
    ? `${d.survive} of ${d.total} functions your agent changed could be gutted, and every test would still pass.`
    : `All ${d.total} functions your agent changed are pinned by a test. Gut one and a test turns red.`;
  const tone = hollow ? RED : GREEN;
  const tree = div(
    { width: 1200, height: 675, boxSizing: 'border-box', flexDirection: 'column', justifyContent: 'space-between', padding: '52px 64px', background: PAPER, color: INK, fontFamily: 'Inter' },
    div(
      { alignItems: 'center', justifyContent: 'space-between' },
      div({ fontSize: 26, fontWeight: 800, letterSpacing: 6, color: WOOD }, 'POTEMKIN'),
      div({ fontSize: 26, fontFamily: 'Mono', color: tone }, hollow ? `${d.survive}/${d.total} hollow` : `0/${d.total} hollow`),
    ),
    div(
      { alignItems: 'center', justifyContent: 'space-between' },
      div(
        { flexDirection: 'column', width: 680 },
        div({ fontSize: headline.length < 80 ? 50 : 44, fontWeight: 800, lineHeight: 1.12, letterSpacing: -1 }, headline),
        div(
          { flexDirection: 'column', marginTop: 26 },
          ...d.worst.slice(0, 3).map((w) => div({ fontSize: 22, fontFamily: 'Mono', color: tone, marginTop: 8 }, w.length > 58 ? `${w.slice(0, 57)}…` : w)),
        ),
      ),
      facade(hollow),
    ),
    div(
      { justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 20, borderTop: `2px solid ${WOOD}`, paddingTop: 18 },
      div({ flexDirection: 'column', maxWidth: 820 }, div({}, d.stats), div({ color: WOOD, marginTop: 6 }, d.meta)),
      div({ fontFamily: 'Mono', fontSize: 24 }, 'npx potemkin-cli'),
    ),
  );
  const svg = await satori(tree as any, {
    width: 1200,
    height: 675,
    fonts: [font('inter', 400, 'Inter'), font('inter', 800, 'Inter'), font('jetbrains-mono', 400, 'Mono')],
  });
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
}
