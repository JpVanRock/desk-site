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
// Captured before anything renders, so "did the page write to the database" can be asked by
// comparing write times rather than by comparing values -- a value that matches a suggestion may
// simply be a suggestion someone accepted last week.
const suiteStarted = Date.now();
let currentRoute = 'boot';
// A direct read, for checking what the page shows against what the database holds. Paged, because
// a table that gains a row per security per night walks into PostgREST's 1000-row cap on its own.
async function rest(table, select, extra = '') {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}${extra}`, { headers: { ...REST, Range: `${from}-${from + 999}` } });
    if (!res.ok) throw new Error(`${table} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    for (const r of page) out.push(r);
    if (page.length < 1000) break;
  }
  return out;
}
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
    gte(k, v) { st.filters.push(`${k}=gte.${v}`); return b; },
    lte(k, v) { st.filters.push(`${k}=lte.${v}`); return b; },
    not(k, op, v) { st.filters.push(`${k}=not.${op}.${v === null ? 'null' : v}`); return b; },
    order(c, o) { st.order = `${c}.${o && o.ascending === false ? 'desc' : 'asc'}`; return b; },
    limit(n) { st.limit = n; return b; },
    range(a, z) { st.range = [a, z]; return b; },
    then(res, rej) { runQuery(st).then(res, rej); },
    // Writes are stubbed. The harness reads production; it must never change it. insert returns
    // a plausible row id so a submit handler can be driven end to end without a round trip:
    // pressing Submit in a test has to exercise the code, not the database.
    upsert: async () => ({ data: null, error: null }),
    insert() { return { select: () => ({ single: async () => ({ data: { id: '00000000-0000-0000-0000-000000000000' }, error: null }) }), then(res) { res({ data: null, error: null }); } }; },
    update() { return { eq: async () => ({ data: null, error: null }) }; },
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
  '#markets', '#sisyphus', '#stan', '#annie', '#adam', '#neil', '#sven', '#kate', '#gail', '#gail/inbox', '#gail/briefs', '#sandbox', '#signals', '#admin',
  strat ? `#sisyphus/${strat.id}` : null,
  strat ? `#stan/${strat.id}` : null,
  sec ? `#markets/${sec.id}` : null,
  series ? `#admin/${series.series_id}` : null,
  '#stan/speed-limit', strat ? `#stan/top3-${strat.id}` : null,
  '#stan/snr-predictive', '#stan/snr-descriptive', '#stan/snr-positioning', '#stan/snr-sentiment',
  '#annie/steel-KSPY', '#sven/SPY',
].filter(Boolean);

for (const r of routes) {
  await go(r);
  // A page that fetches on render is mid-flight for a moment, which is what a browser shows too.
  // The sweep waits for it the way a reader would rather than failing the first frame -- the
  // Markets wall fetches six price series and went from passing to failing the instant a seventh
  // was added, which was a race in the test and not a fault on the page. What is still a fault
  // is a loading state that never resolves, and that is what the bound catches.
  for (let i = 0; i < 24 && /Loading chart…|Loading…|Loading price history…|Loading intraday bars…/.test(both()); i++) await sleep(250);
  const body = both();
  const problems = [];
  if (!body.trim()) problems.push('rendered nothing');
  if (/Loading chart…|Loading…|Loading price history…|Loading intraday bars…/.test(body)) problems.push('still showing a loading state');
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
  for (const [from, to, h1] of [['#overview', '#sisyphus', 'Sisyphus'], ['#decisions', '#annie', 'Decision Coach'], ['#playground', '#admin', 'Admin'], ['#views', '#admin', 'Admin'], ['#sources', '#admin', 'Admin'], ['#agents', '#admin', 'Admin'], ['#status', '#admin', 'Admin'], ['#briefs', '#gail/briefs', 'The Library'], ['#inbox', '#gail/inbox', 'The Library']]) {
    await go(from);
    const ok = location.hash === to && new RegExp(`<h1>${h1}</h1>`).test(app());
    say(` ok  ${from} -> ${location.hash}${ok ? '' : '  DID NOT REDIRECT'}`);
    need(ok, `[routing] ${from} did not redirect to ${to}`);
  }
  // The Playground lives inside Views now: one page, one name, and its controls still work there.
  {
    await go('#views');
    const v = app();
    need(v.includes('The Playground'), '[views] the Playground section is missing');
    need(/data-pgmodel=/.test(v), '[views] the Playground model picker did not render');
    need(!/<h1>The Playground<\/h1>/.test(v), '[views] the Playground still renders its own page heading');
    const nav = readFileSync(join(SITE, 'index.html'), 'utf8');
    need(!/href="#playground"/.test(nav), '[views] the nav still carries a Playground link');
    // The header mark is sized in auth.css, which loads after style.css and wins. A duplicate
    // rule in style.css sat there looking authoritative while doing nothing, and two separate
    // requests to enlarge the logo were spent on the sheet that loses.
    const cssMain = readFileSync(join(SITE, 'style.css'), 'utf8');
    const cssAuth = readFileSync(join(SITE, 'auth.css'), 'utf8');
    const sized = f => (f.match(/\.logo-header\s*\{[^}]*\}/g) || []);
    need(sized(cssMain).length === 0, '[logo] style.css defines .logo-header again; auth.css loads later and overrides it');
    need(sized(cssAuth).length === 1, '[logo] auth.css should carry exactly one .logo-header rule');
    const px = (sized(cssAuth)[0].match(/height:\s*(\d+)px/) || [])[1];
    say(` ok  header logo           -> ${px}px, sized in auth.css only`);
    need(+px === 60, `[logo] the header mark is ${px}px, expected 60`);
    // Its controls must still drive it from inside Views.
    const models = [...v.matchAll(/data-pgmodel="([^"]+)"/g)].map(m => m[1]);
    if (models.length > 1) {
      await click('[data-pgmodel]', { pgmodel: models[1] });
      need(app() !== v, '[views] switching the Playground model did not change the page');
    }
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
  // 10. Adam: the four macro seasons, the path, liquidity and the consumer.
  //     Rebuilt 2026-10-22; the Macro Beauty Contest is gone from this page entirely and lives
  //     on Kate's tab. What is guarded here is that each quad label agrees with the signs it was
  //     derived from, that a reading sitting on an axis is shown as contested rather than stated
  //     flatly, and that the computed domestic measure is never labelled as Howell's index.
  // -------------------------------------------------------------------------
  currentRoute = 'adam';
  await go('#adam');
  const ad = app();
  for (const want of ['The four macro regimes', 'The path', 'Global Liquidity Watch', 'The Macro Code'])
    need(ad.includes(want), `[adam] the ${want} section is missing`);
  need(!/Macro Beauty Contest|week's beauty contest/.test(ad), '[adam] the beauty contest is back on Adam\'s page');
  need(/rates of change, not levels/i.test(ad), '[adam] the page does not say the axes are rates of change');

  const quadRows = await rest('macro_quad_history', 'as_of,regime,quad,growth_z,inflation_z,conviction');
  need(quadRows.length > 12, `[adam] only ${quadRows.length} months of quad history`);
  const QMAP = { goldilocks: 1, reflation: 2, inflation: 3, deflation: 4 };
  let adBad = [];
  for (const r of quadRows) {
    if (QMAP[r.regime] !== r.quad) adBad.push(`${r.as_of} is ${r.regime} but quad ${r.quad}`);
    // The quadrant IS the pair of signs. A row whose numbers disagree with its own label would
    // make the entire path meaningless, and it is the one thing worth checking on every row.
    const want = +r.growth_z >= 0 ? (+r.inflation_z >= 0 ? 2 : 1) : (+r.inflation_z >= 0 ? 3 : 4);
    if (want !== r.quad) adBad.push(`${r.as_of} g ${r.growth_z} i ${r.inflation_z} is quad ${want}, labelled ${r.quad}`);
    if (Math.abs(Math.hypot(+r.growth_z, +r.inflation_z) - +r.conviction) > 0.01) adBad.push(`${r.as_of} conviction is not the distance from the origin`);
  }
  adBad = [...new Set(adBad)];
  for (const b of adBad) errors.push(`[adam] ${b}`);
  const newestQ = quadRows.slice().sort((a, b) => a.as_of.localeCompare(b.as_of)).pop();
  say(` ok  adam quads             -> ${quadRows.length} months, now Quad ${newestQ.quad} (g ${(+newestQ.growth_z).toFixed(2)} i ${(+newestQ.inflation_z).toFixed(2)}), ${adBad.length} problems`);

  // A reading on an axis must be shown as contested. Stating a coin toss flatly is the failure
  // this guard exists for, and today's reading is exactly that case.
  if (Math.abs(+newestQ.growth_z) < 0.15 || Math.abs(+newestQ.inflation_z) < 0.15)
    need(/contested/i.test(ad), '[adam] the reading sits on an axis and the page states the quad flatly anyway');
  need(/revised data/i.test(ad), '[adam] the path does not warn that it is drawn on revised data');

  const liqRows = await rest('global_liquidity_readings', 'as_of,net_liquidity,walcl,tga,rrp,direction');
  if (liqRows.length) {
    const l = liqRows.slice().sort((a, b) => a.as_of.localeCompare(b.as_of)).pop();
    need(+l.net_liquidity > 0, '[adam] net liquidity is not positive, so a unit or a sign is wrong');
    need(+l.net_liquidity < +l.walcl, '[adam] net liquidity exceeds the balance sheet it is drawn from');
    need(+l.tga < +l.walcl && +l.rrp < +l.walcl, '[adam] a drain is larger than the whole balance sheet, which is a units error');
    say(` ok  adam liquidity         -> $${(+l.net_liquidity / 1e6).toFixed(2)}tn, ${l.direction}`);
  }
  need(/never a substitute/i.test(ad), '[adam] the page does not distinguish net liquidity from Howell\'s index');
  need(/disagree/i.test(ad), '[adam] the page does not name the disagreement between the two liquidity frameworks');

  // The consumer block must be loaded but kept out of the quad, or every reading stored before
  // today becomes incomparable with the ones after it.
  const consumerSeries = await rest('macro_series', 'series_id,in_regime', '&series_id=in.(PSAVERT,UMCSENT,JTSQUR,DRCCLACBS,PERMIT,MICH)');
  need(consumerSeries.length === 6, `[adam] only ${consumerSeries.length} of 6 consumer series are loaded`);
  need(consumerSeries.every(x => x.in_regime === false), '[adam] a consumer series is feeding the quad, which silently moves the regime');
  need(/out of the quad/i.test(ad), '[adam] the page does not say the consumer series are excluded from the quad');
  say(` ok  adam consumer          -> ${consumerSeries.length} series loaded, all excluded from the quad`);
  // -------------------------------------------------------------------------
  // 9a. Stan's YTD column must be the MEASURED return, not the target-weight hypothetical.
  // -------------------------------------------------------------------------
  currentRoute = 'stan-ytd';
  await go('#stan');
  {
    const page = app();
    const ps = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_period_stats?select=strategy_id,period,model_return,start_date,end_date&period=eq.YTD`, { headers: REST }).then(r => r.json());
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
    // All three numeraire legs must run over the model's own window, not the performance job's.
    const windows = [...page.matchAll(/both legs over ([^.<"]*)/g)].map(m => m[1]);
    const stale = windows.filter(w => !/the model's own window|the model&#39;s own window/.test(w));
    say(` ok  numeraire windows      -> ${windows.length} legs, ${stale.length} on the performance window`);
    need(windows.length > 0, '[stan-ytd] no numeraire window stated');
    for (const w of stale) errors.push(`[stan-ytd] a numeraire leg still runs over ${w}`);
    // And the dates quoted must be the model's measured window.
    const psDates = ps.filter(r => r.model_return !== null)[0];
    if (psDates) need(page.includes(`${psDates.start_date} to ${psDates.end_date}`), `[stan-ytd] the numeraire tooltip does not quote the model window ${psDates.start_date}..${psDates.end_date}`);
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
  // 9d. Sandbox: the form's conditional parts, and the two sizing ladders.
  // -------------------------------------------------------------------------
  currentRoute = 'sandbox';
  await go('#sandbox');
  {
    const lots = await fetch(`${SUPABASE_URL}/rest/v1/latest_model_open_lots?select=strategy_id,ticker,weight,is_long_term,cost_price,basis_estimated`, { headers: REST }).then(r => r.json());
    function lotsForTicker(tk) { return new Set(lots.filter(l => l.ticker === tk).map(l => l.strategy_id)).size; }
    const buy = app();
    // Set-Up follows the action, and the three lists are different.
    const opts = h => [...h.matchAll(/<option value="([^"]+)"[^>]*>(?!Choose)/g)].map(m => m[1]);
    need(opts(buy).includes('Confirmed Bottom'), '[sandbox] the buy set-up list is missing Confirmed Bottom');
    need(!opts(buy).includes('Stop Loss'), '[sandbox] a sell-only set-up appears under Buy');
    await click('[data-sbaction]', { sbaction: 'sell' });
    const sell = app();
    need(opts(sell).includes('Stop Loss'), '[sandbox] the sell set-up list is missing Stop Loss');
    need(!opts(sell).includes('Confirmed Bottom'), '[sandbox] a buy-only set-up appears under Sell');
    need(/Tax impact of selling|tax a sale would realise/.test(sell), '[sandbox] no tax estimate section under Sell');
    await click('[data-sbaction]', { sbaction: 'rebalance' });
    need(opts(app()).join(',') === 'Time-Based,Risk-Based', '[sandbox] the rebalance set-up list is wrong');
    await click('[data-sbaction]', { sbaction: 'buy' });

    // Two ladders, and the class decides which. Equity-like is 3/6/12, income-like 4/8/16.
    await click('[data-sbclass]', { sbclass: 'equity' });
    const eq = app();
    for (const p of ['(3%)', '(6%)', '(12%)']) need(eq.includes(p), `[sandbox] the equity ladder is missing ${p}`);
    await click('[data-sbclass]', { sbclass: 'equity' });      // untick
    await click('[data-sbclass]', { sbclass: 'fixed_income' });
    const fi = app();
    for (const p of ['(4%)', '(8%)', '(16%)']) need(fi.includes(p), `[sandbox] the fixed income ladder is missing ${p}`);
    need(!fi.includes('(12%)'), '[sandbox] the equity ladder leaked into fixed income');
    // Custom reveals its own input.
    await click('[data-sbsizing]', { sbsizing: 'custom' });
    need(/data-sbcustom/.test(app()), '[sandbox] Custom did not reveal a percentage field');
    say(` ok  sandbox form           -> set-ups follow the action, ladders follow the class`);

    // The five lenses on a journal entry. Kate carried portfolio construction when she was the
    // implementation analyst; she reads the crowd now and construction is Stan's. Three places
    // name the roster -- the Analyze note, the Fine Tune note and Gail's catalogue -- and they
    // drift silently, because nothing breaks when one of them is left behind.
    const LENSES = ['Annie', 'Adam', 'Sven', 'Kate', 'Stan'];
    const sb0 = app();
    for (const a of LENSES) need(new RegExp(`\\b${a}\\b`).test(sb0), `[sandbox] the Analyze note does not name ${a}`);
    need(/Stan on what it does to the book/.test(sb0), '[sandbox] Stan is named without saying which lens he holds');
    need(!/Kate[^.]{0,80}(concentration|12% cap|tax this realises)/.test(sb0), '[sandbox] Kate is still described as the construction lens');
    await go('#gail');
    const g0 = app();
    // Gail renders the per-agent columns only once something has been filed. With an empty
    // catalogue there is no roster on the page to check, and asserting one would be asserting
    // that the empty state is wrong.
    const gailFiled = !/No journal entries yet/.test(g0);
    if (gailFiled) for (const a of LENSES) need(new RegExp(`\\b${a}\\b`).test(g0), `[gail] the catalogue has no column for ${a}`);
    say(` ok  sandbox lenses         -> ${LENSES.join(', ')}; construction is Stan's${gailFiled ? '; Gail shows all five' : '; Gail is empty so its columns were not checked'}`);

    // The Library: one reading room with three shelves, each rendered from the SAME function the
    // standalone page used rather than a copy of it, so the two cannot drift.
    await go('#gail');
    const lib0 = app();
    need(/<h1>The Library<\/h1>/.test(lib0), '[library] the page is not headed The Library');
    need(/class="loc"/.test(lib0), '[library] the reading-room treatment is not applied');
    for (const want of ['Trade Journal History', 'Inbox', 'Briefs'])
      need(lib0.includes(want), `[library] the ${want} shelf is missing from the bar`);
    need((lib0.match(/<h1>/g) || []).length === 1, '[library] a shelf kept its own page heading');
    // Each shelf has to actually change what is in the room, and carry its own hash.
    const seen = {};
    for (const [k, heading, probe] of [['journal', 'Trade Journal History', null],
                                       ['inbox', 'Inbox', 'Clipped and dropped'],
                                       ['briefs', 'Briefs', 'Sunday primer']]) {
      await go('#gail/' + k);
      const v = app();
      need(new RegExp(`<h2>${heading}</h2>`).test(v), `[library] #gail/${k} does not open the ${heading} shelf`);
      need(/aria-current="page"/.test(v), `[library] no shelf is marked current on #gail/${k}`);
      if (probe) need(v.includes(probe), `[library] the ${heading} shelf rendered without its content`);
      seen[k] = v.length;
    }
    need(new Set(Object.values(seen)).size === 3, '[library] two shelves rendered identical content, so the selector is not switching');
    // An unknown shelf must land in the reading room rather than on an empty page.
    await go('#gail/nonsense');
    need(/<h2>Trade Journal History<\/h2>/.test(app()), '[library] an unknown shelf does not fall back to the journal');
    // And the header must no longer carry the two that moved.
    const nav2 = [...readFileSync(join(SITE, 'index.html'), 'utf8').matchAll(/<nav id="nav">([\s\S]*?)<\/nav>/g)].flatMap(m => [...m[1].matchAll(/href="#([a-z-]+)"/g)].map(x => x[1]));
    need(!nav2.includes('briefs') && !nav2.includes('inbox'), '[library] Briefs or Inbox is still a header tab');
    // The reading room now uses the SITE's palette rather than its own. The guard is the inverse
    // of what it was: the earlier parchment version had to re-base the theme tokens so dark-theme
    // inline colours stayed legible, and the right way to never need that again is to not
    // redefine them at all. A token redefined here means the tab has started drifting away from
    // the rest of the site, which is what the first version got wrong.
    const css = readFileSync(join(SITE, 'style.css'), 'utf8');
    const locBlock = (css.match(/\.loc\{[\s\S]*?\n\}/) || [''])[0];
    for (const tok of ['--text:', '--muted:', '--line:', '--pos:', '--neg:', '--panel:', '--bg:'])
      need(!locBlock.includes(tok), `[library] the reading room redefines ${tok.slice(0, -1)}, so it has started drifting from the site's own palette`);
    need(/--loc-brass/.test(locBlock), '[library] the brass accent is gone, so the reading room has no identity left');
    say(` ok  library                -> three shelves, each on its own hash; Briefs and Inbox left the header; on the site's own palette`);
    await go('#sandbox');

    // A real sell: the tax table must name the models that hold the ticker and cost it from lots.
    await click('[data-sbaction]', { sbaction: 'sell' });
    await change('[data-sbticker]', { sbticker: '' }, 'KSPY');
    const sellTax = app();
    const taxRows = [...sellTax.matchAll(/<td>([A-Za-z ]+)<\/td>\s*<td class="num">([\d.]+)%<\/td>\s*<td class="num">([\d.]+)%<\/td>/g)];
    const holders = lotsForTicker('KSPY');
    say(` ok  sandbox sell tax       -> ${taxRows.length} models costed for KSPY, ledger says ${holders} hold it`);
    need(taxRows.length === holders, `[sandbox] the tax table costed ${taxRows.length} models but ${holders} hold KSPY`);
    need(/15% long-term · 24% short-term/.test(sellTax), '[sandbox] the sell tax rates are not stated');
    await click('[data-sbaction]', { sbaction: 'buy' });

    // Submit stays disabled until the entry is complete, which is the guard against a half-written
    // decision reaching the catalogue.
    need(/data-sbsubmit="1" disabled/.test(app()), '[sandbox] Submit is enabled on an incomplete entry');
    need(/Still needed:/.test(app()), '[sandbox] the form does not say what is still missing');

    // Open lots back the tax estimate and must reconcile to the model.

    const byStrat = {};
    for (const l of lots) byStrat[l.strategy_id] = (byStrat[l.strategy_id] || 0) + +l.weight;
    // Every model's lots must account for the whole model. A shortfall means a position has no
    // lot, and a sale of it would report no tax -- the most flattering answer, reached by the
    // holding being invisible.
    const off = Object.entries(byStrat).filter(([, w]) => Math.abs(w - 1) > 0.02);
    say(` ok  open lots              -> ${lots.length} lots across ${Object.keys(byStrat).length} models, ${off.length} not summing to 100%`);

    // The allocation editor: the pies come straight off the weights, and Test must rebuild a real
    // series and produce real statistics rather than rendering a shape with nothing behind it.
    // Measure an equity-bearing model: the fingerprint and sector sections are equity properties,
    // and a bond book correctly has neither, which would make this test prove nothing.
    const eqModel = (await fetch(`${SUPABASE_URL}/rest/v1/strategies?select=id,name&name=eq.Balanced%20Core`, { headers: REST }).then(r => r.json()))[0];
    if (eqModel) await click('[data-samodel]', { samodel: eqModel.id });
    const ed0 = app();
    need(/data-sawt=/.test(ed0), '[sandbox] the allocation editor rendered no weight fields');
    need(/data-satest/.test(ed0) && /data-safinal/.test(ed0), '[sandbox] Test or Submit Final is missing');
    const totalShown = (ed0.match(/<b style="color:var\(--(?:pos|warn)\)">([\d.]+)%<\/b>/) || [])[1];
    need(totalShown && Math.abs(+totalShown - 100) < 0.6, `[sandbox] the editor total reads ${totalShown}%, expected the model's own weights to sum to 100%`);
    // The fingerprint and the sector breakdown must be on the page BEFORE Test is pressed. Both
    // are weighted sums of per-security figures already loaded, so gating them on Test left the
    // section showing two pies and nothing else on arrival -- which read as the fingerprint simply
    // not having been built. Assert the real content, not just the heading: a book with equity in
    // it must produce a radar and at least one sector row without any price fetch at all.
    need(/Factor fingerprint/.test(ed0), '[sandbox] no factor fingerprint before Test was pressed');
    need(/Sector weighting/.test(ed0), '[sandbox] no sector breakdown before Test was pressed');
    need(!/no style tilt to report/.test(ed0), '[sandbox] the fingerprint is empty for a book that holds equity');
    need(!/no breakdown to show|no sector fit/.test(ed0), '[sandbox] the sector breakdown is empty for a book that holds equity');
    need(/Share of equity/.test(ed0), '[sandbox] the sector table has no rows before Test');
    need(ed0.indexOf('Factor fingerprint') < ed0.indexOf('Portfolio statistics'),
      '[sandbox] the fingerprint is not directly below the two pies');
    need(ed0.indexOf('>Regimes<') < ed0.indexOf('Factor fingerprint'),
      '[sandbox] the fingerprint is above the Regimes pie rather than below both pies');
    say(` ok  sandbox fingerprint    -> radar and sector table render on arrival, no Test needed`);
    await click('[data-satest]', { satest: '1' });
    // Waits for the figure rather than for a fixed interval. A flat 2500ms was enough until the
    // suite grew another price fetch to contend with, and then this failed intermittently --
    // which is the worst kind of test, because the failure says the feature is broken when the
    // only thing that was broken is the clock.
    for (let i = 0; i < 48 && !/YTD return<\/span><br><b/.test(app()); i++) await sleep(250);
    const tested = app();
    const ytd = (tested.match(/YTD return<\/span><br><b[^>]*>([+-][\d.]+)%/) || [])[1];
    const vol = (tested.match(/Volatility<\/span><br><b[^>]*>([\d.]+)%/) || [])[1];
    say(` ok  sandbox test           -> YTD ${ytd ?? '—'}, volatility ${vol ?? '—'}`);
    need(ytd !== undefined, '[sandbox] Test produced no YTD figure');
    need(vol !== undefined, '[sandbox] Test produced no volatility figure');
    // A measured book should land in a plausible range; a broken series shows itself here first.
    if (ytd !== undefined) need(Math.abs(+ytd) < 60, `[sandbox] Test returned a YTD of ${ytd}%, which is not this book`);
    need(/Factor fingerprint/.test(tested), '[sandbox] Test did not produce a factor fingerprint');
    need(/Sector weighting/.test(tested), '[sandbox] Test did not produce a sector breakdown');
    // The second pie is the regime split, and the fingerprint sits with the pies rather than
    // among the statistics: those three say what the book IS, the statistics how it has behaved.
    need(/>Regimes</.test(tested), '[sandbox] the second pie is not labelled Regimes');
    // Specifically the pie's eyebrow label, not the fingerprint table's "Factor" column header.
    need(!/class="eyebrow"[^>]*>Factor</.test(tested), '[sandbox] the old Factor pie label is still there');
    need(tested.indexOf('Factor fingerprint') < tested.indexOf('Portfolio statistics'),
      '[sandbox] the fingerprint is not above the portfolio statistics');
    for (const [sid, w] of off) errors.push(`[sandbox] open lots for ${sid} sum to ${(w * 100).toFixed(1)}%`);
    for (const l of lots) if (!(+l.cost_price > 0)) errors.push(`[sandbox] a ${l.ticker} lot has no cost basis`);
  }

  // -------------------------------------------------------------------------
  // 10a. Nav order. Stan sits between Sisyphus and Adam; the page map matches the nav.
  // -------------------------------------------------------------------------
  {
    const nav = readFileSync(join(SITE, 'index.html'), 'utf8');
    const order = [...nav.matchAll(/<a href="#([a-z]+)">/g)].map(m => m[1]);
    const want = ['markets', 'sisyphus', 'stan', 'annie', 'adam', 'neil', 'sven', 'kate', 'gail', 'sandbox', 'signals', 'admin'];
    say(` ok  nav order              -> ${order.join(' · ')}`);
    need(want.length === order.length && want.every((w, i) => order[i] === w), `[nav] expected ${want.join(' · ')}, found ${order.join(' · ')}`);
  }

  // -------------------------------------------------------------------------
  // 9b2. Annie's decision quality: calibration, fielding, kill criteria, dissent.
  //      Three of the four depend on journal inputs that began on 2026-10-20, so the guard is
  //      that an empty measure SAYS it has not started rather than rendering a blank box --
  //      "not yet begun" and "broken" must never look the same to a reader.
  // -------------------------------------------------------------------------
  currentRoute = 'decision-quality';
  await go('#annie');
  {
    const a = app();
    for (const want of ['Decision quality', 'Calibration', 'Fielding', 'Kill criteria held', 'Dissent'])
      need(a.includes(want), `[dq] the ${want} block is missing from Annie's tab`);
    const dq = await rest('latest_annie_decision_quality', 'scope,strategy_id,n_scored,brier,n_fielded,win_skill_share,loss_skill_share,fielding_gap,n_breached,n_honoured,cum_selection,helped_share');
    need(dq.length > 0, '[dq] no decision-quality readings at all');
    const firm = dq.find(x => x.scope === 'firm');
    need(firm, '[dq] there is no firm-wide reading');
    let bad = [];
    for (const r of dq) {
      // A Brier score over a handful of calls is four coin flips wearing a decimal.
      if (r.brier !== null && r.n_scored < 10) bad.push(`${r.scope} published a Brier over ${r.n_scored} entries`);
      if (r.brier !== null && (+r.brier < 0 || +r.brier > 1)) bad.push(`${r.scope} Brier ${r.brier} is outside 0-1`);
      if (+r.n_honoured > +r.n_breached) bad.push(`${r.scope} honoured more thresholds than were breached`);
      // The three numbers on the page must add up for a reader who subtracts them.
      if (r.win_skill_share !== null && r.loss_skill_share !== null) {
        const g = +(+r.win_skill_share - +r.loss_skill_share).toFixed(4);
        if (Math.abs(g - +r.fielding_gap) > 1e-9) bad.push(`${r.scope} gap ${r.fielding_gap} is not ${r.win_skill_share} minus ${r.loss_skill_share}`);
      }
      for (const k of ['win_skill_share', 'loss_skill_share']) {
        if (r[k] !== null && (+r[k] < 0 || +r[k] > 1)) bad.push(`${r.scope} ${k} is ${r[k]}, which is not a share`);
      }
    }
    bad = [...new Set(bad)];
    for (const b of bad) errors.push(`[dq] ${b}`);
    // An unstarted measure must explain itself rather than render blank.
    if (firm && !firm.n_scored) need(/cannot be backfilled/.test(a), '[dq] calibration has not started and the page does not say why it is empty');
    need(/computed, not asked/.test(a), '[dq] the page does not say the fielding is computed rather than surveyed');
    // Firm-wide must count decisions, not rows. One fund exited on one date appears once per
    // model that held it, so counting rows weights a decision by how many models owned it.
    const revRows = await rest('latest_annie_trade_reviews', 'ticker,exit_date,fielded');
    const distinct = new Set(revRows.filter(x => x.fielded).map(x => `${x.ticker}|${x.exit_date}`)).size;
    need(+firm.n_fielded === distinct, `[dq] firm-wide fielded ${firm.n_fielded} but there are ${distinct} distinct decisions`);
    // The gap says how results were attributed; these say whether the choosing paid.
    need(firm.cum_selection !== null && firm.helped_share !== null, '[dq] the edge measures are missing');
    need(+firm.helped_share >= 0 && +firm.helped_share <= 1, `[dq] helped_share ${firm.helped_share} is not a share`);
    need(/whether the choosing paid/.test(a), '[dq] the page does not distinguish attribution from edge');
    say(` ok  decision quality       -> ${dq.length} readings, ${firm.n_fielded} trades fielded, gap ${firm.fielding_gap === null ? '—' : (+firm.fielding_gap * 100).toFixed(0) + 'pt'}, ${bad.length} problems`);

    // The journal entry form must collect the three things that can never be backfilled.
    await go('#sandbox');
    const sb0 = app();
    for (const [sel, what] of [['data-sbconf', 'confidence'], ['data-sbhorizondays', 'a horizon in days'],
                               ['data-sbscenlabel', 'scenario labels'], ['data-sbscenprob', 'scenario probabilities'],
                               ['data-sbpremortem', 'a premortem']])
      need(sb0.includes(sel), `[dq] the journal entry form does not collect ${what}`);
    // Submit must be blocked while the branches do not add up -- a half-filled scenario list is
    // worse than none, because it looks like a record of what was considered and is not.
    need(/data-sbsubmit="1" disabled/.test(sb0), '[dq] Submit is enabled on an entry with no scenarios filled in');
    need(/scenarios summing to 100%|a label on every scenario/.test(sb0), '[dq] the form does not say the scenarios are incomplete');
    need(/cannot be filled in later/.test(sb0), '[dq] the confidence field does not warn that it cannot be backfilled');
    say(` ok  journal inputs         -> confidence, horizon, scenarios and premortem all required`);
  }

  // -------------------------------------------------------------------------
  // 9c. News failure: events, the strength scale, and the flow breakdown.
  //     A failure is one headline release the price traded the wrong way, so one event is enough
  //     to reach the table. The guard that matters is that the surface figures and the list they
  //     open into come from the same place.
  // -------------------------------------------------------------------------
  currentRoute = 'news-failure';
  await go('#sven');
  {
    const sv = app();
    for (const want of ['Signal strength', 'Total news flow', 'Impacted Holdings'])
      need(sv.includes(want), `[news] the ${want} column is missing`);
    need(!/<th class="num">Breadth<\/th>/.test(sv), '[news] the Breadth column survived the rework');
    const rows = await rest('latest_news_failure_readings', 'ticker,window_days,verdict,signal_strength,n_events,n_positive,n_negative,releases,events');
    need(rows.length > 0, '[news] no readings at all');
    const wins = [...new Set(rows.map(r => r.window_days))].sort((a, b) => a - b);
    need(wins.join(',') === '7,30,90', `[news] the time frames changed: ${wins.join(',')}`);
    let bad = [];
    for (const r of rows) {
      const want = r.n_events <= 0 ? null : r.n_events === 1 ? 'initiate' : r.n_events === 2 ? 'confirmed' : 'strong';
      if (r.signal_strength !== want) bad.push(`${r.ticker} ${r.window_days}d has ${r.n_events} events labelled ${r.signal_strength}`);
      if (/failure$/.test(r.verdict) && !(r.n_events > 0)) bad.push(`${r.ticker} ${r.window_days}d calls ${r.verdict} with no event`);
      // The percentage and the list it opens must be the same arithmetic.
      const rel = Array.isArray(r.releases) ? r.releases : [];
      if (rel.filter(x => x.good).length !== r.n_positive || rel.filter(x => !x.good).length !== r.n_negative) {
        bad.push(`${r.ticker} ${r.window_days}d shows ${r.n_positive}+/${r.n_negative}- but opens into ${rel.filter(x => x.good).length}+/${rel.filter(x => !x.good).length}-`);
      }
      // Only headline releases may trigger an event.
      for (const e of (Array.isArray(r.events) ? r.events : [])) {
        if (e.failed && !rel.find(x => x.series === e.series && x.obs_date === e.obs_date && x.headline)) {
          bad.push(`${r.ticker} ${r.window_days}d failed on ${e.series}, which is not a headline release`);
        }
      }
    }
    bad = [...new Set(bad)];
    for (const b of bad) errors.push(`[news] ${b}`);
    // The scale has to discriminate. If every row reads Strong it is not a scale -- which is
    // exactly what a bare sign test produced before the materiality floor went in.
    const withStrength = rows.filter(r => r.signal_strength);
    const allStrong = withStrength.length > 4 && withStrength.every(r => r.signal_strength === 'strong');
    need(!allStrong, '[news] every graded row reads Strong, so the scale is not discriminating');
    const oneEvent = rows.filter(r => r.n_events === 1);
    say(` ok  news failure           -> ${rows.length} readings, ${withStrength.length} graded (${oneEvent.length} on a single event), ${bad.length} problems`);
    // The flow breakdown opens, and separates the two sides.
    const withFlow = rows.find(r => r.window_days === 30 && (r.n_positive + r.n_negative) > 0);
    if (withFlow) {
      await go('#sven/flow-' + withFlow.ticker);
      const dr = drawer();
      need(/Positive for this asset/.test(dr) && /Negative for this asset/.test(dr), '[news] the flow breakdown does not separate positive from negative');
      need(new RegExp(`${withFlow.ticker} news flow`).test(dr), '[news] the flow drawer is not headed with the asset');
      need(/good and bad are properties of the pairing/i.test(dr), '[news] the drawer does not explain that good and bad depend on the asset');
      say(` ok  news flow drawer       -> ${withFlow.ticker} opens ${withFlow.n_positive} positive and ${withFlow.n_negative} negative`);
    }
  }

  // -------------------------------------------------------------------------
  // 9c2. The ticker tape: does the tape agree?
  //      It sits between the Speed Limit and Model Surveillance because that is the argument it
  //      settles -- the light is a judgment, the tape is arithmetic. The guards are that every
  //      correlation is a correlation, that the agreement verdict follows the two signs it is
  //      drawn from, and that the loop renders each item twice so the scroll is seamless.
  // -------------------------------------------------------------------------
  currentRoute = 'tape';
  await go('#stan');
  {
    const tp = app();
    need(/Does the tape agree\?/.test(tp), '[tape] the ticker is missing from Stan\'s page');
    need(/class="tapetrack"/.test(tp), '[tape] the scrolling track did not render');
    // Between the Speed Limit and Model Surveillance, which is where the argument belongs.
    need(tp.indexOf('Speed Limit') < tp.indexOf('Does the tape agree'), '[tape] the ticker is above the Speed Limit');
    need(tp.indexOf('Does the tape agree') < tp.indexOf('Model Surveillance'), '[tape] the ticker is below Model Surveillance');

    const tk = await rest('latest_tape_ticker', 'measure,horizon,label,value,value_kind,secondary,verdict,return_days,lookback_days,n_obs');
    need(tk.length === 16, `[tape] ${tk.length} ticker rows, expected 16 (4 measures x 4 horizons)`);
    const measures = [...new Set(tk.map(x => x.measure))].sort();
    need(measures.join(',') === 'agreement,brakes,correlation,dollar', `[tape] measures are ${measures.join(',')}`);
    const horizons = [...new Set(tk.map(x => x.horizon))].sort();
    need(horizons.join(',') === '1d,1m,1w,2d', `[tape] horizons are ${horizons.join(',')}`);
    let tb = [];
    for (const r of tk) {
      if (r.value_kind === 'correlation' && r.value !== null && (+r.value < -1.0001 || +r.value > 1.0001))
        tb.push(`${r.label} correlation ${r.value} is outside -1..1`);
      if (r.measure === 'brakes' && r.secondary !== null && (+r.secondary < -1.0001 || +r.secondary > 1.0001))
        tb.push(`${r.label} book correlation ${r.secondary} is outside -1..1`);
      // A correlation without an interval and a window is not a number.
      if (r.value_kind === 'correlation' && r.value !== null && (!r.return_days || !r.lookback_days))
        tb.push(`${r.label} reports a correlation without its interval or lookback`);
      // The agreement verdict must follow the two signs it is drawn from.
      if (r.measure === 'agreement' && r.verdict === 'agree' && r.value !== null && +r.secondary !== 0
          && Math.sign(+r.value) !== +r.secondary) tb.push(`${r.label} says agree while the signs differ`);
      if (r.measure === 'agreement' && r.verdict === 'disagree' && r.value !== null && +r.secondary !== 0
          && Math.sign(+r.value) === +r.secondary) tb.push(`${r.label} says disagree while the signs match`);
    }
    tb = [...new Set(tb)];
    for (const b of tb) errors.push(`[tape] ${b}`);
    // Each item must appear twice, or the scroll jumps when it loops.
    const first = tk.find(x => x.measure === 'agreement' && x.horizon === '1d');
    if (first) {
      const hits = (tp.match(new RegExp(first.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      need(hits >= 2, `[tape] "${first.label}" appears ${hits} time(s); the track needs each item twice to loop seamlessly`);
    }
    // The brakes must be shown with their correlation to the book they offset.
    need(/vs book/.test(tp), '[tape] the brakes are shown without their correlation to the risk book');
    const brakes = tk.filter(x => x.measure === 'brakes' && x.secondary !== null);
    say(` ok  tape ticker            -> ${tk.length} rows, brakes vs book ${brakes.map(b => (+b.secondary).toFixed(2)).join(' / ')}, ${tb.length} problems`);
  }

  // -------------------------------------------------------------------------
  // 9d. Stan: what the risk figures cannot say.
  //     The point of this card is to state the limits of every other number on the page, so the
  //     guards are about honesty rather than arithmetic: a window must never be shown as worse
  //     than the history containing it, complacency must not be framed as a forecast, and the
  //     departed-securities count must be labelled a floor rather than a count.
  // -------------------------------------------------------------------------
  currentRoute = 'risk-humility';
  await go('#stan');
  {
    const st = app();
    need(/What these figures cannot say/.test(st), '[humility] the card is missing from Stan\'s page');
    for (const want of ['What the window did not contain', 'Complacency', 'The same book, relived',
                        'Convexity, measured', 'Frequency against magnitude', 'Silent evidence'])
      need(st.includes(want), `[humility] the "${want}" section is missing`);
    need(/not a forecast/i.test(st), '[humility] complacency is not marked as something other than a forecast');
    need(/floor on what is missing, not a count/i.test(st), '[humility] the silent-evidence count is not labelled a floor');

    const hr = await rest('latest_risk_humility', 'scope,strategy_id,window_days,window_worst,history_days,history_worst,coverage,complacency,complacency_legs,sim_p05,sim_p50,sim_p95,beta_up,beta_down,convexity_gap,hit_rate,skew,n_departed');
    need(hr.length >= 2, `[humility] only ${hr.length} rows computed`);
    const firm = hr.find(x => x.scope === 'firm');
    need(firm, '[humility] no firm-wide row');
    let hb = [];
    for (const r of hr) {
      // A window is inside its own history, so it cannot contain a worse day than the history.
      if (r.window_worst !== null && r.history_worst !== null && +r.window_worst < +r.history_worst - 1e-9)
        hb.push(`${r.scope} window worst ${r.window_worst} beats its own history ${r.history_worst}`);
      if (r.coverage !== null && (+r.coverage < 0 || +r.coverage > 1.0001)) hb.push(`${r.scope} coverage ${r.coverage} is not a share`);
      if (r.window_days > r.history_days) hb.push(`${r.scope} window is longer than the record it sits in`);
      if (r.complacency !== null && (+r.complacency < 0 || +r.complacency > 100)) hb.push(`${r.scope} complacency ${r.complacency} outside 0-100`);
      if (r.sim_p05 !== null && (+r.sim_p05 > +r.sim_p50 || +r.sim_p50 > +r.sim_p95)) hb.push(`${r.scope} simulated quantiles out of order`);
      // The gap must equal the two betas it is drawn from, or three numbers on the page disagree.
      if (r.beta_up !== null && r.beta_down !== null) {
        const g = +(+r.beta_up - +r.beta_down).toFixed(6);
        if (Math.abs(g - +r.convexity_gap) > 1e-5) hb.push(`${r.scope} convexity gap is not up minus down`);
      }
      const legs = Array.isArray(r.complacency_legs) ? r.complacency_legs : [];
      if (r.complacency !== null && legs.length < 3) hb.push(`${r.scope} complacency is built on ${legs.length} legs`);
    }
    hb = [...new Set(hb)];
    for (const b of hb) errors.push(`[humility] ${b}`);
    // The measure only means something if at least one book's window is narrower than its record.
    const narrow = hr.filter(r => r.coverage !== null && +r.coverage < 0.98).length;
    say(` ok  risk humility          -> ${hr.length} books, ${narrow} with a window narrower than their record, complacency ${firm.complacency === null ? '—' : (+firm.complacency).toFixed(0)}, ${hb.length} problems`);
  }

  // -------------------------------------------------------------------------
  // 10b. Neil: the saeculum, the generational clock, and the age arithmetic.
  //      The rule this page lives under is that Strauss and Howe's turnings are a FRAMEWORK, not
  //      a measurement, and the page must keep the two visibly apart. A framework that explains
  //      every outcome afterwards explains none in advance, and presenting one as measured would
  //      turn a lens into a forecast.
  // -------------------------------------------------------------------------
  currentRoute = 'neil';
  await go('#neil');
  {
    const nl = app();
    need(/<h1>Hunger Games Demo<\/h1>/.test(nl), '[neil] the page is not titled Hunger Games Demo');
    for (const want of ['The saeculum', 'Who is where', 'The arithmetic', 'The Hunger Games'])
      need(nl.includes(want), `[neil] the ${want} section is missing`);
    need(/their dating, not a measurement/i.test(nl), '[neil] the page does not say the turnings are a framework rather than a measurement');

    const turns = await rest('saeculum_turnings', 'seq,turning,name,start_year,end_year,uncertain');
    const gens = await rest('generations', 'name,birth_from,birth_to');
    need(turns.length === 4, `[neil] ${turns.length} turnings seeded, expected 4`);
    need(gens.length >= 8, `[neil] only ${gens.length} generations seeded`);
    let nBad = [];
    // The turnings must be contiguous and in order, or the clock is drawn from a broken sequence.
    const sorted = turns.slice().sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].end_year !== null && sorted[i].start_year !== sorted[i - 1].end_year)
        nBad.push(`turning ${sorted[i].turning} starts ${sorted[i].start_year} but the one before ends ${sorted[i - 1].end_year}`);
    }
    need(sorted.filter(t => t.end_year === null).length === 1, '[neil] exactly one turning should be open-ended');
    // Generations must not overlap, or a person would be in two at once.
    const gs = gens.slice().sort((a, b) => a.birth_from - b.birth_from);
    for (let i = 1; i < gs.length; i++) {
      if (gs[i].birth_from <= gs[i - 1].birth_to) nBad.push(`${gs[i].name} overlaps ${gs[i - 1].name}`);
    }
    nBad = [...new Set(nBad)];
    for (const b of nBad) errors.push(`[neil] ${b}`);
    // Ages must be computed from today, not written into the page.
    const yr = new Date().getFullYear();
    const boom = gs.find(g => g.name === 'Boom');
    if (boom) need(nl.includes(`${yr - boom.birth_to}\u2013${yr - boom.birth_from}`) || nl.includes(`${yr - boom.birth_to}–${yr - boom.birth_from}`),
      `[neil] the Boom age span is not computed from the current year (${yr - boom.birth_to}-${yr - boom.birth_from})`);
    say(` ok  neil saeculum          -> ${turns.length} turnings, ${gens.length} generations, ${nBad.length} problems`);

    // The arithmetic must carry observation years, because these are annual revised series.
    const demo = await rest('current_macro_readings', 'fred_code,value,obs_date', '&fred_code=in.(SPPOP65UPTOZSUSA,SPPOP0014TOZSUSA,SPPOPDPNDOLUSA,SPDYNTFRTINUSA)');
    need(demo.length === 4, `[neil] only ${demo.length} of 4 headline demographic series are loaded`);
    const o65 = demo.find(d => d.fred_code === 'SPPOP65UPTOZSUSA');
    const u15 = demo.find(d => d.fred_code === 'SPPOP0014TOZSUSA');
    if (o65 && u15) {
      const crossed = +o65.value > +u15.value;
      need(/crossover has happened/i.test(nl) === crossed, '[neil] the page and the data disagree about whether the old-young crossover has happened');
      say(` ok  neil arithmetic        -> 65+ ${(+o65.value).toFixed(1)}% against under-15 ${(+u15.value).toFixed(1)}%${crossed ? ', crossed' : ''}`);
    }
    // The Hunger Games section is sourced now -- from Dredge's own written updates and a recorded
    // meeting -- so the guard flips from "must stay empty" to "must stay honest about what is
    // his, what is the desk's, and what was never verified at all".
    need(/competition among sovereigns/i.test(nl), '[neil] the Hunger Games section does not state what the competition is');
    need(/fewer taxpayers and savers/i.test(nl), '[neil] the demographic half of the thesis is missing');
    need(/not his numbers|he is not the source/i.test(nl), '[neil] the page does not separate the desk\'s fiscal series from his argument');
    need(/not desk guidance|not this desk's/i.test(nl), '[neil] his illustrative portfolios are not marked as his rather than the desk\'s');
    // The figures he gave that the notes themselves flagged as unverified must never appear.
    need(!/\$12\s*(tn|trillion)/i.test(nl) && !/\$20\s*(tn|trillion)/i.test(nl),
      '[neil] a repo figure the meeting notes recorded as unverified has reached the page');
    // The headline number must be the two measured halves, not a figure typed in.
    const fiscal = await rest('current_macro_readings', 'fred_code,value,obs_date', '&fred_code=in.(GFDEBTN,GFDEGDQ188S,LFWA64TTUSM647S)');
    need(fiscal.length === 3, `[neil] only ${fiscal.length} of 3 Hunger Games series are loaded`);
    const debt = fiscal.find(f => f.fred_code === 'GFDEBTN'), wa = fiscal.find(f => f.fred_code === 'LFWA64TTUSM647S');
    if (debt && wa) {
      const per = Math.round((+debt.value * 1e6) / +wa.value);
      need(nl.includes(per.toLocaleString()), `[neil] the debt-per-working-age figure on the page is not ${per.toLocaleString()} computed from the two series`);
      say(` ok  neil hunger games      -> $${per.toLocaleString()} of federal debt per working-age person`);
    }
    const dpct = fiscal.find(f => f.fred_code === 'GFDEGDQ188S');
    if (dpct) need(nl.includes((+dpct.value).toFixed(1) + '%'), '[neil] the debt-to-GDP figure does not match the series');
  }

  // -------------------------------------------------------------------------
  // 10a1. Markets: the desk wall. The panels must carry real quotes, the risk block must sit
  //       beside the VIX, and the performance chart must actually draw once its history lands --
  //       a synchronous render shows it mid-load, which is not proof that it works.
  // -------------------------------------------------------------------------
  currentRoute = 'markets';
  await go('#markets');
  {
    for (const want of ['US equity markets', 'Risk and volatility', 'US equity sectors', 'Fixed income',
                        'Currencies', 'Global markets', 'Commodities', 'Government yields', 'US equity factors',
                        'Normalised performance'])
      need(app().includes(want), `[markets] the ${want} panel is missing`);
    // Removed at the owner's request, for room. Still tracked, so they must remain in the table.
    // Check the quote ROWS, not the prose: the panel's own note explains the removal by name, and
    // matching anywhere in the markup flagged that note as the thing it was describing.
    const panelNames = [...app().split('Every tracked security')[0].matchAll(/<span class="pname"[^>]*>([^<]+)</g)].map(m => m[1]);
    need(!panelNames.includes('Australia') && !panelNames.includes('South Africa'), '[markets] Australia or South Africa is still quoted in a panel');
    need(/EWA/.test(app()) && /EZA/.test(app()), '[markets] EWA or EZA has been dropped from the universe table, which would degrade the geography fits');
    // The risk block, and the honesty about MOVE.
    need(/CBOE VIX/.test(app()), '[markets] the VIX is missing from the risk panel');
    for (const want of ['VIX, 3-month', 'VIX / VIX3M', 'Nasdaq 100 (VXN)', 'Russell 2000 (RVX)', 'Crude oil (OVX)', 'Gold (GVZ)', 'High yield OAS'])
      need(app().includes(want), `[markets] the risk panel is missing ${want}`);
    need(/MOVE is not here/.test(app()), '[markets] the page does not say why MOVE is absent');
    need(!panelNames.some(x => /\bMOVE\b/.test(x)), '[markets] something is being quoted under the MOVE name, which no connected source publishes');
    // 2-year yields were asked for in place of 5-year.
    need(/<th class="num">2Y<\/th>/.test(app()), '[markets] the yield table has no 2Y column');
    need(!/<th class="num">5Y<\/th>/.test(app()), '[markets] the yield table still shows 5Y');

    // app.js is one IIFE, so its internals are not reachable from here -- which is correct, and
    // means this has to be driven the way a browser drives it. Rendering the page schedules the
    // price-history fetch, which re-renders when it lands. So: wait, then read.
    for (let i = 0; i < 40 && /Loading price history/.test(app()); i++) await sleep(250);
    const m2 = app();
    need(!/Loading price history/.test(m2), '[markets] the performance chart never finished loading');
    need(/Could not load price history/.test(m2) === false, '[markets] the performance chart failed to load its history');
    const labelled = ['SPY', 'QQQ', 'IWM', 'DIA'].filter(t => new RegExp(`>${t} [+-]?[\\d.]+%<`).test(m2));
    need(labelled.length >= 3, `[markets] only ${labelled.length} index lines are drawn on the performance chart`);
    // Realised Treasury volatility is the stand-in for MOVE and has to be a real number.
    const rv = (m2.match(/Long Treasuries \(TLT\)<\/span>\s*<span class="ptkr"><\/span><span class="pval">([\d.]+)%/) || [])[1];
    need(rv !== undefined, '[markets] realised Treasury volatility did not compute');
    if (rv !== undefined) need(+rv > 2 && +rv < 60, `[markets] realised Treasury volatility of ${rv}% is not a bond fund`);
    // The window selector has to actually change the window.
    const ytdLen = (m2.match(/<path d="M[^"]+"/g) || []).length;
    await click('[data-perf]', { perf: '1M' });
    const m3 = app();
    need(/class="pill on" data-perf="1M"|data-perf="1M"[^>]*>1M/.test(m3), '[markets] the 1M window is not selected after clicking it');
    need(m3 !== m2, '[markets] switching the window redrew nothing');
    // Every window offered must draw. A pill that renders an empty box is worse than no pill.
    for (const w of ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '3Y']) {
      need(new RegExp(`data-perf="${w}"`).test(m3), `[markets] the ${w} window is not offered`);
    }
    await click('[data-perf]', { perf: '1W' });
    const wk = app();
    need((wk.match(/<path d="M[^"]+"/g) || []).length >= 4, '[markets] the one-week window drew fewer than four lines');
    // One day comes from fifteen-minute bars in a different table, fetched on demand.
    await click('[data-perf]', { perf: '1D' });
    for (let i = 0; i < 40 && /Loading intraday bars/.test(app()); i++) await sleep(250);
    const day = app();
    need(!/Loading intraday bars/.test(day), '[markets] the one-day window never finished loading');
    need(!/Could not load intraday bars/.test(day), '[markets] the one-day window failed to load its bars');
    const intradayRows = await rest('intraday_prices', 'ts,close', '&order=ts.desc&limit=1');
    if (intradayRows.length) {
      need(/Newest bar/.test(day), '[markets] the one-day chart does not print how old its newest bar is');
      need(/previous daily close/.test(day), '[markets] the one-day chart does not say what it is rebased to');
      need((day.match(/<path d="M[^"]+"/g) || []).length >= 4, '[markets] the one-day window drew fewer than four lines');
      // The baseline must be the prior close, so an opening gap shows rather than starting at zero.
      const firstVals = [...day.matchAll(/>(SPY|QQQ|IWM|DIA) ([+-]?[\d.]+)%</g)].map(m => +m[2]);
      need(firstVals.length >= 4, '[markets] the one-day chart has no end labels');
      say(` ok  markets 1D             -> ${intradayRows.length ? 'bars to ' + intradayRows[0].ts.slice(0, 16) : 'none'}, ${firstVals.length} lines labelled`);
    } else {
      say(` ok  markets 1D             -> no intraday bars stored yet; the empty state was checked instead`);
      need(/No intraday bars yet|Not enough intraday bars/.test(day), '[markets] the one-day window with no bars does not explain itself');
    }
    await click('[data-perf]', { perf: '1M' });
    // The volatility panel sits under the performance chart and follows its window.
    await click('[data-perf]', { perf: 'YTD' });
    for (let i = 0; i < 40 && /Loading volatility history/.test(app()); i++) await sleep(250);
    const vol = app();
    need(/<div class="phead">Volatility<\/div>/.test(vol), '[markets] the volatility panel is missing');
    need(!/Loading volatility history/.test(vol), '[markets] the volatility panel never finished loading');
    const volLines = ['VIX', 'OVX · oil', 'GVZ · gold', 'VXN · Nasdaq'].filter(l => vol.includes(l));
    need(volLines.length === 4, `[markets] only ${volLines.length} of 4 volatility indices are drawn`);
    need(/TLT realised/.test(vol), '[markets] the realised Treasury line is missing from the volatility panel');
    need(/MOVE is not here/.test(vol), '[markets] the volatility panel does not say why MOVE is absent');
    // Levels, not rebased: a line labelled VIX must carry a plausible index level.
    const vixEnd = (vol.match(/>VIX ([\d.]+)</) || [])[1];
    need(vixEnd !== undefined, '[markets] the VIX line has no end label');
    if (vixEnd !== undefined) need(+vixEnd > 5 && +vixEnd < 90, `[markets] a VIX of ${vixEnd} is not an index level`);
    say(` ok  markets volatility     -> ${volLines.length} indices plus realised TLT, VIX ends at ${vixEnd ?? '—'}`);
    say(` ok  markets wall           -> panels render, ${labelled.length} lines on the chart, TLT realised vol ${rv ?? '—'}%, ${ytdLen} paths`);
    await click('[data-perf]', { perf: 'YTD' });
  }

  // -------------------------------------------------------------------------
  // 10a2. Kate: the popularity contest, the reflexivity test and the contrarian Top 5.
  //
  // The rule this page lives under is that nothing here may look like positioning data. Every
  // figure is inferred from price and volume, and the guard below fails if the page ever stops
  // saying so -- that caveat is load-bearing, not decoration.
  // -------------------------------------------------------------------------
  currentRoute = 'kate';
  await go('#kate');
  {
    const k = app();
    need(/Crowd sentiment/.test(k), '[kate] the sentiment gauge is missing');
    need(/This week's beauty contest|This week&#39;s beauty contest/.test(k), '[kate] the beauty contest was not recreated on Kate\'s page');
    need(/Contrarian Top 5/.test(k), '[kate] the contrarian Top 5 is missing');
    need(/Feedback loop/.test(k), '[kate] no feedback loop column, so reflexivity is not being reported');
    // The page must never imply it can see who owns what.
    need(/not positioning data/i.test(k), '[kate] the page does not say the crowding is inferred from the tape');
    need(!/short interest is|positioning shows|investors are positioned/i.test(k), '[kate] the page claims to see positioning');

    // The gauge is measured on NARRATIVES now -- asset classes, sectors and themes -- not on
    // individual securities. The page must be reading the narrative tables, and the murmuration
    // must be drawn from real trails rather than a single frozen point per bird.
    const reading = await rest('narrative_sentiment_readings', 'as_of,score,stance,n_live,n_total,n_narratives,top_narrative,concentration', '&order=as_of.desc&limit=1');
    const comps = await rest('latest_narrative_sentiment_components', 'component,score,status,n');
    const nar = await rest('latest_narrative_attention', 'narrative,attention_ratio,attention_pctile,attention_share,attention_rank,price_1m,state,trail,n_sources', '&order=attention_rank.asc');
    const taxonomy = await rest('narratives', 'slug,label,kind,proxy_ticker');
    need(nar.length > 20, `[kate] only ${nar.length} narratives were scored`);
    need(comps.length >= 4, `[kate] the gauge has ${comps.length} legs, expected at least 4`);
    need(new Set(taxonomy.map(t => t.kind)).size === 3, '[kate] the taxonomy is missing a kind; asset classes, sectors and themes should all be present');
    const r0 = reading[0];
    if (r0) {
      say(` ok  kate gauge             -> ${(+r0.score).toFixed(1)} / 100 ${r0.stance}, ${r0.n_live}/${r0.n_total} legs, ${r0.n_narratives} narratives`);
      need(+r0.n_live === comps.filter(c => c.score !== null).length, '[kate] the reading disagrees with its own legs about how many are live');
      const want = +r0.score >= 60 ? 'crowded' : +r0.score <= 40 ? 'scattered' : 'mixed';
      need(r0.stance === want, `[kate] a score of ${r0.score} is labelled ${r0.stance}, not ${want}`);
      need(k.includes(String(Math.round(+r0.score))), `[kate] the page does not show the gauge reading of ${r0.score}`);
      // A dead leg must be visible as a dead leg. Reddit refuses unauthenticated reads, and a
      // five-leg gauge quietly running on four is the thing this guard exists to catch.
      const dead = comps.filter(c => c.score === null);
      if (dead.length) need(/awaiting data/.test(k), '[kate] a leg has no data but the page does not say so');
    }
    // Narrative scoring must be self-consistent, and must never be a ranking of raw fame.
    let bad = [];
    const shareSum = nar.reduce((a, r) => a + (+r.attention_share || 0), 0);
    if (Math.abs(shareSum - 1) > 1e-4) bad.push(`attention shares sum to ${shareSum.toFixed(4)}, not 1`);
    for (let i = 1; i < nar.length; i++) if (+nar[i].attention_ratio > +nar[i - 1].attention_ratio + 1e-9) bad.push(`rank ${nar[i].attention_rank} is busier than rank ${nar[i - 1].attention_rank}`);
    for (const r of nar) {
      if (!(+r.attention_ratio > 0)) bad.push(`${r.narrative} has an attention ratio of ${r.attention_ratio}`);
      if (r.state === null) continue;
      const tr = Array.isArray(r.trail) ? r.trail : [];
      const now = tr.find(t => t.weeks_ago === 0), then = tr.find(t => t.weeks_ago === 4);
      if (!now || !then) { bad.push(`${r.narrative} has a state but no four-week trail behind it`); continue; }
      const up = +now.attention_pctile > +then.attention_pctile, paid = +r.price_1m > 0;
      const want = up ? (paid ? 'gathering' : 'crowding') : (paid ? 'unwatched' : 'dispersing');
      if (r.state !== want) bad.push(`${r.narrative} is ${r.state} but its attention and price say ${want}`);
    }
    // The murmuration needs paths, not points: a trail of one is a scatter plot wearing a metaphor.
    const withTrail = nar.filter(r => Array.isArray(r.trail) && r.trail.filter(t => t.attention_pctile !== null && t.price_1m !== null).length >= 2);
    need(withTrail.length >= 10, `[kate] only ${withTrail.length} narratives carry a usable trail, so the flock has no shape`);
    bad = [...new Set(bad)];
    for (const b of bad) errors.push(`[kate] ${b}`);
    say(` ok  kate narratives        -> ${nar.length} scored, ${withTrail.length} with trails, top ${(+nar[0].attention_ratio).toFixed(2)}x, ${bad.length} problems`);
    // The five most talked-about narratives must be the five the page prints, by label.
    const labelBySlug = Object.fromEntries(taxonomy.map(t => [t.slug, t.label]));
    for (const r of nar.slice(0, 5)) need(k.includes(labelBySlug[r.narrative]), `[kate] ${labelBySlug[r.narrative]} is in the top five by attention but is not on the page`);
    need(/murmuration|flock/i.test(k), '[kate] the flock is not described on the page');
    // Readability: thirty-two labelled birds with thirty-two trails was a tangle. Ten are drawn
    // in full; the rest stay as faint dots so the centre of mass is still the whole flock's.
    const svg = (k.match(/<svg[^>]*aria-label="The flock as a rotation[\s\S]*?<\/svg>/) || [''])[0];
    need(svg, '[kate] the murmuration did not render');
    const labelled = [...svg.matchAll(/font-size="11.5" font-weight="600" text-anchor="[a-z]+" fill="var\(--text\)"/g)].length;
    need(labelled > 0 && labelled <= 8, `[kate] the flock labels ${labelled} narratives; at most eight should be drawn in full`);
    const trails = [...svg.matchAll(/stroke-width="1.4" opacity="0.32"/g)].length;
    need(trails <= 8, `[kate] ${trails} trails are drawn; only the leading eight should have one`);
    // Every phase of the cycle has to be named, or the rim is decoration rather than a legend.
    for (const phase of ['Loudest', 'Gathering', 'Running', 'Unwatched', 'Ignored', 'Dispersing', 'Fading', 'Crowding'])
      need(svg.includes(`>${phase}<`), `[kate] the ${phase} phase is missing from the rotation`);
    // No bird may be drawn outside the rim: a point beyond it would mean the radius scaling has
    // stopped being a scaling, and the reader would have no way to know what the circle means.
    const far = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="4"/g)]
      .map(m => Math.hypot(+m[1] - 450, +m[2] - 316)).filter(d => d > 226);
    need(!far.length, `[kate] ${far.length} narratives are plotted outside the rim`);
    // The faint rest must still be present, or the centre of mass is being computed from a
    // different flock than the one shown.
    // Count the marks instead of matching one opacity literal: what matters is that every
    // narrative is still on the chart, because the flock's centre is computed from all of them.
    const marks = [...svg.matchAll(/<(?:circle cx|rect x|path d="M)[^>]*(?:fill="var\(--[a-z]+\)")/g)].length;
    need(marks >= nar.length, `[kate] only ${marks} marks for ${nar.length} narratives; the ones outside the leading eight were dropped, which moves the flock's centre away from what is drawn`);
    say(` ok  kate murmuration       -> ${labelled} labelled, ${trails} trails, remainder kept as context`);
    need(/Wikipedia/.test(k) && /StockTwits/.test(k), '[kate] the page does not say which public sources the attention came from');
    // The per-security crowding still runs: it is what the desk's OWN holdings are read against,
    // one section down, and its ranking has to be a ranking.
    const rows = await rest('latest_security_crowding', 'security_id,crowd_score,crowd_rank,attention,stretch_pctile,momentum_6m,persistence,up_down_volume,loop_state', '&order=crowd_rank.asc');
    need(rows.length > 20, `[kate] only ${rows.length} securities were scored for crowding`);
    bad = [];
    for (let i = 1; i < rows.length; i++) if (+rows[i].crowd_score > +rows[i - 1].crowd_score + 1e-9) bad.push(`rank ${rows[i].crowd_rank} scores above rank ${rows[i - 1].crowd_rank}`);
    for (const r of rows) {
      if (!(+r.crowd_score >= 0 && +r.crowd_score <= 100)) bad.push(`${r.crowd_rank} scores ${r.crowd_score}, outside 0-100`);
      if (r.loop_state === 'cold' && +r.stretch_pctile >= 0.70) bad.push(`rank ${r.crowd_rank} is cold at the ${(+r.stretch_pctile * 100).toFixed(0)}% stretch mark`);
      if ((r.loop_state === 'running' || r.loop_state === 'crowding') && !(+r.up_down_volume > 1)) bad.push(`rank ${r.crowd_rank} is ${r.loop_state} with volume favouring down days`);
      // A cash substitute scoring high is how the first version of this job ranked BIL among the
      // ten most crowded names on the desk: six-month return over volatility is enormous for a
      // bill fund and means nothing. The vol floor is meant to keep them out entirely.
      if (Math.abs(+r.momentum_6m) < 0.005 && +r.crowd_score > 60) bad.push(`rank ${r.crowd_rank} is crowded on a six-month move of ${(+r.momentum_6m * 100).toFixed(2)}%`);
    }
    bad = [...new Set(bad)];
    for (const b of bad) errors.push(`[kate] ${b}`);
    say(` ok  kate crowding          -> ${rows.length} securities scored on the tape, ${bad.length} problems`);
    for (const b of bad) errors.push(`[kate] ${b}`);

    // The reflexivity test on the contest: the loop must be read on whichever side the TAPE
    // favours. Testing the regime's preferred side regardless reported a loop "running" on a
    // dimension whose preferred leg was losing by 6.9% over the quarter.
    const ranks = await rest('latest_beauty_contest_rankings', 'dimension,rank,confirmed,spread_1m,spread_3m,flow_prefer,flow_avoid,loop_state');
    const withLoop = ranks.filter(r => r.loop_state);
    need(withLoop.length > 0, '[kate] no dimension carries a loop state, so the reflexivity test did not run');
    for (const r of withLoop) {
      const sign = +r.spread_3m >= 0 ? 1 : -1;
      const accel = sign * (+r.spread_1m / 30 - +r.spread_3m / 90);
      const chasing = sign > 0 ? +r.flow_prefer > +r.flow_avoid : +r.flow_avoid > +r.flow_prefer;
      const want = accel > 0 ? (chasing ? 'running' : 'faltering') : (chasing ? 'crowding' : 'cold');
      need(r.loop_state === want, `[kate] ${r.dimension} is ${r.loop_state} but its acceleration and flows say ${want}`);
    }
    say(` ok  kate reflexivity       -> ${withLoop.length} of ${ranks.length} dimensions carry a loop verdict`);
    // Top five of the contest, and only five.
    //
    // SCOPED TO THE CONTEST CARD, not to the whole page. This check used to substring-match the
    // entire rendered page, which worked only while no other section happened to use a dimension's
    // name as an ordinary word. The credit panel added 2026-10-23 says "Credit" several times, and
    // "Credit" is dimension nine -- so the loose version failed on content that was perfectly
    // correct. A test that breaks when an unrelated card is added was testing the wrong thing.
    const contestCard = (() => {
      const i = k.indexOf("This week's beauty contest");
      if (i < 0) return '';
      const j = k.indexOf('<h2', k.indexOf('</h2>', i));
      return j < 0 ? k.slice(i) : k.slice(i, j);
    })();
    need(contestCard.length > 200, '[kate] the beauty contest card could not be isolated on the page');
    const winners = ranks.filter(r => r.confirmed && r.rank !== null).sort((a, b) => a.rank - b.rank);
    for (const w of winners.slice(0, 5)) need(contestCard.includes(w.dimension), `[kate] ${w.dimension} is in the contest's top five but is not in the contest card`);
    need(!winners.slice(5).some(w => contestCard.includes(w.dimension)
      && !ranks.find(x => x.dimension === w.dimension && x.confirmed === false)), '[kate] more than five winners are listed in the contest card');

    // And Adam must have handed the contest over rather than keeping a second copy of it.
    await go('#adam');
    const a = app();
    need(!/This week's beauty contest|This week&#39;s beauty contest/.test(a), '[adam] the beauty contest is still on Adam\'s page as well as Kate\'s');
    // Adam's page was rebuilt around the quads on 2026-10-22 and the risk-on gauge went with the
    // contest, so the old assertion that it stayed no longer describes the desk. What still
    // matters is that the contest is on exactly one page: Kate's.
    need(/The four macro regimes/.test(a), '[adam] the rebuilt macro page is not rendering');
    need(/beauty contest/i.test(k), '[kate] the contest is not on Kate\'s page either, so it is nowhere');
    say(` ok  kate handover          -> the contest is on Kate's tab alone; Adam is the quads now`);

    // Admin: four tabs became four sections, in the order asked for, and each old hash still lands.
    await go('#admin');
    const adm = app();
    for (const want of ['Status', 'Sources', 'Views', 'Agents'])
      need(new RegExp(`<h2[^>]*>${want}</h2>`).test(adm), `[admin] the ${want} section is missing`);
    need(adm.indexOf('>Status<') < adm.indexOf('>Sources<'), '[admin] Sources is above Status; status was asked for first');
    need(adm.indexOf('>Sources<') < adm.indexOf('>Views<'), '[admin] Views is above Sources; sources was asked for second');
    need((adm.match(/<h1>/g) || []).length === 1, '[admin] a merged section kept its own page heading');
    for (const old of ['#views', '#sources', '#agents', '#status']) {
      await go(old);
      need(/<h1>Admin<\/h1>/.test(app()), `[admin] ${old} no longer lands anywhere`);
    }
    say(` ok  admin merge            -> status, sources, views, agents in one tab; four old hashes still land`);
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
    // A failing classification with a workable blend must arrive with that blend already
    // selected, and must still be waiting on Update rather than saved.
    {
      const needsFix = fits.filter(f => f.passes !== true && f.suggested_mix);
      const selectedSuggestions = (d.match(/<option value="custom:[^"]*" selected>Suggested —/g) || []).length;
      const banner = /suggested blend(s)? have been selected for you|suggested blend has been selected for you/.test(d);
      say(` ok  blend auto-select      -> ${needsFix.length} funds need a blend, ${selectedSuggestions} pre-selected in this drawer`);
      if (needsFix.length) {
        need(selectedSuggestions > 0, '[classify-vol] a suggested blend exists but none is pre-selected');
        need(banner, '[classify-vol] blends were pre-selected without saying so');
        need(/data-repupdate="1" >/.test(d) || /data-repupdate="1">/.test(d), '[classify-vol] the Update button is disabled though a change is staged');
        // Pre-selected means staged, not written. The invariant is that rendering the drawer
        // writes NOTHING -- not that no stored override can ever match a suggestion. Comparing
        // the values alone flagged three funds whose overrides were accepted days ago and whose
        // suggestion has been stable since, which is the system working rather than failing. What
        // actually matters is the write time, so that is what is checked.
        const stored = await fetch(`${SUPABASE_URL}/rest/v1/holding_factor_overrides?select=security_id,split,mix,updated_at`, { headers: REST }).then(r => r.json());
        for (const f of needsFix) {
          const row = stored.find(o => o.security_id === f.security_id);
          if (row && row.updated_at && Date.parse(row.updated_at) >= suiteStarted) {
            errors.push(`[classify-vol] an override for ${f.ticker || f.security_id} was written during the run, without Update being pressed`);
          }
        }
      }
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
  // Distinct tickers, not link occurrences: the acting-right card added 2026-10-23 links the same
  // nine indices a second time, and counting links reported eighteen indices on a nine-index page.
  const idx = new Set((s0.match(/data-go="#sven\/(\w+)"/g) || []).map(m => m.slice(16, -1))).size;
  say(` ok  sven matrix            -> ${idx} indices`);
  need(idx > 0, '[sven] rule matrix rendered no indices');
  need(s0.includes('News failure'), '[sven] news failure card missing');
  // The verdict column reads by colour: confirming green, any failure red.
  {
    const seg = s0.split('News failure')[1] || '';
    // Anchored on the verdict's own attribute rather than on the shape of its span: the signal
    // strength cell renders an identically shaped span, and matching by shape silently folded
    // "Initiate" into the list of verdicts and then reported the sort order as broken.
    const verdicts = [...seg.matchAll(/<span data-verdict="[a-z_]+" style="color:(var\(--[a-z]+\));font-weight:[^"]*"[^>]*>([^<]+)<\/span>/g)].map(m => [m[2], m[1]]);
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

  // -------------------------------------------------------------------------
  // 13. Sven, from Reminiscences of a Stock Operator: the fourth state, the market comparison,
  //     "acting right", the precedent-break flag and the quiet tape.
  //
  //     The guards are about MEANING, not rendering. no_read must never carry a direction, and it
  //     must not have simply absorbed what neutral used to mean -- neutral has to keep existing for
  //     the cases where the rule was tested and failed. The market comparison must follow the two
  //     states it is drawn from. And an "acting right" verdict must follow the distribution it is
  //     drawn from, in the median's own direction, since that sign flip is the easiest thing in the
  //     job to get backwards and the hardest to see by eye.
  // -------------------------------------------------------------------------
  currentRoute = 'tape-reading';
  await go('#sven');
  {
    const sv = app();

    // ---- the fourth state ----
    const rules = await rest('latest_sven_rule_signals', 'ticker,rule_key,rule_no,state,headline,market_state,vs_market');
    need(rules.length > 0, '[no_read] no rule rows at all');
    const states = [...new Set(rules.map(r => r.state))];
    need(states.includes('no_read'), '[no_read] the fourth state is not in use; neutral is still doing two jobs');
    need(states.includes('neutral'), '[no_read] neutral has vanished — no_read has absorbed it, and "tested and failed" can no longer be said');
    let tb = [];
    for (const r of rules) {
      if (r.state === 'no_read' && /\bbullish\b|\bbearish\b/i.test(r.headline || '')) tb.push(`${r.ticker} ${r.rule_key}: no_read with a directional headline`);
      if (!['bullish', 'bearish', 'neutral', 'no_read', 'not_evaluable'].includes(r.state)) tb.push(`${r.ticker} ${r.rule_key}: unknown state ${r.state}`);
    }
    need(/no read/.test(sv), '[no_read] the matrix legend does not name the fourth state');
    need(/No diagnosis, no prognosis/.test(sv), '[no_read] the sentence the state exists for is not on the page');
    const nNo = rules.filter(r => r.state === 'no_read').length;
    say(` ok  sven fourth state      -> ${nNo} of ${rules.length} cells read no_read, ${states.length} states in use`);

    // ---- every reading against the general market ----
    const OPP = { bullish: 'bearish', bearish: 'bullish' };
    const mkt = Object.fromEntries(rules.filter(r => r.ticker === 'SPY').map(r => [r.rule_key, r.state]));
    for (const r of rules) {
      if (r.ticker === 'SPY') { if (r.vs_market !== 'is_market') tb.push(`SPY ${r.rule_key} is not marked as the market`); continue; }
      // Only a direction can agree or disagree with a direction. The job's first version fell
      // through to with_market for every pair that was neither identical nor opposite, which filed
      // a bullish cell against a neutral market as agreement; these four lines are what found it.
      const dir = st => st === 'bullish' || st === 'bearish';
      if (r.vs_market === 'against_market' && OPP[mkt[r.rule_key]] !== r.state) tb.push(`${r.ticker} ${r.rule_key}: against the market without an opposite state`);
      if (r.vs_market === 'with_market' && mkt[r.rule_key] !== r.state) tb.push(`${r.ticker} ${r.rule_key}: with the market on a different state`);
      if (r.vs_market === 'market_silent' && !(dir(r.state) && !dir(mkt[r.rule_key]))) tb.push(`${r.ticker} ${r.rule_key}: market called directionless while this reads ${r.state} and SPY reads ${mkt[r.rule_key]}`);
      if (r.vs_market === 'silent' && dir(r.state) && mkt[r.rule_key] !== r.state) tb.push(`${r.ticker} ${r.rule_key}: called silent while reading ${r.state}`);
      if (r.market_state !== null && r.market_state !== mkt[r.rule_key]) tb.push(`${r.ticker} ${r.rule_key}: carries market_state ${r.market_state} but SPY reads ${mkt[r.rule_key]}`);
    }
    need(/vs mkt/.test(sv), '[market] the matrix has no column for disagreement with the market');
    need(/individual curves with the general market curve/.test(sv), '[market] the page does not say why the market column is there');
    const nAgainst = rules.filter(r => r.vs_market === 'against_market').length;
    say(` ok  sven vs the market     -> ${nAgainst} cells disagree with SPY, ${rules.filter(r => r.vs_market === 'with_market').length} agree`);

    // ---- acting right ----
    const prec = await rest('latest_sven_precedent_tests', 'ticker,precedent_key,precedent_label,horizon_days,n_precedents,hist_median,hist_p25,hist_p75,hist_hit_rate,trigger_date,realised,realised_pctile,verdict');
    need(prec.length > 0, '[acting] no precedent tests computed');
    need(/Is it acting right\?/.test(sv), '[acting] the acting-right card is not on the page');
    for (const r of prec) {
      if (r.realised_pctile !== null && (+r.realised_pctile < 0 || +r.realised_pctile > 1)) tb.push(`${r.ticker} ${r.precedent_key}: percentile ${r.realised_pctile} out of range`);
      if (r.hist_hit_rate !== null && (+r.hist_hit_rate < 0 || +r.hist_hit_rate > 1)) tb.push(`${r.ticker} ${r.precedent_key}: hit rate ${r.hist_hit_rate} out of range`);
      if (['acting_right', 'acting_strong', 'not_acting_right'].includes(r.verdict)) {
        if (!(r.n_precedents >= 12)) tb.push(`${r.ticker} ${r.precedent_key}: judged on ${r.n_precedents} occurrences, under the 12 minimum`);
        if (r.realised === null) tb.push(`${r.ticker} ${r.precedent_key}: a verdict with no realised response`);
        if (!r.trigger_date) tb.push(`${r.ticker} ${r.precedent_key}: a verdict with no trigger date`);
        if (!(+r.hist_p25 <= +r.hist_median && +r.hist_median <= +r.hist_p75)) tb.push(`${r.ticker} ${r.precedent_key}: median outside its own quartiles`);
        // The sign flip: the same realised number means opposite things depending on which way
        // this index normally goes after the condition.
        const up = +r.hist_median > 0;
        const want = up ? (+r.realised >= +r.hist_p75 ? 'acting_strong' : +r.realised >= +r.hist_p25 ? 'acting_right' : 'not_acting_right')
                        : (+r.realised <= +r.hist_p25 ? 'acting_strong' : +r.realised <= +r.hist_p75 ? 'acting_right' : 'not_acting_right');
        if (r.verdict !== want) tb.push(`${r.ticker} ${r.precedent_key}: verdict ${r.verdict} but its own distribution says ${want}`);
      }
      if (r.verdict === 'no_precedent' && r.n_precedents >= 12 && r.hist_median !== null && Math.abs(+r.hist_median) >= 0.002)
        tb.push(`${r.ticker} ${r.precedent_key}: called no_precedent on ${r.n_precedents} occurrences with a median of ${r.hist_median}`);
    }
    // Not acting right must never be rendered as a direction.
    const nr = prec.filter(r => r.verdict === 'not_acting_right');
    if (nr.length) need(/being unable to tell precisely what is wrong/i.test(sv), '[acting] not-acting-right is shown without the warning that it is not a direction');
    const perTicker = new Set(prec.map(r => r.ticker));
    const keys = new Set(prec.map(r => r.precedent_key));
    for (const t of perTicker) if (prec.filter(r => r.ticker === t).length !== keys.size)
      tb.push(`${t} carries ${prec.filter(r => r.ticker === t).length} conditions, not the ${keys.size} every other index carries`);
    say(` ok  sven acting right      -> ${prec.length} tests, ${nr.length} not acting right, ${prec.filter(r => r.verdict === 'no_precedent').length} with no precedent`);

    // ---- the precedent-break flag, and its sustain guard ----
    const brk = await rest('latest_sven_precedent_breaks', 'ticker,vol_20,vol_pctile,vol_streak,vol_broken,corr_60,corr_pctile,corr_streak,corr_broken,verdict');
    need(brk.length > 0, '[precedent] no break readings computed');
    for (const r of brk) {
      if (r.vol_broken && r.vol_streak < 10) tb.push(`${r.ticker}: volatility broken on a ${r.vol_streak}-session streak, under the 10 required`);
      if (r.corr_broken && r.corr_streak < 10) tb.push(`${r.ticker}: correlation broken on a ${r.corr_streak}-session streak, under the 10 required`);
      if (r.verdict === 'volatility_regime' && !r.vol_broken) tb.push(`${r.ticker}: a volatility verdict without the flag`);
      if (r.verdict === 'correlation_regime' && !r.corr_broken) tb.push(`${r.ticker}: a correlation verdict without the flag`);
      if (r.verdict === 'both' && !(r.vol_broken && r.corr_broken)) tb.push(`${r.ticker}: verdict "both" without both flags`);
      if (r.verdict === 'holds' && (r.vol_broken || r.corr_broken)) tb.push(`${r.ticker}: says it holds while carrying a flag`);
      if (r.corr_60 !== null && (+r.corr_60 < -1.0001 || +r.corr_60 > 1.0001)) tb.push(`${r.ticker}: correlation ${r.corr_60} outside -1..1`);
      if (r.ticker === 'SPY' && r.corr_60 !== null) tb.push('SPY is correlated against itself');
    }
    need(/knocked all precedents into a cocked hat/.test(sv), '[precedent] the break flag is shown without the reason it exists');
    need(/ten consecutive sessions/i.test(sv), '[precedent] the sustain guard is not stated on the page');
    const flagged = brk.filter(r => r.verdict !== 'holds' && r.verdict !== 'insufficient');
    say(` ok  sven precedent breaks  -> ${brk.length} indices, ${flagged.length} flagged${flagged.length ? ` (${flagged.map(r => `${r.ticker} ${r.verdict}`).join(', ')})` : ''}`);

    // ---- the quiet tape ----
    const qt = (await rest('latest_sven_tape_quiet', 'as_of,n_indices,mid_range_share,no_read_share,directional,vol_pctile,breadth,extremes,verdict,headline,legs'))[0];
    need(Boolean(qt), '[quiet] no quiet-tape reading');
    need(/Is there anything to say\?/.test(sv), '[quiet] the quiet-tape card is not on the page');
    need(/no man can always have adequate reasons/i.test(sv), '[quiet] the card is there without the sentence it exists for');
    {
      const legs = Array.isArray(qt.legs) ? qt.legs : [];
      need(legs.length === 5, `[quiet] ${legs.length} legs, expected 5`);
      for (const l of legs) if (!['quiet', 'something', 'unavailable'].includes(l.says)) tb.push(`quiet leg ${l.leg} says "${l.says}"`);
      const nq = legs.filter(l => l.says === 'quiet').length;
      const nlive = legs.filter(l => l.says !== 'unavailable').length;
      // "quiet" must mean every readable internal is quiet. A partial quiet is "ordinary".
      if (qt.verdict === 'quiet' && nq !== nlive) tb.push(`called quiet with ${nlive - nq} internal(s) saying otherwise`);
      if (qt.verdict === 'loud' && nq !== 0) tb.push(`called loud with ${nq} quiet internal(s)`);
      for (const f of ['mid_range_share', 'no_read_share', 'vol_pctile', 'breadth'])
        if (qt[f] !== null && (+qt[f] < 0 || +qt[f] > 1)) tb.push(`${f} is ${qt[f]}, not a share`);
      // The no_read share must agree with the rule table it is counted from.
      const ev = rules.filter(r => r.state !== 'not_evaluable');
      const want = ev.length ? ev.filter(r => r.state === 'no_read').length / ev.length : null;
      if (want !== null && qt.no_read_share !== null && Math.abs(+qt.no_read_share - want) > 0.02)
        tb.push(`no_read share ${qt.no_read_share} does not match the ${want.toFixed(3)} in the rule table`);
      say(` ok  sven quiet tape        -> ${qt.verdict}, ${nq} of ${nlive} internals say nothing`);
    }

    tb = [...new Set(tb)];
    for (const b of tb) errors.push(`[tape-reading] ${b}`);
    need(tb.length === 0, `[tape-reading] ${tb.length} problem(s) above`);
  }

  // -------------------------------------------------------------------------
  // 15. The Speed Limit: decay, the conviction gate, and the scoreboard that grades it.
  //
  //     The decay guard is the one that matters. The light printed a single value on all 18 of its
  //     readings, and the thing that made that invisible was that nothing on the page or in the
  //     table recorded how old the evidence was. So: freshness must exist, must be inside 0-1, must
  //     fall as calls age, and the gate must be arithmetically consistent with it -- a light that
  //     survives at a freshness its own boundary cannot support is the bug coming back.
  // -------------------------------------------------------------------------
  currentRoute = 'speed-limit';
  await go('#stan');
  const stKpi = app();
  // The full master card lives in the drawer; the page itself carries only the tile.
  await go('#stan/speed-limit');
  {
    // The master card renders into the drawer, not the page body, so read both.
    const st = both();
    let sb2 = [];
    need(/fresh/.test(stKpi), '[speed-limit] the Speed Limit tile does not show how fresh its evidence is');

    // ---- decay and the gate ----
    const sl = await rest('latest_speed_limit_readings', 'category,score,light,raw_light,freshness,conviction,evidence_raw,evidence_live,n_silent,oldest_call,newest_call,n_calls');
    const m = sl.find(r => r.category === 'master');
    need(Boolean(m), '[speed-limit] no master reading');
    need(m.freshness !== null, '[speed-limit] the master carries no freshness — the decay fix is not in effect');
    need(+m.freshness > 0 && +m.freshness <= 1, `[speed-limit] freshness ${m.freshness} is not a share`);
    need(Boolean(m.conviction), '[speed-limit] no conviction label');
    for (const r of sl) {
      if (r.evidence_live === null) continue;
      if (+r.evidence_live > +r.evidence_raw + 1e-6) sb2.push(`${r.category}: live evidence exceeds raw, so decay is adding conviction`);
      if (r.freshness !== null && Math.abs(+r.freshness - +r.evidence_live / +r.evidence_raw) > 1e-3)
        sb2.push(`${r.category}: freshness is not live evidence over raw`);
      // The gate: the light must be reachable at this freshness, and must match the widened cut.
      if (r.score !== null && r.freshness !== null) {
        const cut = 0.33 / +r.freshness;
        const want = +r.score > cut ? 'green' : +r.score < -cut ? 'red' : 'yellow';
        if (r.light !== want) sb2.push(`${r.category}: light ${r.light} but the gate at freshness ${(+r.freshness).toFixed(2)} says ${want}`);
        // raw_light is the ungated reading and must never be MORE cautious than the gated one.
        const raw = +r.score > 0.33 ? 'green' : +r.score < -0.33 ? 'red' : 'yellow';
        if (r.raw_light !== raw) sb2.push(`${r.category}: raw_light ${r.raw_light} does not match the ungated rule`);
        if (r.light !== 'yellow' && r.raw_light === 'yellow') sb2.push(`${r.category}: the gate turned a yellow into a ${r.light}`);
      }
    }
    need(/decay over their own horizon/i.test(st), '[speed-limit] the page does not explain the decay');
    need(/18 readings/.test(st), '[speed-limit] the page does not say the light had been frozen');
    say(` ok  speed limit decay      -> freshness ${(+m.freshness * 100).toFixed(0)}%, conviction ${m.conviction}, a light needs |score| > ${(0.33 / +m.freshness).toFixed(2)}, ${m.n_silent} silent lens(es)`);

    // ---- the scoreboard ----
    const bd = await rest('latest_speed_limit_scoreboard', 'scope,strategy_id,period,model_return,bench_return,excess,beta_used,beta_drag,residual,cum_excess,cum_beta_drag,cum_residual,n_months,headline,detail');
    need(bd.length > 0, '[scoreboard] nothing computed');
    const firm = bd.filter(r => r.scope === 'posture' && !r.strategy_id).sort((a, b) => String(a.period).localeCompare(String(b.period)));
    need(firm.length > 12, `[scoreboard] only ${firm.length} firm months — the record should span years`);
    need(/What has caution cost\?/.test(stKpi), '[scoreboard] the card is not on Stan\'s page');
    for (const r of bd.filter(x => x.scope === 'posture')) {
      if (/-00$/.test(r.period)) sb2.push(`${r.period}: an annual row is being counted as a month`);
      if (r.beta_drag !== null && Math.abs((+r.beta_drag + +r.residual) - +r.excess) > 1e-4)
        sb2.push(`${r.period}: the split does not add back to the excess`);
      if (r.strategy_id && r.beta_drag !== null
          && Math.abs(+r.beta_drag - (+r.beta_used - 1) * +r.bench_return) > 1e-4)
        sb2.push(`${r.period}: drag is not (beta - 1) x benchmark`);
      // The sign has to follow the arithmetic, and it is the whole point of the table.
      if (r.beta_drag !== null && +r.beta_used < 1 && +r.bench_return > 0 && +r.beta_drag > 0)
        sb2.push(`${r.period}: below-benchmark beta in a rising month should have cost, not earned`);
      if (r.beta_drag !== null && +r.beta_used < 1 && +r.bench_return < 0 && +r.beta_drag < 0)
        sb2.push(`${r.period}: below-benchmark beta in a falling month should have earned, not cost`);
    }
    // Cumulatives must actually accumulate.
    for (let i = 1; i < firm.length; i++) {
      if (firm[i].cum_beta_drag !== null && firm[i - 1].cum_beta_drag !== null
          && Math.abs(+firm[i].cum_beta_drag - (+firm[i - 1].cum_beta_drag + +firm[i].beta_drag)) > 1e-4)
        sb2.push(`${firm[i].period}: the running total does not add the month to the one before`);
    }
    // The signal half must refuse to conclude while the light has printed one colour.
    const sig = bd.find(r => r.scope === 'signal' && !r.strategy_id);
    need(Boolean(sig), '[scoreboard] no signal row');
    if (sig.detail && sig.detail.conclusive === false) {
      need(/nothing here to grade|has never been recorded/i.test(sig.headline || ''),
        '[scoreboard] the signal half reports a verdict on a light that has not moved');
      // A NUMERIC claim, not the word. The first version of this matched the disclaimer that says a
      // hit rate on one colour is meaningless, and reported the honest sentence as the problem.
      need(!/\d+(\.\d+)?%\s*(hit|accurate|correct)/i.test(sig.headline || ''),
        '[scoreboard] a hit rate is claimed on a light that has printed one colour');
    }
    const f = firm.at(-1);
    const down = firm.filter(r => +r.bench_return < 0), up = firm.filter(r => +r.bench_return > 0);
    sb2 = [...new Set(sb2)];
    for (const b of sb2) errors.push(`[speed-limit] ${b}`);
    need(sb2.length === 0, `[speed-limit] ${sb2.length} problem(s) above`);
    say(` ok  caution scoreboard     -> ${f.n_months} months, posture ${(+f.cum_beta_drag * 100).toFixed(1)}%, rest ${(+f.cum_residual * 100).toFixed(1)}%, net ${(+f.cum_excess * 100).toFixed(1)}%`);
    say(` ok  caution sign check     -> paid in ${down.filter(r => +r.beta_drag > 0).length}/${down.length} down-months, cost in ${up.filter(r => +r.beta_drag < 0).length}/${up.length} up-months`);
  }

  // -------------------------------------------------------------------------
  // 16. The insurance value table: what each brake pays, costs, and whether it worked every time.
  //
  //     THE GUARD THAT MATTERS is that a pooled average can never promote an instrument to 'brake'
  //     on its own. Long Treasuries pass every pooled test and lost a third of their value through
  //     2022 while the book fell 22%. If the episode record ever stops gating the verdict, this
  //     table becomes the thing it was built to prevent.
  //
  //     The second guard is the measurement window. An episode must be dated peak to TROUGH: an
  //     earlier version measured peak to recovery and reported VIXM -- which returns nearly 8% a
  //     day in the book's worst 1% -- as having helped in one drawdown out of five, because it
  //     gives the spike back on the way up. That is only true for someone who never monetises.
  // -------------------------------------------------------------------------
  currentRoute = 'insurance';
  await go('#stan');
  {
    const iv = app();
    const rows = await rest('latest_insurance_value', 'instrument,label,window_key,n_days,n_stress,drawdowns_seen,crash_1pct,carry_annual,free_carry,payoff_per_carry,corr_calm,corr_stress,corr_shift,episodes,episodes_helped,verdict');
    need(rows.length > 0, '[insurance] nothing computed');
    need(/Which brake is worth owning\?/.test(iv), '[insurance] the card is not on the page');
    const full = rows.filter(r => r.window_key === 'full');
    need(full.length >= 8, `[insurance] only ${full.length} instruments compared — the table exists to choose between them`);

    let ib = [];
    for (const r of rows) {
      for (const f of ['corr_calm', 'corr_stress']) if (r[f] !== null && (+r[f] < -1.0001 || +r[f] > 1.0001)) ib.push(`${r.instrument}/${r.window_key}: ${f} outside -1..1`);
      if (r.corr_shift !== null && Math.abs(+r.corr_shift - (+r.corr_stress - +r.corr_calm)) > 1e-3) ib.push(`${r.instrument}/${r.window_key}: corr_shift is not stress minus calm`);
      if (r.free_carry && !(+r.carry_annual > 0)) ib.push(`${r.instrument}/${r.window_key}: free carry flagged on a negative carry`);
      if (!r.free_carry && r.payoff_per_carry !== null && !(+r.carry_annual < 0)) ib.push(`${r.instrument}/${r.window_key}: a payoff-per-carry ratio on a non-negative carry`);
      // THE LOAD-BEARING GUARD.
      if (r.verdict === 'brake') {
        const eps = Array.isArray(r.episodes) ? r.episodes : [];
        if (!eps.length) ib.push(`${r.instrument}/${r.window_key}: called a brake with no drawdown record at all`);
        if (r.episodes_helped !== eps.length) ib.push(`${r.instrument}/${r.window_key}: called a brake having lost money through ${eps.length - r.episodes_helped} of ${eps.length} drawdowns`);
        if (!(+r.crash_1pct > 0)) ib.push(`${r.instrument}/${r.window_key}: called a brake while losing money in the book's worst 1%`);
        if (!(+r.corr_stress < 0)) ib.push(`${r.instrument}/${r.window_key}: called a brake while positively correlated through stress`);
      }
      if (r.verdict === 'funder' && !r.free_carry) ib.push(`${r.instrument}/${r.window_key}: called a funder while costing money to hold`);
      // Episodes must be dated peak to trough, and the depth must be a drawdown.
      for (const e of (Array.isArray(r.episodes) ? r.episodes : [])) {
        if (!(e.peak < e.trough)) ib.push(`${r.instrument}: an episode whose peak is not before its trough`);
        if (!(+e.depth <= -0.10)) ib.push(`${r.instrument}: an episode only ${(e.depth * 100).toFixed(0)}% deep is not a drawdown`);
        if (e.helped !== (+e.ret > 0)) ib.push(`${r.instrument}: an episode's helped flag disagrees with its own return`);
      }
      if (r.verdict !== 'insufficient' && r.drawdowns_seen === 0) ib.push(`${r.instrument}/${r.window_key}: judged without ever having been in a drawdown`);
    }
    // The table must still identify at least one instrument that FAILED an episode, or the episode
    // gate is not doing anything and the regression it guards against would pass unnoticed.
    const failed = full.filter(r => r.episodes_helped !== null && r.episodes_helped < (r.episodes || []).length);
    need(failed.length > 0, '[insurance] no instrument failed any drawdown — the episode record is not discriminating');
    need(/peak to trough, not peak to recovery/i.test(iv), '[insurance] the page does not say which window the episodes are measured over');
    need(/pooled stress averages cannot tell/i.test(iv), '[insurance] the page does not explain why the episode dots gate the verdict');

    const px2 = (await rest('latest_insurance_pricing', 'vix,vix_3m,realised_21d,vol_premium,term_ratio,term_state,verdict,headline'))[0];
    need(Boolean(px2), '[insurance] no pricing reading');
    if (px2.vol_premium !== null && px2.vix !== null && px2.realised_21d !== null)
      need(Math.abs(+px2.vol_premium - (+px2.vix - +px2.realised_21d)) < 0.02, '[insurance] the volatility premium is not VIX minus realised');
    if (px2.term_ratio !== null && px2.vix > 0)
      need(Math.abs(+px2.term_ratio - (+px2.vix_3m / +px2.vix)) < 0.01, '[insurance] the term ratio is not VIX3M over VIX');
    if (px2.term_state === 'backwardation') need(+px2.term_ratio < 1, '[insurance] backwardation called on a ratio above 1');
    if (px2.term_state === 'contango') need(+px2.term_ratio > 1, '[insurance] contango called on a ratio below 1');

    ib = [...new Set(ib)];
    for (const b of ib) errors.push(`[insurance] ${b}`);
    need(ib.length === 0, `[insurance] ${ib.length} problem(s) above`);
    const brakes = full.filter(r => r.verdict === 'brake');
    say(` ok  insurance value        -> ${full.length} instruments, ${brakes.length} brakes (${brakes.map(r => r.instrument).join(', ')}), ${failed.length} failed an episode`);
    say(` ok  insurance pricing      -> ${px2.verdict}, premium ${px2.vol_premium} pts, curve ${px2.term_state} at ${(+px2.term_ratio).toFixed(2)}`);
  }

  // -------------------------------------------------------------------------
  // 17. The sleeve mix. Two guards carry this section.
  //
  //     THE SIGN CONVENTION. Drawdowns are negative, and the iso-drawdown solver compares them.
  //     Written the wrong way round every guard fires on the ordinary case and the whole table
  //     comes back empty with correct arithmetic underneath it, which is exactly what happened.
  //     So: at zero sleeve the solver must return the baseline's own equity share, and no sleeve
  //     may be reported at a drawdown materially deeper than the baseline it is matched to.
  //
  //     COMPARABILITY. The candidates do not share a window and the windows differ by more than
  //     the sleeves do. Only `uplift` may be ranked; if the page ever sorts on raw real CAGR it is
  //     comparing periods and calling it a comparison of sleeves.
  // -------------------------------------------------------------------------
  currentRoute = 'sleeve-mix';
  await go('#stan');
  {
    const sv2 = app();
    const rows = await rest('latest_sleeve_candidates', 'sleeve_key,label,composition,window_from,n_days,episodes_covered,sleeve_carry,funding_ratio,iso_weight,iso_equity,iso_real_cagr,iso_max_dd,baseline_dd,baseline_real_cagr,uplift,curve,plateau_from,plateau_to,episodes,episodes_helped,loo_rank,loo_chosen,verdict');
    need(rows.length >= 5, `[sleeve] only ${rows.length} candidates — the table exists to choose between them`);
    need(/Which sleeve, and how much\?/.test(sv2), '[sleeve] the card is not on the page');

    let sb3 = [];
    const baseline = rows.find(r => r.sleeve_key === 'cash');
    for (const r of rows) {
      const comp = Array.isArray(r.composition) ? r.composition : [];
      if (Math.abs(comp.reduce((a, c) => a + +c.weight, 0) - 1) > 1e-6) sb3.push(`${r.sleeve_key}: composition does not sum to 1`);
      if (r.iso_equity !== null && (+r.iso_equity < 0.3 || +r.iso_equity > 1)) sb3.push(`${r.sleeve_key}: iso equity ${r.iso_equity} is not a share`);
      // The solver must have matched the drawdown it claims to match.
      if (r.iso_max_dd !== null && +r.iso_max_dd < +r.baseline_dd - 5e-3)
        sb3.push(`${r.sleeve_key}: reported at a ${(r.iso_max_dd * 100).toFixed(1)}% drawdown against a baseline of ${(r.baseline_dd * 100).toFixed(1)}%`);
      if (+r.baseline_dd >= 0) sb3.push(`${r.sleeve_key}: a baseline drawdown of ${r.baseline_dd} is not a drawdown — the sign convention has flipped`);
      if (r.uplift !== null && Math.abs(+r.uplift - (+r.iso_real_cagr - +r.baseline_real_cagr)) > 1e-4)
        sb3.push(`${r.sleeve_key}: uplift is not the iso return minus its own baseline`);
      // Zero sleeve must mean zero gas and zero uplift, or the solver is not solving the equation.
      if (+r.iso_weight === 0) {
        if (Math.abs(+r.iso_equity - 0.70) > 5e-3) sb3.push(`${r.sleeve_key}: zero sleeve yet ${(r.iso_equity * 100).toFixed(1)}% equity — the solver disagrees with its own baseline`);
        if (Math.abs(+r.uplift) > 1e-4) sb3.push(`${r.sleeve_key}: zero sleeve yet an uplift of ${r.uplift}`);
      }
      if (r.verdict === 'preferred') {
        if (!(+r.uplift >= 0.02)) sb3.push(`${r.sleeve_key}: preferred on an uplift of ${r.uplift}`);
        if (r.episodes_covered < 2) sb3.push(`${r.sleeve_key}: preferred on ${r.episodes_covered} drawdown(s)`);
      }
      if (r.episodes_covered < 2 && r.verdict !== 'untested') sb3.push(`${r.sleeve_key}: judged "${r.verdict}" on ${r.episodes_covered} drawdown(s)`);
      if (r.plateau_from !== null && +r.plateau_from > +r.plateau_to) sb3.push(`${r.sleeve_key}: an inverted plateau`);
      // The curve must be monotone in nothing, but it must be a curve.
      const curve = Array.isArray(r.curve) ? r.curve : [];
      if (curve.length < 5) sb3.push(`${r.sleeve_key}: a weight curve of ${curve.length} points is not a surface`);
      for (const c of curve) if (c.equity !== null && (+c.equity < 0 || +c.equity > 1)) sb3.push(`${r.sleeve_key}: a curve point with equity ${c.equity}`);
    }
    // Cash must buy nothing. If T-bills ever read as buying gas, the solver is broken.
    if (baseline) need(Math.abs(+baseline.uplift) < 1e-4, `[sleeve] T-bills report an uplift of ${baseline.uplift} — holding cash cannot buy gas at equal drawdown`);
    need(/Added.{0,80}only column comparable across rows/is.test(sv2), '[sleeve] the page does not warn that raw real CAGR is not comparable');
    need(/plateau, not peak/i.test(sv2), '[sleeve] the page does not explain why a plateau is reported instead of a best weight');
    need(/one drawdown is an anecdote/i.test(sv2), '[sleeve] the page does not say why a thin record is marked untested');

    sb3 = [...new Set(sb3)];
    for (const b of sb3) errors.push(`[sleeve] ${b}`);
    need(sb3.length === 0, `[sleeve] ${sb3.length} problem(s) above`);
    const pref = rows.filter(r => r.verdict === 'preferred').sort((a, b) => +b.uplift - +a.uplift);
    say(` ok  sleeve mix             -> ${rows.length} candidates, ${pref.length} preferred${pref.length ? `, best ${pref[0].label} +${(+pref[0].uplift * 100).toFixed(2)}pp at ${(+pref[0].iso_equity * 100).toFixed(0)}% equity` : ''}`);
    const cur = rows.find(r => r.sleeve_key === 'current');
    if (cur) say(` ok  sleeve as held        -> ${(+cur.iso_equity * 100).toFixed(0)}% equity supported, uplift ${(+cur.uplift * 100).toFixed(2)}pp, ${cur.episodes_covered} drawdown(s), ${cur.verdict}`);
  }

  // -------------------------------------------------------------------------
  // 14. Kate, from The Alchemy of Finance: the equilibrium gate, the successful-test count, the
  //     asymmetry, the credit panel and the named flaw.
  //
  //     THE LOAD-BEARING GUARD IS THE GATE'S CALIBRATION. Soros wrote a preface to say reflexivity
  //     is feeble in most situations, so a page on which most narratives read far-from-equilibrium
  //     is not reporting his framework, it is reporting a threshold error -- which is exactly what
  //     the first version did, flagging 18 of 32. The test asserts the majority sit near
  //     equilibrium, because that is the claim the book makes about the world.
  //
  //     And nowhere may a stage number appear. Soros calls his own nine-stage sequence "only one
  //     possible path" and says it hardly needs emphasizing how crude the model is.
  // -------------------------------------------------------------------------
  currentRoute = 'reflexivity';
  await go('#kate');
  {
    const kt = app();
    const rx = await rest('latest_narrative_reflexivity', 'narrative,proxy_ticker,leg_start,leg_days,test_threshold,tests,days_since_test,median_gap,gap_ratio,test_verdict,attention_pctile,price_pctile,gap_now,gap_4w,gap_12w,gap_trend,equilibrium,n_advances,n_declines,adv_days_median,dec_days_median,asymmetry,asymmetry_verdict,n_bars');
    need(rx.length > 0, '[reflexivity] nothing computed');
    need(/Is the loop even worth asking about\?/.test(kt), '[reflexivity] the gate card is not on the page');
    need(/so feeble it can safely be ignored/.test(kt), '[reflexivity] the 1994 correction is not quoted, so the gate looks arbitrary');

    let kb = [];
    const GATE = 68;
    for (const r of rx) {
      if (r.gap_now !== null && (+r.gap_now < 0 || +r.gap_now > 100)) kb.push(`${r.narrative}: gap ${r.gap_now} is not in percentile points`);
      for (const f of ['attention_pctile', 'price_pctile'])
        if (r[f] !== null && (+r[f] < 0 || +r[f] > 1)) kb.push(`${r.narrative}: ${f} is ${r[f]}, not a share`);
      if (r.equilibrium === 'near_equilibrium' && r.gap_now !== null && +r.gap_now >= GATE) kb.push(`${r.narrative}: near equilibrium at ${r.gap_now} points, over the ${GATE} gate`);
      if (['stretched', 'far_from_equilibrium'].includes(r.equilibrium) && !(+r.gap_now >= GATE)) kb.push(`${r.narrative}: off the gate at ${r.gap_now} points`);
      if (r.equilibrium === 'far_from_equilibrium' && !(+r.gap_trend > 0)) kb.push(`${r.narrative}: far from equilibrium without a widening gap`);
      if (r.gap_now !== null && r.attention_pctile !== null && r.price_pctile !== null
        && Math.abs(+r.gap_now - Math.abs(+r.attention_pctile - +r.price_pctile) * 100) > 0.2)
        kb.push(`${r.narrative}: gap ${r.gap_now} does not equal the distance between its own two percentiles`);
      // The test counter.
      if (r.test_verdict === 'no_leg' && r.leg_start) kb.push(`${r.narrative}: no advance, yet an advance start date`);
      if (r.test_verdict === 'late_untested' && !(+r.gap_ratio > 2)) kb.push(`${r.narrative}: called late without the gap ratio`);
      if (r.test_verdict === 'untested' && !(r.tests === 0)) kb.push(`${r.narrative}: called never tested with ${r.tests} tests`);
      if (r.test_verdict === 'untested' && !(r.leg_days >= 120)) kb.push(`${r.narrative}: called never tested on a ${r.leg_days}-session advance, which is early`);
      if (r.tests === 0 && r.days_since_test !== null) kb.push(`${r.narrative}: zero tests but a count since the last one`);
      if (r.test_threshold !== null && +r.test_threshold < 0.04) kb.push(`${r.narrative}: test threshold ${r.test_threshold} is under the 4% floor`);
      // The asymmetry. A zigzag alternates, so the two counts can differ by at most one.
      if (r.n_advances !== null && r.n_declines !== null && Math.abs(r.n_advances - r.n_declines) > 1)
        kb.push(`${r.narrative}: ${r.n_advances} advances against ${r.n_declines} declines — a zigzag cannot do that`);
      if (r.asymmetry_verdict !== 'insufficient' && (r.n_advances < 3 || r.n_declines < 3))
        kb.push(`${r.narrative}: an asymmetry verdict on ${r.n_advances}/${r.n_declines} swings`);
      if (r.asymmetry !== null && r.adv_days_median && r.dec_days_median
        && Math.abs(+r.asymmetry - +r.adv_days_median / +r.dec_days_median) > 0.01)
        kb.push(`${r.narrative}: asymmetry ${r.asymmetry} is not its own two medians divided`);
      if (r.asymmetry_verdict === 'slow_up_fast_down' && !(+r.asymmetry >= 1.3)) kb.push(`${r.narrative}: slow-up-fast-down at ${r.asymmetry}`);
    }
    // The calibration claim: most of the flock must be near equilibrium, or the gate is wrong.
    const near = rx.filter(r => r.equilibrium === 'near_equilibrium').length;
    need(near > rx.length / 2, `[reflexivity] only ${near} of ${rx.length} narratives are near equilibrium — Soros says most situations are, so the gate is miscalibrated`);
    // A zigzag that never reverses reports zero swings, which is how the dir=0 bug was found.
    need(!rx.some(r => r.n_advances === 0 && r.n_bars > 1000), '[reflexivity] a narrative with years of history reports zero swings; the zigzag is stuck');
    // No stage number, anywhere.
    need(!/stage\s*[1-9]\s*(of|\/)\s*9/i.test(kt), '[reflexivity] a stage number is on the page; Soros disclaimed that precision');
    need(/corrections become scarcer/.test(kt), '[reflexivity] the test counter is shown without the sentence it encodes');
    need(/not on attention/.test(kt), '[reflexivity] the asymmetry is shown without saying it is measured on price');
    say(` ok  kate equilibrium gate  -> ${near} of ${rx.length} near equilibrium, ${rx.filter(r => r.equilibrium === 'far_from_equilibrium').length} far from it`);
    say(` ok  kate successful tests  -> ${rx.filter(r => r.test_verdict === 'untested' || r.test_verdict === 'late_untested').length} advances no longer being tested, ${rx.filter(r => r.test_verdict === 'no_leg').length} with no advance`);
    say(` ok  kate asymmetry         -> ${rx.filter(r => r.asymmetry_verdict === 'slow_up_fast_down').length} slow up / fast down, ${rx.filter(r => r.asymmetry_verdict === 'symmetric').length} symmetric`);

    // ---- the credit panel ----
    const cl = await rest('latest_credit_cycle_legs', 'leg,label,series_id,obs_date,level,level_unit,change,acceleration,direction,accel_sign');
    const cr = (await rest('credit_cycle_readings', 'as_of,phase,n_easing,n_tightening,n_accelerating,n_decelerating,n_legs,oldest_obs,caveat')).sort((a, b) => String(b.as_of).localeCompare(String(a.as_of)))[0];
    need(cl.length >= 4, `[credit] only ${cl.length} legs computed`);
    need(Boolean(cr), '[credit] no credit reading');
    need(/The credit cycle/.test(kt), '[credit] the credit card is not on the page');
    // The caveat is the load-bearing part: this is conditions, not Soros's loan/collateral loop.
    need(/not Soros'?.?s loop/i.test(kt), '[credit] the panel does not say it is conditions rather than the loop');
    need(/collateral/i.test(kt), '[credit] the loop being approximated is never named');
    need(/Only net new lending stimulates/i.test(kt), '[credit] the reason acceleration is the signal is missing');
    for (const r of cl) {
      if (!r.obs_date) kb.push(`credit leg ${r.leg} carries no observation date, so its staleness is hidden`);
      if (!['easing', 'tightening', 'flat', 'unavailable'].includes(r.direction)) kb.push(`credit leg ${r.leg} direction "${r.direction}"`);
      if (!r.series_id) kb.push(`credit leg ${r.leg} names no series, so it cannot be audited`);
    }
    if (cr.n_legs !== cl.length) kb.push(`the reading counts ${cr.n_legs} legs against ${cl.length} rows`);
    if (cr.n_easing + cr.n_tightening > cl.length) kb.push(`${cr.n_easing} easing plus ${cr.n_tightening} tightening exceeds ${cl.length} legs`);
    if (cr.phase === 'decelerating' && !(cr.n_easing > cr.n_tightening && cr.n_decelerating > cr.n_accelerating))
      kb.push('phase says decelerating without the legs to support it');
    if (cr.oldest_obs !== cl.map(r => r.obs_date).sort()[0]) kb.push('the stated oldest observation is not the oldest leg');
    say(` ok  kate credit cycle      -> ${cr.phase}, ${cl.length} legs, ${cr.n_easing} easing / ${cr.n_tightening} tightening, oldest ${cr.oldest_obs}`);

    // ---- the named flaw ----
    // Authored, never computed. The column must exist, a missing row must read as not-yet-named
    // rather than as a blank, and any row that IS there must carry sources and a date.
    need(/>The flaw</.test(kt), '[flaw] the contrarian list has no column for the flaw');
    need(/There is bound to be a flaw/.test(kt), '[flaw] the column is there without the sentence it comes from');
    need(/written, not computed/i.test(kt), '[flaw] the page does not say the flaw is authored rather than measured');
    const fl = (await rest('annie_assessments', 'as_of,kind,narrative,headline,body_md,sources,author')).filter(r => r.kind === 'narrative_flaw');
    const slugs = new Set(rx.map(r => r.narrative));
    for (const f of fl) {
      if (!f.narrative) kb.push('a narrative_flaw row carries no narrative');
      else if (!slugs.has(f.narrative)) kb.push(`a flaw is written against "${f.narrative}", which is not a narrative`);
      if (!(Array.isArray(f.sources) && f.sources.length)) kb.push(`the flaw on ${f.narrative} cites nothing`);
      if (!f.body_md) kb.push(`the flaw on ${f.narrative} has a headline and no argument`);
    }
    if (!fl.length) need(/not yet named/.test(kt), '[flaw] no flaw is written and the page does not say so');
    say(` ok  kate the flaw           -> ${fl.length} named, ${fl.length ? fl.map(f => f.narrative).join(', ') : 'column shows not yet named'}`);

    kb = [...new Set(kb)];
    for (const b of kb) errors.push(`[reflexivity] ${b}`);
    need(kb.length === 0, `[reflexivity] ${kb.length} problem(s) above`);
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (errors.length) { console.log(`${errors.length} PROBLEM(S):`); for (const e of errors) console.log('  ' + e); process.exit(1); }
console.log('No problems found.');
