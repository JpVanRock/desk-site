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
  const [strategies, alloc, secs, classes, factors, cLoad, sLoad, runs, outputs, prices, technicals, macro, views, roadmap, sources, calls, routingLog] = await Promise.all([
    q(sb.from('strategies').select('id,name,label,sort_order').order('sort_order')),
    q(sb.from('target_allocations').select('strategy_id,security_id,asset_class_id,target_weight,effective_from').is('effective_to', null)),
    q(sb.from('securities').select('id,ticker,name,asset_class_id,role')),
    q(sb.from('asset_classes').select('id,slug,name,sort_order').order('sort_order')),
    q(sb.from('factors').select('id,slug,name,sort_order').order('sort_order')),
    q(sb.from('asset_class_factor_loadings').select('asset_class_id,factor_id,loading,as_of')),
    q(sb.from('security_factor_loadings').select('security_id,factor_id,loading,as_of')),
    q(sb.from('data_runs').select('job,status,latest_price_date,started_at').order('started_at', { ascending: false }).limit(10)),
    q(sb.from('agent_outputs').select('agent,kind,title,body_md,as_of').order('as_of', { ascending: false }).limit(50)),
    q(sb.from('current_prices').select('security_id,as_of,close,prev_close,day_change_pct,source')),
    q(sb.from('current_technical_snapshot').select('security_id,as_of,close,sma50,sma200,rsi14,macd_hist,hv20_ann,trend_state,rs_vs_class_63,support,resistance')),
    q(sb.from('current_macro_readings').select('series_id,fred_code,name,factor_id,unit,obs_date,value')),
    q(sb.from('asset_class_views').select('asset_class_id,as_of,stance,confidence,thesis,role_in_profile,change_my_mind,status,author').order('as_of', { ascending: false })),
    q(sb.from('roadmap_items').select('area,item,status,detail,sort_order').order('sort_order')),
    q(sb.from('source_track_record').select('source,category,n_directional,hit_rate,n_open,last_call_at').order('source')),
    q(sb.from('research_calls').select('id,source,category,agent,called_at,asset_class_id,direction,confidence,thesis,review_at,scored_at,actual_return,hit').order('called_at', { ascending: false }).limit(200)),
    q(sb.from('inbox_routing_log').select('file,source,received_at,routed_to,reason,status,processed_at').order('processed_at', { ascending: false }).limit(200)),
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
  const techBySec = Object.fromEntries(technicals.map(t => [t.security_id, t]));
  const markets = secs.map(s => ({ id: s.id, ticker: s.ticker, name: s.name, role: s.role, cls: cls[s.asset_class_id]?.slug || 'unclassified', price: priceBySec[s.id] || null, tech: techBySec[s.id] || null }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  const factorSlug = Object.fromEntries(factors.map(f => [f.id, f.slug]));
  const macroByFactor = {};
  for (const m of macro) (macroByFactor[factorSlug[m.factor_id] || 'unassigned'] ||= []).push(m);

  const latestViews = latestBy(views, v => v.asset_class_id);
  const viewsByClass = classes.map(c => ({ slug: c.slug, name: c.name, view: latestViews.get(c.id) || null }));

  const run = runs.find(r => r.job === 'daily_prices') || null;
  const macroRun = runs.find(r => r.job === 'daily_macro') || null;
  const classSlugById = Object.fromEntries(classes.map(c => [c.id, c.slug]));
  const callsOut = calls.map(c => ({ ...c, classSlug: classSlugById[c.asset_class_id] || null }));
  return { models, factors, matrix, classNames, run, macroRun, outputs, markets, macroByFactor, viewsByClass, roadmap, sources, calls: callsOut, routingLog };
}

// ---------- Views ----------
// Shared by markets(), openChart() and indexSection() — must stay at module scope: it was
// briefly a local inside markets(), which made openChart() throw ReferenceError mid-render
// and leave the drawer stuck on "Loading chart…".
const trendChip = t => t ? `<span class="chip ${t === 'bullish' ? 'long' : t === 'bearish' ? 'short' : 'flat'}">${esc(t)}</span>` : '<span style="color:var(--muted)">–</span>';
function heat(v) { const a = Math.min(Math.abs(v) / 0.6, 1) * 0.75 + 0.08; return `background:rgba(${v >= 0 ? '63,178,127' : '224,96,94'},${a.toFixed(2)})`; }
const fname = f => (f.slug === 'liquidity_cost' ? 'Cost of liquidity' : f.name);
const netCells = m => m.net.map(v => `<td class="num"><span class="cell" style="${heat(v)}">${sgn(v)}</span></td>`).join('');
const factorHeads = () => D.factors.map(f => `<th class="num">${esc(fname(f))}</th>`).join('');

function route() {
  if (!D) return;
  const [page, arg] = (location.hash || '#overview').slice(1).split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + page));
  closeDrawer();
  const pages = { overview, models, markets, views: viewsPage, agents, inbox, status, sources };
  $('#app').innerHTML = (pages[page] || overview)();
  if (page === 'models' && arg) openModel(arg);
  if (page === 'markets' && arg) openChart(arg);
  if (page === 'overview' && arg) openExposureChart(arg);
  if (page === 'views' && arg) openMacroChart(arg);
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
   ${M.map(m => `<tr class="click" data-go="#overview/${esc(m.id)}"><td><b>${esc(m.name)}</b> <span class="chip">${esc(m.label)}</span></td>${netCells(m)}<td class="num">${pct(m.cov, 0)}</td></tr>`).join('')}</tbody></table>
   <p class="note">Net exposure = Σ weight × loading on each model's last recorded allocation (not drifted). Unscored holdings count as zero, so low coverage understates the figures. Click a row for its exposure history.</p></div>
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
  const rsiColor = v => v === null || v === undefined ? 'var(--muted)' : v >= 70 ? 'var(--neg)' : v <= 30 ? 'var(--pos)' : 'var(--text)';
  return `<span class="eyebrow">Allocation model</span><h1>Markets</h1>
  <p class="sub">Latest close and standard technicals for every security in the universe, from the daily job. Click a row for its chart.</p>
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Universe</span><b>${rows.length}</b><small>tracked securities</small></div>
   <div class="card kpi"><span class="eyebrow">Priced</span><b>${withPrice}/${rows.length}</b><small>have a latest close</small></div>
   <div class="card kpi"><span class="eyebrow">As of</span><b style="font-size:20px">${esc(D.run ? D.run.latest_price_date || '—' : '—')}</b><small>last daily job: ${esc(D.run ? D.run.status : 'no run yet')}</small></div>
  </div>
  <div class="card"><table><thead><tr><th>Ticker</th><th>Class</th><th class="num">Close</th><th class="num">1-day</th><th class="num">RSI14</th><th>Trend</th><th class="num">vs SMA50</th><th class="num">vs SMA200</th><th class="num">RS vs class(63d)</th></tr></thead><tbody>
  ${rows.map(r => { const t = r.tech; const vs = (c, sma) => sma ? `<span style="color:${c > sma ? 'var(--pos)' : 'var(--neg)'}">${c > sma ? '+' : ''}${(((c - sma) / sma) * 100).toFixed(1)}%</span>` : '–';
    const rs = t?.rs_vs_class_63; const rsStr = rs === null || rs === undefined ? '–' : `<span style="color:${rs >= 0 ? 'var(--pos)' : 'var(--neg)'}">${rs >= 0 ? '+' : ''}${(rs * 100).toFixed(1)}%</span>`;
    return `<tr class="click" data-go="#markets/${esc(r.id)}"><td><b>${esc(r.ticker)}</b><br><small style="color:var(--muted)">${esc(r.name)}</small></td><td>${esc(D.classNames[r.cls] || r.cls)}</td>
     <td class="num">${r.price ? '$' + Number(r.price.close).toFixed(2) : '<span style="color:var(--muted)">no price</span>'}</td>
     <td class="num">${r.price ? chg(r.price.day_change_pct) : ''}</td>
     <td class="num" style="color:${rsiColor(t?.rsi14)}">${t?.rsi14 != null ? t.rsi14.toFixed(1) : '–'}</td>
     <td>${trendChip(t?.trend_state)}</td>
     <td class="num">${t ? vs(t.close ?? r.price?.close, t.sma50) : '–'}</td>
     <td class="num">${t ? vs(t.close ?? r.price?.close, t.sma200) : '–'}</td>
     <td class="num">${rsStr}</td></tr>`; }).join('')}
  </tbody></table><p class="note">RSI14 uses Wilder's smoothing; below 30 (green) is oversold, above 70 (red) is overbought by the standard convention, not a signal to act on alone. Trend: bullish = close &gt; SMA50 &gt; SMA200, bearish = the reverse, else neutral. RS vs class = 63-day return minus the median of same-asset-class peers. SMA200 and RS need ~10 months of history — newer listings show "–". This is price action and trend, not a rating: the desk decided the underlying trend-anchored rating hasn't earned a role in decisions yet (see ROADMAP.md / the Status tab). Parameters: desk-workspace/stan/technicals-parameters.md.</p></div>`;
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

// ---------- Chart (hand-rolled SVG: price + SMA overlays, RSI panel) ----------
function linePath(vals, x, y) {
  let d = '', started = false;
  vals.forEach((v, i) => {
    if (v === null || v === undefined) { started = false; return; }
    d += (started ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
    started = true;
  });
  return d.trim();
}
function priceChartSvg(dates, series, W, H) {
  const pad = { l: 44, r: 10, t: 8, b: 14 };
  const all = series.flatMap(s => s.vals).filter(v => v !== null && v !== undefined);
  if (!all.length) return '<div class="empty">No history to chart.</div>';
  const min = Math.min(...all), max = Math.max(...all), span = (max - min) || 1;
  const x = i => pad.l + (i / Math.max(1, dates.length - 1)) * (W - pad.l - pad.r);
  const y = v => H - pad.b - ((v - min) / span) * (H - pad.t - pad.b);
  const gridY = [0, 0.25, 0.5, 0.75, 1].map(f => min + f * span);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block">
    ${gridY.map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
      <text x="2" y="${(y(v) + 3).toFixed(1)}" font-size="9" fill="var(--muted)">${v.toFixed(v < 10 ? 3 : 2)}</text>`).join('')}
    ${series.map(s => `<path d="${linePath(s.vals, x, y)}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.5}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`).join('')}
    <text x="${pad.l}" y="${H - 2}" font-size="9" fill="var(--muted)">${esc(dates[0] || '')}</text>
    <text x="${W - pad.r}" y="${H - 2}" font-size="9" fill="var(--muted)" text-anchor="end">${esc(dates.at(-1) || '')}</text>
  </svg>`;
}
function rsiChartSvg(dates, rsi, W, H) {
  const pad = { l: 44, r: 10, t: 6, b: 4 };
  const x = i => pad.l + (i / Math.max(1, dates.length - 1)) * (W - pad.l - pad.r);
  const y = v => H - pad.b - (v / 100) * (H - pad.t - pad.b);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block">
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(70).toFixed(1)}" y2="${y(70).toFixed(1)}" stroke="var(--neg)" stroke-width="1" stroke-dasharray="3,3"/>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(30).toFixed(1)}" y2="${y(30).toFixed(1)}" stroke="var(--pos)" stroke-width="1" stroke-dasharray="3,3"/>
    <text x="2" y="${(y(70) + 3).toFixed(1)}" font-size="9" fill="var(--muted)">70</text>
    <text x="2" y="${(y(30) + 3).toFixed(1)}" font-size="9" fill="var(--muted)">30</text>
    <path d="${linePath(rsi, x, y)}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  </svg>`;
}

async function openChart(securityId) {
  const row = D.markets.find(m => m.id === securityId); if (!row) return;
  $('#drawer').innerHTML = `<button class="close" data-go="#markets">Close</button>
   <span class="eyebrow">${esc(D.classNames[row.cls] || row.cls)}</span><h1>${esc(row.ticker)}</h1>
   <p class="sub">${esc(row.name)}</p><div class="empty">Loading chart…</div>`;
  $('#drawer').hidden = false; $('#scrim').hidden = false;

  let hist;
  try {
    hist = await q(sb.from('technical_snapshots').select('as_of,close,sma50,sma200,rsi14')
      .eq('security_id', securityId).order('as_of', { ascending: false }).limit(300));
    hist.reverse();
  } catch (ex) {
    $('#drawer').querySelector('.empty').textContent = `Could not load history: ${ex.message}`;
    return;
  }
  if (!hist.length) { $('#drawer').querySelector('.empty').textContent = 'No technical history for this security yet.'; return; }

  const dates = hist.map(h => h.as_of);
  const t = row.tech;
  $('#drawer').innerHTML = `<button class="close" data-go="#markets">Close</button>
   <span class="eyebrow">${esc(D.classNames[row.cls] || row.cls)}</span><h1>${esc(row.ticker)}</h1>
   <p class="sub">${esc(row.name)} · ${dates.length} trading days shown, through ${esc(dates.at(-1))}</p>
   <div class="kpis">
    <div class="card kpi"><span class="eyebrow">Close</span><b>${row.price ? '$' + Number(row.price.close).toFixed(2) : '—'}</b><small>${row.price ? esc(row.price.as_of) : ''}</small></div>
    <div class="card kpi"><span class="eyebrow">RSI14</span><b style="color:${t?.rsi14 >= 70 ? 'var(--neg)' : t?.rsi14 <= 30 ? 'var(--pos)' : 'var(--text)'}">${t?.rsi14 != null ? t.rsi14.toFixed(1) : '—'}</b><small>Wilder's</small></div>
    <div class="card kpi"><span class="eyebrow">Trend</span><b style="font-size:16px">${trendChip(t?.trend_state)}</b><small>close vs SMA50/200</small></div>
   </div>
   <div class="card" style="margin-bottom:10px"><h2>Price · close, SMA50, SMA200</h2>
    ${priceChartSvg(dates, [
      { vals: hist.map(h => h.close), color: 'var(--text)', width: 1.75 },
      { vals: hist.map(h => h.sma50), color: 'var(--accent)', dash: '4,3' },
      { vals: hist.map(h => h.sma200), color: 'var(--flat)', dash: '4,3' },
    ], 560, 220)}
    <div class="legend" style="margin-top:8px"><span><b style="background:var(--text)"></b>Close</span><span><b style="background:var(--accent)"></b>SMA50</span><span><b style="background:var(--flat)"></b>SMA200</span></div>
   </div>
   <div class="card"><h2>RSI14</h2>${rsiChartSvg(dates, hist.map(h => h.rsi14), 560, 90)}
    <p class="note">Dashed lines at 30 (oversold) and 70 (overbought) by the standard convention, not a signal to act on alone. Descriptive context only — see the Markets note for why no rating is shown.</p></div>`;
}

const FACTOR_COLORS = { growth: 'var(--pos)', inflation: 'var(--warn)', liquidity_cost: 'var(--accent)' };

async function openExposureChart(strategyId) {
  const m = D.models.find(x => x.id === strategyId); if (!m) return;
  $('#drawer').innerHTML = `<button class="close" data-go="#overview">Close</button>
   <span class="eyebrow">Model · ${esc(m.label)}</span><h1>${esc(m.name)}</h1>
   <p class="sub">Net exposure over time, computed at each historical allocation snapshot.</p><div class="empty">Loading chart…</div>`;
  $('#drawer').hidden = false; $('#scrim').hidden = false;

  let hist;
  try {
    hist = await q(sb.from('strategy_exposure_history').select('factor_id,as_of,net_exposure,coverage')
      .eq('strategy_id', strategyId).order('as_of', { ascending: true }));
  } catch (ex) {
    $('#drawer').querySelector('.empty').textContent = `Could not load history: ${ex.message}`;
    return;
  }
  if (!hist.length) { $('#drawer').querySelector('.empty').textContent = 'No exposure history yet. Run jobs/compute-exposure-history.mjs.'; return; }

  const dates = [...new Set(hist.map(h => h.as_of))].sort();
  const byFactorDate = new Map(hist.map(h => [h.factor_id + '|' + h.as_of, h.net_exposure]));
  const series = D.factors.map(f => ({
    vals: dates.map(d => { const v = byFactorDate.get(f.id + '|' + d); return v === undefined ? null : +v; }),
    color: FACTOR_COLORS[f.slug] || 'var(--text)', width: 1.75,
  }));
  $('#drawer').innerHTML = `<button class="close" data-go="#overview">Close</button>
   <span class="eyebrow">Model · ${esc(m.label)}</span><h1>${esc(m.name)}</h1>
   <p class="sub">Net exposure at each of ${dates.length} allocation snapshots, ${esc(dates[0])} to ${esc(dates.at(-1))}. Not drifted between snapshots — each point is that snapshot's target weights.</p>
   <div class="card"><h2>Growth, inflation, cost of liquidity</h2>${priceChartSvg(dates, series, 560, 240)}
    <div class="legend" style="margin-top:8px">${D.factors.map(f => `<span><b style="background:${FACTOR_COLORS[f.slug] || '#888'}"></b>${esc(fname(f))}</span>`).join('')}</div>
    <p class="note">Uses today's factor loadings applied to each historical snapshot's weights, not the loadings as they stood at that time (loadings are mostly static judgments, not date-sensitive yet).</p></div>`;
}

async function openMacroChart(seriesId) {
  const rows = Object.values(D.macroByFactor).flat();
  const row = rows.find(r => r.series_id === seriesId); if (!row) return;
  $('#drawer').innerHTML = `<button class="close" data-go="#views">Close</button>
   <span class="eyebrow">${esc(row.fred_code)}</span><h1>${esc(row.name)}</h1><div class="empty">Loading chart…</div>`;
  $('#drawer').hidden = false; $('#scrim').hidden = false;

  let obs;
  try {
    obs = await q(sb.from('macro_observations').select('obs_date,value,vintage_date')
      .eq('series_id', seriesId).order('obs_date', { ascending: true }).order('vintage_date', { ascending: true }).limit(2000));
  } catch (ex) {
    $('#drawer').querySelector('.empty').textContent = `Could not load history: ${ex.message}`;
    return;
  }
  if (!obs.length) { $('#drawer').querySelector('.empty').textContent = 'No history for this series yet.'; return; }
  // Latest vintage per obs_date (a revised series like GDP can have more than one reading per date).
  const byDate = new Map();
  for (const o of obs) byDate.set(o.obs_date, o.value);
  const dates = [...byDate.keys()].sort();
  const vals = dates.map(d => +byDate.get(d));
  $('#drawer').innerHTML = `<button class="close" data-go="#views">Close</button>
   <span class="eyebrow">${esc(row.fred_code)}</span><h1>${esc(row.name)}</h1>
   <p class="sub">${dates.length} observations, ${esc(dates[0])} to ${esc(dates.at(-1))}. ${esc(row.unit || '')}</p>
   <div class="card">${priceChartSvg(dates, [{ vals, color: 'var(--accent)', width: 1.75 }], 560, 240)}
    <p class="note">Latest published value per date (a revised series like GDP can be restated after its first print). Source: FRED.</p></div>`;
}

function viewsPage() {
  const cell = v => v === null ? ['M', 'UNSCORED'] : v > 0.4 ? ['L', 'LONG'] : v < -0.75 ? ['S', 'SHORT'] : v < -0.25 ? ['M', 'FLAT / SHORT'] : ['F', 'FLAT'];
  const rows = D.matrix.map(r => `<div class="rl">${esc(r.name)}</div>${r.v.map(x => { const [c, t] = cell(x === null ? null : +x); return `<div class="${c}">${t}</div>`; }).join('')}`).join('');

  const stanceChip = s => { if (!s) return ''; const cls = /overweight/.test(s) ? 'long' : /underweight/.test(s) ? 'short' : 'flat'; return `<span class="chip ${cls}">${esc(s.replace(/_/g, ' '))}</span>`; };
  const haveViews = D.viewsByClass.some(v => v.view);
  const viewCards = D.viewsByClass.map(({ name, view: v }) => !v ? '' : `
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0">${esc(name)} ${stanceChip(v.stance)} ${v.status === 'draft' ? '<span class="chip draft">draft</span>' : ''}</h2>
        <small style="color:var(--muted)">${esc(v.author || '')} · ${esc(v.as_of)}${v.confidence != null ? ` · confidence ${pct(v.confidence, 0)}` : ''}</small>
      </div>
      <p>${esc(v.thesis)}</p>
      ${v.role_in_profile ? `<p class="note"><b>Role in the profile:</b> ${esc(v.role_in_profile)}</p>` : ''}
      ${v.change_my_mind ? `<p class="note"><b>Would change our mind:</b> ${esc(v.change_my_mind)}</p>` : ''}
    </div>`).join('');

  const macroSection = D.factors.map(f => {
    const rows = (D.macroByFactor[f.slug] || []).sort((a, b) => a.fred_code.localeCompare(b.fred_code));
    if (!rows.length) return '';
    return `<div class="card" style="margin-bottom:10px"><h2>${esc(fname(f))}</h2><table><thead><tr><th>Series</th><th class="num">Value</th><th>As of</th></tr></thead><tbody>
     ${rows.map(r => `<tr class="click" data-go="#views/${esc(r.series_id)}"><td>${esc(r.name)} <small style="color:var(--muted)">(${esc(r.fred_code)})</small></td><td class="num">${r.value}${/percent/i.test(r.unit || '') ? '%' : ''}</td><td>${esc(r.obs_date)}</td></tr>`).join('')}
     </tbody></table></div>`;
  }).join('');

  return `<span class="eyebrow">Allocation model</span><h1>Views</h1><p class="sub">Exposure of each asset class, the desk's current stance where recorded, and the macro data behind it. Click a macro series for its chart.</p>
  <div class="card" style="margin-bottom:14px"><h2>Exposure matrix</h2><div class="mx"><div class="hd"></div>${D.factors.map(f => `<div class="hd">${esc(fname(f).toUpperCase())}</div>`).join('')}${rows}</div>
  <p class="note">Long +1, Flat 0, Short −1, Flat/Short −0.5. Subjective judgments.</p></div>
  <h2 style="margin:18px 0 10px">Stances</h2>
  ${haveViews ? viewCards : '<div class="empty">No stance recorded yet for any asset class.</div>'}
  <h2 style="margin:18px 0 10px">Indexes</h2>
  ${indexSection()}
  <h2 style="margin:18px 0 10px">Macro data</h2>
  ${macroSection || '<div class="empty">No macro data loaded yet.</div>'}`;
}

// Price action and trend for the benchmark/index securities, shown alongside the views they
// inform. Same descriptive technicals as the Markets tab — no rating, same reasoning.
function indexSection() {
  const idx = (D.markets || []).filter(m => m.role === 'benchmark');
  if (!idx.length) return '<div class="empty">No index securities in the universe yet.</div>';
  const rsiColor = v => v === null || v === undefined ? 'var(--muted)' : v >= 70 ? 'var(--neg)' : v <= 30 ? 'var(--pos)' : 'var(--text)';
  const vs = (c, sma) => sma && c ? `<span style="color:${c > sma ? 'var(--pos)' : 'var(--neg)'}">${c > sma ? '+' : ''}${(((c - sma) / sma) * 100).toFixed(1)}%</span>` : '–';
  return `<div class="card"><table><thead><tr><th>Index</th><th class="num">Close</th><th class="num">RSI14</th><th>Trend</th><th class="num">vs SMA50</th><th class="num">vs SMA200</th><th>As of</th></tr></thead><tbody>
   ${idx.map(r => { const t = r.tech; const c = t?.close ?? r.price?.close;
     return `<tr class="click" data-go="#markets/${esc(r.id)}"><td><b>${esc(r.ticker)}</b><br><small style="color:var(--muted)">${esc(r.name)}</small></td>
      <td class="num">${r.price ? '$' + Number(r.price.close).toFixed(2) : '–'}</td>
      <td class="num" style="color:${rsiColor(t?.rsi14)}">${t?.rsi14 != null ? t.rsi14.toFixed(1) : '–'}</td>
      <td>${trendChip(t?.trend_state)}</td>
      <td class="num">${vs(c, t?.sma50)}</td><td class="num">${vs(c, t?.sma200)}</td>
      <td>${esc(t?.as_of || r.price?.as_of || '–')}</td></tr>`; }).join('')}
   </tbody></table><p class="note">Click an index for its full chart on the Markets tab. Descriptive price action and trend only — no rating, for the same reason given on Markets.</p></div>`;
}

function agents() {
  // isolated: true for agents whose output never feeds a brief or Stan's process unless
  // explicitly tapped in — worth showing on the card so the distinction stays visible.
  const A = [
    ['adam', 'Adam', 'Macro', false], ['stan', 'Stan', 'Risk', false],
    ['megan', 'Megan', 'Planning ideas', false], ['annie', 'Annie', 'Decision quality', false],
    ['sisyphus', 'Sisyphus', 'Executive', false],
    ['sven', 'Sven', 'Market internals', true], ['gail', 'Gail', 'Geopolitics', true],
  ];
  return `<span class="eyebrow">Allocation model</span><h1>Agents</h1><p class="sub">Each agent's latest output, with its as-of date. Isolated agents are shown here to read, but their work never feeds a brief or the allocation process unless explicitly tapped in.</p>
  <div class="agents">${A.map(([k, n, r, isolated]) => { const o = D.outputs.find(x => x.agent === k);
   return `<div class="card"><span class="eyebrow">${r}</span><h2 style="font-size:18px">${n} ${isolated ? '<span class="chip">isolated</span>' : ''}</h2>${o ? `<div><b>${esc(o.title)}</b> <span class="chip">${esc(o.as_of)}</span></div><p style="white-space:pre-wrap;color:var(--muted)">${esc(o.body_md.slice(0, 900))}${o.body_md.length > 900 ? '…' : ''}</p>` : '<div class="empty">No output yet.</div>'}</div>`; }).join('')}</div>`;
}
function inbox() {
  const log = D.routingLog || [];
  const statusChip = s => { const cls = s === 'routed' ? 'long' : s === 'held' ? 'held' : 'flat'; return `<span class="chip ${cls}">${esc((s || '').replace(/_/g, ' '))}</span>`; };
  const held = log.filter(r => r.status === 'held').length;
  const byAgent = {};
  for (const r of log) if (r.routed_to) byAgent[r.routed_to] = (byAgent[r.routed_to] || 0) + 1;
  return `<span class="eyebrow">Allocation model</span><h1>Inbox</h1><p class="sub">Clipped and dropped items, where they were routed, and why.</p>
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Items</span><b>${log.length}</b><small>processed</small></div>
   <div class="card kpi"><span class="eyebrow">Routed to</span><b style="font-size:16px">${Object.entries(byAgent).map(([a, n]) => `${esc(a)} ${n}`).join(' · ') || '—'}</b><small></small></div>
   <div class="card kpi"><span class="eyebrow">Held</span><b class="${held ? 'stale' : ''}">${held}</b><small>not read by any agent</small></div>
  </div>
  <div class="card">${log.length ? `<table><thead><tr><th>Item</th><th>Source</th><th>Received</th><th>Routed to</th><th>Reason</th><th>Status</th></tr></thead><tbody>
   ${log.map(r => `<tr><td>${esc((r.file || '').split('/').pop())}</td><td>${esc(r.source || '—')}</td><td>${esc(r.received_at || '—')}</td>
    <td>${esc(r.routed_to || '—')}</td><td style="max-width:320px;color:var(--muted)">${esc(r.reason || '')}</td><td>${statusChip(r.status)}</td></tr>`).join('')}
   </tbody></table><p class="note">Held items are deliberately not read by any agent — a publisher's terms restrict it. Source policy lives in desk-workspace/inbox/_source-policy.md; that file, not this table, is what the processor actually enforces.</p>`
   : '<div class="empty">Nothing processed yet. Run the inbox-processor skill, then jobs/sync-routing-log.mjs.</div>'}</div>`;
}

function sources() {
  const src = D.sources || [], calls = D.calls || [];
  const hitColor = h => h === null || h === undefined ? 'var(--muted)' : h ? 'var(--pos)' : 'var(--neg)';
  const dirChip = d => { const cls = d === 'bullish' ? 'long' : d === 'bearish' ? 'short' : 'flat'; return `<span class="chip ${cls}">${esc(d)}</span>`; };
  const totalScored = src.reduce((a, s) => a + (s.n_directional || 0), 0);
  const totalOpen = src.reduce((a, s) => a + (s.n_open || 0), 0);
  return `<span class="eyebrow">Allocation model</span><h1>Sources</h1>
  <p class="sub">Which research sources have actually been right. Each directional call a source makes is papertraded against that asset class's benchmark once the horizon passes — this is measured, not a feeling.</p>
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Sources tracked</span><b>${src.length}</b><small></small></div>
   <div class="card kpi"><span class="eyebrow">Calls scored</span><b>${totalScored}</b><small>all-time</small></div>
   <div class="card kpi"><span class="eyebrow">Calls open</span><b>${totalOpen}</b><small>awaiting their review date</small></div>
  </div>
  <div class="card" style="margin-bottom:14px"><h2>Track record by source</h2>
   ${src.length ? `<table><thead><tr><th>Source</th><th>Category</th><th class="num">Scored</th><th class="num">Hit rate</th><th class="num">Open</th><th>Last call</th></tr></thead><tbody>
    ${src.map(s => `<tr><td><b>${esc(s.source)}</b></td><td>${esc(s.category || '—')}</td><td class="num">${s.n_directional ?? 0}</td>
     <td class="num">${s.hit_rate != null ? `<span style="color:${s.hit_rate >= 0.5 ? 'var(--pos)' : 'var(--neg)'}">${(s.hit_rate * 100).toFixed(0)}%</span>` : '<span style="color:var(--muted)">—</span>'}</td>
     <td class="num">${s.n_open ?? 0}</td><td>${esc(s.last_call_at || '—')}</td></tr>`).join('')}
    </tbody></table><p class="note">All-time hit rate; rolling 30d/3m/6m/12m windows come once there's enough call volume for them to mean something. A source needs at least a few scored, directional (non-neutral) calls before its hit rate is worth reading.</p>`
    : '<div class="empty">No sources tracked yet. Adam logs a call with jobs/log-research-call.mjs whenever a source makes an explicit directional bet.</div>'}
  </div>
  <div class="card"><h2>Recent calls</h2>
   ${calls.length ? `<table><thead><tr><th>Source</th><th>Called</th><th>Asset class</th><th>Direction</th><th class="num">Confidence</th><th>Thesis</th><th class="num">Result</th></tr></thead><tbody>
    ${calls.slice(0, 40).map(c => `<tr><td><b>${esc(c.source)}</b></td><td>${esc(c.called_at)}</td><td>${esc(D.classNames[c.classSlug] || c.classSlug || '—')}</td><td>${dirChip(c.direction)}</td>
     <td class="num">${c.confidence != null ? pct(c.confidence, 0) : '—'}</td><td style="max-width:280px">${esc((c.thesis || '').slice(0, 140))}${(c.thesis || '').length > 140 ? '…' : ''}</td>
     <td class="num" style="color:${hitColor(c.hit)}">${c.scored_at ? (c.hit === null ? 'n/a (neutral)' : c.hit ? 'HIT' : 'MISS') + (c.actual_return != null ? ` (${c.actual_return >= 0 ? '+' : ''}${(c.actual_return * 100).toFixed(1)}%)` : '') : `due ${esc(c.review_at)}`}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">Nothing logged yet.</div>'}
  </div>`;
}

function status() {
  const items = D.roadmap || [];
  const byArea = new Map();
  for (const it of items) { if (!byArea.has(it.area)) byArea.set(it.area, []); byArea.get(it.area).push(it); }
  const doneCount = items.filter(i => i.status === 'done').length;
  const dot = s => ({ done: 'var(--pos)', in_progress: 'var(--flat)', deferred: 'var(--muted)', not_started: 'var(--neg)' }[s] || 'var(--muted)');
  const label = s => ({ done: 'Done', in_progress: 'In progress', deferred: 'Deferred', not_started: 'Not started' }[s] || s);
  return `<span class="eyebrow">Allocation model</span><h1>Status</h1><p class="sub">What's built, in progress, or not started — kept in sync with the project roadmap.</p>
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Items</span><b>${items.length}</b><small>tracked</small></div>
   <div class="card kpi"><span class="eyebrow">Done</span><b style="color:var(--pos)">${doneCount}</b><small>of ${items.length}</small></div>
   <div class="card kpi"><span class="eyebrow">Areas</span><b>${byArea.size}</b><small>tracked</small></div>
  </div>
  ${items.length ? [...byArea.entries()].map(([area, list]) => `
   <div class="card" style="margin-bottom:10px"><h2>${esc(area)}</h2>
    ${list.map(it => `<div class="alert"><span class="dot" style="background:${dot(it.status)}"></span><div>
      <b>${esc(it.item)}</b> <span class="chip" style="color:${dot(it.status)};border-color:${dot(it.status)}">${label(it.status)}</span>
      ${it.detail ? `<div class="note" style="margin-top:2px">${esc(it.detail)}</div>` : ''}
    </div></div>`).join('')}
   </div>`).join('') : '<div class="empty">No roadmap items synced yet.</div>'}`;
}

// ---------- Wiring ----------
document.addEventListener('click', e => { const t = e.target.closest('[data-go]'); if (t) location.hash = t.dataset.go; });
const closeDrawerHash = () => { location.hash = (location.hash || '#overview').split('/')[0]; };
$('#scrim').addEventListener('click', closeDrawerHash);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawerHash(); });
$('#theme').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('theme', t); } catch (e) {} });
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
window.addEventListener('hashchange', route);

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (linkType && session) return showGate('set');
  await enter(session);
})();
})();
