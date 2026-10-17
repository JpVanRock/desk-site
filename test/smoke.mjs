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
  '#sisyphus', '#stan', '#adam', '#sven', '#annie', '#markets', '#views', '#signals', '#agents',
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
    // Once every holding in a model carries a classification the residual is 0 and no staged
    // split can push it lower, so asserting a fall tests nothing and fails on success. The claim
    // worth making either way is that the donut previews a STAGED change; when there is nothing
    // left to classify, staging one back to unclassified proves it in the other direction.
    if (b4 > 0) {
      await change('[data-splitfor]', { splitfor: sid }, 'eq60_fi40');
      const st = unclass(drawer());
      say(` ok  classify stage        -> unclassified ${b4}% -> ${st}%`);
      need(st < b4, '[classify] staging a split did not reduce the unclassified residual');
    } else {
      await change('[data-splitfor]', { splitfor: sid }, '');
      const st = unclass(drawer());
      say(` ok  classify stage        -> all classified; unstaging one gives ${st}%`);
      need(st > 0, '[classify] unstaging a classification did not restore an unclassified residual');
    }
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
  // The annual cell is coloured by its own sign; the months beside it by the benchmark. A red
  // annual on a year that made money is what sent the owner looking in the first place.
  {
    const d = drawer();
    const annuals = [...d.matchAll(/<td class="num" style="background:(var\(--\w+bg\)|transparent);font-weight:600;[^"]*"[^>]*>(-?[\d.]+)%/g)]
      .map(m => ({ bg: m[1], v: +m[2] }));
    const wrong = annuals.filter(a => a.bg !== 'transparent' && ((a.v >= 0) !== (a.bg === 'var(--winbg)')));
    say(` ok  monthly annual colour -> ${annuals.length} annual cells, ${wrong.length} coloured against their sign`);
    need(annuals.length > 0, '[monthly] no annual cells found');
    for (const a of wrong) errors.push(`[monthly] an annual of ${a.v}% is shown ${a.bg === 'var(--winbg)' ? 'green' : 'red'}`);
  }
  // Every window must start where its name says. A YTD that begins in a prior year is a different
  // question wearing the YTD label, which is how Fixed Income Core came to report 39.04%.
  {
    const ps = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_period_stats?select=strategy_id,period,model_return,start_date,window_starts_in_gap&period=in.(YTD,1YR,3YR)`, { headers: REST }).then(r => r.json());
    const yr = new Date().getUTCFullYear();
    const bad = [];
    for (const r of ps) {
      if (!r.start_date) continue;
      if (r.period === 'YTD' && r.start_date < `${yr - 1}-12-25`) bad.push(`YTD starts ${r.start_date}`);
      if (r.period === '1YR' && r.start_date < `${yr - 1}-10-01`) bad.push(`1YR starts ${r.start_date}`);
      if (r.period === '3YR' && r.start_date < `${yr - 3}-10-01`) bad.push(`3YR starts ${r.start_date}`);
    }
    // Two windows of different lengths cannot honestly return the same figure.
    const byStrat = {};
    for (const r of ps) { (byStrat[r.strategy_id] ||= {})[r.period] = r.model_return; }
    for (const [sid, v] of Object.entries(byStrat)) {
      if (v.YTD !== null && v.YTD !== undefined && v.YTD === v['3YR']) bad.push('YTD equals 3YR exactly, so one window was stretched');
    }
    say(` ok  period windows        -> ${ps.length} windows, ${[...new Set(bad)].length} starting outside their own span`);
    for (const b of [...new Set(bad)]) errors.push(`[period] ${b}`);
  }
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
  await click('[data-breakdown]', { breakdown: 'geography' });
  const bd1 = drawer();
  need(bd1 !== bd0, '[breakdown] switching to the geography lens did not change the card');
  // The equity-factor lens was replaced by geography. Neither its tab nor its content may return.
  need(!bd0.includes('Equity factors') && !bd1.includes('Equity factors'), '[breakdown] the Equity factors tab is still rendered');
  need(!bd1.includes('Defensive') && !bd1.includes('Multi-Factor'), '[breakdown] factor-lens content leaked into the geography card');
  await click('[data-breakdown]', { breakdown: 'factor' });
  need(drawer() === bd1, '[breakdown] a stale factor lens is still reachable and rendered');
  await click('[data-breakdown]', { breakdown: 'geography' });
  if (wantDump) { const out = join(SITE, '..', 'family-office-agentic-orchestration', 'preview', '_geo.html');
    writeFileSync(out, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="_page.css"><body data-theme="dark" style="padding:20px;background:var(--bg)"><div style="max-width:1060px;margin:auto">${drawer()}</div>`); }

  need(bd1.includes('Ten largest countries'), '[breakdown] geography is missing the country table');
  need(/viewBox="20 15 980 400"/.test(bd1), '[breakdown] the world map did not render');
  {
    const seg = (bd0.split('Portfolio breakdown')[1] || '').split('Derived from the rows above')[0];
    const vals = [...seg.matchAll(/<div style="height:9px;width:[^"]*"><\/div>\s*<small style="color:var\(--text\)[^"]*">([\d.]+)%/g)].map(m => +m[1]);
    if (!vals.length) say('      breakdown sector : model column not resolved');
    else {
      const sum = vals.reduce((a, b) => a + b, 0);
      say(`      breakdown sector  model column totals ${sum.toFixed(1)}%`);
      need(Math.abs(sum - 100) < 1.5, `[breakdown] sector model column totals ${sum.toFixed(1)}%, expected 100% of resolved equity`);
    }
  }
  // Geography: both scopes must sum to 100% on each side, countries must roll up into their
  // regions, and a fixed income or commodity holding must never appear as unplaced equity.
  {
    const geo = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_geo_exposure?select=strategy_id,scope,code,label,region,model_weight,benchmark_weight`, { headers: REST }).then(r => r.json());
    const covs = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_geo_coverage?select=strategy_id,model_equity_weight,model_resolved,benchmark_resolved,unresolved`, { headers: REST }).then(r => r.json());
    const bad = [];
    const byStrat = [...new Set(geo.map(g => g.strategy_id))];
    for (const sid of byStrat) {
      for (const scope of ['country', 'region']) {
        for (const side of ['model_weight', 'benchmark_weight']) {
          const rs = geo.filter(g => g.strategy_id === sid && g.scope === scope && g[side] !== null);
          if (!rs.length) continue;
          const sum = rs.reduce((a, r) => a + +r[side], 0);
          if (Math.abs(sum - 1) > 0.005) bad.push(`${scope} ${side} sums to ${sum.toFixed(3)}`);
          if (rs.some(r => +r[side] < -1e-9)) bad.push(`${scope} ${side} has a negative weight`);
        }
        // Countries must roll up to exactly the region totals, or map and table disagree.
        if (scope === 'country') {
          const regions = geo.filter(g => g.strategy_id === sid && g.scope === 'region');
          for (const reg of regions) {
            for (const side of ['model_weight', 'benchmark_weight']) {
              if (reg[side] === null) continue;
              const kids = geo.filter(g => g.strategy_id === sid && g.scope === 'country' && g.region === reg.code && g[side] !== null);
              const sum = kids.reduce((a, r) => a + +r[side], 0);
              if (Math.abs(sum - +reg[side]) > 0.002) bad.push(`${reg.code} ${side}: countries sum to ${sum.toFixed(4)} but the region says ${(+reg[side]).toFixed(4)}`);
            }
          }
        }
      }
    }
    for (const c of covs) {
      if (c.model_resolved !== null && (+c.model_resolved < 0 || +c.model_resolved > 1.000001)) bad.push('model_resolved outside 0..1');
      for (const u of (c.unresolved || [])) if (!u.ticker) bad.push('an unresolved entry has no ticker');
    }
    say(` ok  geography              -> ${byStrat.length} models, ${geo.filter(g => g.scope === 'country').length} country rows, ${[...new Set(bad)].length} problems`);
    for (const b of [...new Set(bad)]) errors.push(`[geography] ${b}`);
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
  const tabIds0 = [...a0.matchAll(/data-anniemodel="([^"]+)"/g)].map(m => m[1]);

  // The hot-hand card and the streak must agree with the ledger, and the streak must run newest
  // first on EVERY tab -- it is rebuilt per tab, so checking one proves nothing about the rest.
  {
    const card = a0.match(/<div class="pcard pcard-(\w+)"[^>]*title="([^"]*)"/);
    need(card, '[annie] the hot-hand card did not render');
    if (card) {
      const kind = card[1];
      const pct = (a0.match(/<div class="pcorner"[^>]*>(\d+)%</) || [])[1];
      if (kind !== 'none') {
        const p = +pct;
        const want = p >= 51 ? 'hot' : p >= 50 ? 'even' : 'cold';
        say(` ok  annie hot hand         -> ${p}% over 90 days, card reads ${kind}`);
        need(kind === want, `[annie] a 90-day rate of ${p}% rendered the ${kind} card, expected ${want}`);
        // The even card carries the site mark, the other two carry an icon.
        if (kind === 'even') need(/pcard-even[\s\S]{0,400}#sisyphus-mark/.test(a0), '[annie] the even card does not use the site logo');
        else need(/pcard-(hot|cold)[\s\S]{0,400}<svg viewBox="0 0 24 24"/.test(a0), '[annie] the hot/cold card has no icon');
      } else say(' ok  annie hot hand         -> no trades closed in 90 days; card is blank');
    }
    for (const tab of tabIds0.slice(0, 4)) {
      await click('[data-anniemodel]', { anniemodel: tab });
      const h = app();
      const chips = [...h.matchAll(/class="stk [wl]" data-tip="([^"]*?) · opened/g)].map(m => m[1]);
      const dates = [...h.matchAll(/class="stk [wl]" data-tip="[^"]*?closed ([\d-]+)"/g)].map(m => m[1]);
      if (dates.length > 1) {
        const desc = dates.every((d, i) => i === 0 || dates[i - 1] >= d);
        need(desc, `[annie] streak on tab ${tab} is not newest-first: ${dates.slice(0, 3).join(' ')}`);
      }
      need(!h.includes('oldest first'), `[annie] streak on tab ${tab} still says oldest first`);
      if (chips.length) need(chips.length <= 10, `[annie] streak on tab ${tab} shows ${chips.length} chips, expected at most 10`);
    }
    say(` ok  annie streak order     -> newest first on ${Math.min(4, tabIds0.length)} tabs`);
    // On Overall the ledger holds one row per model per trade, so without collapsing them a
    // single call across seven models fills seven of the ten chips and the streak contradicts
    // the win rate beside it. No two chips may describe the same ticker leaving on the same day.
    await click('[data-anniemodel]', { anniemodel: 'overall' });
    {
      const h = app();
      const keys = [...h.matchAll(/class="stk [wl]" data-tip="([A-Z]+) · opened [^"]*?closed ([\d-]+)/g)].map(m => `${m[1]}|${m[2]}`);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      const wins = (h.match(/class="stk w"/g) || []).length, losses = (h.match(/class="stk l"/g) || []).length;
      say(` ok  annie overall streak   -> ${wins}W ${losses}L of ${keys.length} decisions, ${dupes.length} duplicated`);
      need(dupes.length === 0, `[annie] the Overall streak repeats the same decision: ${[...new Set(dupes)].join(', ')}`);

      // The three-year trade bars must agree with the stored YTD figure, or the chart and the
      // ledger are counting different things.
      const seg = h.split('Trades YTD')[1] || '';
      const labels = [...seg.matchAll(/font-size:9\.5px;color:var\(--muted\)">(YTD|\d{4})</g)].map(m => m[1]);
      const counts = [...seg.matchAll(/font-variant-numeric:tabular-nums">(\d+)</g)].map(m => +m[1]);
      const stored = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_decision_stats?select=n_trades_ytd`, { headers: REST })
        .then(r => r.json()).then(rs => rs.reduce((a, x) => a + (x.n_trades_ytd || 0), 0));
      say(` ok  annie trade bars       -> ${labels.join('/')} = ${counts.slice(0, 3).join('/')}, stored YTD ${stored}`);
      need(labels.length === 3 && labels[2] === 'YTD', `[annie] expected three bars ending in YTD, got ${labels.join(',')}`);
      need(counts[2] === stored, `[annie] the YTD bar reads ${counts[2]} but the ledger stores ${stored}`);
      const yr = new Date().getUTCFullYear();
      need(labels[0] === String(yr - 2) && labels[1] === String(yr - 1), `[annie] year labels ${labels.join(',')} are not the two years before ${yr}`);
      // A partial year beside two full ones has to be marked as partial.
      need(/border-top:2px dashed/.test(seg), '[annie] the YTD bar is not marked as a partial year');
    }
    await click('[data-anniemodel]', { anniemodel: tabIds0[0] });
  }

  // Tax efficiency: the arithmetic, the netting, and the bracket toggle.
  {
    const eff = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_tax_efficiency?select=strategy_id,year,st_gain_bps,st_loss_bps,lt_gain_bps,lt_loss_bps,n_st,n_lt,bps_from_trims,n_sales,n_full_exits,n_trims`, { headers: REST }).then(r => r.json());
    const cov = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_tax_coverage?select=strategy_id,n_sales,n_partial_sales,opening_lot_bps`, { headers: REST }).then(r => r.json());
    const bad = [];
    for (const r of eff) {
      for (const k of ['st_gain_bps', 'st_loss_bps', 'lt_gain_bps', 'lt_loss_bps']) {
        if (+r[k] < 0) bad.push(`${r.year} ${k} is negative; the components are magnitudes`);
      }
      // Figures without events behind them, or events without figures, mean the walk lost one.
      if (r.n_st + r.n_lt === 0 && (+r.st_gain_bps || +r.lt_gain_bps)) bad.push(`${r.year} has gains but no realisation events`);
      if (+r.bps_from_trims < 0) bad.push(`${r.year} has negative trim attribution`);
    }
    for (const c of cov) if (c.n_partial_sales > c.n_sales) bad.push('more partial sales than sales');
    // Netting must follow the rule, not tax gross gains. Reproduce it here independently.
    const net = (r, lt, st) => {
      let S = +r.st_gain_bps - +r.st_loss_bps, L = +r.lt_gain_bps - +r.lt_loss_bps;
      if (S < 0 && L > 0) { const u = Math.min(-S, L); L -= u; S += u; }
      else if (L < 0 && S > 0) { const u = Math.min(-L, S); S -= u; L += u; }
      return Math.max(0, S) * st + Math.max(0, L) * lt;
    };
    for (const r of eff) {
      const gross = (+r.st_gain_bps) * 0.24 + (+r.lt_gain_bps) * 0.15;
      if (net(r, 0.15, 0.24) > gross + 1e-6) bad.push(`${r.year} nets to more tax than taxing gross gains would`);
      // HNW must never be cheaper than standard: both rates are strictly higher.
      if (net(r, 0.20, 0.37) < net(r, 0.15, 0.24) - 1e-6) bad.push(`${r.year} HNW rates produce less tax than standard`);
    }
    say(` ok  tax efficiency         -> ${eff.length} model-years, ${cov.reduce((a, c) => a + c.n_partial_sales, 0)} partial sales counted, ${[...new Set(bad)].length} problems`);
    for (const b of [...new Set(bad)]) errors.push(`[tax] ${b}`);

    // Overall and the per-model tabs carry different titles.
    need(a0.includes('Tax Drag') && a0.includes('estimated across all models'), '[tax] the Overall title is wrong');
    need(a0.indexOf('Decision errors') < a0.indexOf('Tax Drag'), '[tax] the card is not below the decision errors section');
    need(!a0.includes('Tax efficiency'), '[tax] the old Tax efficiency title is still rendered on Overall');
    {
      const modelTab = tabIds0.find(t => t !== 'overall');
      await click('[data-anniemodel]', { anniemodel: modelTab });
      const mh = app();
      need(mh.includes('Estimated Tax Drag'), '[tax] a model tab does not carry the Estimated Tax Drag title');
      need(!mh.includes('estimated across all models'), '[tax] a model tab is using the Overall title');
      await click('[data-anniemodel]', { anniemodel: 'overall' });
    }
    // Sell decisions must split into exits plus trims, and never exceed the lots they consumed.
    {
      const bad2 = [];
      for (const r of eff) {
        if (r.n_full_exits + r.n_trims !== r.n_sales) bad2.push(`${r.year} ${r.n_sales} sales but ${r.n_full_exits}+${r.n_trims}`);
        if (r.n_sales > 0 && r.n_st + r.n_lt < r.n_sales) bad2.push(`${r.year} ${r.n_sales} sales consuming only ${r.n_st + r.n_lt} lots`);
      }
      const totSales = eff.reduce((a, r) => a + r.n_sales, 0), totLots = eff.reduce((a, r) => a + r.n_st + r.n_lt, 0);
      say(` ok  tax sell decisions     -> ${totSales} decisions across ${totLots} lots, ${[...new Set(bad2)].length} problems`);
      for (const b of [...new Set(bad2)]) errors.push(`[tax] ${b}`);
      // The column must show decisions, not the lot count that used to be there.
      const shown = [...a0.matchAll(/<td class="num" style="color:var\(--muted\)" title="\d+ full exits[^"]*">(\d+)</g)].map(m => +m[1]);
      const expect = [...new Set(eff.map(r => r.year))].sort().map(y => eff.filter(r => r.year === y).reduce((a, r) => a + r.n_sales, 0));
      need(JSON.stringify(shown) === JSON.stringify(expect), `[tax] the sell-decision column reads ${shown.join('/')} but the ledger totals ${expect.join('/')}`);
    }
    // Both rate sets must be stated on the page, and the toggle must change the figure.
    need(/15% long-term · 24% short-term/.test(a0), '[tax] the standard rates are not stated');
    need(/20% long-term · 37% short-term/.test(a0), '[tax] the HNW rates are not stated');
    const headline = h => (h.match(/−([\d.]+)<span style="font-size:19px">%<\/span> <span style="font-size:15px;font-weight:600">\/yr/) || [])[1];
    const stdDrag = headline(a0);
    await click('[data-taxbracket]', { taxbracket: 'hnw' });
    const h1 = app();
    const hnwDrag = headline(h1);
    say(` ok  tax bracket toggle     -> standard −${stdDrag}%/yr, HNW −${hnwDrag}%/yr`);
    need(stdDrag && hnwDrag, '[tax] could not read the headline drag on one of the brackets');
    need(!/bps\/yr/.test(a0), '[tax] the headline is still in basis points');
    need(+hnwDrag > +stdDrag, `[tax] HNW (${hnwDrag}) is not heavier than standard (${stdDrag}), though both its rates are higher`);
    await click('[data-taxbracket]', { taxbracket: 'standard' });
  }

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
  // 10. Adam: the contest must agree with itself. A dimension marked as agreeing with the tape
  //     while showing a negative spread would mean the verdict and the ranking were computed from
  //     different numbers, which is the kind of thing that reads as a finding.
  // -------------------------------------------------------------------------
  currentRoute = 'adam';
  await go('#adam');
  const ad = app();
  for (const want of ["This week's beauty contest", 'Macro Beauty Contest', 'The four legs', 'Macro regime'])
    need(ad.includes(want), `[adam] missing section: ${want}`);
  const rows = [...ad.matchAll(/<td>([^<]+)<\/td>\s*<td><b>([^<]+)<\/b>[\s\S]*?<td class="num">(?:<span style="color:var\(--(pos|neg)\)">(-?[\d.]+)%<\/span>|<span style="color:var\(--muted\)">–<\/span>)<\/td>\s*<td>(?:<span style="color:var\(--(?:pos|neg|muted)\)"[^>]*>)?(agrees|disagrees|unscored)/g)];
  let bad = 0;
  for (const m of rows) {
    const spread = m[4] === undefined ? null : +m[4] * (m[3] === 'neg' ? 1 : 1);
    const signed = m[3] === 'neg' ? -Math.abs(+m[4]) : +m[4];
    if (m[5] === 'unscored') continue;
    if ((m[5] === 'agrees') !== (signed > 0)) bad++;
  }
  say(` ok  adam preference table  -> ${rows.length} rows, ${bad} verdict/spread mismatches`);
  need(bad === 0, `[adam] ${bad} rows say they agree with the tape while showing a spread that disagrees`);
  const legs = (ad.match(/awaiting data|live<\/span>|stale<\/span>/g) || []).length;
  say(` ok  adam legs              -> ${legs} with a status chip`);
  need(legs >= 4, `[adam] expected 4 component legs, found ${legs}`);
  // A leg with no data must never render a 0: on a 0-100 risk scale that reads as maximum risk-off.
  need(!/>awaiting data<\/span>[\s\S]{0,160}?font-weight:700;color:var\(--\w+\)">0</.test(ad),
    '[adam] a leg awaiting data rendered a 0 score; it must render a dash');

  // -------------------------------------------------------------------------
  // 9a. Stan's YTD column must be the MEASURED return, not the target-weight hypothetical.
  // -------------------------------------------------------------------------
  currentRoute = 'stan-ytd';
  await go('#stan');
  {
    const page = app();
    const ps = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_period_stats?select=strategy_id,period,model_return&period=eq.YTD`, { headers: REST }).then(r => r.json());
    const perf = await fetch(`${SUPABASE_URL}/rest/v1/latest_strategy_performance?select=strategy_id,period,portfolio_return&period=eq.YTD`, { headers: REST }).then(r => r.json());
    const measured = Object.fromEntries(ps.filter(r => r.model_return !== null).map(r => [r.strategy_id, +r.model_return]));
    const target = Object.fromEntries(perf.filter(r => r.portfolio_return !== null).map(r => [r.strategy_id, +r.portfolio_return]));
    // Every YTD cell the page renders must match a measured figure, where one exists.
    const shown = [...page.matchAll(/title="Year-to-date on what the model actually held[^"]*"[^>]*>([+-]?[\d.]+)%/g)].map(m => +m[1]);
    const expect = Object.values(measured).map(v => +(v * 100).toFixed(1)).sort((a, b) => a - b);
    const got = shown.map(v => +v.toFixed(1)).sort((a, b) => a - b);
    say(` ok  stan ytd basis         -> ${shown.length} measured cells of ${Object.keys(measured).length} models with a measured figure`);
    need(JSON.stringify(got) === JSON.stringify(expect), `[stan-ytd] the YTD column reads ${got.join('/')} but measured is ${expect.join('/')}`);
    // A target-weight fallback is allowed only where nothing measured exists, and must be marked.
    const fallbacks = (page.match(/>target weights</g) || []).length;
    const noMeasured = Object.keys(target).filter(id => measured[id] === undefined).length;
    need(fallbacks === noMeasured, `[stan-ytd] ${fallbacks} rows marked as target weights but ${noMeasured} models lack a measured figure`);
    // The old wording must be gone, or the note describes a table that no longer exists.
    // The old claim must be gone. It is quoted in the new note as history, so the test looks for
    // the assertion rather than the words: "is ... on target weights for every model".
    need(!/Performance is year-to-date on <b>target weights for every model<\/b>/.test(page), '[stan-ytd] the note still asserts every model is on target weights');
  }

  // -------------------------------------------------------------------------
  // 9c. Scatter: a position that lost money is red, in the dot and the ticker.
  // -------------------------------------------------------------------------
  currentRoute = 'scatter-colour';
  await go('#stan');
  // Checked on every window, not just whichever one an earlier block happened to leave selected:
  // how many positions are under water changes with the period, and the colouring has to hold on
  // all of them. On 5Y one position is negative; year to date, seven are.
  {
    let totalMarks = 0;
    const seen = [];
    for (const period of ['YTD', '1Y', '3Y', '5Y']) {
      await click('[data-scatter]', { scatter: period });
      const page = app();
      // Each <g> is one point: the circle carries the return in its title, the text repeats the
      // colour. Matching per group stops a non-greedy span pairing one point's dot with the next
      // point's label.
      const marks = [...page.matchAll(/<g><circle[^>]*fill="(var\(--\w+\))">\s*<title>([A-Z]+) · return (-?[\d.]+)%(?:(?!<\/g>)[\s\S])*?<text[^>]*fill="(var\(--\w+\))"/g)]
        .map(m => ({ dot: m[1], ticker: m[2], x: +m[3], label: m[4] }));
      if (!marks.length) continue;
      totalMarks += marks.length;
      const losers = marks.filter(m => m.x < 0);
      seen.push(`${period} ${losers.length}/${marks.length}`);
      for (const m of marks) {
        const want = m.x < 0 ? 'var(--neg)' : 'var(--growth)';
        if (m.dot !== want) errors.push(`[scatter] ${period}: ${m.ticker} returned ${m.x}% but its dot is ${m.dot}`);
        if (m.label !== m.dot) errors.push(`[scatter] ${period}: ${m.ticker} dot and ticker disagree (${m.dot} vs ${m.label})`);
      }
      // No point may sit absurdly far out: one bad price series rescales the whole chart, which
      // is how a 2,397,621% CPAI return flattened the 5Y plot into a vertical line.
      // Gridlines must stay readable: a fixed 5% step drew 49 of them across the five-year span.
      const xLabels = (page.match(/text-anchor="middle">-?\d+%</g) || []).length;
      if (xLabels > 16) errors.push(`[scatter] ${period}: ${xLabels} x-axis labels, which run together`);
      const extreme = marks.filter(m => Math.abs(m.x) > 1000);
      for (const m of extreme) errors.push(`[scatter] ${period}: ${m.ticker} plots at ${m.x}%, which is a broken price series rather than a holding`);
      // The tile must agree with the plot.
      const tile = (page.match(/Lost money<\/span><b[^>]*>(\d+)</) || [])[1];
      if (tile !== undefined) need(+tile === losers.length, `[scatter] ${period}: the Lost money tile reads ${tile} but ${losers.length} points are negative`);
    }
    say(` ok  scatter colour         -> under water by window: ${seen.join(', ')}; ${totalMarks} points checked`);
    need(totalMarks > 0, '[scatter] no points rendered on any window');
    await click('[data-scatter]', { scatter: 'YTD' });
  }

  // -------------------------------------------------------------------------
  // 9b. Beta vs band carries the verdict only; the beta figure lives one column over.
  // -------------------------------------------------------------------------
  currentRoute = 'beta-band';
  await go('#stan');
  {
    // The band cell is the one carrying a dot followed by a verdict word; the header row repeats
    // every column name, so slicing on those labels cuts the table off before its first row.
    const page = app();
    const cells = [...page.matchAll(/<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:(var\(--\w+\));vertical-align:middle"><\/span>\s*<span style="color:var\(--\w+\);font-weight:600"> (\w+)<\/span>((?:(?!<\/td>)[\s\S])*?)<\/td>/g)]
      .map(m => ({ dot: m[1], state: m[2], rest: m[3] }));
    const states = cells.map(c => c.state);
    // A beta reads like 0.51x, and none may appear in this column any more. The band range uses
    // an en dash and no multiplication sign, so it cannot be mistaken for one.
    const strayBeta = cells.filter(c => /\d\.\d{2}×/.test(c.rest));
    say(` ok  beta vs band           -> ${states.length} verdicts (${[...new Set(states)].join('/')}), ${strayBeta.length} still showing a beta`);
    need(strayBeta.length === 0, '[beta-band] the band cell still prints the beta figure');
    need(states.length > 0, '[beta-band] no band verdict rendered');
    // Green inside, red outside — the dot marks conformity to the band, not the master light.
    for (const c of cells) {
      const want = c.state === 'inside' ? 'var(--pos)' : 'var(--neg)';
      if (c.dot !== want) errors.push(`[beta-band] "${c.state}" rendered a ${c.dot} dot, expected ${want}`);
    }
    // Every verdict must carry the band it is a verdict about.
    for (const c of cells) if (!/\d\.\d{2}–\d\.\d{2}/.test(c.rest)) errors.push(`[beta-band] "${c.state}" is shown without its band range`);
  }

  // -------------------------------------------------------------------------
  // 10a. Nav order. Stan sits between Sisyphus and Adam; the page map matches the nav.
  // -------------------------------------------------------------------------
  {
    const nav = readFileSync(join(SITE, 'index.html'), 'utf8');
    const order = [...nav.matchAll(/<a href="#([a-z]+)">/g)].map(m => m[1]);
    const want = ['sisyphus', 'stan', 'adam', 'sven', 'annie'];
    say(` ok  nav order              -> ${order.slice(0, 5).join(' · ')}`);
    need(want.every((w, i) => order[i] === w), `[nav] expected ${want.join(' · ')}, found ${order.slice(0, 5).join(' · ')}`);
  }

  // -------------------------------------------------------------------------
  // 10b. Volatility match on the unclassified holdings, and the FI duration tile.
  // -------------------------------------------------------------------------
  currentRoute = 'classify-vol';
  await go('#stan/' + strat.id);
  {
    const d = drawer();
    const fits = await fetch(`${SUPABASE_URL}/rest/v1/latest_security_class_blend_fit?select=security_id,vol_asset,vol_chosen,ratio_chosen,passes,suggested_mix,vol_suggested,ratio_suggested,tolerance,achievable,n_weeks`, { headers: REST }).then(r => r.json());
    const bad = [];
    for (const f of fits) {
      const tol = +f.tolerance;
      // The tick must follow the arithmetic, not a stored opinion about it.
      if (f.ratio_chosen !== null) {
        const should = Math.abs(+f.ratio_chosen - 1) <= tol;
        if (should !== f.passes) bad.push(`passes=${f.passes} but ratio ${f.ratio_chosen} against tolerance ${tol}`);
      }
      // A suggestion that does not itself pass is not a suggestion.
      if (f.suggested_mix) {
        if (Math.abs(+f.ratio_suggested - 1) > tol) bad.push(`suggested mix lands at ratio ${f.ratio_suggested}, outside ${tol}`);
        const sum = Object.values(f.suggested_mix).reduce((a, b) => a + +b, 0);
        if (Math.abs(sum - 1) > 1e-6) bad.push(`suggested mix sums to ${sum}, not 1`);
        if (Object.values(f.suggested_mix).some(v => +v < 0.10 - 1e-9)) bad.push('suggested mix contains a slice under 10%');
        if (f.passes === true) bad.push('a passing classification was still given a suggestion');
      }
      if (f.passes === false && !f.suggested_mix && f.achievable) bad.push('missed tolerance, a mix exists, yet nothing was suggested');
      if (!(+f.vol_asset > 0)) bad.push('volatility is not positive');
      if (!(f.n_weeks >= 52)) bad.push(`fitted on ${f.n_weeks} weeks, under the 52-week minimum`);
    }
    say(` ok  classification vol     -> ${fits.length} funds, ${fits.filter(f => f.passes).length} within tolerance, ${[...new Set(bad)].length} problems`);
    for (const b of [...new Set(bad)]) errors.push(`[classify-vol] ${b}`);
    if (fits.length) {
      need(/class="vmark"/.test(d), '[classify-vol] no volatility verdict rendered on any unclassified row');
      need(/vol \d/.test(d), '[classify-vol] the fund volatility is not shown beside the weight');
    }
    // The duration tile replaced Weight priced; both must not be present, and the tile must not
    // invent a number when the model has no measured fixed income.
    need(!d.includes('Weight priced'), '[duration] the Weight priced tile is still rendered');
    need(d.includes('FI duration'), '[duration] the FI duration tile is missing');
    const md = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_duration?select=strategy_id,fi_duration,fi_weight,coverage,n_fi_holdings,n_priced&strategy_id=eq.${strat.id}`, { headers: REST }).then(r => r.json());
    if (md[0]) {
      const shown = (d.match(/FI duration[\s\S]{0,160}?>([\-\d.]+) yrs/) || [])[1];
      say(` ok  fi duration            -> ${md[0].fi_duration} yrs on ${(md[0].fi_weight * 100).toFixed(1)}% FI, tile shows ${shown ?? 'a dash'}`);
      if (md[0].fi_duration !== null) need(shown !== undefined && Math.abs(+shown - +md[0].fi_duration) < 0.005, '[duration] the tile disagrees with the stored figure');
      need(!(md[0].coverage > 1.000001), '[duration] coverage exceeds 100% of fixed income weight');
      need(md[0].n_priced <= md[0].n_fi_holdings, '[duration] more holdings priced than exist');
    }
  }

  // -------------------------------------------------------------------------
  // 10c. Factor fingerprint: five factors, signed tilts, on both the model and the firm.
  // -------------------------------------------------------------------------
  {
    const fp = await fetch(`${SUPABASE_URL}/rest/v1/latest_factor_fingerprint?select=scope,strategy_id,factor,label,model_beta,benchmark_beta,active_beta,sort_order`, { headers: REST }).then(r => r.json());
    const WANT = ['value', 'momentum', 'quality', 'low_volatility', 'size'];
    const bad = [];
    const scopes = [...new Set(fp.map(r => `${r.scope}|${r.strategy_id || ''}`))];
    for (const key of scopes) {
      const [scope, sid] = key.split('|');
      const rs = fp.filter(r => r.scope === scope && (r.strategy_id || '') === sid);
      const factors = rs.map(r => r.factor).sort();
      if (JSON.stringify(factors) !== JSON.stringify([...WANT].sort())) bad.push(`${key} has factors ${factors.join(',')}`);
      for (const r of rs) {
        // Active must be exactly model minus benchmark, or the column is its own opinion.
        if (r.model_beta !== null && r.benchmark_beta !== null && r.active_beta !== null) {
          if (Math.abs((+r.model_beta - +r.benchmark_beta) - +r.active_beta) > 0.0002) bad.push(`${key} ${r.factor}: active ${r.active_beta} != ${r.model_beta} - ${r.benchmark_beta}`);
        }
        // A style tilt past 1.5 is the regression describing something other than style.
        for (const k of ['model_beta', 'benchmark_beta']) if (r[k] !== null && Math.abs(+r[k]) > 1.5) bad.push(`${key} ${r.factor} ${k} is ${r[k]}`);
      }
    }
    // The point of a tilt is that it can be negative. If nothing anywhere is, the sign has been
    // lost somewhere between the regression and the table -- which is exactly the bug the old
    // non-negative allocation had, and the reason this replaced it.
    if (fp.length && !fp.some(r => r.model_beta !== null && +r.model_beta < 0)) bad.push('no negative tilt anywhere; the sign is being dropped');
    need(fp.some(r => r.scope === 'firm'), '[fingerprint] no firm-wide fingerprint');
    need(fp.some(r => r.scope === 'model'), '[fingerprint] no per-model fingerprint');
    say(` ok  factor fingerprint     -> ${scopes.length} scopes x ${WANT.length} factors, ${[...new Set(bad)].length} problems`);
    for (const b of [...new Set(bad)]) errors.push(`[fingerprint] ${b}`);

    // Rendered in both places the owner asked for: under the monthly grid in the model drawer,
    // and above Value at Risk on Sisyphus.
    await go('#stan/' + strat.id);
    const dm = drawer();
    need(dm.includes('Factor fingerprint'), '[fingerprint] missing from the model drawer');
    need(dm.indexOf('Monthly returns') < dm.indexOf('Factor fingerprint'), '[fingerprint] is not below the monthly return grid');
    need(/aria-label="Factor fingerprint"/.test(dm), '[fingerprint] the radar did not render in the model drawer');
    await go('#sisyphus');
    const sp = app();
    need(sp.includes('Factor fingerprint — firm-wide equity'), '[fingerprint] missing from Sisyphus');
    need(sp.indexOf('Factor fingerprint') < sp.indexOf('Value at Risk'), '[fingerprint] is not above the Value at Risk section');
  }

  // -------------------------------------------------------------------------
  // 11. Sisyphus stress: the universe lists, and the cap that sets their length.
  // -------------------------------------------------------------------------
  currentRoute = 'sisyphus';
  await go('#sisyphus');
  const sis = app();
  if (sis.includes('Stress scenarios')) {
    const rows = await fetch(`${SUPABASE_URL}/rest/v1/latest_firm_stress_results?select=scenario_id,universe_helps,universe_hurts,universe_meta`, { headers: REST }).then(r => r.json());
    need(rows.length > 0, '[stress] no firm stress rows');
    let bad = [];
    for (const r of rows) {
      const m = r.universe_meta || {};
      const uh = r.universe_helps || [], uu = r.universe_hurts || [];
      // The 12% cap is what sets the list length. If a list is longer than the cap allows, the
      // card is showing names the desk could not all fund, which is the opposite of the point.
      if (uh.length > m.list_length) bad.push(`helps list is ${uh.length} long, cap allows ${m.list_length}`);
      if (uu.length > m.list_length) bad.push(`hurts list is ${uu.length} long, cap allows ${m.list_length}`);
      // Sorted, signed, and disjoint: a name cannot both help and hurt the same shock.
      for (let i = 1; i < uh.length; i++) if (+uh[i].score > +uh[i - 1].score) bad.push('helps not sorted descending');
      for (let i = 1; i < uu.length; i++) if (+uu[i].score < +uu[i - 1].score) bad.push('hurts not sorted ascending');
      if (uh.some(x => +x.score <= 0)) bad.push('a name in helps has a non-positive score');
      if (uu.some(x => +x.score >= 0)) bad.push('a name in hurts has a non-negative score');
      const overlap = uh.map(x => x.ticker).filter(t => uu.some(y => y.ticker === t));
      if (overlap.length) bad.push(`${overlap.join(',')} appears in both helps and hurts`);
      // Expressibility must agree with the list it is derived from.
      const expect = Math.min(1, m.n_helps * m.max_position);
      if (Math.abs(expect - m.help_coverage) > 1e-6) bad.push(`help_coverage ${m.help_coverage} does not match ${m.n_helps} names x ${m.max_position}`);
      if (m.max_position !== 0.12) bad.push(`single-position cap is ${m.max_position}, expected 0.12`);
      // A beta that survived the significance gate must be a real number, and one that did not
      // must be null rather than 0 -- the two mean different things and 0 would rank.
      for (const x of [...uh, ...uu]) {
        const bs = Object.values(x.betas || {});
        if (!bs.length) bad.push(`${x.ticker} has no betas`);
        if (bs.some(v => v !== null && !Number.isFinite(+v))) bad.push(`${x.ticker} has a non-finite beta`);
        if (!bs.some(v => v !== null)) bad.push(`${x.ticker} scored with no significant beta`);
        if (!(x.n_weeks >= m.min_weeks)) bad.push(`${x.ticker} fitted on ${x.n_weeks} weeks, minimum is ${m.min_weeks}`);
        if (Math.abs(+x.score) > 25) bad.push(`${x.ticker} scores ${x.score}%/wk, which is not a fund`);
      }
      // The universe is the universe, not the book. If every listed name is held, the column has
      // silently reverted to current holdings -- the exact bug this replaced.
      if (uh.length > 2 && uh.every(x => x.held) && uu.length > 2 && uu.every(x => x.held)) bad.push('every listed name is held; the universe ranking has reverted to holdings');
    }
    bad = [...new Set(bad)];
    say(` ok  stress universe        -> ${rows.length} scenarios, ${rows[0].universe_meta.n_scored} securities scored, ${bad.length} problems`);
    for (const b of bad) errors.push(`[stress] ${b}`);
    // And the card must actually render them rather than the old dollar lists.
    need(sis.includes('Expressible'), '[stress] the Expressible column is missing from the card');
    need(!/Helped by[\s\S]{0,400}\$\d+M/.test(sis), '[stress] helped-by still renders firm dollars, so it is still ranking holdings');
    const anyTicker = (rows[0].universe_helps || [])[0];
    if (anyTicker) need(sis.includes(anyTicker.ticker), `[stress] card does not show ${anyTicker.ticker}, the top universe name`);
  }

  // -------------------------------------------------------------------------
  // 12. Sven: every index carries every rule, and the news window switches.
  // -------------------------------------------------------------------------
  currentRoute = 'sven';
  await go('#sven');
  const s0 = app();
  const idx = (s0.match(/data-go="#sven\/\w+"/g) || []).length;
  say(` ok  sven matrix            -> ${idx} indices`);
  need(idx > 0, '[sven] rule matrix rendered no indices');
  need(s0.includes('News failure'), '[sven] news failure card missing');
  // The verdict column reads by colour: confirming green, any failure red.
  {
    const seg = s0.split('News failure')[1] || '';
    const verdicts = [...seg.matchAll(/<span style="color:(var\(--[a-z]+\));font-weight:[^"]*"[^>]*>([^<]+)<\/span>/g)].map(m => [m[2], m[1]]);
    const wrong = verdicts.filter(([label, col]) =>
      (/failure/i.test(label) && col !== 'var(--neg)') || (/^Confirming$/.test(label) && col !== 'var(--pos)'));
    say(` ok  sven verdict colours   -> ${verdicts.length} verdicts, ${wrong.length} mis-coloured`);
    for (const [l, c] of wrong) errors.push(`[sven] verdict "${l}" rendered ${c}`);

    // Failures first, and the impacted column must name holdings rather than models.
    const order = verdicts.map(([l]) => l);
    const lastFail = order.map((l, i) => /failure/i.test(l) ? i : -1).filter(i => i >= 0).pop() ?? -1;
    const firstNonFail = order.findIndex(l => !/failure/i.test(l));
    need(lastFail < 0 || firstNonFail < 0 || lastFail < firstNonFail,
      `[sven] failures are not listed first: ${order.join(' | ')}`);
    need(!seg.includes('>Held in<'), '[sven] the Held in column is still rendered');
    need(seg.includes('Impacted Holdings'), '[sven] the Impacted Holdings column is missing');
    const rows = await fetch(`${SUPABASE_URL}/rest/v1/latest_news_failure_readings?select=ticker,verdict,impacted,window_days&window_days=eq.30`, { headers: REST }).then(r => r.json());
    const bad = [];
    for (const r of rows) {
      const imp = r.impacted || [];
      // A verdict that concluded nothing must reach nothing, or the column implies a call.
      if (['none', 'insufficient'].includes(r.verdict) && imp.length) bad.push(`${r.ticker} concluded "${r.verdict}" yet lists ${imp.length} holdings`);
      for (const x of imp) {
        if (!x.ticker || !(+x.usd > 0)) bad.push(`${r.ticker} has an impacted entry with no ticker or no dollars`);
        if (+x.firm_weight > 1) bad.push(`${x.ticker} is ${x.firm_weight} of the firm`);
      }
      // Sorted largest first, since the column's job is to size the exposure.
      for (let i = 1; i < imp.length; i++) if (+imp[i].usd > +imp[i - 1].usd) bad.push(`${r.ticker} impacted list is not largest-first`);
    }
    const withImpact = rows.filter(r => (r.impacted || []).length).length;
    say(` ok  sven impacted holdings -> ${withImpact} of ${rows.length} readings reach a position, ${[...new Set(bad)].length} problems`);
    for (const b of [...new Set(bad)]) errors.push(`[sven] ${b}`);
    need(seg.includes('No Impact to Models'), '[sven] no row shows the No Impact to Models default');
  }
  await click('[data-newswin]', { newswin: '90' });
  need(app() !== s0, '[sven] switching the news window did not change the table');
}

// ---------------------------------------------------------------------------
console.log('');
if (errors.length) { console.log(`${errors.length} PROBLEM(S):`); for (const e of errors) console.log('  ' + e); process.exit(1); }
console.log('No problems found.');
