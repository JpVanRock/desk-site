// Smoke harness for desk-site.
//
// WHAT THIS IS. app.js is one IIFE that talks to the DOM, window.supabase and location. This file
// stubs those three, evaluates app.js against them, lets it sign in and load, and then drives it
// by firing the hashchange listeners it registered. Nothing is mocked below that line: every query
// goes to the REAL database, so the pages render the figures the site renders.
//
// WHY IT EXISTS. Almost every bug this site has had rendered as a plausible number rather than an
// error. A contribution table that summed to 200% because a dated set was loaded without filtering
// to the newest run. A 5-year CAGR of +466% from a stub price. Tabs that drew correctly and did
// nothing because the handler was never wired. A monthly grid that silently went blank when the
// table crossed PostgREST's 1000-row cap. None of those throw. So the assertions here are mostly
// about INTERNAL AGREEMENT — a total matching its parts, a figure matching the same figure
// elsewhere on the page, a control actually changing what it claims to change — because that is
// the shape these failures take.
//
// WRITES ARE STUBBED. The builder below answers upsert and delete with a no-op. The harness reads
// production and must never write to it: an earlier version of the classification test would have
// rewritten the owner's own look-throughs on every run.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node test/smoke.mjs
//   node test/smoke.mjs --route '#stan/<id>'   one route only, no interaction tests
//   node test/smoke.mjs --dump                 write the rendered page to preview/_page.html
//   node test/smoke.mjs --empties              list every empty state it rendered
//
// The key is read from the environment and never from a file in this repo. It lives in the
// orchestration repo's .env, which is gitignored there:
//   export $(grep -E '^SUPABASE_(URL|SERVICE_ROLE_KEY)=' ../family-office-agentic-orchestration/.env | xargs)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const argOf = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const argRoute = argOf('--route');
const wantDump = process.argv.includes('--dump');
const wantEmpties = process.argv.includes('--empties');

// The URL comes from the site's own config so the harness cannot test a different database than
// the one it ships against. The key does not: it is a secret and belongs in the environment.
const cfgSrc = readFileSync(join(SITE, 'config.js'), 'utf8');
const SUPABASE_URL = process.env.SUPABASE_URL || (cfgSrc.match(/url:\s*"([^"]+)"/) || [])[1];
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL) { console.error('No Supabase URL in config.js and none in SUPABASE_URL.'); process.exit(2); }
if (!KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set. The harness reads the real database, so it needs a key.\n' +
    "  export $(grep -E '^SUPABASE_(URL|SERVICE_ROLE_KEY)=' ../family-office-agentic-orchestration/.env | xargs)");
  process.exit(2);
}
const REST = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const errors = [];
let currentRoute = 'boot';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Supabase stub: reads proxy to PostgREST, writes go nowhere.
// ---------------------------------------------------------------------------
async function runQuery(st) {
  const params = [...st.filters];
  params.push('select=' + encodeURIComponent(st.select));
  if (st.order) params.push('order=' + st.order);
  if (st.limit) params.push('limit=' + st.limit);
  const headers = { ...REST };
  if (st.range) headers.Range = `${st.range[0]}-${st.range[1]}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${st.table}?${params.join('&')}`, { headers });
  if (!res.ok) return { data: null, error: { message: `${res.status} ${await res.text()}` } };
  const data = await res.json();
  // PostgREST caps a response at 1000 rows and says so only in the Content-Range header. A table
  // that crosses it comes back truncated and looking perfectly healthy, which is how the monthly
  // grid went blank. Treat a full page as a failure: the site should be reading a latest_* view.
  if (!st.range && Array.isArray(data) && data.length >= 1000) {
    errors.push(`[data] ${st.table} returned ${data.length} rows — at or over PostgREST's cap, so the site is getting a truncated page. Read a newest-run view instead.`);
  }
  return { data, error: null };
}
function builder(table) {
  const st = { table, select: '*', filters: [], order: null, limit: null };
  const b = {
    select(c) { st.select = c; return b; },
    eq(k, v) { st.filters.push(`${k}=eq.${v}`); return b; },
    is(k, v) { st.filters.push(`${k}=is.${v === null ? 'null' : v}`); return b; },
    in(k, v) { st.filters.push(`${k}=in.(${v.join(',')})`); return b; },
    order(c, o) { st.order = `${c}.${o && o.ascending === false ? 'desc' : 'asc'}`; return b; },
    limit(n) { st.limit = n; return b; },
    range(a, z) { st.range = [a, z]; return b; },
    then(res, rej) { runQuery(st).then(res, rej); },
    // Writes are stubbed. The harness reads production; it must never change it.
    upsert: async () => ({ data: null, error: null }),
    delete() { return { eq: async () => ({ data: null, error: null }) }; },
  };
  return b;
}

// ---------------------------------------------------------------------------
// DOM stub. The innerHTML setter is where most of the value is: anything that renders a literal
// undefined, NaN or [object Object] is a formatting bug that reached the page.
// ---------------------------------------------------------------------------
class El {
  constructor(id) {
    this.id = id; this._html = ''; this.hidden = false; this.textContent = ''; this.value = '';
    this.dataset = {}; this.style = {}; this.disabled = false; this.required = false; this.minLength = 0;
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  set innerHTML(v) {
    this._html = String(v);
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      const at = this._html.indexOf('>' + bad + '<') >= 0 ? this._html.indexOf('>' + bad + '<') : this._html.indexOf('"' + bad + '"');
      if (at >= 0) errors.push(`[${currentRoute}] #${this.id} rendered a literal ${bad}: …${this._html.slice(Math.max(0, at - 160), at + 40).replace(/\s+/g, ' ')}…`);
    }
  }
  get innerHTML() { return this._html; }
  addEventListener() {} removeEventListener() {} querySelector() { return new El('sub'); }
  querySelectorAll() { return []; } closest() { return new El('closest'); }
  focus() {} reset() {} setAttribute() {} getAttribute() { return null; } appendChild() {} remove() {}
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; }
}
const els = new Map();
const el = id => { const k = String(id); if (!els.has(k)) els.set(k, new El(k.replace('#', ''))); return els.get(k); };
const docListeners = {}, winListeners = {};

globalThis.document = {
  querySelector: el, querySelectorAll: () => [],
  addEventListener: (t, f) => (docListeners[t] ||= []).push(f),
  documentElement: { dataset: {}, setAttribute() {}, getAttribute: () => null },
  createElement: () => new El('created'),
  body: new El('body'),
};
globalThis.location = {
  hash: '#sisyphus', href: 'http://localhost/', pathname: '/',
  // The app retires old hashes with location.replace, so the stub honours it and re-runs the
  // router the way a browser would. Without this the redirect tests pass vacuously.
  replace(h) { this.hash = h.startsWith('#') ? h : '#' + h; for (const f of winListeners.hashchange || []) f(); },
};
globalThis.history = { replaceState(_a, _b, url) { const i = String(url).indexOf('#'); if (i >= 0) location.hash = String(url).slice(i); } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.window = {
  addEventListener: (t, f) => (winListeners[t] ||= []).push(f),
  DESK_CONFIG: { url: SUPABASE_URL, key: KEY },
  supabase: {
    createClient: () => ({
      from: builder,
      auth: {
        // A session the app will accept: enter() checks app_metadata.desk_member.
        getSession: async () => ({ data: { session: { user: { email: 'smoke@harness', app_metadata: { desk_member: true } } } } }),
        onAuthStateChange() {}, signOut: async () => ({}), updateUser: async () => ({}),
        signInWithPassword: async () => ({ error: null }),
      },
    }),
  },
  innerWidth: 1600, innerHeight: 900,
  getComputedStyle: () => ({ color: '' }),
};
for (const k of ['DESK_CONFIG', 'supabase']) globalThis[k] = window[k];

// ---------------------------------------------------------------------------
const src = readFileSync(join(SITE, 'app.js'), 'utf8');
try { (0, eval)(src); } catch (e) { console.error('FAILED to evaluate app.js:', e); process.exit(1); }

async function go(hash) {
  currentRoute = hash;
  location.hash = hash;
  for (const f of winListeners.hashchange || []) { try { await f(); } catch (e) { errors.push(`[${hash}] threw: ${e.message}`); } }
  // The chart drawers render "Loading chart…" and then fetch price history, so a short wait here
  // reports a drawer that works as a drawer that hangs. Long enough for the fetch, not so long
  // that the whole walk crawls.
  await sleep(1800);
}
// Fire every registered click handler with a closest() that answers for ONE selector and null for
// every other. Answering for all of them is how an earlier version of this file silently invoked
// commitSplits and wrote to the database.
async function click(sel, dataset) {
  for (const f of docListeners.click || []) {
    try { f({ target: { closest: s => (s === sel ? { dataset, disabled: false } : null) } }); }
    catch (e) { errors.push(`[${currentRoute}] click ${sel} threw: ${e.message}`); }
  }
  await sleep(200);
}
async function change(sel, dataset, value) {
  for (const f of docListeners.change || []) {
    try { f({ target: { closest: s => (s === sel ? { dataset, value } : null) } }); }
    catch (e) { errors.push(`[${currentRoute}] change ${sel} threw: ${e.message}`); }
  }
  await sleep(200);
}
const app = () => el('#app').innerHTML;
const drawer = () => el('#drawer').innerHTML;
const both = () => app() + drawer();
const say = s => console.log(s);
const need = (cond, msg) => { if (!cond) errors.push(msg); return cond; };

// Boot: the app's own load path, so the harness tests what the site does.
for (const f of winListeners.load || []) { try { await f(); } catch (e) { errors.push(`[boot] ${e.message}`); } }
await sleep(3500);

const pick = async (t, sel, extra = '') => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=${sel}&limit=1${extra}`, { headers: REST });
  return (await r.json())[0];
};
const strat = await pick('strategies', 'id,name', '&name=eq.Balanced%20Core') || await pick('strategies', 'id,name');
const sec = await pick('securities', 'id,ticker', '&role=eq.watchlist');
const series = await pick('current_macro_readings', 'series_id,fred_code');

// ---------------------------------------------------------------------------
// 1. Every route renders something that is not an error or a loading state.
// ---------------------------------------------------------------------------
const routes = argRoute ? [argRoute] : [
  '#sisyphus', '#stan', '#sven', '#annie', '#markets', '#views', '#signals', '#agents',
  '#playground', '#briefs', '#sources', '#inbox', '#status',
  strat ? `#sisyphus/${strat.id}` : null,
  strat ? `#stan/${strat.id}` : null,
  sec ? `#markets/${sec.id}` : null,
  series ? `#views/${series.series_id}` : null,
  '#stan/speed-limit', strat ? `#stan/top3-${strat.id}` : null,
  '#stan/snr-predictive', '#stan/snr-descriptive', '#stan/snr-positioning', '#stan/snr-sentiment',
  '#annie/steel-KSPY', '#sven/SPY',
].filter(Boolean);

for (const r of routes) {
  await go(r);
  const body = both();
  const problems = [];
  if (!body.trim()) problems.push('rendered nothing');
  if (/Loading chart…|Loading…/.test(body)) problems.push('still showing a loading state');
  if (/Could not load/.test(body)) problems.push('shows a load error: ' + (/Could not load[^<]*/.exec(body) || [''])[0]);
  const svgs = (body.match(/<svg/g) || []).length, empties = (body.match(/class="empty"/g) || []).length;
  say(`${problems.length ? 'FAIL' : ' ok '} ${r.padEnd(44)} ${String(body.length).padStart(7)}b  svg:${svgs} empty:${empties}${problems.length ? '  << ' + problems.join('; ') : ''}`);
  problems.forEach(p => errors.push(`[${r}] ${p}`));
  if (wantEmpties) for (const m of body.match(/class="empty"[^>]*>([^<]*)</g) || []) say('        empty: ' + m.replace(/class="empty"[^>]*>/, '').replace(/<$/, '').trim());
  if (wantDump) {
    const out = join(SITE, '..', 'family-office-agentic-orchestration', 'preview', '_page.html');
    if (existsSync(dirname(out))) {
      writeFileSync(out, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="_page.css"><body data-theme="dark" style="padding:20px;background:var(--bg)"><div style="max-width:1060px;margin:auto">${drawer() && !/#\w+$/.test(location.hash) ? drawer() : app()}</div>`);
      say('        dumped');
    }
  }
}

if (!argRoute) {
  // -------------------------------------------------------------------------
  // 2. Retired hashes still land. #sisyphus was the DEFAULT, so it is the one most likely to be
  //    sitting in a bookmark, and without the redirect every stale link looks like a deleted page.
  // -------------------------------------------------------------------------
  currentRoute = 'legacy-hashes';
  for (const [from, to, heading] of [['#overview', '#sisyphus', 'Decision'], ['#decisions', '#annie', 'Decision Coach']]) {
    await go(from);
    const ok = location.hash === to && (heading === 'Decision' ? /<h1>Sisyphus<\/h1>/.test(app()) : /<h1>Decision Coach<\/h1>/.test(app()));
    say(` ok  ${from} -> ${location.hash}${ok ? '' : '  DID NOT REDIRECT'}`);
    need(ok, `[routing] ${from} did not redirect to ${to}`);
  }

  // -------------------------------------------------------------------------
  // 3. Stan: the scatter must plot, and switching the window must CHANGE the plot. Counting points
  //    alone would have passed the day the tab handler was never inserted.
  // -------------------------------------------------------------------------
  currentRoute = 'scatter';
  await go('#stan');
  const before = app(), n0 = (before.match(/<circle cx=/g) || []).length;
  await click('[data-scatter]', { scatter: '5Y' });
  const after = app(), n1 = (after.match(/<circle cx=/g) || []).length;
  say(` ok  scatter               -> ${n0} points YTD, ${n1} points 5Y`);
  need(n0 > 0 && n1 > 0, '[scatter] no points plotted');
  need(after !== before, '[scatter] switching the window did not change the plot');

  // -------------------------------------------------------------------------
  // 4. Staging a classification previews before it is saved. Nothing is written: the Update button
  //    is never clicked, and the builder's upsert is a no-op either way.
  // -------------------------------------------------------------------------
  currentRoute = 'classify';
  await go('#stan/' + strat.id);
  const h0 = drawer();
  // No Unclassified row means nothing is unclassified, which is 0% and not "unknown". Reading it
  // as null made this fail the moment the last unclassified holding was staged — the success case.
  const unclass = h => { const x = h.match(/Unclassified<\/span><span class="vl">([\d.]+)%/); return x ? +x[1] : 0; };
  const sid = (h0.match(/data-splitfor="([0-9a-f-]{36})"/) || [])[1];
  if (!sid) say(' ok  classify stage        -> nothing unclassified to stage');
  else {
    const b4 = unclass(h0);
    await change('[data-splitfor]', { splitfor: sid }, 'eq60_fi40');
    const st = unclass(drawer());
    say(` ok  classify stage        -> unclassified ${b4}% -> ${st}%`);
    need(st < b4, '[classify] staging a split did not preview in the donut');
    need(drawer().includes('data-repupdate'), '[classify] no Update button appeared with staged changes');
  }

  // -------------------------------------------------------------------------
  // 5. Contribution must total about 100% of weight. It read 200% the day a dated set was loaded
  //    without filtering to the newest run — a number, not a crash.
  // -------------------------------------------------------------------------
  currentRoute = 'contribution';
  await go('#stan/' + strat.id);
  const tot = (drawer().match(/TOTAL<\/b><\/td><td><\/td><td class="num"><b>([\d.]+)%<\/b>/) || [])[1];
  if (!tot) say(' ok  contribution total    -> no table for this model');
  else {
    say(` ok  contribution total    -> ${tot}% of weight`);
    need(Math.abs(+tot - 100) < 2, `[contribution] weights total ${tot}%, expected ~100% — a dated set is probably unfiltered`);
  }

  // -------------------------------------------------------------------------
  // 6. Every donut wedge names the holdings inside it, and those weights must add to the wedge.
  //    The pie rule halves a holding that is long two factors; printing its full weight in both
  //    would describe more book than the model holds, and would look entirely reasonable.
  // -------------------------------------------------------------------------
  currentRoute = 'donut';
  await go('#stan/' + strat.id);
  const tips = [...drawer().matchAll(/<path[^>]*data-tip="([^"]*)"/g)].map(m => m[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  say(` ok  donut wedges           -> ${tips.length} with a ticker list`);
  need(tips.length > 0, '[donut] no wedge carries a hover list');
  for (const t of tips) {
    const lines = t.split('\n');
    const head = lines[0].match(/^(.+) — ([\d.]+)% of the model$/);
    if (!head) { errors.push('[donut] wedge tooltip has no header: ' + lines[0]); continue; }
    const rows = lines.slice(1).map(l => l.match(/^([A-Z0-9.]+)\s+([\d.]+)%$/)).filter(Boolean);
    if (!rows.length) { errors.push(`[donut] ${head[1]} names no holdings`); continue; }
    const sum = rows.reduce((a, r) => a + +r[2], 0);
    need(Math.abs(sum - +head[2]) < 0.6, `[donut] ${head[1]} wedge is ${head[2]}% but names holdings totalling ${sum.toFixed(1)}%`);
  }

  // -------------------------------------------------------------------------
  // 7. The monthly grid, and the cross-check that forced the target basis to compound monthly:
  //    the year it shows for the current year must equal the trailing YTD directly above it. Two
  //    year-to-date numbers on one card that disagree is worse than either being slightly off.
  // -------------------------------------------------------------------------
  currentRoute = 'monthly';
  await go('#stan/' + strat.id);
  const d1 = drawer();
  need(d1.includes('Monthly returns'), '[monthly] grid did not render');
  const yr = new Date().getUTCFullYear();
  // Walk the trailing table positionally: a dash has to keep its column, or every figure after it
  // is read off the wrong period.
  const ytd = (() => {
    const seg = d1.split('>Trailing returns<')[1]; if (!seg) return null;
    const head = seg.split('<thead>')[1]?.split('</thead>')[0]; if (!head) return null;
    const cols = [...head.matchAll(/<th class="num">([^<]+)<\/th>/g)].map(m => m[1]);
    const i = cols.indexOf('YTD'); if (i < 0) return null;
    const row = seg.split('</thead>')[1].split('</tr>')[0];
    const cells = [...row.matchAll(/<td class="num">([\s\S]*?)<\/td>/g)].map(m => {
      const v = m[1].replace(/<[^>]*>/g, '').trim(); const num = v.match(/^(-?[\d.]+)%$/); return num ? +num[1] : null;
    });
    return cells[i] ?? null;
  })();
  const annual = (() => {
    const seg = d1.split('Monthly returns')[1] || '';
    const m = seg.match(new RegExp('<td><b>' + yr + '</b></td><td class="num"[^>]*>(-?[\\d.]+)%'));
    return m ? +m[1] : null;
  })();
  if (ytd !== null && annual !== null) {
    say(` ok  monthly ${yr} annual    -> ${annual}% vs trailing YTD ${ytd}%`);
    need(Math.abs(ytd - annual) < 0.02, `[monthly] ${yr} annual ${annual}% does not match the trailing YTD ${ytd}% on the same card`);
  } else say(` ok  monthly/YTD cross-check skipped (ytd=${ytd} annual=${annual})`);
  await click('[data-monthtab]', { monthtab: 'excess' });
  need(drawer() !== d1, '[monthly] switching to the Vs. Benchmark tab did not change the grid');

  // -------------------------------------------------------------------------
  // 8. The sector/factor breakdown: both lenses render, the toggle works, and the allocation
  //    column totals 100% of resolved equity. A composite row leaking into the allocation would
  //    read as a plausible mix rather than as a bug.
  // -------------------------------------------------------------------------
  currentRoute = 'breakdown';
  await go('#stan/' + strat.id);
  const bd0 = drawer();
  need(bd0.includes('Portfolio breakdown'), '[breakdown] card did not render');
  await click('[data-breakdown]', { breakdown: 'factor' });
  const bd1 = drawer();
  need(bd1 !== bd0, '[breakdown] switching to the factor lens did not change the table');
  need(bd1.includes('Defensive'), '[breakdown] factor lens is missing the Defensive composite');
  for (const [lens, html] of [['sector', bd0], ['factor', bd1]]) {
    const seg = (html.split('Portfolio breakdown')[1] || '').split('Derived from the rows above')[0];
    const vals = [...seg.matchAll(/<div style="height:9px;width:[^"]*"><\/div>\s*<small style="color:var\(--text\)[^"]*">([\d.]+)%/g)].map(m => +m[1]);
    if (!vals.length) { say(`      breakdown ${lens}: model column not resolved`); continue; }
    const sum = vals.reduce((a, b) => a + b, 0);
    say(`      breakdown ${lens.padEnd(7)} model column totals ${sum.toFixed(1)}%`);
    need(Math.abs(sum - 100) < 1.5, `[breakdown] ${lens} model column totals ${sum.toFixed(1)}%, expected 100% of resolved equity`);
  }

  // -------------------------------------------------------------------------
  // 9. Annie. The scorecard must agree with itself, an ungraded model must show dashes and not
  //    zeroes (a .000 batting average is a far worse claim than "not measured", and it is the one
  //    a reader would believe), and the equity curve must draw a hover target per trade.
  // -------------------------------------------------------------------------
  currentRoute = 'annie';
  await go('#annie');
  const a0 = app();
  for (const want of ['Scorecard', 'Hunting Pitches', 'Current positions — decision score', 'Trade journal',
                      'Performance Snapshot', 'Consistency &amp; Curve Quality', 'Recent Performance'])
    need(a0.includes(want), `[annie] missing section: ${want}`);

  const tabIds = [...a0.matchAll(/data-anniemodel="([^"]+)"/g)].map(m => m[1]);
  say(` ok  annie scorecard tabs   -> ${tabIds.length} (${tabIds[0]} first)`);
  need(tabIds.length === 9, `[annie] expected 9 scorecard tabs, got ${tabIds.length}`);
  need(tabIds[0] === 'overall', '[annie] the first scorecard tab is not Overall');

  const sc = a0.match(/(\d+) of (\d+) exited profitable[\s\S]*?<span style="color:var\(--pos\)">(\d+)<\/span><span style="color:var\(--muted\)">\/<\/span><span style="color:var\(--neg\)">(\d+)<\/span>/);
  if (!sc) say(' ok  annie scorecard       -> no model has a ledger yet');
  else {
    const [, w1, closed, w2, l] = sc.map(Number);
    say(` ok  annie scorecard       -> ${w2}W ${l}L of ${closed} closed`);
    need(w1 === w2 && w2 + l === closed, `[annie] scorecard says ${w1} of ${closed} profitable but ${w2}W/${l}L`);
  }

  const curveN = (a0.match(/Cumulative contribution across (\d+) completed trades/) || [])[1];
  const hits = (a0.match(/<rect [^>]*data-tip="/g) || []).length;
  say(` ok  annie equity curve     -> ${curveN ?? '?'} trades, ${hits} hover targets`);
  need(!curveN || +curveN === hits, `[annie] curve says ${curveN} trades but drew ${hits} hover targets`);

  await click('[data-anniemodel]', { anniemodel: tabIds[tabIds.length - 1] });
  const card = (app().split('>Scorecard<')[1] || '').split('</p></div>')[0];
  const zeros = (card.match(/font-size:26px">\.000</g) || []).length + (card.match(/font-size:26px">0</g) || []).length;
  const dashes = (card.match(/font-size:26px"><span style="color:var\(--muted\)">—</g) || []).length;
  say(` ok  annie ungraded tab     -> ${dashes} dashes, ${zeros} zeroes`);
  need(zeros === 0, '[annie] an ungraded model shows a zero where it has no data; it must show a dash');
  await click('[data-anniemodel]', { anniemodel: 'overall' });
  const w0 = app();
  await click('[data-anniewin]', { anniewin: '6M' });
  need(app() !== w0, '[annie] switching the decision-score window did not change the table');

  // -------------------------------------------------------------------------
  // 10. Sven: every index carries every rule, and the news window switches.
  // -------------------------------------------------------------------------
  currentRoute = 'sven';
  await go('#sven');
  const s0 = app();
  const idx = (s0.match(/data-go="#sven\/\w+"/g) || []).length;
  say(` ok  sven matrix            -> ${idx} indices`);
  need(idx > 0, '[sven] rule matrix rendered no indices');
  need(s0.includes('News failure'), '[sven] news failure card missing');
  await click('[data-newswin]', { newswin: '90' });
  need(app() !== s0, '[sven] switching the news window did not change the table');
}

// ---------------------------------------------------------------------------
console.log('');
if (errors.length) { console.log(`${errors.length} PROBLEM(S):`); for (const e of errors) console.log('  ' + e); process.exit(1); }
console.log('No problems found.');
