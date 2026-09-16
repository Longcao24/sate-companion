#!/usr/bin/env node
/**
 * SATE design system — drift checker.
 *
 * A design system that is only a document rots. This makes it enforceable: point it at a
 * project and it reports every colour that is close to a token but not the token, plus any
 * misuse of the semantic annotation palette.
 *
 *   node verify.mjs ../sate-devapi/src        # check one project
 *   node verify.mjs ../sate-devapi/src --ci   # exit non-zero on any violation
 *
 * It flags near-misses, not unknown colours: an off-by-a-shade grey is drift, while a
 * deliberate one-off illustration colour is not this tool's business. Perceptual distance
 * is measured in CIELAB ΔE, so "#2564ec is basically the primary" is caught but "#16a34a is
 * a different hue entirely" is not.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
const CI = process.argv.includes('--ci');

if (!target) {
  console.error('usage: node verify.mjs <path-to-project> [--ci]');
  process.exit(2);
}

const tokens = JSON.parse(readFileSync(join(HERE, 'tokens.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Colour maths — ΔE in CIELAB. Hex distance would call #000010 and #100000 equally
// far from black, which is not how an eye works.
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function rgbToLab([r, g, b]) {
  const f = (v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const [R, G, B] = [f(r), f(g), f(b)];
  // sRGB -> XYZ (D65), then XYZ -> Lab
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const g2 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [g2(X), g2(Y), g2(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const deltaE = (a, b) => {
  const [l1, a1, b1] = rgbToLab(hexToRgb(a));
  const [l2, a2, b2] = rgbToLab(hexToRgb(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

// ---------------------------------------------------------------------------
// Flatten the token tree into a lookup of canonical colours.
// ---------------------------------------------------------------------------
const PALETTE = [];
(function walk(node, path) {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$')) continue;
    if (value && typeof value === 'object') {
      if (typeof value.value === 'string' && value.value.startsWith('#')) {
        PALETTE.push({ name: [...path, key].join('.'), hex: value.value.toLowerCase() });
      } else {
        for (const k of ['dot', 'bg']) {
          if (typeof value[k] === 'string' && value[k].startsWith('#')) {
            PALETTE.push({ name: [...path, key, k].join('.'), hex: value[k].toLowerCase(), semantic: true });
          }
        }
        walk(value, [...path, key]);
      }
    }
  }
})(tokens.color, []);

const CANONICAL = new Set(PALETTE.map((p) => p.hex));

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
const EXTS = new Set(['.css', '.ts', '.tsx', '.js', '.jsx', '.html', '.svelte', '.vue']);
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.wrangler', 'coverage']);

function files(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

// ΔE ~2.3 is the "just noticeable difference"; below ~6 two colours read as the same
// intent, which is exactly the band where drift hides.
const NEAR = 6;

const drift = [];
const seen = new Map();

for (const file of files(target)) {
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
      const hex = match[0].toLowerCase();
      const norm = hex.length === 4 ? '#' + [...hex.slice(1)].map((c) => c + c).join('') : hex;
      if (CANONICAL.has(norm)) continue;

      let best = null;
      for (const token of PALETTE) {
        const d = deltaE(norm, token.hex);
        if (!best || d < best.d) best = { d, token };
      }
      if (best && best.d < NEAR) {
        const key = norm + '->' + best.token.name;
        if (!seen.has(key)) seen.set(key, { hex: norm, token: best.token, d: best.d, hits: [] });
        seen.get(key).hits.push(`${relative(process.cwd(), file)}:${i + 1}`);
      }
    }
  });
}

for (const v of seen.values()) drift.push(v);
drift.sort((a, b) => a.d - b.d);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m', b: '\x1b[1m' };

console.log(`${C.b}SATE design system v${tokens.version} — drift check${C.x}`);
console.log(`${C.d}target: ${target} · ${PALETTE.length} canonical colours${C.x}\n`);

if (drift.length === 0) {
  console.log(`${C.g}${C.b}No colour drift. Every colour is either a token or clearly deliberate.${C.x}\n`);
} else {
  console.log(`${C.y}${C.b}${drift.length} near-miss colour${drift.length === 1 ? '' : 's'} — ` +
              `close enough to a token to read as the same intent, but not the token:${C.x}\n`);
  for (const v of drift) {
    const semantic = v.token.semantic ? `  ${C.r}(semantic annotation colour — meaning, not decoration)${C.x}` : '';
    console.log(`  ${C.y}${v.hex}${C.x} → should be ${C.b}${v.token.hex}${C.x} (${v.token.name}, ΔE ${v.d.toFixed(1)})${semantic}`);
    console.log(`    ${C.d}${v.hits.slice(0, 4).join(', ')}${v.hits.length > 4 ? ` +${v.hits.length - 4} more` : ''}${C.x}`);
  }
  console.log('');
}

if (CI && drift.length) process.exit(1);
