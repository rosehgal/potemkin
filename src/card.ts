// Share card: satori lays out the tree as SVG, resvg rasterizes it. Fully local.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';

export interface CardData {
  survive: number; // functions that could be gutted with every test still green
  total: number; // functions with a verdict
  unchecked: number; // UNVERIFIABLE plus not checked: said on the card, never hidden
  worst: { name: string; why: string }[];
  meta: string; // project · base · runner
  stats: string; // one line of totals
}

const require = createRequire(import.meta.url);
// One family name per subset: satori falls back across names listed in fontFamily, not within one name.
const SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'greek'];
const fonts = (pkg: string, family: string, weights: (400 | 800)[]) =>
  SUBSETS.flatMap((s) =>
    weights.flatMap((weight) => {
      let file: string;
      try {
        file = require.resolve(`@fontsource/${pkg}/files/${pkg}-${s}-${weight}-normal.woff`);
      } catch {
        return [];
      }
      return existsSync(file) ? [{ name: `${family}-${s}`, weight, style: 'normal' as const, data: readFileSync(file) }] : [];
    }),
  );
const family = (f: string) => SUBSETS.map((s) => `${f}-${s}`).join(', ');
const SANS = family('Inter');
const MONO = family('Mono');

export const div = (style: Record<string, unknown>, ...children: unknown[]) => ({
  type: 'div',
  props: { style: { display: 'flex', ...style }, children },
});

const INK = '#1f1a17', PAPER = '#f6f1e7', WALL = '#e0a93b', SIDE = '#c48f2c', WINDOW = '#27435f', WOOD = '#8a6a48', RED = '#c2362b', GREEN = '#2f7d4a';

/** A building front. Hollow: braces hold it up from behind, and there is nothing there. */
export function facade(hollow: boolean) {
  const win = () => div({ width: 46, height: 62, background: WINDOW, borderRadius: 4, border: `5px solid ${PAPER}` });
  const row = () => div({ justifyContent: 'space-between', width: 220 }, win(), win(), win());
  const front = div(
    { width: 280, height: 330, background: WALL, flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '34px 0 0', borderTop: `18px solid ${INK}` },
    row(),
    row(),
    div({ width: 70, height: 100, background: INK, borderRadius: '35px 35px 0 0' }),
  );
  if (!hollow) return div({ alignItems: 'flex-end', flexShrink: 0 }, front, div({ width: 90, height: 382, background: SIDE })); // 330 + padding + roof
  const brace = (h: number, deg: number) =>
    div({ position: 'absolute', right: 0, bottom: 0, width: 12, height: h, background: WOOD, transformOrigin: 'bottom right', transform: `rotate(${-deg}deg)` });
  return div(
    { alignItems: 'flex-end', flexShrink: 0 },
    front,
    div(
      { width: 150, height: 382, position: 'relative', borderBottom: `6px solid ${WOOD}` },
      brace(272, 31),
      brace(192, 48),
      div({ position: 'absolute', right: 0, top: 40, fontFamily: MONO, fontSize: 18, color: WOOD }, 'nothing here'),
    ),
  );
}

// JetBrains Mono at 22px: about 45 characters fit the column. Shorten the name, keep the reason,
// and for a long Class.method keep the method.
const fit = (name: string, why: string, width = 45) => {
  const room = Math.max(8, width - why.length - 3);
  if (name.length > room && name.includes('.')) name = name.slice(name.lastIndexOf('.') + 1);
  return `${name.length > room ? `${name.slice(0, room - 1)}…` : name} · ${why}`;
};

export async function renderCard(d: CardData): Promise<Buffer> {
  const hollow = d.survive > 0;
  const also = d.unchecked ? ` ${d.unchecked} more could not be checked.` : '';
  const headline = hollow
    ? d.total === 1
      ? `The function your agent changed could be gutted, and every test would still pass.${also}`
      : `${d.survive === d.total ? 'All' : `${d.survive} of`} ${d.total} functions your agent changed could be gutted, and every test would still pass.${also}`
    : d.total === 1
      ? `The function your agent changed is pinned: gut it and a test turns red.${also}`
      : `All ${d.total} functions your agent changed are pinned: gut one and a test turns red.${also}`;
  const tone = hollow ? RED : GREEN;
  const lines = d.worst.slice(0, 3).map((w) => div({ fontSize: 22, fontFamily: MONO, color: tone, marginTop: 8 }, fit(w.name, w.why)));
  if (d.worst.length > 3) lines.push(div({ fontSize: 20, fontFamily: MONO, color: WOOD, marginTop: 8 }, `+${d.worst.length - 3} more`));
  const tree = div(
    { width: 1200, height: 675, boxSizing: 'border-box', flexDirection: 'column', justifyContent: 'space-between', padding: '52px 64px', background: PAPER, color: INK, fontFamily: SANS },
    div(
      { alignItems: 'center', justifyContent: 'space-between' },
      div({ fontSize: 26, fontWeight: 800, letterSpacing: 6, color: WOOD }, 'POTEMKIN'),
      div({ fontSize: 26, fontFamily: MONO, color: tone }, hollow ? `${d.survive}/${d.total} gutted, still green` : `${d.total}/${d.total} pinned`),
    ),
    div(
      { alignItems: 'center', justifyContent: 'space-between' },
      div(
        { flexDirection: 'column', width: 680, minWidth: 0, flexShrink: 1, marginRight: 40 },
        div({ fontSize: headline.length < 70 ? 50 : headline.length < 100 ? 44 : 38, fontWeight: 800, lineHeight: 1.12, letterSpacing: -1, textWrap: 'balance' }, headline),
        div({ flexDirection: 'column', marginTop: 24 }, ...lines),
      ),
      facade(hollow),
    ),
    div(
      { justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 20, borderTop: `2px solid ${WOOD}`, paddingTop: 18 },
      div({ flexDirection: 'column', maxWidth: 820 }, div({}, d.stats), div({ color: WOOD, marginTop: 6 }, d.meta.length > 70 ? `${d.meta.slice(0, 69)}…` : d.meta)),
      div({ fontFamily: MONO, fontSize: 24 }, 'npx potemkin-cli'),
    ),
  );
  const svg = await satori(tree as any, { width: 1200, height: 675, fonts: [...fonts('inter', 'Inter', [400, 800]), ...fonts('jetbrains-mono', 'Mono', [400])] });
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
}

export const FONTS = () => [...fonts('inter', 'Inter', [400, 800]), ...fonts('jetbrains-mono', 'Mono', [400])];
export { MONO, SANS };
