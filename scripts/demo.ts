// Builds a sample repo where an "agent" just changed five checkout functions and wrote green tests.
// Usage: node scripts/demo.ts DIR [--fixed]   (creates DIR/checkout; vitest comes from this repo's node_modules)
// --fixed writes the tests a careful reviewer would ask for, so nothing survives gutting.
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.argv[2] ?? '.', 'checkout');
const fixed = process.argv.includes('--fixed');
const git = (...args: string[]) => spawnSync('git', args, { cwd: root, stdio: 'ignore' });
const write = (f: string, body: string) => {
  mkdirSync(join(root, f, '..'), { recursive: true });
  writeFileSync(join(root, f), body);
};

write('package.json', '{ "name": "checkout", "type": "module", "scripts": { "test": "vitest run" }, "devDependencies": { "vitest": "^5.1.0" } }\n');
write('.gitignore', 'node_modules\n');
symlinkSync(join(import.meta.dirname, '..', 'node_modules'), join(root, 'node_modules'));
write('src/cart.ts', 'export type Item = { sku: string; price: number; qty: number };\n');
git('init', '-q', '-b', 'main');
git('-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
git('add', '-A');
git('-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', 'cart types');

// The agent's change: five new functions...
write(
  'src/cart.ts',
  `export type Item = { sku: string; price: number; qty: number };
export type Cart = { items: Item[]; coupon?: string };

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function applyCoupon(cart: Cart, code: string): Cart {
  if (code !== 'SAVE10') throw new Error(\`unknown coupon \${code}\`);
  return { ...cart, coupon: code };
}

export function total(cart: Cart): number {
  const sum = subtotal(cart);
  return cart.coupon === 'SAVE10' ? Math.round(sum * 0.9) : sum;
}

export function formatTotal(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function saveCart(cart: Cart, storage: Storage): void {
  storage.setItem('cart', JSON.stringify(cart));
}

export function shippingFor(cart: Cart): number {
  return subtotal(cart) >= 5000 ? 0 : 499;
}
`,
);
// ...and the tests it wrote. All green.
write(
  'src/cart.test.ts',
  `import { describe, expect, it } from 'vitest';
import { applyCoupon, formatTotal, saveCart, shippingFor, subtotal, total, type Cart } from './cart';

const cart: Cart = { items: [{ sku: 'mug', price: 1200, qty: 2 }, { sku: 'tee', price: 2500, qty: 1 }] };

describe('cart', () => {
  it('adds up the subtotal', () => {
    expect(subtotal(cart)).toBe(4900);
  });
  it('rejects unknown coupons', () => {
    expect(() => applyCoupon(cart, 'BOGUS')).toThrow();
  });
  it('takes 10% off with SAVE10', () => {
    expect(total(applyCoupon(cart, 'SAVE10'))).toBe(4410);
  });
${
    fixed
      ? `  it('formats cents as dollars', () => {
    expect(formatTotal(4900)).toBe('$49.00');
  });
  it('saves the cart as JSON', () => {
    const storage = new Map<string, string>();
    saveCart(cart, { setItem: (k: string, v: string) => storage.set(k, v) } as Storage);
    expect(JSON.parse(storage.get('cart')!)).toEqual(cart);
  });
  it('ships free from $50', () => {
    expect(shippingFor(cart)).toBe(499);
    expect(shippingFor({ items: [{ sku: 'tee', price: 2500, qty: 2 }] })).toBe(0);
  });`
      : `  it('formats the total without crashing', () => {
    expect(() => formatTotal(4900)).not.toThrow();
  });
  it('saves the cart', () => {
    const storage = new Map<string, string>();
    saveCart(cart, { setItem: (k: string, v: string) => storage.set(k, v) } as Storage);
    expect(storage).toBeDefined();
  });`
  }
});
`,
);
