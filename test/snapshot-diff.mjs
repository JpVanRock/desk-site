// Compare two number snapshots written by smoke.mjs (SMOKE_SNAPSHOT), route by route.
//
//   node test/snapshot-diff.mjs before.json after.json
//
// A change that only restyles the site must not move a figure. Every text fragment containing a
// digit is compared as a multiset per route, so a figure that merely moved on the page is not a
// difference, but one that changed, appeared or vanished is. Only spelling is normalised: a real
// minus sign for a hyphen, thousands separators, and spacing. Anything else is printed, with the
// label it sat under, and the exit code is 1 -- the difference has to be explained, not ignored.
import { readFileSync } from 'node:fs';

const [, , a, b] = process.argv;
if (!a || !b) { console.error('usage: snapshot-diff.mjs before.json after.json'); process.exit(2); }
const before = JSON.parse(readFileSync(a, 'utf8')), after = JSON.parse(readFileSync(b, 'utf8'));

const norm = t => t
  .replace(/−/g, '-')
  .replace(/(\d),(?=\d{3}\b)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

const count = list => { const m = new Map(); for (const f of list) { const k = norm(f.text); m.set(k, (m.get(k) || []).concat(f)); } return m; };
let changed = 0, total = 0;
for (const route of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
  const x = count(before[route] || []), y = count(after[route] || []);
  const gone = [], added = [];
  for (const [k, fs] of x) { const n = (y.get(k) || []).length; for (let i = n; i < fs.length; i++) gone.push(fs[i]); }
  for (const [k, fs] of y) { const n = (x.get(k) || []).length; for (let i = n; i < fs.length; i++) added.push(fs[i]); }
  total += (before[route] || []).length;
  if (!gone.length && !added.length) continue;
  changed++;
  console.log(`\n${route}: ${gone.length} gone, ${added.length} new`);
  for (const f of gone.slice(0, 12)) console.log(`  - [${f.label}] ${f.text}`);
  for (const f of added.slice(0, 12)) console.log(`  + [${f.label}] ${f.text}`);
  if (gone.length > 12 || added.length > 12) console.log('  …');
}
console.log(`\n${changed ? `${changed} route(s) differ` : 'Every figure identical'} (${total} figures on ${Object.keys(before).length} routes before).`);
process.exit(changed ? 1 : 0);
