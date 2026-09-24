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
  const [strategies, alloc, secs, classes, factors, cLoad, sLoad, runs, outputs, prices, technicals, macro, views, roadmap, sources, calls, routingLog, contribs, scenarios, stress, perf, attrib, speedLimit, modelSpeed, rocBoard, trigHits, trigRules] = await Promise.all([
    q(sb.from('strategies').select('id,name,label,sort_order').order('sort_order')),
    q(sb.from('target_allocations').select('strategy_id,security_id,asset_class_id,target_weight,effective_from').is('effective_to', null)),
    q(sb.from('securities').select('id,ticker,name,asset_class_id,role')),
    q(sb.from('asset_classes').select('id,slug,name,sort_order,primary_role,primary_role_is_draft').order('sort_order')),
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
    q(sb.from('inbox_routing_log').select('file,source,received_at,routed_to,lens,reason,status,processed_at').order('processed_at', { ascending: false }).limit(200)),
    q(sb.from('holding_contributions').select('strategy_id,security_id,as_of,weight,risk_share,risk_ratio,corr_to_rest,max_corr,closest_peer_id,verdict,rationale').order('as_of', { ascending: false })),
    q(sb.from('stress_scenarios').select('id,slug,name,description,shocks').order('sort_order')),
    q(sb.from('strategy_stress_results').select('strategy_id,scenario_id,as_of,factor_score,coverage,n_windows,mean_return,worst_return,best_return,replay_coverage,windows').order('as_of', { ascending: false })),
    q(sb.from('strategy_performance').select('strategy_id,period,as_of,start_date,end_date,portfolio_return,peer_benchmark_return,policy_benchmark_return,coverage,max_drawdown,peer_max_drawdown').order('as_of', { ascending: false })),
    q(sb.from('strategy_attribution').select('strategy_id,period,as_of,asset_class_id,w_portfolio,w_benchmark,r_portfolio,r_benchmark,contribution,allocation_effect,selection_effect,interaction_effect,attributable').order('as_of', { ascending: false })),
    q(sb.from('speed_limit_readings').select('as_of,category,score,light,weight,n_calls,n_recorded,target_beta_low,target_beta_high,sign_label').order('as_of', { ascending: false })),
    q(sb.from('strategy_speed_limit').select('strategy_id,as_of,actual_beta,r_squared,n_obs,target_low,target_high,light,note').order('as_of', { ascending: false })),
    q(sb.from('market_roc_board').select('as_of,security_id,label,sort_order,close,price_roc_1d,price_roc_1w,price_roc_1m,volume_roc_1w,vol_ann,vol_roc_1m').order('sort_order')),
    q(sb.from('trigger_hits').select('as_of,headline,value,rule_id,security_id,strategy_id').order('as_of', { ascending: false }).limit(200)),
    q(sb.from('trigger_rules').select('id,name,kind,enabled')),
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

  // Both allocation tests are written with an as_of, and a re-run makes a new dated set rather
  // than overwriting. Keep only the newest set so a stale run can't sit alongside a fresh one.
  const newest = rows => { const d = rows.map(r => r.as_of).sort().pop(); return rows.filter(r => r.as_of === d); };
  const contribByStrategy = {}, stressByStrategy = {};
  for (const c of newest(contribs)) (contribByStrategy[c.strategy_id] ||= []).push({ ...c, ticker: sec[c.security_id]?.ticker || '?', peer: sec[c.closest_peer_id]?.ticker || null });
  for (const s of newest(stress)) (stressByStrategy[s.strategy_id] ||= []).push(s);

  const perfByStrategy = {}, attribByStrategy = {};
  for (const r of newest(perf))   (perfByStrategy[r.strategy_id] ||= []).push(r);
  for (const r of newest(attrib)) (attribByStrategy[r.strategy_id] ||= []).push(r);
  // Asset-class role, for the growth/inflation/liquidity donut. Roles are per asset class and are
  // a draft; see desk-workspace/design/asset-role-vs-net-exposure.md for why this is NOT the same
  // measure as the net factor exposure shown above it.
  const roleByClassSlug = Object.fromEntries(classes.map(c => [c.slug, c.primary_role || null]));

  return { models, factors, matrix, classNames, run, macroRun, outputs, markets, macroByFactor, viewsByClass, roadmap, sources, calls: callsOut, routingLog,
    contribByStrategy, stressByStrategy, scenarios, perfByStrategy, attribByStrategy, roleByClassSlug, classes,
    speedLimit: newest(speedLimit),
    modelSpeedLimit: newest(modelSpeed),
    rocBoard: newest(rocBoard),
    triggerHits: (trigHits || []).map(h => ({ ...h, rule_name: (trigRules || []).find(r => r.id === h.rule_id)?.name || null })) };
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
  const pages = { overview, models, markets, views: viewsPage, signals, agents, inbox, status, sources };
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

// ---------- Signals: the Speed Limit lights, the ROC board, and trigger hits ----------
const LIGHT_COLOR = { green: 'var(--pos)', yellow: 'var(--flat)', red: 'var(--neg)' };
const LIGHT_MEANING = { green: 'risk on', yellow: 'neutral', red: 'risk off' };

function lightDot(l, size = 14) {
  return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${l ? LIGHT_COLOR[l] : 'transparent'};border:${l ? 'none' : '2px solid var(--line)'};vertical-align:middle"></span>`;
}

function signals() {
  const sl = D.speedLimit || [];
  const master = sl.find(r => r.category === 'master');
  // Heaviest lens first: predictive at 60% should lead, not whatever order the rows arrived in.
  const cats = sl.filter(r => r.category !== 'master').sort((a, b) => (+b.weight || 0) - (+a.weight || 0));
  const board = D.rocBoard || [];
  const hits = D.triggerHits || [];
  const modelSL = D.modelSpeedLimit || [];
  const pc = (v, d = 1) => v === null || v === undefined ? '<span style="color:var(--muted)">–</span>'
    : `<span style="color:${v >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(v >= 0 ? '+' : '') + (+v * 100).toFixed(d)}%</span>`;

  const masterCard = !master ? '<div class="empty">No Speed Limit reading yet. Run jobs/compute-speed-limit.mjs.</div>' : `
   <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <div style="text-align:center">
     ${lightDot(master.light, 46)}
     <div style="margin-top:6px;font-size:22px;font-weight:700;color:${master.light ? LIGHT_COLOR[master.light] : 'var(--muted)'}">${esc(master.sign_label || '—')}</div>
     <div style="color:var(--muted);font-size:12px">${master.light ? esc(LIGHT_MEANING[master.light]) : 'no reading'}${master.score !== null ? ` · score ${(+master.score).toFixed(2)}` : ''}</div>
     ${master.target_beta_low !== null ? `<div style="color:var(--muted);font-size:12px">target beta ${master.target_beta_low}–${master.target_beta_high}×</div>` : ''}
    </div>
    <table style="flex:1;min-width:280px;margin:0"><thead><tr><th>Lens</th><th class="num">Weight</th><th class="num">Score</th><th>Light</th><th class="num">Calls</th></tr></thead><tbody>
    ${cats.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${(+c.weight * 100).toFixed(0)}%</td>
      <td class="num">${c.score === null ? '<span style="color:var(--muted)">–</span>' : (+c.score).toFixed(2)}</td>
      <td>${c.light ? `${lightDot(c.light, 10)} <span style="color:${LIGHT_COLOR[c.light]}">${esc(LIGHT_MEANING[c.light])}</span>` : '<span style="color:var(--muted)">no reading</span>'}</td>
      <td class="num">${c.n_calls}${c.n_recorded > c.n_calls ? ` <span style="color:var(--muted)">of ${c.n_recorded}</span>` : ''}</td></tr>`).join('')}
    </tbody></table>
   </div>
   <p class="note"><b>Draft rule.</b> The framework set the lens weights; the scoring rule was left open, so this is a proposal to argue with, not a settled measure. A lens scores the confidence-weighted mean direction of its open research calls — green above +0.33, red below −0.33 — and the master is the weighted mean over the lenses that actually have calls, so a silent lens abstains rather than counting as neutral. ${master && master.n_calls < 6 ? `<b>This reading rests on ${master.n_calls} scoring call${master.n_calls === 1 ? '' : 's'}</b>, which is far too few to lean on — treat it as the machinery working, not as a signal.` : ''} Only equities and commodities calls carry a sign: cash, gold and bond calls are counted but score zero, because bearish bonds can mean growth or inflation and the call itself does not say which.</p>`;

  const modelCard = !modelSL.length ? '' : `
   <div class="card" style="margin-bottom:14px"><h2>Each model against the Speed Limit</h2>
    <table><thead><tr><th>Model</th><th class="num">Actual beta</th><th class="num">R²</th><th class="num">Target</th><th>Light</th></tr></thead><tbody>
    ${modelSL.map(r => {
      const st = D.models.find(m => m.id === r.strategy_id);
      return `<tr title="${esc(r.note || '')}"><td><b>${esc(st?.name || '—')}</b></td>
       <td class="num">${r.actual_beta === null ? '–' : (+r.actual_beta).toFixed(2) + '×'}</td>
       <td class="num" style="color:${r.r_squared !== null && +r.r_squared < 0.5 ? 'var(--neg)' : 'var(--text)'}">${r.r_squared === null ? '–' : (+r.r_squared).toFixed(2)}</td>
       <td class="num">${r.target_low === null ? '–' : `${r.target_low}–${r.target_high}×`}</td>
       <td>${r.light ? `${lightDot(r.light, 10)} <span style="color:${LIGHT_COLOR[r.light]}">${esc(r.light)}</span>` : '<span class="chip">unrated</span>'}</td></tr>`;
    }).join('')}
    </tbody></table>
    <p class="note">Beta is measured against each model's peer benchmark by least squares over the last year. <b>Read R² first.</b> These models hold gold, commodities and alternatives their benchmark does not, which leaves a lot unexplained and drags the slope down — below 0.5 the beta is not describing risk posture, so the model is left <b>unrated</b> rather than shown red. Where the fit does hold, a model below its target band is positioned more defensively than the lights call for. Hover a row for the full reading.</p>
   </div>`;

  const boardCard = !board.length ? '' : `
   <div class="card" style="margin-bottom:14px"><h2>Rate of change · major markets</h2>
    <table><thead><tr><th>Market</th><th class="num">Close</th><th class="num">1D</th><th class="num">1W</th><th class="num">1M</th><th class="num">Vol</th><th class="num">Vol 1M</th><th class="num">Volume 1W</th></tr></thead><tbody>
    ${board.map(r => `<tr><td><b>${esc(r.label)}</b> <small style="color:var(--muted)">${esc(D.markets.find(m => m.id === r.security_id)?.ticker || '')}</small></td>
      <td class="num">${r.close === null ? '–' : (+r.close).toFixed(2)}</td>
      <td class="num">${pc(r.price_roc_1d)}</td><td class="num">${pc(r.price_roc_1w)}</td><td class="num">${pc(r.price_roc_1m)}</td>
      <td class="num">${r.vol_ann === null ? '–' : (+r.vol_ann * 100).toFixed(0) + '%'}</td>
      <td class="num">${pc(r.vol_roc_1m, 0)}</td>
      <td class="num">${r.volume_roc_1w === null ? '<span style="color:var(--muted)">n/r</span>' : pc(r.volume_roc_1w, 0)}</td></tr>`).join('')}
    </tbody></table>
    <p class="note">Change over 1, 5 and 21 trading bars — bars rather than calendar days, since a "week" in calendar days lands on a weekend a fifth of the time. Vol is 20-bar realised volatility annualised, and its 1M column is the change in that reading, not a price move. Volume compares the last 5 bars against the prior 5, because one day against one day is mostly noise; <span style="color:var(--muted)">n/r</span> means the security reports no volume, which is normal for a mutual fund.</p>
   </div>`;

  const byRule = {};
  for (const h of hits) (byRule[h.rule_name || 'Other'] ||= []).push(h);
  const hitsCard = `
   <div class="card"><h2>Triggers <span class="chip">${hits.length} recent</span></h2>
    ${!hits.length ? '<div class="empty">Nothing has fired recently. Run jobs/compute-triggers.mjs.</div>' : `
    <table><thead><tr><th>Date</th><th>What fired</th><th>Rule</th></tr></thead><tbody>
    ${hits.slice(0, 60).map(h => `<tr><td>${esc(h.as_of)}</td><td>${esc(h.headline)}</td><td><small style="color:var(--muted)">${esc(h.rule_name || '')}</small></td></tr>`).join('')}
    </tbody></table>`}
    <p class="note">A trigger fires on a CHANGE, not on a state: something bullish for months does not fire, the day it flips does. Rules live in the database and can be tuned without a deploy. None of these is a recommendation — the desk's standing position is that the technical layer is descriptive context, and the risk-range bands in particular use constants calibrated on the source spec's universe rather than ours.</p>
   </div>`;

  return `<span class="eyebrow">Gigantic Rocks</span><h1>Signals</h1>
   <p class="sub">The Speed Limit, the rate-of-change board, and what has crossed a line recently.</p>
   <div class="card" style="margin-bottom:14px"><h2>Master Speed Limit <span class="chip draft">draft scoring rule</span></h2>${masterCard}</div>
   ${modelCard}${boardCard}${hitsCard}`;
}

// ---------- Donut (asset roles, toggling to asset class) ----------
const ROLE_COLORS = { growth: 'var(--pos)', inflation: 'var(--warn)', liquidity: 'var(--accent)', unassigned: 'var(--muted)' };
const ROLE_LABEL = { growth: 'Growth assets', inflation: 'Inflation assets', liquidity: 'Liquidity assets', unassigned: 'Unassigned' };
let donutMode = 'role';   // 'role' | 'class'

// A donut as SVG arcs. Shares are normalised so the ring always closes, and a single 100% slice
// is drawn as a plain circle because an arc of exactly 360 degrees degenerates to a point.
function donutSvg(parts, size = 190) {
  const total = parts.reduce((s, p) => s + p.v, 0);
  if (!total) return '<div class="empty">Nothing to chart.</div>';
  const r = size / 2 - 6, cx = size / 2, cy = size / 2, hole = r * 0.62;
  const live = parts.filter(p => p.v > 0);
  let a0 = -Math.PI / 2, out = '';
  if (live.length === 1) {
    out = `<circle cx="${cx}" cy="${cy}" r="${(r + hole) / 2}" fill="none" stroke="${live[0].color}" stroke-width="${r - hole}"/>`;
  } else {
    for (const p of live) {
      const a1 = a0 + (p.v / total) * Math.PI * 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const hx1 = cx + hole * Math.cos(a1), hy1 = cy + hole * Math.sin(a1);
      const hx0 = cx + hole * Math.cos(a0), hy0 = cy + hole * Math.sin(a0);
      out += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${big} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${hx1.toFixed(1)},${hy1.toFixed(1)} A${hole},${hole} 0 ${big} 0 ${hx0.toFixed(1)},${hy0.toFixed(1)} Z" fill="${p.color}"><title>${esc(p.label)} ${pct(p.v / total)}</title></path>`;
      a0 = a1;
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block">${out}</svg>`;
}

function donutCard(m) {
  const byRole = {};
  for (const [slug, w] of m.byClass) {
    const role = D.roleByClassSlug?.[slug] || 'unassigned';
    byRole[role] = (byRole[role] || 0) + w;
  }
  const roleParts = ['growth', 'inflation', 'liquidity', 'unassigned']
    .filter(k => byRole[k]).map(k => ({ label: ROLE_LABEL[k], v: byRole[k], color: ROLE_COLORS[k] }));
  const classParts = m.byClass.map(([k, v]) => ({ label: D.classNames[k] || k, v, color: CLASS_COLORS[k] || '#888' }));
  const parts = donutMode === 'role' ? roleParts : classParts;
  const total = parts.reduce((s, p) => s + p.v, 0);
  const tab = (k, label) => `<span class="click" data-donut="${k}" style="cursor:pointer;padding:3px 9px;border-radius:6px;font-size:12px;background:${donutMode === k ? 'var(--panel2)' : 'transparent'};color:${donutMode === k ? 'var(--text)' : 'var(--muted)'}">${label}</span>`;

  return `<div class="card" style="margin-bottom:14px">
   <h2>Where the allocation sits <span class="chip draft">draft roles</span></h2>
   <div style="margin-bottom:10px">${tab('role', 'By role')}${tab('class', 'By asset class')}</div>
   <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    ${donutSvg(parts)}
    <div style="flex:1;min-width:190px">
     <table style="margin:0"><tbody>
      ${parts.map(p => `<tr><td style="padding:3px 0"><b style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${p.color};margin-right:7px"></b>${esc(p.label)}</td><td class="num">${pct(p.v / total)}</td></tr>`).join('')}
     </tbody></table>
    </div>
   </div>
   <p class="note">${donutMode === 'role'
     ? 'Every holding is assigned one primary role and the shares total 100%. This is <b>not</b> the net factor exposure above it: that is signed and sums to nothing, this is a share of allocation. A model can sit 25% in the inflation bucket and still read net short inflation, and both are true. Roles are a draft — gold is placed in inflation per the owner, and bonds sit with cash as the risk-off budget, which is the one worth confirming since it moves more of this chart than any other single decision.'
     : 'Share of allocation by asset class. Classified by behaviour rather than prospectus label, which is why high-yield credit and REITs sit in equities.'}</p>
  </div>`;
}

// ---------- Contribution and attribution ----------
let perfPeriod = '1Y';
const PERIODS = ['1M', '3M', '6M', 'YTD', '1Y'];

function perfCard(m) {
  const rows = (D.perfByStrategy?.[m.id] || []);
  if (!rows.length) return '';
  const p = rows.find(r => r.period === perfPeriod) || rows[0];
  const attrib = (D.attribByStrategy?.[m.id] || []).filter(r => r.period === p.period);
  const clsName = id => (D.classes || []).find(c => c.id === id) || {};
  const n = v => v === null || v === undefined ? null : +v;
  const pc = (v, d = 2) => v === null ? '<span style="color:var(--muted)">–</span>'
    : `<span style="color:${v >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(v >= 0 ? '+' : '') + (v * 100).toFixed(d)}%</span>`;

  const pr = n(p.portfolio_return), peer = n(p.peer_benchmark_return), pol = n(p.policy_benchmark_return);
  const vsPeer = pr !== null && peer !== null ? pr - peer : null;
  const vsPolicy = pr !== null && pol !== null ? pr - pol : null;

  const sum = k => attrib.filter(r => r.attributable).reduce((s, r) => s + (n(r[k]) || 0), 0);
  const alloc = sum('allocation_effect'), sel = sum('selection_effect'), inter = sum('interaction_effect');
  const unattrib = attrib.filter(r => !r.attributable);
  const unattribW = unattrib.reduce((s, r) => s + (n(r.w_portfolio) || 0), 0);
  const residual = vsPolicy === null ? null : vsPolicy - (alloc + sel + inter);

  const tab = k => `<span class="click" data-period="${k}" style="cursor:pointer;padding:3px 9px;border-radius:6px;font-size:12px;background:${perfPeriod === k ? 'var(--panel2)' : 'transparent'};color:${perfPeriod === k ? 'var(--text)' : 'var(--muted)'}">${k}</span>`;

  const contribRows = attrib.slice().sort((a, b) => (n(b.contribution) || 0) - (n(a.contribution) || 0));
  const maxAbsContrib = Math.max(...contribRows.map(r => Math.abs(n(r.contribution) || 0)), 1e-9);
  const bar = (v, max, color) => {
    const w = Math.min(Math.abs(v) / max, 1) * 46;
    return `<span style="display:inline-block;width:100px;vertical-align:middle"><span style="display:inline-block;width:50%;text-align:right">${v < 0 ? `<i style="display:inline-block;height:9px;width:${w}%;background:${color};opacity:.75"></i>` : ''}</span><span style="display:inline-block;width:50%">${v >= 0 ? `<i style="display:inline-block;height:9px;width:${w}%;background:${color};opacity:.75"></i>` : ''}</span></span>`;
  };

  return `<div class="card" style="margin-bottom:14px">
   <h2>Returns, contribution and attribution</h2>
   <div style="margin-bottom:10px">${PERIODS.map(tab).join('')}</div>
   <p class="sub" style="margin-top:0">${esc(p.start_date)} to ${esc(p.end_date)}${n(p.coverage) !== null && n(p.coverage) < 0.999 ? ` · ${(n(p.coverage) * 100).toFixed(0)}% of weight priced` : ''}</p>

   <div class="kpis" style="margin-bottom:12px">
    <div class="card kpi"><span class="eyebrow">Model</span><b>${pc(pr)}</b><small>target allocation</small></div>
    <div class="card kpi"><span class="eyebrow">Peer benchmark</span><b>${pc(peer)}</b><small>vs model ${vsPeer === null ? '–' : ((vsPeer >= 0 ? '+' : '') + (vsPeer * 100).toFixed(2) + '%')}</small></div>
    <div class="card kpi"><span class="eyebrow">Policy benchmark</span><b>${pc(pol)}</b><small>vs model ${vsPolicy === null ? '–' : ((vsPolicy >= 0 ? '+' : '') + (vsPolicy * 100).toFixed(2) + '%')}</small></div>
    <div class="card kpi"><span class="eyebrow">Max drawdown</span><b>${pc(n(p.max_drawdown))}</b><small>peer ${n(p.peer_max_drawdown) === null ? '–' : (n(p.peer_max_drawdown) * 100).toFixed(1) + '%'}</small></div>
   </div>

   <h2 style="font-size:13px;margin-top:16px">Contribution — where the return came from</h2>
   <table><thead><tr><th>Asset class</th><th class="num">Weight</th><th class="num">Return</th><th class="num">Contribution</th><th></th></tr></thead><tbody>
   ${contribRows.map(r => {
     const c = n(r.contribution);
     return `<tr><td>${esc(clsName(r.asset_class_id).name || '—')}</td>
      <td class="num">${(n(r.w_portfolio) * 100).toFixed(1)}%</td>
      <td class="num">${pc(n(r.r_portfolio))}</td>
      <td class="num">${pc(c)}</td>
      <td>${bar(c, maxAbsContrib, c >= 0 ? 'var(--pos)' : 'var(--neg)')}</td></tr>`;
   }).join('')}
   <tr style="border-top:2px solid var(--line)"><td><b>Total</b></td><td class="num"></td><td class="num"></td><td class="num"><b>${pc(pr)}</b></td><td></td></tr>
   </tbody></table>
   <p class="note">Weight times return, per asset class. These sum to the model's return by construction — it is a decomposition, not an estimate. No benchmark is involved.</p>

   <h2 style="font-size:13px;margin-top:18px">Attribution — why it differed from the policy benchmark</h2>
   <table><thead><tr><th>Asset class</th><th class="num">Model wt</th><th class="num">Bench wt</th><th class="num">O/U</th><th class="num">Model ret</th><th class="num">Bench ret</th><th class="num">Allocation</th><th class="num">Selection</th></tr></thead><tbody>
   ${attrib.slice().sort((a, b) => Math.abs((n(b.allocation_effect) || 0) + (n(b.selection_effect) || 0)) - Math.abs((n(a.allocation_effect) || 0) + (n(a.selection_effect) || 0))).map(r => {
     const ou = (n(r.w_portfolio) || 0) - (n(r.w_benchmark) || 0);
     return `<tr${r.attributable ? '' : ' style="opacity:.55"'}><td>${esc(clsName(r.asset_class_id).name || '—')}</td>
      <td class="num">${(n(r.w_portfolio) * 100).toFixed(1)}%</td>
      <td class="num">${(n(r.w_benchmark) * 100).toFixed(1)}%</td>
      <td class="num" style="color:${ou > 0.0005 ? 'var(--pos)' : ou < -0.0005 ? 'var(--neg)' : 'var(--muted)'}">${(ou >= 0 ? '+' : '') + (ou * 100).toFixed(1)}%</td>
      <td class="num">${pc(n(r.r_portfolio))}</td>
      <td class="num">${pc(n(r.r_benchmark))}</td>
      <td class="num">${r.attributable ? pc(n(r.allocation_effect)) : '<span style="color:var(--muted)">n/a</span>'}</td>
      <td class="num">${r.attributable ? pc(n(r.selection_effect)) : '<span style="color:var(--muted)">n/a</span>'}</td></tr>`;
   }).join('')}
   </tbody></table>
   <div class="kpis" style="margin-top:10px">
    <div class="card kpi"><span class="eyebrow">Allocation effect</span><b>${pc(alloc)}</b><small>over/underweighting</small></div>
    <div class="card kpi"><span class="eyebrow">Selection effect</span><b>${pc(sel)}</b><small>holdings vs their index</small></div>
    <div class="card kpi"><span class="eyebrow">Interaction</span><b>${pc(inter)}</b><small>the cross term</small></div>
    <div class="card kpi"><span class="eyebrow">Excess vs policy</span><b>${pc(vsPolicy)}</b><small>${residual !== null && Math.abs(residual) > 0.0001 ? `incl. ${((residual) * 100).toFixed(2)}% unattributable` : 'fully attributed'}</small></div>
   </div>
   <p class="note"><b>Allocation</b> is what holding a different weight than the benchmark earned: (model weight − benchmark weight) × (that class's index return − the benchmark's total return). Measured against the total on purpose (Brinson-Fachler), so overweighting a class that merely rose earns nothing unless it beat the benchmark overall. <b>Selection</b> is what the holdings inside a class did against that class's index: benchmark weight × (model's return in the class − the index's). <b>Interaction</b> is the cross term, shown rather than quietly folded into selection.
   This runs against the <b>policy</b> benchmark — the model's own stated stock/bond split built from index proxies — not the peer benchmark, because a LifeStrategy fund gives a total return and not its composition, and Brinson needs both. That makes this the more telling comparison anyway: the policy benchmark is the plain stocks-and-bonds portfolio the framework calls structurally short inflation, so the allocation effect is what diversifying away from it has actually earned.${unattribW > 0.0005 ? ` ${(unattribW * 100).toFixed(0)}% of the model sits in classes with no honest index proxy (alternatives); that share is shown greyed and left out of the effects rather than forced into them.` : ''}</p>
  </div>`;
}

const VERDICT = {
  earns_place: { label: 'earns place', cls: 'flat' },
  diversifier: { label: 'diversifier', cls: 'long' },
  review:      { label: 'review',      cls: 'short' },
  redundant:   { label: 'redundant',   cls: 'short' },
  no_data:     { label: 'no data',     cls: '' },
};

// "If inflation rises and liquidity becomes scarce, how does your allocation remain resilient?"
// Two readings, deliberately shown side by side because they can disagree and the disagreement
// is informative: the score is the framework's own forward-looking lens, the replay is what
// today's weights actually did in the historical stretches that matched the scenario.
function stressCard(m) {
  const rows = D.stressByStrategy?.[m.id] || [];
  if (!rows.length) return '';
  const byId = Object.fromEntries((D.scenarios || []).map(s => [s.id, s]));
  const pctv = x => x === null || x === undefined ? '<span style="color:var(--muted)">–</span>'
    : `<span style="color:${x >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(x >= 0 ? '+' : '') + (x * 100).toFixed(1)}%</span>`;
  return `<div class="card" style="margin-bottom:14px"><h2>Stress scenarios</h2>
   <table><thead><tr><th>Scenario</th><th class="num">Exposure score</th><th class="num">Replay mean</th><th class="num">Worst</th><th class="num">Windows</th></tr></thead><tbody>
   ${rows.slice().sort((a, b) => (byId[a.scenario_id]?.name || '').localeCompare(byId[b.scenario_id]?.name || '')).map(r => {
     const sc = byId[r.scenario_id] || {};
     const s = r.factor_score === null ? null : +r.factor_score;
     return `<tr><td><b>${esc(sc.name || '—')}</b><br><small style="color:var(--muted)">${esc(sc.description || '')}</small></td>
      <td class="num"><span class="cell" style="${heat(s === null ? 0 : Math.max(-1, Math.min(1, s)))}">${s === null ? '–' : sgn(s)}</span></td>
      <td class="num">${pctv(r.mean_return === null ? null : +r.mean_return)}</td>
      <td class="num">${pctv(r.worst_return === null ? null : +r.worst_return)}</td>
      <td class="num">${r.n_windows || 0}${r.replay_coverage ? `<br><small style="color:var(--muted)">≥${(+r.replay_coverage * 100).toFixed(0)}% covered</small>` : ''}</td></tr>`;
   }).join('')}
   </tbody></table>
   <p class="note">The exposure score is this model's net growth/inflation/liquidity exposure read against the scenario's shock. It is a <b>directional score, not a predicted return</b> — negative means the model is positioned against the scenario. The replay is measured in real returns: what today's weights would have done across the historical stretches where that macro rule actually held, found from the data rather than chosen by hand. Windows covering under 60% of today's holdings are excluded, which is why the 2020 growth shock drops out — most of this book did not exist yet. A small number of recent windows is a hint, not a distribution, and the two columns can disagree.</p></div>`;
}

function earnsPlaceCard(m) {
  const rows = D.contribByStrategy?.[m.id] || [];
  if (!rows.length) return '';
  const measured = rows.filter(r => r.risk_share !== null).sort((a, b) => +b.risk_share - +a.risk_share);
  if (!measured.length) return '';
  const top3 = measured.slice(0, 3);
  const top3Risk = top3.reduce((s, r) => s + +r.risk_share, 0), top3Wt = top3.reduce((s, r) => s + +r.weight, 0);
  return `<div class="card" style="margin-bottom:14px"><h2>Does every position earn its place?</h2>
   <p class="sub" style="margin-top:-4px">Top 3 by risk — ${top3.map(r => esc(r.ticker)).join(', ')} — carry <b>${(top3Risk * 100).toFixed(0)}%</b> of this model's risk on <b>${(top3Wt * 100).toFixed(0)}%</b> of its weight.</p>
   <table><thead><tr><th>Holding</th><th class="num">Weight</th><th class="num">Risk share</th><th class="num">Ratio</th><th class="num">Corr to rest</th><th>Verdict</th></tr></thead><tbody>
   ${measured.map(r => {
     const v = VERDICT[r.verdict] || VERDICT.no_data;
     return `<tr title="${esc(r.rationale || '')}"><td><b>${esc(r.ticker)}</b></td>
      <td class="num">${(+r.weight * 100).toFixed(1)}%</td>
      <td class="num">${(+r.risk_share * 100).toFixed(1)}%</td>
      <td class="num" style="color:${+r.risk_ratio >= 2 ? 'var(--neg)' : +r.risk_ratio <= 0.85 ? 'var(--pos)' : 'var(--text)'}">${(+r.risk_ratio).toFixed(2)}×</td>
      <td class="num">${r.corr_to_rest === null ? '–' : (+r.corr_to_rest).toFixed(2)}</td>
      <td><span class="chip ${v.cls}">${v.label}</span></td></tr>`;
   }).join('')}
   ${rows.filter(r => r.risk_share === null).map(r => `<tr><td><b>${esc(r.ticker)}</b></td><td class="num">${(+r.weight * 100).toFixed(1)}%</td><td class="num" colspan="3" style="color:var(--muted)">not enough price history</td><td><span class="chip">no data</span></td></tr>`).join('')}
   </tbody></table>
   <p class="note">Risk share is each holding's marginal contribution to the model's volatility; the shares sum to 100%, so they compare directly against weight. Ratio above 1 means a position consumes more of the model's risk than its size suggests — which is not a criticism (equity risk in a growth model <i>should</i> outrun its weight), it is the prompt to say out loud what the position is for. "Review" marks 2× or more. Hover a row for the full reasoning. Measured on volatility and correlation only: it says nothing about drawdown shape, tail behaviour, liquidity or tax, any of which can be the real reason a holding is there.</p></div>`;
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
   ${donutCard(m)}
   ${perfCard(m)}
   ${stressCard(m)}
   ${earnsPlaceCard(m)}
   <div class="card"><h2>Holdings <span class="chip draft">draft loadings</span></h2><table><thead><tr><th>Holding</th><th>Class</th><th class="num">Weight</th>${D.factors.map(f => `<th class="num">${esc(f.slug[0].toUpperCase())}</th>`).join('')}</tr></thead><tbody>
   ${m.holdings.map(h => `<tr><td><b>${esc(h.ticker)}</b><br><small style="color:var(--muted)">${esc(h.name)}</small></td><td>${esc(D.classNames[h.cls] || h.cls)}</td><td class="num">${pct(h.weight)}</td>
    ${h.loading ? h.loading.map(v => v === null ? '<td class="num" style="color:var(--muted)">–</td>' : `<td class="num" style="color:${v > 0 ? 'var(--pos)' : v < 0 ? 'var(--neg)' : 'var(--muted)'}">${sgn(v)}</td>`).join('') : `<td class="num" colspan="${D.factors.length}" style="color:var(--muted)">not scored</td>`}</tr>`).join('')}
   </tbody></table><p class="note">G = growth, I = inflation, L = cost of liquidity. Subjective loadings; overrides are drafts.</p></div>`;
  $('#drawer').hidden = false; $('#scrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

// ---------- Chart (hand-rolled SVG: price, Layer 2 overlays, RSI panel) ----------
//
// Everything drawn here is descriptive. The desk's standing position is that none of it drives
// an allocation call — the source build spec measured TD Sequential, the T/B/R markers and the
// track line as weak-or-nothing predictors in its own backtests, and they are drawn because the
// owner reads them, not because we have evidence they work. The risk-range constants are the
// spec's, calibrated on its universe rather than ours, so those bands are indicative.
function linePath(vals, x, y) {
  let d = '', started = false;
  vals.forEach((v, i) => {
    if (v === null || v === undefined) { started = false; return; }
    d += (started ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
    started = true;
  });
  return d.trim();
}
// Filled area between two series, for the risk-range bands. Breaks the band wherever either
// edge is missing, so a warm-up period at the left of the chart doesn't get a bogus fill.
function bandPath(lo, hi, x, y) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length < 2) { run = []; return; }
    d += 'M' + run.map(i => `${x(i).toFixed(1)},${y(hi[i]).toFixed(1)}`).join('L');
    d += 'L' + run.slice().reverse().map(i => `${x(i).toFixed(1)},${y(lo[i]).toFixed(1)}`).join('L') + 'Z ';
    run = [];
  };
  for (let i = 0; i < lo.length; i++) {
    if (lo[i] == null || hi[i] == null) flush(); else run.push(i);
  }
  flush();
  return d.trim();
}
// The track line is one line whose colour changes with track_state, so it has to be drawn as
// separate paths. Each segment carries the first point of the next one, otherwise the colour
// changes leave a one-bar gap in the line.
function stateSegments(vals, states, colors) {
  const segs = [];
  let cur = null;
  for (let i = 0; i < vals.length; i++) {
    const st = states[i] || 'neutral';
    if (!cur || cur.state !== st) {
      if (cur) { cur.vals[i] = vals[i]; segs.push(cur); }
      cur = { state: st, color: colors[st] || colors.neutral, vals: new Array(vals.length).fill(null) };
    }
    cur.vals[i] = vals[i];
  }
  if (cur) segs.push(cur);
  return segs;
}
const TRACK_COLORS = { bullish: 'var(--pos)', bearish: 'var(--neg)', neutral: 'var(--muted)' };

// opts: { series, bands, hlines, markers }. A bare array is accepted as shorthand for just
// series — the exposure and macro charts only ever draw lines, and silently rendering them as
// "no history" because they passed the older shape is a worse failure than accepting both.
function priceChartSvg(dates, opts, W, H) {
  const { series = [], bands = [], hlines = [], markers = [] } = Array.isArray(opts) ? { series: opts } : (opts || {});
  const pad = { l: 46, r: 46, t: 10, b: 16 };
  // The scale comes from the plotted series and bands only. Horizontal levels deliberately do
  // NOT get a vote: a support level well below anything in the window would compress the price
  // action into a sliver to make room for a line. Levels outside the resulting range are simply
  // not drawn — they're real, but they belong to a longer window than this chart shows.
  const scaleVals = [
    ...series.flatMap(s => s.vals),
    ...bands.flatMap(b => [...b.lo, ...b.hi]),
  ].filter(v => v !== null && v !== undefined && Number.isFinite(v));
  if (!scaleVals.length) return '<div class="empty">No history to chart.</div>';
  const lo = Math.min(...scaleVals), hi = Math.max(...scaleVals);
  const padY = (hi - lo) * 0.06 || 1;          // headroom so markers near the extremes stay legible
  const min = lo - padY, max = hi + padY, span = (max - min) || 1;
  const drawn = hlines.filter(h => Number.isFinite(h.v) && h.v >= min && h.v <= max);
  const x = i => pad.l + (i / Math.max(1, dates.length - 1)) * (W - pad.l - pad.r);
  const y = v => H - pad.b - ((v - min) / span) * (H - pad.t - pad.b);
  const dp = max < 10 ? 3 : 2;
  const gridY = [0, 0.25, 0.5, 0.75, 1].map(f => min + f * span);

  // Markers are placed a fixed fraction of the pane away from the bar so they never sit on it.
  const off = (H - pad.t - pad.b) * 0.05;
  const markerSvg = markers.map(m => {
    const px = x(m.i), py = y(m.v) + (m.place === 'below' ? off + 8 : -off);
    return `<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" font-size="${m.size || 10}" font-weight="700"
      fill="${m.color}" text-anchor="middle">${esc(m.text)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block" role="img">
    ${gridY.map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
      <text x="2" y="${(y(v) + 3).toFixed(1)}" font-size="9" fill="var(--muted)">${v.toFixed(dp)}</text>`).join('')}
    ${bands.map(b => `<path d="${bandPath(b.lo, b.hi, x, y)}" fill="${b.color}" fill-opacity="${b.opacity ?? 0.13}" stroke="none"/>`).join('')}
    ${drawn.map(h => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(h.v).toFixed(1)}" y2="${y(h.v).toFixed(1)}"
      stroke="${h.color}" stroke-width="1" stroke-dasharray="${h.dash || '5,4'}" opacity="0.85"/>
      <text x="${W - pad.r + 3}" y="${(y(h.v) + 3).toFixed(1)}" font-size="9" fill="${h.color}">${esc(h.label)}</text>`).join('')}
    ${series.map(s => `<path d="${linePath(s.vals, x, y)}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.5}"
      ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} ${s.opacity ? `opacity="${s.opacity}"` : ''} stroke-linejoin="round"/>`).join('')}
    ${markerSvg}
    <text x="${pad.l}" y="${H - 3}" font-size="9" fill="var(--muted)">${esc(dates[0] || '')}</text>
    <text x="${W - pad.r}" y="${H - 3}" font-size="9" fill="var(--muted)" text-anchor="end">${esc(dates.at(-1) || '')}</text>
  </svg>`;
}

// RSI with its 9-day signal line and the Cardwell/Brown regime bands. The regime is what makes
// the 40 and 60 lines matter: in a bull regime RSI tends to hold 40 on pullbacks and run to 80,
// in a bear regime it tends to cap near 60 and reach 20. The strip along the bottom shows which
// regime each bar was in, because the regime changes across the window.
function rsiChartSvg(dates, rsi, signal, regimes, W, H) {
  const pad = { l: 46, r: 46, t: 8, b: 14 };
  const x = i => pad.l + (i / Math.max(1, dates.length - 1)) * (W - pad.l - pad.r);
  const y = v => H - pad.b - (v / 100) * (H - pad.t - pad.b);
  const REG = { bull: 'var(--pos)', bear: 'var(--neg)', neutral: 'var(--muted)' };
  const step = (W - pad.l - pad.r) / Math.max(1, dates.length - 1);
  const strip = (regimes || []).map((r, i) => r && r !== 'neutral'
    ? `<rect x="${x(i).toFixed(1)}" y="${(H - pad.b + 1).toFixed(1)}" width="${Math.max(step, 1).toFixed(2)}" height="4"
        fill="${REG[r]}" fill-opacity="0.75"/>` : '').join('');
  const gl = (v, color, dash, op) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"
      stroke="${color}" stroke-width="1" stroke-dasharray="${dash}" opacity="${op}"/>
    <text x="2" y="${(y(v) + 3).toFixed(1)}" font-size="9" fill="var(--muted)">${v}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block" role="img">
    ${gl(70, 'var(--neg)', '3,3', 0.9)}${gl(60, 'var(--muted)', '2,4', 0.5)}
    ${gl(40, 'var(--muted)', '2,4', 0.5)}${gl(30, 'var(--pos)', '3,3', 0.9)}
    ${strip}
    <path d="${linePath(signal, x, y)}" fill="none" stroke="var(--flat)" stroke-width="1" opacity="0.9"/>
    <path d="${linePath(rsi, x, y)}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  </svg>`;
}

// Layers are toggleable because all of them at once on 300 bars is unreadable, and because the
// ones that are off by default (anchored VWAP, the wider trend range) are the ones the owner
// asked for occasionally rather than always. Defaults are what's useful at a glance.
const CHART_LAYERS = [
  { key: 'ma',    label: 'SMA 50 / 200',   on: true },
  { key: 'track', label: 'Track line',     on: true },
  { key: 'rr',    label: 'Risk range',     on: true },
  { key: 'sr',    label: 'Support / res.', on: true },
  { key: 'td',    label: 'TD Sequential',  on: true },
  { key: 'tbr',   label: 'T / B / R',      on: true },
  { key: 'avwap', label: 'Anchored VWAP',  on: false },
  { key: 'trend', label: 'Trend range',    on: false },
];
const TECH_HISTORY_COLS = ['as_of', 'close', 'sma50', 'sma200', 'ema26', 'track_state', 'atr14',
  'rsi14', 'rsi_signal', 'rsi_regime', 'td_setup_buy', 'td_setup_sell', 'td_countdown_buy',
  'td_countdown_sell', 'marker', 'avwap_52w_low', 'avwap_ytd', 'rr_trade_low', 'rr_trade_high',
  'rr_trend_low', 'rr_trend_high', 'support', 'resistance'].join(',');

let chartCtx = null;   // { row, hist, dates, layers:Set } — kept so a toggle can re-render without refetching

// Returns null for anything that isn't a finite number, so a NaN can never reach an SVG
// coordinate. Postgres numerics arrive as strings, and some columns (support/resistance) are
// JSON arrays — coercing one of those with + yields NaN, which silently renders y="NaN".
function num(v) { const n = v === null || v === undefined ? NaN : +v; return Number.isFinite(n) ? n : null; }

function renderChart() {
  if (!chartCtx) return;
  const { row, hist, dates, layers } = chartCtx;
  const t = row.tech, last = hist.at(-1);
  const close = hist.map(h => num(h.close));

  const series = [];
  const bands = [];
  const hlines = [];
  const markers = [];

  if (layers.has('rr')) {
    bands.push({ lo: hist.map(h => num(h.rr_trade_low)), hi: hist.map(h => num(h.rr_trade_high)), color: 'var(--accent)', opacity: 0.16 });
  }
  if (layers.has('trend')) {
    bands.push({ lo: hist.map(h => num(h.rr_trend_low)), hi: hist.map(h => num(h.rr_trend_high)), color: 'var(--flat)', opacity: 0.10 });
  }
  if (layers.has('ma')) {
    series.push({ vals: hist.map(h => num(h.sma50)), color: 'var(--accent)', dash: '4,3', width: 1.2, opacity: 0.9 });
    series.push({ vals: hist.map(h => num(h.sma200)), color: 'var(--flat)', dash: '4,3', width: 1.2, opacity: 0.9 });
  }
  if (layers.has('avwap')) {
    series.push({ vals: hist.map(h => num(h.avwap_52w_low)), color: 'var(--pos)', dash: '1,3', width: 1.2, opacity: 0.85 });
    series.push({ vals: hist.map(h => num(h.avwap_ytd)), color: 'var(--warn)', dash: '1,3', width: 1.2, opacity: 0.85 });
  }
  if (layers.has('track')) {
    for (const seg of stateSegments(hist.map(h => num(h.ema26)), hist.map(h => h.track_state), TRACK_COLORS)) {
      series.push({ vals: seg.vals, color: seg.color, width: 2 });
    }
  }
  series.push({ vals: close, color: 'var(--text)', width: 1.75 });

  if (layers.has('sr')) {
    // support/resistance are arrays of pivots, [{level, touches}]. A level the price has turned
    // at repeatedly is the one worth seeing, so rank by touches, keep the top few, and draw the
    // well-tested ones more solidly than the single-touch ones.
    const pivots = (arr, color, tag) => (Array.isArray(arr) ? arr : [])
      .map(p => ({ v: num(p && p.level), touches: (p && p.touches) || 1 }))
      .filter(p => p.v !== null)
      .sort((a, b) => b.touches - a.touches).slice(0, 3)
      .forEach(p => hlines.push({ v: p.v, color, label: tag + (p.touches > 1 ? '·' + p.touches : ''), dash: p.touches >= 3 ? '7,3' : '2,4' }));
    pivots(last.support, 'var(--pos)', 'S');
    pivots(last.resistance, 'var(--neg)', 'R');
  }
  if (layers.has('td')) {
    hist.forEach((h, i) => {
      if (h.td_countdown_buy === 13) markers.push({ i, v: close[i], text: '13', color: 'var(--pos)', place: 'below', size: 11 });
      else if (h.td_setup_buy === 9) markers.push({ i, v: close[i], text: '9', color: 'var(--pos)', place: 'below' });
      if (h.td_countdown_sell === 13) markers.push({ i, v: close[i], text: '13', color: 'var(--neg)', place: 'above', size: 11 });
      else if (h.td_setup_sell === 9) markers.push({ i, v: close[i], text: '9', color: 'var(--neg)', place: 'above' });
    });
  }
  if (layers.has('tbr')) {
    hist.forEach((h, i) => {
      if (h.marker === 'T') markers.push({ i, v: close[i], text: 'T', color: 'var(--neg)', place: 'above', size: 11 });
      if (h.marker === 'B') markers.push({ i, v: close[i], text: 'B', color: 'var(--pos)', place: 'below', size: 11 });
      if (h.marker === 'R') markers.push({ i, v: close[i], text: 'R', color: 'var(--accent)', place: 'below', size: 11 });
    });
  }

  const rrChip = (lab, lo, hi, pos, dir) => {
    if (num(lo) == null || num(hi) == null) return '';
    const col = dir === 'bullish' ? 'var(--pos)' : dir === 'bearish' ? 'var(--neg)' : 'var(--muted)';
    return `<div class="card kpi"><span class="eyebrow">${lab} range</span>
      <b style="font-size:15px">${num(lo).toFixed(2)} – ${num(hi).toFixed(2)}</b>
      <small style="color:${col}">${pos != null ? (num(pos) * 100).toFixed(0) + '% of range' : ''}${dir ? ' · ' + esc(dir) : ''}</small></div>`;
  };
  const regimeLabel = { bull: 'Bull regime', bear: 'Bear regime', neutral: 'No regime' }[last.rsi_regime] || 'No regime';
  const regimeColor = last.rsi_regime === 'bull' ? 'var(--pos)' : last.rsi_regime === 'bear' ? 'var(--neg)' : 'var(--muted)';
  const tdNow = last.td_setup_buy ? `Buy setup ${last.td_setup_buy}` : last.td_setup_sell ? `Sell setup ${last.td_setup_sell}`
    : last.td_countdown_buy ? `Buy countdown ${last.td_countdown_buy}` : last.td_countdown_sell ? `Sell countdown ${last.td_countdown_sell}` : '—';

  $('#drawer').innerHTML = `<button class="close" data-go="#markets">Close</button>
   <span class="eyebrow">${esc(D.classNames[row.cls] || row.cls)}</span><h1>${esc(row.ticker)}</h1>
   <p class="sub">${esc(row.name)} · ${dates.length} trading days shown, through ${esc(dates.at(-1))}</p>
   <div class="kpis">
    <div class="card kpi"><span class="eyebrow">Close</span><b>${row.price ? '$' + Number(row.price.close).toFixed(2) : '—'}</b><small>${row.price ? esc(row.price.as_of) : ''}</small></div>
    <div class="card kpi"><span class="eyebrow">RSI14</span><b style="color:${t?.rsi14 >= 70 ? 'var(--neg)' : t?.rsi14 <= 30 ? 'var(--pos)' : 'var(--text)'}">${t?.rsi14 != null ? t.rsi14.toFixed(1) : '—'}</b><small style="color:${regimeColor}">${esc(regimeLabel)}</small></div>
    <div class="card kpi"><span class="eyebrow">Trend</span><b style="font-size:16px">${trendChip(t?.trend_state)}</b><small>close vs SMA50/200</small></div>
    <div class="card kpi"><span class="eyebrow">Track line</span><b style="font-size:15px;color:${TRACK_COLORS[last.track_state] || 'var(--muted)'}">${esc(last.track_state || 'neutral')}</b><small>EMA26, 2-close confirm</small></div>
    <div class="card kpi"><span class="eyebrow">TD Sequential</span><b style="font-size:15px">${esc(tdNow)}</b><small>DeMark count</small></div>
    ${rrChip('Trade', last.rr_trade_low, last.rr_trade_high, last.rr_trade_pos, last.rr_trade_dir)}
   </div>
   <div class="card" style="margin-bottom:10px">
    <h2>Price</h2>
    <div class="legend" style="margin:0 0 8px">
      ${CHART_LAYERS.map(l => `<span class="click layer-toggle" data-layer="${l.key}" style="cursor:pointer;opacity:${layers.has(l.key) ? 1 : 0.4}">
        <b style="background:${layers.has(l.key) ? 'var(--accent)' : 'var(--muted)'}"></b>${esc(l.label)}</span>`).join('')}
    </div>
    ${priceChartSvg(dates, { series, bands, hlines, markers }, 560, 300)}
    <p class="note">Track line is EMA26, coloured by state — it only flips after two consecutive closes more than 1.5 ATR beyond the line, so it lags deliberately. Shaded band is the trade-duration risk range. 9 and 13 are TD Sequential setup and countdown completions; T, B and R are top, bottom and reversal markers.</p>
   </div>
   <div class="card"><h2>RSI14 · signal line and regime</h2>
    ${rsiChartSvg(dates, hist.map(h => num(h.rsi14)), hist.map(h => num(h.rsi_signal)), hist.map(h => h.rsi_regime), 560, 160)}
    <div class="legend" style="margin-top:8px"><span><b style="background:var(--accent)"></b>RSI14</span><span><b style="background:var(--flat)"></b>Signal (9)</span><span><b style="background:var(--pos)"></b>Bull regime</span><span><b style="background:var(--neg)"></b>Bear regime</span></div>
    <p class="note">The strip under the axis marks the regime bar by bar. Regime is the Cardwell/Brown reading over 60 bars: in a bull regime RSI tends to hold 40 on pullbacks and reach 80, in a bear regime to cap near 60 and reach 20 — which is why 30/70 alone can mislead in a strong trend. Descriptive context only; none of this drives an allocation call.</p></div>`;
}

async function openChart(securityId) {
  const row = D.markets.find(m => m.id === securityId); if (!row) return;
  $('#drawer').innerHTML = `<button class="close" data-go="#markets">Close</button>
   <span class="eyebrow">${esc(D.classNames[row.cls] || row.cls)}</span><h1>${esc(row.ticker)}</h1>
   <p class="sub">${esc(row.name)}</p><div class="empty">Loading chart…</div>`;
  $('#drawer').hidden = false; $('#scrim').hidden = false;

  let hist;
  try {
    hist = await q(sb.from('technical_snapshots').select(TECH_HISTORY_COLS)
      .eq('security_id', securityId).order('as_of', { ascending: false }).limit(300));
    hist.reverse();
  } catch (ex) {
    $('#drawer').querySelector('.empty').textContent = `Could not load history: ${ex.message}`;
    return;
  }
  if (!hist.length) { $('#drawer').querySelector('.empty').textContent = 'No technical history for this security yet.'; return; }

  // Keep the layer choice across securities within a session — flipping between tickers with the
  // same overlays on is the whole point of having the toggles.
  const layers = chartCtx ? chartCtx.layers : new Set(CHART_LAYERS.filter(l => l.on).map(l => l.key));
  chartCtx = { row, hist, dates: hist.map(h => h.as_of), layers };
  renderChart();
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
    // PostgREST caps a response at 1000 rows whatever limit is asked for, so this has to be
    // ordered NEWEST first and reversed. Ordered oldest-first it silently returned the first 1000
    // rows and stopped: once macro history was backfilled to 2015, every daily series (DGS10,
    // VIXCLS, T10Y2Y) drew a chart that ended in 2018 and looked perfectly healthy doing it.
    // The most recent 1000 observations is about four years of daily data, which is the useful
    // window here; the full history stays in the table for the jobs that need it.
    obs = await q(sb.from('macro_observations').select('obs_date,value,vintage_date')
      .eq('series_id', seriesId).order('obs_date', { ascending: false }).order('vintage_date', { ascending: true }).limit(1000));
  } catch (ex) {
    $('#drawer').querySelector('.empty').textContent = `Could not load history: ${ex.message}`;
    return;
  }
  if (!obs.length) { $('#drawer').querySelector('.empty').textContent = 'No history for this series yet.'; return; }
  // Latest vintage per obs_date (a revised series like GDP can have more than one reading per
  // date). vintage_date still ascends within a date, so the last write per date wins.
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
  // Weights are the framework's, shown on the chip so it's obvious why the lens matters: a
  // Predictive call carries six times a Positioning one in the master Speed Limit.
  const LENS_W = { predictive: '60%', descriptive: '20%', sentiment: '10%', positioning: '10%' };
  const lensChip = l => l && l !== 'unclassified'
    ? `<span class="chip" title="${esc(LENS_W[l] || '')} of the master Speed Limit">${esc(l)}</span>`
    : '<span class="chip" title="Source not yet placed in a lens bucket — add it to _source-policy.md">unclassified</span>';
  const byLens = {};
  for (const r of log) byLens[r.lens || 'unclassified'] = (byLens[r.lens || 'unclassified'] || 0) + 1;
  const held = log.filter(r => r.status === 'held').length;
  const byAgent = {};
  for (const r of log) if (r.routed_to) byAgent[r.routed_to] = (byAgent[r.routed_to] || 0) + 1;
  return `<span class="eyebrow">Allocation model</span><h1>Inbox</h1><p class="sub">Clipped and dropped items, where they were routed, and why.</p>
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Items</span><b>${log.length}</b><small>processed</small></div>
   <div class="card kpi"><span class="eyebrow">Routed to</span><b style="font-size:16px">${Object.entries(byAgent).map(([a, n]) => `${esc(a)} ${n}`).join(' · ') || '—'}</b><small></small></div>
   <div class="card kpi"><span class="eyebrow">Held</span><b class="${held ? 'stale' : ''}">${held}</b><small>not read by any agent</small></div>
   <div class="card kpi"><span class="eyebrow">By lens</span><b style="font-size:15px">${Object.entries(byLens).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${esc(l)} ${n}`).join(' · ') || '—'}</b><small>research lens</small></div>
  </div>
  <div class="card">${log.length ? `<table><thead><tr><th>Item</th><th>Source</th><th>Received</th><th>Routed to</th><th>Lens</th><th>Reason</th><th>Status</th></tr></thead><tbody>
   ${log.map(r => `<tr><td>${esc((r.file || '').split('/').pop())}</td><td>${esc(r.source || '—')}</td><td>${esc(r.received_at || '—')}</td>
    <td>${esc(r.routed_to || '—')}</td><td>${lensChip(r.lens)}</td><td style="max-width:320px;color:var(--muted)">${esc(r.reason || '')}</td><td>${statusChip(r.status)}</td></tr>`).join('')}
   </tbody></table><p class="note">Held items are deliberately not read by any agent — a publisher's terms restrict it. Source policy lives in desk-workspace/inbox/_source-policy.md; that file, not this table, is what the processor actually enforces. The lens is the framework's research bucket, taken from the source rather than the subject matter, and it sets how much the item weighs in the master Speed Limit (Predictive 60%, Descriptive 20%, Sentiment 10%, Positioning 10%). It is not a judgment of quality — how often a source is right is tracked separately on the Sources tab.</p>`
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
// Chart layer toggles re-render from the already-fetched history — no refetch, no hash change.
// Donut and period toggles re-render the model drawer from data already loaded.
document.addEventListener('click', e => {
  const d = e.target.closest('[data-donut]'), p = e.target.closest('[data-period]');
  if (!d && !p) return;
  if (d) donutMode = d.dataset.donut;
  if (p) perfPeriod = p.dataset.period;
  const id = (location.hash.split('/')[1] || '');
  if (id) openModel(id);
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-layer]'); if (!t || !chartCtx) return;
  const k = t.dataset.layer;
  if (chartCtx.layers.has(k)) chartCtx.layers.delete(k); else chartCtx.layers.add(k);
  renderChart();
});
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
