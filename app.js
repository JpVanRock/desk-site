// Desk Allocation Model. Static site: signs in through Supabase Auth, then reads data the
// database allows the signed-in desk member to see. Nothing sensitive is stored in this repo.
(() => {
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const sgn = x => (x > 0 ? '+' : '') + x.toFixed(2);
const CLASS_COLORS = { equities: '#7aa2f7', bonds: '#e0605e', cash: '#3fb27f', commodities_real_assets: '#d6a93b', gold: '#e8c96a', alternatives: '#b28cf0', unclassified: '#5b6577' };
const cfg = window.DESK_CONFIG;
const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
// An invite or password-reset link arrives with type=invite|recovery in the URL hash.
const linkType = (/type=(invite|recovery)/.exec(location.hash) || [])[1];
let D = null, gateMode = 'in';

// ---------- Sign-in ----------
function showGate(mode, msg) {
  gateMode = mode;
  $('#shell').hidden = true; $('#gate').hidden = false;
  const set = mode === 'set';
  $('#gate-title').textContent = set ? 'Set your password' : 'Sign in';
  $('#gate-msg').textContent = msg || (set ? 'Choose a password of at least 12 characters.' : 'Internal use only.');
  $('#gate-btn').textContent = set ? 'Save password' : 'Sign in';
  $('#email').closest('label').hidden = set; $('#email').required = !set;
  $('#password').autocomplete = set ? 'new-password' : 'current-password';
  $('#password').minLength = set ? 12 : 8; $('#password').value = ''; $('#gate-err').textContent = '';
}
$('#login').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#gate-btn'), err = $('#gate-err'); btn.disabled = true; err.textContent = '';
  try {
    if (gateMode === 'set') {
      const { error } = await sb.auth.updateUser({ password: $('#password').value });
      if (error) throw error;
      history.replaceState(null, '', location.pathname + '#overview');
    } else {
      const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
      if (error) throw error;
    }
    const { data: { session } } = await sb.auth.getSession();
    await enter(session);
  } catch (ex) {
    err.textContent = gateMode === 'set' ? 'Could not save the password. Try a longer one.' : 'Sign-in failed. Check your email and password.';
  } finally { btn.disabled = false; }
});
$('#signout').addEventListener('click', async () => { await sb.auth.signOut(); D = null; showGate('in'); });
sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && $('#gate').hidden) { D = null; showGate('in'); } });

async function enter(session) {
  if (!session) return showGate('in');
  const approved = session.user?.app_metadata?.desk_member === true;
  if (!approved) { await sb.auth.signOut(); return showGate('in', 'This account has not been approved for the desk yet. Ask JP.'); }
  $('#who').textContent = session.user.email;
  $('#gate').hidden = true; $('#shell').hidden = false;
  $('#app').innerHTML = '<div class="empty">Loading…</div>';
  try { D = await load(); } catch (ex) { $('#app').innerHTML = `<div class="empty">Could not load data: ${esc(ex.message)}</div>`; return; }
  $('#stamp').textContent = 'Data loaded ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  route();
}

// ---------- Data ----------
async function q(query) { const { data, error } = await query; if (error) throw new Error(error.message); return data; }
function latestBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); const p = m.get(k); if (!p || r.as_of > p.as_of) m.set(k, r); } return m; }

async function load() {
  const [strategies, alloc, secs, classes, factors, cLoad, sLoad, runs, outputs, prices] = await Promise.all([
    q(sb.from('strategies').select('id,name,label,sort_order').order('sort_order')),
    q(sb.from('target_allocations').select('strategy_id,security_id,asset_class_id,target_weight,effective_from').is('effective_to', null)),
    q(sb.from('securities').select('id,ticker,name,asset_class_id,role')),
    q(sb.from('asset_classes').select('id,slug,name,sort_order').order('sort_order')),
    q(sb.from('factors').select('id,slug,name,sort_order').order('sort_order')),
    q(sb.from('asset_class_factor_loadings').select('asset_class_id,factor_id,loading,as_of')),
    q(sb.from('security_factor_loadings').select('security_id,factor_id,loading,as_of')),
    q(sb.from('data_runs').select('status,latest_price_date,started_at').order('started_at', { ascending: false }).limit(1)),
    q(sb.from('agent_outputs').select('agent,kind,title,body_md,as_of').order('as_of', { ascending: false }).limit(50)),
    q(sb.from('current_prices').select('security_id,as_of,close,prev_close,day_change_pct,source')),
  ]);
  const cls = Object.fromEntries(classes.map(c => [c.id, c]));
  const sec = Object.fromEntries(secs.map(s => [s.id, s]));
  const cl = latestBy(cLoad, r => r.asset_class_id + '|' + r.factor_id);
  const sl = latestBy(sLoad, r => r.security_id + '|' + r.factor_id);
  const loadingFor = (s, ac) => {
    const out = factors.map(f => (sl.get(s + '|' + f.id) || cl.get(ac + '|' + f.id) || {}).loading);
    return out.every(v => v === undefined) ? null : out.map(v => (v === undefined ? null : +v));
  };
  const models = strategies.map(st => {
    const rows = alloc.filter(a => a.strategy_id === st.id);
    let total = 0, cov = 0; const net = factors.map(() => 0), byClass = {};
    const holdings = rows.map(a => {
      const s = sec[a.security_id] || {}, ac = a.asset_class_id || s.asset_class_id;
      const w = +a.target_weight, ld = loadingFor(a.security_id, ac), slug = cls[ac]?.slug || 'unclassified';
      total += w; byClass[slug] = (byClass[slug] || 0) + w;
      if (ld) { cov += w; ld.forEach((v, i) => { net[i] += w * (v ?? 0); }); }
      return { ticker: s.ticker || '?', name: s.name || '', weight: w, cls: slug, loading: ld };
    }).sort((a, b) => b.weight - a.weight);
    return { id: st.id, name: st.name, label: st.label, holdings, total, net: net.map(x => +x.toFixed(3)), cov: total ? cov / total : 0,
      byClass: Object.entries(byClass).sort((a, b) => b[1] - a[1]), last: rows.map(r => r.effective_from).sort().pop() || null };
  });
  const classNames = Object.fromEntries(classes.map(c => [c.slug, c.name])); classNames.unclassified = 'Unclassified';
  const matrix = classes.map(c => ({ slug: c.slug, name: c.name, v: factors.map(f => (cl.get(c.id + '|' + f.id) || {}).loading ?? null) }));
  const priceBySec = Object.fromEntries(prices.map(p => [p.security_id, p]));
  const markets = secs.map(s => ({ ticker: s.ticker, name: s.name, role: s.role, cls: cls[s.asset_class_id]?.slug || 'unclassified', price: priceBySec[s.id] || null }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  return { models, factors, matrix, classNames, run: runs[0] || null, outputs, markets };
}

// ---------- Views ----------
function heat(v) { const a = Math.min(Math.abs(v) / 0.6, 1) * 0.75 + 0.08; return `background:rgba(${v >= 0 ? '63,178,127' : '224,96,94'},${a.toFixed(2)})`; }
const fname = f => (f.slug === 'liquidity_cost' ? 'Cost of liquidity' : f.name);
const netCells = m => m.net.map(v => `<td class="num"><span class="cell" style="${heat(v)}">${sgn(v)}</span></td>`).join('');
const factorHeads = () => D.factors.map(f => `<th class="num">${esc(fname(f))}</th>`).join('');

function route() {
  if (!D) return;
  const [page, arg] = (location.hash || '#overview').slice(1).split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + page));
  closeDrawer();
  const pages = { overview, models, markets, views: viewsPage, agents, inbox };
  $('#app').innerHTML = (pages[page] || overview)();
  if (page === 'models' && arg) openModel(arg);
}

function overview() {
  const M = D.models, latest = M.map(m => m.last).filter(Boolean).sort().pop();
  const gaps = M.filter(m => m.cov < 0.95), off = M.filter(m => Math.abs(m.total - 1) > 0.005);
  const alerts = [];
  if (!M.some(m => m.holdings.length)) alerts.push('No allocations are loaded in the database yet.');
  gaps.forEach(m => alerts.push(`<b>${esc(m.name)}</b>: only ${pct(m.cov, 0)} of weight has a loading.`));
  off.forEach(m => alerts.push(`<b>${esc(m.name)}</b>: latest weights sum to ${pct(m.total)}.`));
  M.filter(m => m.last && latest && m.last < latest).forEach(m => alerts.push(`<b>${esc(m.name)}</b>: last allocation ${m.last}, older than ${latest}.`));
  const run = D.run;
  return `<span class="eyebrow">Allocation model</span><h1>Overview</h1>
  <p class="sub">Eight models, viewed as net long or short growth, inflation and the cost of liquidity.</p>
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Models</span><b>${M.length}</b><small>10/90 to 80/20</small></div>
   <div class="card kpi"><span class="eyebrow">Latest allocation</span><b style="font-size:20px">${esc(latest || '—')}</b><small>most recent trade date</small></div>
   <div class="card kpi"><span class="eyebrow">Exposure coverage</span><b>${M.length - gaps.length}/${M.length}</b><small>models with ≥95% scored</small></div>
   <div class="card kpi"><span class="eyebrow">Prices</span><b style="font-size:20px" class="${run && run.status !== 'ok' ? 'stale' : ''}">${esc(run ? run.latest_price_date || run.status : 'no run yet')}</b><small>${run ? 'last job: ' + esc(run.status) : 'daily job not run'}</small></div>
  </div>
  <div class="grid2"><div class="card"><h2>Net exposure by model <span class="chip draft">draft loadings</span></h2>
   <table><thead><tr><th>Model</th>${factorHeads()}<th class="num">Scored</th></tr></thead><tbody>
   ${M.map(m => `<tr class="click" data-go="#models/${esc(m.id)}"><td><b>${esc(m.name)}</b> <span class="chip">${esc(m.label)}</span></td>${netCells(m)}<td class="num">${pct(m.cov, 0)}</td></tr>`).join('')}</tbody></table>
   <p class="note">Net exposure = Σ weight × loading on each model's last recorded allocation (not drifted). Unscored holdings count as zero, so low coverage understates the figures.</p></div>
  <div class="card"><h2>Needs attention</h2>${alerts.length ? alerts.map(a => `<div class="alert"><span class="dot"></span><div>${a}</div></div>`).join('') : '<div class="empty">Nothing flagged.</div>'}</div></div>`;
}

function models() {
  return `<span class="eyebrow">Allocation model</span><h1>Models</h1><p class="sub">Click a model for its allocation and exposure profile.</p>
  <div class="card"><table><thead><tr><th>Model</th><th>Last allocation</th><th class="num">Holdings</th><th class="num">Cash</th>${factorHeads()}<th>Scored</th></tr></thead><tbody>
  ${D.models.map(m => `<tr class="click" data-go="#models/${esc(m.id)}"><td><b>${esc(m.name)}</b> <span class="chip">${esc(m.label)}</span></td><td>${esc(m.last || '—')}</td><td class="num">${m.holdings.length}</td>
   <td class="num">${pct((m.byClass.find(c => c[0] === 'cash') || [0, 0])[1])}</td>${netCells(m)}<td><div class="bar"><i style="width:${m.cov * 100}%"></i></div></td></tr>`).join('')}</tbody></table></div>`;
}

function markets() {
  const rows = D.markets;
  const withPrice = rows.filter(r => r.price).length;
  const chg = v => v === null || v === undefined ? '<span style="color:var(--muted)">–</span>' : `<span style="color:${v > 0 ? 'var(--pos)' : v < 0 ? 'var(--neg)' : 'var(--muted)'}">${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%</span>`;
  return `<span class="eyebrow">Allocation model</span><h1>Markets</h1>
  <p class="sub">Latest close for every security in the universe, from the daily Tiingo job.</p>
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Universe</span><b>${rows.length}</b><small>tracked securities</small></div>
   <div class="card kpi"><span class="eyebrow">Priced</span><b>${withPrice}/${rows.length}</b><small>have a latest close</small></div>
   <div class="card kpi"><span class="eyebrow">As of</span><b style="font-size:20px">${esc(D.run ? D.run.latest_price_date || '—' : '—')}</b><small>last daily job: ${esc(D.run ? D.run.status : 'no run yet')}</small></div>
  </div>
  <div class="card"><table><thead><tr><th>Ticker</th><th>Class</th><th>Role</th><th class="num">Close</th><th class="num">1-day</th><th>As of</th><th>Source</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td><b>${esc(r.ticker)}</b><br><small style="color:var(--muted)">${esc(r.name)}</small></td><td>${esc(D.classNames[r.cls] || r.cls)}</td>
   <td><span class="chip">${esc(r.role)}</span></td><td class="num">${r.price ? '$' + Number(r.price.close).toFixed(2) : '<span style="color:var(--muted)">no price</span>'}</td>
   <td class="num">${r.price ? chg(r.price.day_change_pct) : ''}</td><td>${r.price ? esc(r.price.as_of) : ''}</td><td>${r.price ? esc(r.price.source) : ''}</td></tr>`).join('')}
  </tbody></table><p class="note">1-day change compares the latest close to the prior close in the same source's history. Mutual funds post once a day after close, so their "1-day" figure lags ETFs, which can be intraday-stale here too until live quotes are added.</p></div>`;
}

function openModel(id) {
  const m = D.models.find(x => x.id === id); if (!m) return;
  const stack = m.byClass.map(([k, v]) => `<i title="${esc(D.classNames[k])} ${pct(v)}" style="width:${(v / m.total) * 100}%;background:${CLASS_COLORS[k] || '#888'}"></i>`).join('');
  const legend = m.byClass.map(([k, v]) => `<span><b style="background:${CLASS_COLORS[k] || '#888'}"></b>${esc(D.classNames[k])} ${pct(v)}</span>`).join('');
  $('#drawer').innerHTML = `<button class="close" data-go="#models">Close</button>
   <span class="eyebrow">Model · ${esc(m.label)}</span><h1>${esc(m.name)}</h1>
   <p class="sub">Last allocation ${esc(m.last || '—')} · weights sum to ${pct(m.total)}</p>
   <div class="kpis">${D.factors.map((f, i) => `<div class="card kpi"><span class="eyebrow">${esc(fname(f))}</span><b style="color:${m.net[i] >= 0 ? 'var(--pos)' : 'var(--neg)'}">${sgn(m.net[i])}</b><small>net exposure</small></div>`).join('')}</div>
   <div class="card" style="margin-bottom:14px"><h2>By asset class</h2><div class="stack">${stack}</div><div class="legend">${legend}</div></div>
   <div class="card"><h2>Holdings <span class="chip draft">draft loadings</span></h2><table><thead><tr><th>Holding</th><th>Class</th><th class="num">Weight</th>${D.factors.map(f => `<th class="num">${esc(f.slug[0].toUpperCase())}</th>`).join('')}</tr></thead><tbody>
   ${m.holdings.map(h => `<tr><td><b>${esc(h.ticker)}</b><br><small style="color:var(--muted)">${esc(h.name)}</small></td><td>${esc(D.classNames[h.cls] || h.cls)}</td><td class="num">${pct(h.weight)}</td>
    ${h.loading ? h.loading.map(v => v === null ? '<td class="num" style="color:var(--muted)">–</td>' : `<td class="num" style="color:${v > 0 ? 'var(--pos)' : v < 0 ? 'var(--neg)' : 'var(--muted)'}">${sgn(v)}</td>`).join('') : `<td class="num" colspan="${D.factors.length}" style="color:var(--muted)">not scored</td>`}</tr>`).join('')}
   </tbody></table><p class="note">G = growth, I = inflation, L = cost of liquidity. Subjective loadings; overrides are drafts.</p></div>`;
  $('#drawer').hidden = false; $('#scrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

function viewsPage() {
  const cell = v => v === null ? ['M', 'UNSCORED'] : v > 0.4 ? ['L', 'LONG'] : v < -0.75 ? ['S', 'SHORT'] : v < -0.25 ? ['M', 'FLAT / SHORT'] : ['F', 'FLAT'];
  const rows = D.matrix.map(r => `<div class="rl">${esc(r.name)}</div>${r.v.map(x => { const [c, t] = cell(x === null ? null : +x); return `<div class="${c}">${t}</div>`; }).join('')}`).join('');
  return `<span class="eyebrow">Allocation model</span><h1>Views</h1><p class="sub">Exposure of each asset class. Stances and theses per class come next.</p>
  <div class="card"><div class="mx"><div class="hd"></div>${D.factors.map(f => `<div class="hd">${esc(fname(f).toUpperCase())}</div>`).join('')}${rows}</div>
  <p class="note">Long +1, Flat 0, Short −1, Flat/Short −0.5. Subjective judgments.</p></div>
  <div class="empty">No stance recorded yet for any asset class.</div>`;
}

function agents() {
  const A = [['adam', 'Adam', 'Macro'], ['stan', 'Stan', 'Risk'], ['megan', 'Megan', 'Planning ideas'], ['annie', 'Annie', 'Decision quality'], ['sisyphus', 'Sisyphus', 'Executive']];
  return `<span class="eyebrow">Allocation model</span><h1>Agents</h1><p class="sub">Each agent's latest output, with its as-of date.</p>
  <div class="agents">${A.map(([k, n, r]) => { const o = D.outputs.find(x => x.agent === k);
   return `<div class="card"><span class="eyebrow">${r}</span><h2 style="font-size:18px">${n}</h2>${o ? `<div><b>${esc(o.title)}</b> <span class="chip">${esc(o.as_of)}</span></div><p style="white-space:pre-wrap;color:var(--muted)">${esc(o.body_md.slice(0, 900))}${o.body_md.length > 900 ? '…' : ''}</p>` : '<div class="empty">No output yet.</div>'}</div>`; }).join('')}</div>`;
}
function inbox() {
  return `<span class="eyebrow">Allocation model</span><h1>Inbox</h1><p class="sub">Clipped and dropped items, where they were routed, and why.</p>
  <div class="empty">The routing log will appear here once the inbox processor syncs to the database.</div>`;
}

// ---------- Wiring ----------
document.addEventListener('click', e => { const t = e.target.closest('[data-go]'); if (t) location.hash = t.dataset.go; });
$('#scrim').addEventListener('click', () => { location.hash = '#models'; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) location.hash = '#models'; });
$('#theme').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch (e) {} });
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
window.addEventListener('hashchange', route);

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (linkType && session) return showGate('set');
  await enter(session);
})();
})();
