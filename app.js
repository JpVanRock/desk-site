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
// Same as q(), but a failure yields an empty set instead of taking the page down. Used for the
// auxiliary datasets — the lights, the boards, the attribution — where a missing table means one
// card renders empty and the rest of the site still works. It was not always this way: a single
// migration lagging behind a deploy turned the WHOLE dashboard into "Could not load data",
// because Promise.all rejects as a unit. The core tables below deliberately still use q(): if
// strategies or securities are unreachable there is no dashboard to show, and saying so plainly
// is better than rendering an empty one that looks real.
const softFailures = [];
async function qSoft(query, label) {
  try { return await q(query); }
  catch (ex) { softFailures.push(`${label}: ${ex.message}`); console.warn(`[desk] optional dataset "${label}" unavailable:`, ex.message); return []; }
}
function latestBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); const p = m.get(k); if (!p || r.as_of > p.as_of) m.set(k, r); } return m; }

async function load() {
  // CAUTION: this is POSITIONAL destructuring over a long Promise.all. A query inserted
  // anywhere but the end silently shifts every binding after it, and the page still renders
  // — it just renders the wrong table's rows. That happened: five queries added before the
  // signal-to-noise one made the statistics block read contribution rows. The rule is append
  // only: add the query at the END of the array and its name at the END of this list.
  const [strategies, alloc, secs, classes, factors, cLoad, sLoad, runs, outputs, prices, technicals, macro, views, roadmap, sources, calls, routingLog, contribs, scenarios, stress, perf, attrib, speedLimit, modelSpeed, rocBoard, trigHits, trigRules, stn, periodStats, contribution, factorAlloc, valueSeries, snapIntegrity, currentHoldings, factorOverrides, lensSnr, holdingRR, trailing, styleExposure, styleCoverage, monthly, trades, positionScores, decisionStats, assessments] = await Promise.all([
    q(sb.from('strategies').select('id,name,label,sort_order,benchmark').order('sort_order')),
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
    qSoft(sb.from('asset_class_views').select('asset_class_id,as_of,stance,confidence,thesis,role_in_profile,change_my_mind,status,author').order('as_of', { ascending: false }), 'asset class views'),
    qSoft(sb.from('roadmap_items').select('area,item,status,detail,sort_order').order('sort_order'), 'roadmap'),
    qSoft(sb.from('source_track_record').select('source,category,n_directional,hit_rate,n_open,last_call_at').order('source'), 'source track record'),
    qSoft(sb.from('research_calls').select('id,source,category,agent,called_at,asset_class_id,direction,confidence,thesis,review_at,scored_at,actual_return,hit').order('called_at', { ascending: false }).limit(200), 'research calls'),
    qSoft(sb.from('inbox_routing_log').select('file,source,received_at,routed_to,lens,reason,status,processed_at').order('processed_at', { ascending: false }).limit(200), 'routing log'),
    qSoft(sb.from('holding_contributions').select('strategy_id,security_id,as_of,weight,risk_share,risk_ratio,corr_to_rest,max_corr,closest_peer_id,verdict,rationale').order('as_of', { ascending: false }), 'holding contributions'),
    qSoft(sb.from('stress_scenarios').select('id,slug,name,description,shocks').order('sort_order'), 'stress scenarios'),
    qSoft(sb.from('strategy_stress_results').select('strategy_id,scenario_id,as_of,factor_score,coverage,n_windows,mean_return,worst_return,best_return,replay_coverage,windows').order('as_of', { ascending: false }), 'stress results'),
    qSoft(sb.from('strategy_performance').select('strategy_id,period,as_of,start_date,end_date,portfolio_return,peer_benchmark_return,policy_benchmark_return,coverage,max_drawdown,peer_max_drawdown,gold_return,btc_return,weighted_expense_ratio,expense_coverage,cpi_return,cpi_window_start,cpi_window_end,model_return_cpi_window').order('as_of', { ascending: false }), 'performance'),
    qSoft(sb.from('strategy_attribution').select('strategy_id,period,as_of,asset_class_id,w_portfolio,w_benchmark,r_portfolio,r_benchmark,contribution,allocation_effect,selection_effect,interaction_effect,attributable').order('as_of', { ascending: false }), 'attribution'),
    qSoft(sb.from('speed_limit_readings').select('as_of,category,score,light,weight,n_calls,n_recorded,target_beta_low,target_beta_high,sign_label').order('as_of', { ascending: false }), 'speed limit'),
    qSoft(sb.from('strategy_speed_limit').select('strategy_id,as_of,actual_beta,r_squared,n_obs,target_low,target_high,light,note').order('as_of', { ascending: false }), 'model speed limit'),
    qSoft(sb.from('market_roc_board').select('as_of,security_id,label,sort_order,close,price_roc_1d,price_roc_1w,price_roc_1m,volume_roc_1w,vol_ann,vol_roc_1m').order('sort_order'), 'ROC board'),
    qSoft(sb.from('trigger_hits').select('as_of,headline,value,rule_id,security_id,strategy_id').order('as_of', { ascending: false }).limit(200), 'trigger hits'),
    qSoft(sb.from('trigger_rules').select('id,name,kind,enabled'), 'trigger rules'),
    qSoft(sb.from('source_signal_to_noise').select('source,category,window_label,n_scored,hit_rate,signal,noise,signal_to_noise,too_few_to_judge'), 'signal to noise'),
    qSoft(sb.from('model_period_stats').select('strategy_id,period,as_of,start_date,end_date,model_return,benchmark_return,max_drawdown,benchmark_max_drawdown,upside_capture,downside_capture,beta_sp500,beta_r2,dividend_yield,min_coverage,window_starts_in_gap,unavailable_reason,method_note').order('as_of', { ascending: false }), 'model period stats'),
    qSoft(sb.from('model_contribution').select('strategy_id,period,as_of,ticker,name_raw,start_weight,end_weight,period_return,contribution_bps,status,priced').order('as_of', { ascending: false }), 'model contribution'),
    qSoft(sb.from('model_factor_allocation').select('strategy_id,as_of,basis,long_growth,long_inflation,long_liquidity,short_growth,short_inflation,short_liquidity,unclassified,detail').order('as_of', { ascending: false }), 'model factor allocation'),
    qSoft(sb.from('model_value_series').select('strategy_id,as_of,value,benchmark_value,coverage').order('as_of', { ascending: true }), 'model value series'),
    qSoft(sb.from('holdings_snapshot_integrity').select('strategy_id,as_of,n_holdings,weight_total,weight_off,n_unmatched,n_suspect_names,gap_days_before').order('as_of', { ascending: true }), 'holdings integrity'),
    qSoft(sb.from('current_holdings').select('strategy_id,as_of,ticker,security_id,name_raw,weight'), 'current holdings'),
    qSoft(sb.from('holding_factor_overrides').select('security_id,split,note,author,as_of'), 'factor overrides'),
    qSoft(sb.from('lens_signal_to_noise').select('category,window_label,n_scored,n_sources,hit_rate,signal,noise,signal_to_noise,too_few_to_judge'), 'lens signal to noise'),
    qSoft(sb.from('holding_risk_return').select('security_id,period,as_of,start_date,end_date,total_return,sharpe,vol_ann,n_obs'), 'holding risk/return'),
    qSoft(sb.from('model_trailing_returns').select('strategy_id,period,as_of,sort_order,start_date,end_date,model_return,benchmark_return,excess_return,is_cagr,basis,unavailable_reason').order('sort_order'), 'trailing returns'),
    qSoft(sb.from('model_style_exposure').select('strategy_id,lens,as_of,bucket,label,sort_order,kind,model_weight,benchmark_weight').order('sort_order'), 'style exposure'),
    qSoft(sb.from('model_style_coverage').select('strategy_id,lens,as_of,basis,window_start,window_end,model_equity_weight,model_resolved,benchmark_resolved,unresolved'), 'style coverage'),
    qSoft(sb.from('model_monthly_returns').select('strategy_id,as_of,year,month,model_return,benchmark_return,excess_return,coverage,is_partial,in_gap,basis,unavailable_reason'), 'monthly returns'),
    qSoft(sb.from('model_trades').select('strategy_id,as_of,ticker,entry_date,exit_date,avg_weight,entry_weight,exit_weight,total_return,contribution_bps,excess_bps,status,sizing_verdict,starts_in_gap,pre_existing,unavailable_reason'), 'trade ledger'),
    qSoft(sb.from('position_decision_scores').select('strategy_id,as_of,ticker,window_key,sort_order,start_date,end_date,weight,position_return,benchmark_return,decision_bps,is_partial,starts_in_gap,unavailable_reason').order('sort_order'), 'position decision scores'),
    qSoft(sb.from('model_decision_stats').select('strategy_id,as_of,n_closed,n_open,n_wins,n_losses,batting_average,slugging_bps,win_bps,loss_bps,median_weight,n_unpriced,first_snapshot,last_snapshot,gap_days,n_beat_benchmark,excess_bps_total'), 'decision stats'),
    qSoft(sb.from('annie_assessments').select('as_of,kind,strategy_id,ticker,headline,body_md,score,score_scale,confidence,sources,author').order('as_of', { ascending: false }), 'Annie assessments'),
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
      return { ticker: s.ticker || '?', name: s.name || '', weight: w, cls: slug, loading: ld, security_id: a.security_id };
    }).sort((a, b) => b.weight - a.weight);
    return { id: st.id, name: st.name, label: st.label, benchmarkLabel: st.benchmark || null, holdings, total, net: net.map(x => +x.toFixed(3)), cov: total ? cov / total : 0,
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
    triggerHits: (trigHits || []).map(h => ({ ...h, rule_name: (trigRules || []).find(r => r.id === h.rule_id)?.name || null })),
    signalToNoise: stn || [], softFailures: softFailures.slice(),
    // newest() matters on every dated set: these jobs write a fresh as_of each run, so loading
    // them raw sums every run ever made. It showed up as a contribution total of 200% weight and
    // double the basis points the day a second run landed — a figure that looks like a number
    // rather than like a bug, which is the dangerous kind.
    periodStats: newest(periodStats), contribution: newest(contribution),
    factorAlloc: newest(factorAlloc), valueSeries: valueSeries || [], snapIntegrity: snapIntegrity || [],
    currentHoldings: currentHoldings || [], factorOverrides: factorOverrides || [], lensSnr: lensSnr || [], holdingRR: newest(holdingRR), trailing: newest(trailing),
    styleExposure: newest(styleExposure), styleCoverage: newest(styleCoverage), monthly: newest(monthly),
    trades: newest(trades), positionScores: newest(positionScores), decisionStats: newest(decisionStats),
    // Assessments are NOT filtered to the newest date: Annie's view in October and her view in
    // March are both worth keeping, and comparing a judgment with what happened afterwards is the
    // whole point of the page.
    assessments: assessments || [] };
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
  let [page, arg] = (location.hash || '#overview').slice(1).split('/');
  // #decisions was this page's hash before it was named after the agent who writes it. Anything
  // already bookmarked or pasted into a note still has to land, so the old name redirects rather
  // than falling through to Overview and looking like the page was deleted.
  if (page === 'decisions') { location.replace('#annie'); return; }
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + page));
  closeDrawer();
  const pages = { overview, stan, markets, views: viewsPage, signals, playground, agents, annie, briefs, inbox, status, sources };
  $('#app').innerHTML = (pages[page] || overview)();
  if (page === 'stan' && arg) {
    // One route, three drawers. Keeping them on the hash means Escape, the scrim and the back
    // button all close them the same way a model drawer closes.
    if (arg === 'speed-limit') { $('#drawer').innerHTML = speedLimitDrawer(); $('#drawer').hidden = false; $('#scrim').hidden = false; }
    else if (arg.startsWith('snr-')) { $('#drawer').innerHTML = snrDrawer(arg.slice(4)); $('#drawer').hidden = false; $('#scrim').hidden = false; }
    else if (arg.startsWith('top3-')) { $('#drawer').innerHTML = top3Drawer(arg.slice(5)); $('#drawer').hidden = false; $('#scrim').hidden = false; }
    else openModel(arg);
  }
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

// ---------- Speed Limit and signal-to-noise: shared renderers ----------
//
// These are built once and used in two places: the Signals tab, and the pop-outs from Stan's
// header boxes. One implementation rather than two copies that drift.
const LENSES = [
  { key: 'predictive',  label: 'Predictive',  weight: 0.60 },
  { key: 'descriptive', label: 'Descriptive', weight: 0.20 },
  { key: 'positioning', label: 'Positioning', weight: 0.10 },
  { key: 'sentiment',   label: 'Sentiment',   weight: 0.10 },
];
const SNR_WINDOWS = ['1M', '1Q', '6M', '12M'];
let snrWindow = 'YTD';

// The master light and its lens breakdown.
function speedLimitMasterCard() {
  const sl = D.speedLimit || [];
  const master = sl.find(r => r.category === 'master');
  const cats = sl.filter(r => r.category !== 'master').sort((a, b) => (+b.weight || 0) - (+a.weight || 0));
  if (!master) return '<div class="empty">No Speed Limit reading yet. Run jobs/compute-speed-limit.mjs.</div>';
  return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <div style="text-align:center">
     ${lightDot(master.light, 46)}
     <div style="margin-top:6px;font-size:22px;font-weight:700;color:${master.light ? LIGHT_COLOR[master.light] : 'var(--muted)'}">${esc((master.sign_label || '').replace(/^Speed Limit\s*/i, '') || '—')}</div>
     <div style="color:var(--muted);font-size:12px">${master.light ? esc(LIGHT_MEANING[master.light]) : 'no reading'}${master.score !== null ? ` · score ${(+master.score).toFixed(2)}` : ''}</div>
     ${master.target_beta_low !== null ? `<div style="color:var(--muted);font-size:12px">target beta ${master.target_beta_low}–${master.target_beta_high}×</div>` : ''}
    </div>
    <table style="flex:1;min-width:280px;margin:0"><thead><tr><th>Lens</th><th class="num">Weight</th><th class="num">Score</th><th>Light</th><th class="num">Calls</th></tr></thead><tbody>
    ${cats.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${(+c.weight * 100).toFixed(0)}%</td>
      <td class="num">${c.score === null ? '<span style="color:var(--muted)">–</span>' : (+c.score).toFixed(2)}</td>
      <td>${c.light ? `${lightDot(c.light, 10)} <span style="color:${LIGHT_COLOR[c.light]}">${esc(LIGHT_MEANING[c.light])}</span>` : '<span style="color:var(--muted)">no reading</span>'}</td>
      <td class="num">${c.n_calls}${c.n_recorded > c.n_calls ? ` <span style="color:var(--muted)">of ${c.n_recorded}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
   <p class="note"><b>Draft rule.</b> The framework set the lens weights; the scoring rule was left open, so this is a proposal to argue with, not a settled measure. A lens scores the confidence-weighted mean direction of its open research calls — green above +0.33, red below −0.33 — and the master is the weighted mean over the lenses that actually have calls, so a silent lens abstains rather than counting as neutral. ${master.n_calls < 6 ? `<b>This reading rests on ${master.n_calls} scoring call${master.n_calls === 1 ? '' : 's'}</b>, far too few to lean on — read it as the machinery working, not as a signal.` : ''} Only equities, commodities and cash calls carry a sign: bond and gold calls are counted but score zero, because their risk reading is genuinely ambiguous.</p>`;
}

// Each model's beta against the band the master light calls for.
function speedLimitModelCard() {
  const modelSL = D.modelSpeedLimit || [];
  if (!modelSL.length) return '';
  const n = v => v === null || v === undefined ? null : +v;
  return `<div class="card" style="margin-top:14px"><h2>Each model against the Speed Limit</h2>
    <table><thead><tr><th>Model</th><th class="num">Actual beta</th><th class="num">R²</th><th class="num">Target</th><th>Light</th></tr></thead><tbody>
    ${modelSL.map(r => {
      const st = D.models.find(m => m.id === r.strategy_id);
      return `<tr title="${esc(r.note || '')}"><td><b>${esc(st?.name || '—')}</b></td>
       <td class="num">${n(r.actual_beta) === null ? '–' : n(r.actual_beta).toFixed(2) + '×'}</td>
       <td class="num" style="color:${n(r.r_squared) !== null && n(r.r_squared) < 0.5 ? 'var(--neg)' : 'var(--text)'}">${n(r.r_squared) === null ? '–' : n(r.r_squared).toFixed(2)}</td>
       <td class="num">${r.target_low === null ? '–' : `${r.target_low}–${r.target_high}×`}</td>
       <td>${r.light ? `${lightDot(r.light, 10)} <span style="color:${LIGHT_COLOR[r.light]}">${esc(r.light)}</span>` : '<span class="chip">unrated</span>'}</td></tr>`;
    }).join('')}
    </tbody></table>
    <p class="note">Beta is measured against each model's peer benchmark by least squares over the last year. <b>Read R² first.</b> These models hold gold, commodities and alternatives their benchmark does not, which leaves a lot unexplained and drags the slope down — below 0.5 the beta is not describing risk posture, so the model is left <b>unrated</b> rather than shown red. Where the fit holds, a model below its target band is positioned more defensively than the lights call for.</p></div>`;
}

// SNR for one lens, by source, over the selected window.
function snrDrawer(lens) {
  const meta = LENSES.find(l => l.key === lens) || { key: lens, label: lens, weight: 0 };
  const rows = (D.signalToNoise || []).filter(r => r.category === lens && r.window_label === snrWindow);
  const ranked = rows.slice().sort((a, b) => {
    const av = a.signal_to_noise === null ? -Infinity : +a.signal_to_noise;
    const bv = b.signal_to_noise === null ? -Infinity : +b.signal_to_noise;
    return bv - av;
  });
  const lensRow = (D.lensSnr || []).find(r => r.category === lens && r.window_label === snrWindow);
  const num = (v, d = 2) => v === null || v === undefined ? '<span style="color:var(--muted)">–</span>' : (+v).toFixed(d);
  const pcv = v => v === null || v === undefined ? '<span style="color:var(--muted)">–</span>'
    : `<span style="color:${+v >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(+v >= 0 ? '+' : '') + (+v * 100).toFixed(2)}%</span>`;
  const tabs = ['YTD', ...SNR_WINDOWS].map(w => `<button class="tab" data-snrwin="${w}" aria-selected="${w === snrWindow}">${w}</button>`).join('');

  return `<button class="close" data-go="#stan">Close</button>
   <span class="eyebrow">Signal to noise · ${(meta.weight * 100).toFixed(0)}% of the master light</span>
   <h1>${esc(meta.label)} sources</h1>
   <p class="sub">How much of each source's directional calls was signal rather than noise, over the selected window.</p>
   <div class="card" style="margin-bottom:14px"><h2>Lens total</h2>
    <div class="tabs">${tabs}</div>
    ${!lensRow || !lensRow.n_scored ? `<div class="empty">Nothing scored in this window yet. Calls settle once their horizon passes; the desk's first were logged 2026-09-24 and settle from December 2026.</div>`
     : `<div class="kpis">
      <div class="card kpi"><span class="eyebrow">Signal / noise</span><b>${num(lensRow.signal_to_noise)}</b><small>${lensRow.too_few_to_judge ? 'too few to judge' : 'pooled across sources'}</small></div>
      <div class="card kpi"><span class="eyebrow">Signal</span><b>${pcv(lensRow.signal)}</b><small>mean return in the call's direction</small></div>
      <div class="card kpi"><span class="eyebrow">Noise</span><b>${num(lensRow.noise === null ? null : +lensRow.noise * 100, 2)}%</b><small>standard deviation of those returns</small></div>
      <div class="card kpi"><span class="eyebrow">Calls scored</span><b>${lensRow.n_scored}</b><small>${lensRow.n_sources} source${lensRow.n_sources === 1 ? '' : 's'}</small></div>
     </div>`}
   </div>
   <div class="card"><h2>By source${snrWindow === 'YTD' ? ', ranked year to date' : ', ranked'}</h2>
    ${!ranked.length ? '<div class="empty">No scored calls from this lens in the selected window.</div>'
     : `<table><thead><tr><th>Source</th><th class="num">Signal / noise</th><th class="num">Signal</th><th class="num">Noise</th><th class="num">Hit rate</th><th class="num">Calls</th></tr></thead><tbody>
    ${ranked.map(r => `<tr${r.too_few_to_judge ? ' style="opacity:.55"' : ''}>
      <td><b>${esc(r.source)}</b>${r.too_few_to_judge ? ' <span class="chip">too few</span>' : ''}</td>
      <td class="num" style="color:${r.signal_to_noise === null ? 'var(--muted)' : +r.signal_to_noise > 0 ? 'var(--pos)' : 'var(--neg)'}"><b>${num(r.signal_to_noise)}</b></td>
      <td class="num">${pcv(r.signal)}</td>
      <td class="num">${r.noise === null ? '<span style="color:var(--muted)">–</span>' : (+r.noise * 100).toFixed(2) + '%'}</td>
      <td class="num">${r.hit_rate === null ? '–' : (+r.hit_rate * 100).toFixed(0) + '%'}</td>
      <td class="num">${r.n_scored}</td></tr>`).join('')}
    </tbody></table>`}
    <p class="note">Signal is the mean return in the <b>direction</b> of the call; noise is the standard deviation of those same returns; the ratio is the two divided — the trading proxy named in the reference the owner supplied, as a plain ratio with no decibel conversion. A source right by a hair every time scores below one right by a lot, and a scattered source below a consistent one at the same hit rate. Windows are anchored on when a call was <b>made</b>, not when it settled. <b>No threshold is drawn</b>, deliberately: the reference is explicit that there is no universal number for a good SNR, so any green or red line here would be the desk's judgment wearing the article's clothes. Rows under ten scored calls are faded and marked.</p></div>`;
}

function speedLimitDrawer() {
  return `<button class="close" data-go="#stan">Close</button>
   <span class="eyebrow">Gigantic Rocks</span><h1>Master Speed Limit</h1>
   <p class="sub">What the research lenses say about risk, and how each model sits against the band it calls for.</p>
   <div class="card"><h2>Master Speed Limit <span class="chip draft">draft scoring rule</span></h2>${speedLimitMasterCard()}</div>
   ${speedLimitModelCard()}`;
}

// The three positions carrying most of a model's volatility. Opened from the Top-3 risk cell,
// because a concentration figure is only actionable once you know which names it is.
function top3Drawer(strategyId) {
  const m = D.models.find(x => x.id === strategyId);
  if (!m) return `<button class="close" data-go="#stan">Close</button><div class="empty">Model not found.</div>`;
  const all = (D.contribByStrategy?.[strategyId] || []).filter(c => c.risk_share !== null)
    .sort((a, b) => +b.risk_share - +a.risk_share);
  const top = all.slice(0, 3);
  const n = v => v === null || v === undefined ? null : +v;
  const totRisk = top.reduce((s, r) => s + +r.risk_share, 0);
  const totWt = top.reduce((s, r) => s + +r.weight, 0);
  return `<button class="close" data-go="#stan">Close</button>
   <span class="eyebrow">Risk concentration</span><h1>${esc(m.name.replace(/\s*\([^)]*\)/g, ''))}</h1>
   <p class="sub">The three positions carrying most of this model's volatility.</p>
   ${!top.length ? '<div class="card"><div class="empty">No measured risk contributions for this model. Run jobs/compute-earns-its-place.mjs.</div></div>'
    : `<div class="kpis">
      <div class="card kpi"><span class="eyebrow">Risk in top 3</span><b>${(totRisk * 100).toFixed(0)}%</b><small>of model volatility</small></div>
      <div class="card kpi"><span class="eyebrow">On weight of</span><b>${(totWt * 100).toFixed(0)}%</b><small>of the model</small></div>
      <div class="card kpi"><span class="eyebrow">Concentration</span><b>${totWt > 0 ? (totRisk / totWt).toFixed(2) + '×' : '–'}</b><small>risk per unit of weight</small></div>
      <div class="card kpi"><span class="eyebrow">Measured</span><b>${all.length}</b><small>of ${(D.contribByStrategy?.[strategyId] || []).length} holdings</small></div>
     </div>
     <div class="card" style="margin-bottom:14px"><h2>The three largest contributors</h2>
      <table><thead><tr><th>Ticker</th><th class="num">Weight</th><th class="num">Risk share</th><th class="num">Ratio</th><th class="num">Vol</th><th class="num">Corr to rest</th></tr></thead><tbody>
      ${top.map(r => `<tr><td><b>${esc(r.ticker)}</b></td>
        <td class="num">${pct(+r.weight)}</td>
        <td class="num"><b>${(+r.risk_share * 100).toFixed(1)}%</b></td>
        <td class="num" style="color:${+r.risk_ratio >= 2 ? 'var(--neg)' : +r.risk_ratio <= 0.85 ? 'var(--pos)' : 'var(--text)'}">${n(r.risk_ratio) === null ? '–' : (+r.risk_ratio).toFixed(2) + '×'}</td>
        <td class="num">${n(r.vol_ann) === null ? '–' : (+r.vol_ann * 100).toFixed(0) + '%'}</td>
        <td class="num">${n(r.corr_to_rest) === null ? '–' : (+r.corr_to_rest).toFixed(2)}</td></tr>`).join('')}
      </tbody></table></div>
     <div class="card"><h2>Why each one</h2>
      ${top.map(r => `<div style="margin-bottom:10px"><b>${esc(r.ticker)}</b> <span class="chip ${r.verdict === 'review' || r.verdict === 'redundant' ? 'short' : r.verdict === 'diversifier' ? 'long' : 'flat'}">${esc((r.verdict || '').replace(/_/g, ' '))}</span>
        <p style="margin:4px 0 0;color:var(--muted)">${esc(r.rationale || '')}</p></div>`).join('')}
      <p class="note">Risk share is each holding's marginal contribution to model volatility; the shares sum to 100%, so they compare directly against weight. A ratio above 1 is not a criticism — equity risk in a growth model <i>should</i> outrun its weight — it is the prompt to say what the position is for. Measured on volatility and correlation only, so it is silent on drawdown shape, tails, liquidity and tax.</p></div>`}`;
}

// ---------- Position scatter: Sharpe against total return ----------
//
// One point per security currently held anywhere in the book. Sharpe is excess of the desk's cash
// proxy rather than of zero, so a cash-like fund does not get credit for the risk-free rate.
let scatterPeriod = 'YTD';
// Which lens the model drawer's portfolio breakdown is showing. Module scope so it survives the
// drawer re-render the toggle triggers.
let breakdownLens = 'sector';
// Which column the monthly grid is showing. Module scope for the same reason as breakdownLens.
let monthlyTab = 'portfolio';
const SCATTER_PERIODS = ['YTD', '1Y', '3Y', '5Y'];

function positionScatter() {
  const rows = (D.holdingRR || []).filter(r => r.period === scatterPeriod && r.sharpe !== null);
  const tick = id => (D.markets.find(m => m.id === id) || {}).ticker || '?';
  const tabs = `<div class="tabs">${SCATTER_PERIODS.map(p => {
    const any = (D.holdingRR || []).some(r => r.period === p && r.sharpe !== null);
    return `<button class="tab" data-scatter="${p}" aria-selected="${p === scatterPeriod}" ${any ? '' : 'disabled title="No holding has enough history for this window"'}>${p}</button>`;
  }).join('')}</div>`;

  if (!rows.length) {
    return `<div class="card" style="margin-top:14px"><h2>Position scatter plot</h2>${tabs}
      <div class="empty">No holding has both a return and a Sharpe for this window. Run jobs/compute-holding-risk-return.mjs.</div></div>`;
  }

  const pts = rows.map(r => ({ x: +r.total_return, y: +r.sharpe, t: tick(r.security_id), vol: +r.vol_ann, n: r.n_obs }));
  const W = 900, Hh = 560, pad = { l: 64, r: 26, t: 34, b: 52 };
  // Axis bounds padded outward to a round step, and always including zero so the quadrant lines
  // mean something.
  const nice = (lo, hi, step) => [Math.floor(Math.min(lo, 0) / step) * step, Math.ceil(Math.max(hi, 0) / step) * step];
  const [x0, x1] = nice(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x)), 0.05);
  const [y0, y1] = nice(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)), 0.5);
  const X = v => pad.l + ((v - x0) / ((x1 - x0) || 1)) * (W - pad.l - pad.r);
  const Y = v => Hh - pad.b - ((v - y0) / ((y1 - y0) || 1)) * (Hh - pad.t - pad.b);

  const xTicks = [], yTicks = [];
  for (let v = x0; v <= x1 + 1e-9; v += 0.05) xTicks.push(+v.toFixed(4));
  const yStep = (y1 - y0) > 6 ? 1 : 0.5;
  for (let v = y0; v <= y1 + 1e-9; v += yStep) yTicks.push(+v.toFixed(3));

  const grid = [
    ...xTicks.map(v => `<line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${pad.t}" y2="${Hh - pad.b}" stroke="var(--line)" stroke-width="1"/>
      <text x="${X(v).toFixed(1)}" y="${Hh - pad.b + 16}" font-size="10" fill="var(--muted)" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`),
    ...yTicks.map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
      <text x="${pad.l - 8}" y="${(Y(v) + 3.5).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="end">${v.toFixed(2)}</text>`),
  ].join('');

  // The quadrant lines: zero return and zero Sharpe. Below the Sharpe line a holding did not beat
  // cash after allowing for its own volatility, which is the division that matters most here.
  const zero = `<line x1="${X(0).toFixed(1)}" x2="${X(0).toFixed(1)}" y1="${pad.t}" y2="${Hh - pad.b}" stroke="var(--muted)" stroke-width="1.5"/>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="var(--muted)" stroke-width="1.5"/>`;

  // Labels alternate above and below the dot when two points are close, so a cluster stays legible.
  const sorted = pts.slice().sort((a, b) => X(a.x) - X(b.x));
  const placed = [];
  const marks = sorted.map(p => {
    const cx = X(p.x), cy = Y(p.y);
    const clash = placed.some(q => Math.abs(q.cx - cx) < 42 && Math.abs(q.cy - cy) < 26);
    const below = !clash;
    placed.push({ cx, cy });
    return `<g><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="var(--growth)">
        <title>${esc(p.t)} · return ${(p.x * 100).toFixed(1)}% · Sharpe ${p.y.toFixed(2)} · vol ${(p.vol * 100).toFixed(0)}% · ${p.n} days</title></circle>
      <text x="${cx.toFixed(1)}" y="${(cy + (below ? 17 : -10)).toFixed(1)}" font-size="10" fill="var(--growth)" text-anchor="middle">${esc(p.t)}</text></g>`;
  }).join('');

  const r0 = rows[0];
  const omitted = (D.markets || []).length ? null : null;
  const best = pts.slice().sort((a, b) => b.y - a.y)[0];
  const worst = pts.slice().sort((a, b) => a.y - b.y)[0];

  return `<div class="card" style="margin-top:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Position scatter plot</h2>
      <span style="font-size:12px;color:var(--muted)">${esc(r0.start_date)} → ${esc(r0.end_date)} · ${pts.length} positions</span></div>
    ${tabs}
    <div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${Hh}" style="width:100%;min-width:620px;height:auto;display:block" role="img"
      aria-label="Sharpe ratio against total return for every position held across the models">
      ${grid}${zero}${marks}
      <text x="${pad.l}" y="${pad.t - 14}" font-size="12" fill="var(--text)" font-weight="600">Sharpe ratio (${esc(scatterPeriod)})</text>
      <text x="${W - pad.r}" y="${Hh - 10}" font-size="12" fill="var(--text)" font-weight="600" text-anchor="end">Total return % (${esc(scatterPeriod)})</text>
    </svg></div>
    <div class="kpis" style="margin-top:10px">
      <div class="card kpi"><span class="eyebrow">Best risk-adjusted</span><b>${esc(best.t)}</b><small>Sharpe ${best.y.toFixed(2)} on ${(best.x * 100).toFixed(1)}%</small></div>
      <div class="card kpi"><span class="eyebrow">Worst risk-adjusted</span><b>${esc(worst.t)}</b><small>Sharpe ${worst.y.toFixed(2)} on ${(worst.x * 100).toFixed(1)}%</small></div>
      <div class="card kpi"><span class="eyebrow">Below cash</span><b>${pts.filter(p => p.y < 0).length}</b><small>negative Sharpe</small></div>
      <div class="card kpi"><span class="eyebrow">Positions plotted</span><b>${pts.length}</b><small>held across all models</small></div>
    </div>
    <p class="note">Every security currently held anywhere in the book, plotted by its total return against its Sharpe ratio over the window. <b>Sharpe is excess of BIL</b>, the desk's cash proxy, not of zero — across a period when cash paid 4–5% that distinction decides whether a low-volatility fund looks good or merely looks calm. Anything below the horizontal line failed to beat cash once its own volatility is allowed for, whatever its return did. A holding without enough price history for a window is not plotted rather than shown on a short sample; hover any point for its volatility and the number of days behind it.</p></div>`;
}

// ---------- Stan: risk across the models ----------
//
// Stan's standing job is a dashboard per strategy. This leads with risk rather than with the
// allocation table it replaced: where each model's risk actually sits, which positions carry more
// of it than their weight, and how each one scores against the desk's own stress scenarios.
// Everything here is already computed by the nightly jobs — nothing is derived in the browser.
function stan() {
  const n = v => v === null || v === undefined ? null : +v;
  const pc = (v, d = 1) => v === null ? '<span style="color:var(--muted)">–</span>'
    : `<span style="color:${v >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(v >= 0 ? '+' : '') + (v * 100).toFixed(d)}%</span>`;
  const sl = D.modelSpeedLimit || [];
  const master = (D.speedLimit || []).find(r => r.category === 'master');
  const scenById = Object.fromEntries((D.scenarios || []).map(s => [s.id, s]));

  // Per-model risk, assembled from what the jobs already wrote.
  const rows = D.models.map(m => {
    const contrib = (D.contribByStrategy?.[m.id] || []).filter(c => c.risk_share !== null);
    const ranked = contrib.slice().sort((a, b) => +b.risk_share - +a.risk_share);
    const top3 = ranked.slice(0, 3);
    const top3Risk = top3.reduce((s, r) => s + +r.risk_share, 0);
    const top3Wt = top3.reduce((s, r) => s + +r.weight, 0);
    const review = (D.contribByStrategy?.[m.id] || []).filter(c => c.verdict === 'review' || c.verdict === 'redundant');
    const stress = (D.stressByStrategy?.[m.id] || []).filter(s => s.factor_score !== null);
    const worst = stress.slice().sort((a, b) => +a.factor_score - +b.factor_score)[0] || null;
    const beta = sl.find(s => s.strategy_id === m.id) || null;
    const perf = (D.periodStats || []).find(p => p.strategy_id === m.id && p.period === '1YR' && !p.unavailable_reason) || null;
    return { m, top3, top3Risk, top3Wt, review, worst, beta, perf, measured: ranked.length };
  });

  const flagged = rows.reduce((s, r) => s + r.review.length, 0);
  const offBand = rows.filter(r => r.beta && r.beta.light && r.beta.light !== 'green').length;
  const unrated = rows.filter(r => r.beta && !r.beta.light).length;

  const lightCell = b => {
    if (!b) return '<span style="color:var(--muted)">–</span>';
    if (!b.light) return `<span class="chip" title="${esc(b.note || '')}">unrated</span>`;
    return `<span title="${esc(b.note || '')}">${lightDot(b.light, 9)} <span style="color:${LIGHT_COLOR[b.light]}">${n(b.actual_beta) === null ? '–' : n(b.actual_beta).toFixed(2) + '×'}</span></span>`;
  };

  // ---- Model Surveillance ----
  // A performance cell: green when ahead, red when behind, with the comparison named in the
  // tooltip so a colour never has to be guessed at.
  const perfCell = (v, title) => {
    if (v === null || v === undefined) return `<td class="num"><span style="color:var(--muted)" title="${esc(title)}">–</span></td>`;
    const good = v >= 0;
    return `<td class="num"><span title="${esc(title)}" style="display:inline-block;padding:2px 7px;border-radius:5px;font-variant-numeric:tabular-nums;
      background:${good ? 'rgba(63,178,127,.16)' : 'rgba(224,96,94,.16)'};color:${good ? 'var(--pos)' : 'var(--neg)'}">${(v >= 0 ? '+' : '') + (v * 100).toFixed(1)}%</span></td>`;
  };
  // The model measured in something other than dollars: (1+model)/(1+numeraire) - 1.
  const vsNumeraire = (mr, nr) => (mr === null || nr === null || nr === undefined || nr <= -1) ? null : (1 + mr) / (1 + nr) - 1;

  const riskTable = `<div class="card" style="margin-bottom:14px"><h2>Model Surveillance</h2>
   <div style="overflow-x:auto"><table style="min-width:1040px"><thead><tr>
     <th>Model</th><th class="num">Cash</th><th>Beta vs band</th><th class="num">Beta vs bench</th>
     <th class="num">Top-3 risk</th><th class="num">YTD</th><th class="num">vs CPI</th>
     <th class="num">vs Gold</th><th class="num">vs BTC</th><th class="num">vs Bench</th></tr></thead><tbody>
   ${rows.map(r => {
     const p = (D.perfByStrategy?.[r.m.id] || []).find(x => x.period === 'YTD') || null;
     const num = v => v === null || v === undefined ? null : +v;
     const mr = p ? num(p.portfolio_return) : null;
     const br = p ? num(p.peer_benchmark_return) : null;
     const gr = p ? num(p.gold_return) : null;
     const btc = p ? num(p.btc_return) : null;
     const cash = (r.m.byClass.find(c => c[0] === 'cash') || [0, 0])[1];
     // The CPI leg and the model measured over the SAME, shorter window -- never portfolio_return
     // divided by cpi_return, which would be a nine-month return over an eight-month price level.
     const cpi = p ? num(p.cpi_return) : null;
     const mCpi = p ? num(p.model_return_cpi_window) : null;
     const b = r.beta;
     const bandState = !b || !b.actual_beta ? null
       : b.target_low === null ? null
       : +b.actual_beta < +b.target_low ? 'below' : +b.actual_beta > +b.target_high ? 'above' : 'inside';
     return `<tr>
       <td class="click" data-go="#stan/${esc(r.m.id)}" style="cursor:pointer"><b>${esc(r.m.name.replace(/\s*\([^)]*\)/g, ''))}</b> <span class="chip">${esc(r.m.label)}</span></td>
       <td class="num">${pct(cash)}</td>
       <td>${!b ? '<span style="color:var(--muted)">–</span>'
          : !b.light ? `<span class="chip" title="${esc(b.note || '')}">unrated</span>`
          : `<span title="${esc([b.note, b.target_low === null ? '' : `Band ${(+b.target_low).toFixed(2)}×–${(+b.target_high).toFixed(2)}×`].filter(Boolean).join(' · '))}">
              <b style="font-variant-numeric:tabular-nums;color:${LIGHT_COLOR[b.light]}">${b.actual_beta === null ? '–' : (+b.actual_beta).toFixed(2) + '×'}</b>
              <br><small style="white-space:nowrap">${lightDot(b.light, 8)} <span style="color:${LIGHT_COLOR[b.light]}">${bandState || b.light}</span>${b.target_low === null ? '' : `<span style="color:var(--muted)"> ${(+b.target_low).toFixed(2)}–${(+b.target_high).toFixed(2)}</span>`}</small></span>`}</td>
       <td class="num" title="${b && b.note ? esc(b.note) : 'Least-squares beta against the benchmark chosen for this model'}">${b && b.actual_beta !== null ? (+b.actual_beta).toFixed(2) + '×' : '<span style="color:var(--muted)">–</span>'}${b && b.r_squared !== null ? `<br><small style="color:${+b.r_squared < 0.5 ? 'var(--neg)' : 'var(--muted)'}">R² ${(+b.r_squared).toFixed(2)}</small>` : ''}</td>
       <td class="num">${r.measured ? `<span class="click" data-go="#stan/top3-${esc(r.m.id)}" style="cursor:pointer;text-decoration:underline dotted" title="Show the three largest risk contributors"><b>${(r.top3Risk * 100).toFixed(0)}%</b></span><br><small style="color:var(--muted)">on ${(r.top3Wt * 100).toFixed(0)}% wt</small>` : '<span style="color:var(--muted)">–</span>'}</td>
       ${perfCell(mr, 'Year-to-date return, target weights, gross of fees')}
       ${perfCell(vsNumeraire(mCpi, cpi), cpi === null
          ? 'No CPI reading covers this window. Check that the macro feed is still running.'
          : `Model ${(mCpi * 100).toFixed(1)}% against CPI ${(cpi * 100).toFixed(1)}% over ${p.cpi_window_start} to ${p.cpi_window_end} — a SHORTER window than the YTD beside it, because CPI is monthly and published in arrears. Both legs run over the same dates.`)}
       ${perfCell(vsNumeraire(mr, gr), gr === null ? 'No gold price for this window' : `Model ${((mr || 0) * 100).toFixed(1)}% against gold ${(gr * 100).toFixed(1)}% — the model measured in gold terms`)}
       ${perfCell(vsNumeraire(mr, btc), btc === null ? 'No BTC price for this window' : `Model ${((mr || 0) * 100).toFixed(1)}% against bitcoin ${(btc * 100).toFixed(1)}% — the model measured in BTC terms`)}
       ${perfCell(mr !== null && br !== null ? mr - br : null, br === null ? 'No benchmark return for this window' : `Model ${((mr || 0) * 100).toFixed(1)}% against its benchmark ${(br * 100).toFixed(1)}%`)}
     </tr>`;
   }).join('')}
   </tbody></table></div>
   <p class="note"><b>Beta vs band</b> says whether the model sits inside, below or above the band the master Speed Limit calls for; <b>beta vs bench</b> is the figure itself, against that model's own benchmark — read R² first, since below 0.5 the regression is not describing risk posture and the band cell shows "unrated" instead. <b>Top-3 risk</b> is the share of model volatility carried by its three largest contributors, against the weight those same three hold; click it for the names. Performance is year-to-date on <b>target weights for every model</b>, gross of fees, so the eight are comparable with each other. That is not the same number a model's own drawer shows: where a model has a dated holdings history its drawer measures what it actually held, and the two will differ — for Balanced Core by several points. Cash is priced as BIL rather than dropped, which it used to be. <b>vs CPI</b>, <b>vs Gold</b> and <b>vs BTC</b> restate the model in that numeraire — (1+model)÷(1+numeraire)−1 — so green means the model held its value against that yardstick rather than merely rose. Gold is GLD and bitcoin is Tiingo spot, both over the model's own window. <b>CPI is different and the cell is honest about it:</b> headline CPI is monthly and published in arrears, so the newest reading always covers a month that ended some time ago. Rather than divide a longer investment return by a shorter inflation one — which would quietly flatter every model here — the comparison runs over the months CPI has actually reported, with the model re-measured over exactly those dates. Hover the cell for the window.</p></div>`;

  // Every position any model has flagged, gathered in one place so a name appearing in several
  // models is obvious — that is the concentration that matters at desk level, not model level.
  const allFlags = [];
  for (const r of rows) for (const c of r.review) allFlags.push({ ...c, model: r.m.name });
  const byTicker = {};
  for (const f of allFlags) (byTicker[f.ticker] ||= []).push(f);
  const flagRows = Object.entries(byTicker).sort((a, b) => b[1].length - a[1].length || (+b[1][0].risk_ratio || 0) - (+a[1][0].risk_ratio || 0));
  const flagsCard = `<div class="card" style="margin-bottom:14px"><h2>Flagged positions <span class="chip">${allFlags.length}</span></h2>
   ${!flagRows.length ? '<div class="empty">Nothing flagged. No position is taking 2× or more of its weight in risk, and nothing duplicates a larger holding.</div>'
    : `<table><thead><tr><th>Ticker</th><th class="num">Models</th><th class="num">Worst ratio</th><th>Why</th></tr></thead><tbody>
   ${flagRows.map(([tk, fs]) => {
     const worst = fs.slice().sort((a, b) => (+b.risk_ratio || 0) - (+a.risk_ratio || 0))[0];
     return `<tr><td><b>${esc(tk)}</b></td>
      <td class="num">${fs.length}</td>
      <td class="num" style="color:var(--neg)">${n(worst.risk_ratio) === null ? '–' : n(worst.risk_ratio).toFixed(2) + '×'}</td>
      <td style="max-width:420px;color:var(--muted)">${esc(worst.rationale || '')}</td></tr>`;
   }).join('')}
   </tbody></table>
   <p class="note">A high ratio is not by itself a criticism — equity risk in a growth model <i>should</i> outrun its weight. It is the prompt to say out loud what the position is for. A name appearing across several models is where the desk's risk is genuinely concentrated.</p>`}
  </div>`;

  // Stan's own written work, from the workspace.
  const docs = (D.outputs || []).filter(o => o.agent === 'stan').sort((a, b) => b.as_of.localeCompare(a.as_of));
  const docsCard = `<div class="card"><h2 style="font-size:20px;margin-bottom:14px">Stan's notes</h2>
   ${!docs.length ? '<div class="empty">No written output yet. Run Stan, then jobs/sync-agent-outputs.mjs.</div>'
    : docs.map((o, i) => `<details ${i === 0 ? 'open' : ''} style="margin-bottom:8px">
        <summary style="cursor:pointer;padding:6px 0"><b>${esc(o.title)}</b> <span class="chip">${esc(o.as_of)}</span></summary>
        <div style="padding-top:6px">${md(o.body_md)}</div></details>`).join('')}
   <p class="note">Written by the Stan agent from the desk workspace. Dated: check the as-of before relying on a number, since these refresh on their own schedule rather than with the nightly data.</p></div>`;

  return `<span class="eyebrow">Risk</span><h1>Stan</h1>
   <p class="sub">Where the risk sits across the eight models, what is flagged, and Stan's own read.</p>
   <div class="kpis" style="grid-template-columns:repeat(5,1fr)">
    <div class="card kpi click" data-go="#stan/speed-limit" style="cursor:pointer" title="Open the master Speed Limit and how each model sits against it">
      <span class="eyebrow">Speed Limit</span>
      <b style="font-size:26px;color:${master && master.light ? LIGHT_COLOR[master.light] : 'var(--muted)'}">${master && master.sign_label ? esc(master.sign_label.replace(/^Speed Limit\s*/i, '')) : '—'}</b>
      <small>${master && master.light ? esc(LIGHT_MEANING[master.light]) : 'no reading'}${master && master.n_calls ? ` · ${master.n_calls} call${master.n_calls === 1 ? '' : 's'}` : ''}</small></div>
    ${LENSES.map(l => {
      const r = (D.lensSnr || []).find(x => x.category === l.key && x.window_label === 'YTD');
      const v = r && r.signal_to_noise !== null ? +r.signal_to_noise : null;
      return `<div class="card kpi click" data-go="#stan/snr-${l.key}" style="cursor:pointer" title="Signal-to-noise for ${l.label.toLowerCase()} sources — click for the breakdown by source">
        <span class="eyebrow">${esc(l.label)} SNR</span>
        <b style="font-size:26px;color:${v === null ? 'var(--muted)' : v > 0 ? 'var(--pos)' : 'var(--neg)'}">${v === null ? '—' : v.toFixed(2)}</b>
        <small>${!r || !r.n_scored ? 'nothing scored yet' : r.too_few_to_judge ? `${r.n_scored} call${r.n_scored === 1 ? '' : 's'} · too few to judge` : `${r.n_scored} calls · YTD`}</small></div>`;
    }).join('')}
   </div>
   ${riskTable}${flagsCard}${positionScatter()}${docsCard}`;
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

// Minimal markdown for agent output. Everything is HTML-escaped BEFORE any formatting is applied,
// so no markup can survive from the source text — the bodies are written by agents from material
// the desk clipped off the web, and that is not content to trust with raw HTML. Only a small,
// closed set of transforms runs afterwards: headings, bold, italic, inline code, bullet and
// numbered lists, blockquotes, rules, tables and paragraphs. Link syntax renders as text plus a
// bare URL rather than an anchor, deliberately — a clickable link from untrusted text is exactly
// the thing not worth adding for a little convenience.
function md(src) {
  if (!src) return '';
  const lines = esc(String(src)).split('\n');
  const inline = t => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 <span style="color:var(--muted)">($2)</span>');

  const out = [];
  let list = null, inTable = false, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); closeList(); closeTable(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); closeTable(); const lvl = Math.min(h[1].length + 1, 6); out.push(`<h${lvl} style="font-size:${17 - h[1].length}px;margin:12px 0 6px">${inline(h[2])}</h${lvl}>`); continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); closeTable(); out.push('<hr style="border:none;border-top:1px solid var(--line);margin:12px 0">'); continue; }

    // Tables: a header row followed by a separator row of dashes.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (/^[\s|:-]+$/.test(line)) continue;          // the separator row itself
      flushPara(); closeList();
      if (!inTable) { out.push(`<table><thead><tr>${cells.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`); inTable = true; }
      else out.push(`<tr>${cells.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();

    const q = line.match(/^&gt;\s?(.*)$/);
    if (q) { flushPara(); closeList(); out.push(`<blockquote style="border-left:3px solid var(--line);margin:8px 0;padding:2px 0 2px 10px;color:var(--muted)">${inline(q[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want} style="margin:6px 0 6px 18px">`); list = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara(); closeList(); closeTable();
  return out.join('');
}

// ---------- The Playground: a what-if sandbox ----------
//
// Change the asset-class mix and watch the model's factor exposures, its stress scores and its
// role split move. Everything here is computed in the browser from data already loaded — nothing
// is written, nothing is saved, and no allocation changes as a result. That is the point: a place
// to ask "what would happen if" without touching the model.
//
// The arithmetic is the same as the server's: net exposure is the weight-sum of each class's
// factor loadings, and a scenario's factor score is that exposure vector dotted with the
// scenario's shock. So a number moved here means what the same number means everywhere else.
let pgModelId = null;
let pgWeights = null;   // { classSlug: weight } — null until a model is chosen

function pgReset(m) {
  pgWeights = {};
  for (const [slug, w] of m.byClass) pgWeights[slug] = w;
}
function pgExposure(weights) {
  const out = D.factors.map(() => 0);
  let covered = 0, total = 0;
  for (const [slug, w] of Object.entries(weights)) {
    total += w;
    const row = D.matrix.find(r => r.slug === slug);
    if (!row) continue;
    let any = false;
    row.v.forEach((v, i) => { if (v !== null) { out[i] += w * +v; any = true; } });
    if (any) covered += w;
  }
  return { net: out, coverage: total ? covered / total : 0, total };
}

function playground() {
  const models = D.models;
  if (!models.length) return '<div class="empty">No models loaded.</div>';
  const m = models.find(x => x.id === pgModelId) || models[0];
  if (!pgWeights || pgModelId !== m.id) { pgModelId = m.id; pgReset(m); }

  const base = pgExposure(Object.fromEntries(m.byClass));
  const now = pgExposure(pgWeights);
  const total = Object.values(pgWeights).reduce((s, w) => s + w, 0);

  const classes = (D.classes || []).map(c => c.slug).filter(s => s !== 'unclassified');
  for (const s of Object.keys(pgWeights)) if (!classes.includes(s)) classes.push(s);

  const roleOf = s => D.roleByClassSlug?.[s] || 'unassigned';
  const byRole = {};
  for (const [s, w] of Object.entries(pgWeights)) byRole[roleOf(s)] = (byRole[roleOf(s)] || 0) + w;
  const roleParts = ['growth', 'inflation', 'liquidity', 'unassigned'].filter(k => byRole[k])
    .map(k => ({ label: ROLE_LABEL[k], v: byRole[k], color: ROLE_COLORS[k] }));

  const scenarios = D.scenarios || [];
  const scRow = sc => {
    const shocks = sc.shocks || {};
    const scoreOf = exp => D.factors.reduce((s, f, i) => s + (exp.net[i] * (shocks[f.slug] ?? 0)), 0);
    const b = scoreOf(base), n = scoreOf(now), d = n - b;
    return `<tr><td>${esc(sc.name)}</td>
      <td class="num"><span class="cell" style="${heat(Math.max(-1, Math.min(1, b)))}">${sgn(b)}</span></td>
      <td class="num"><span class="cell" style="${heat(Math.max(-1, Math.min(1, n)))}">${sgn(n)}</span></td>
      <td class="num" style="color:${Math.abs(d) < 0.005 ? 'var(--muted)' : d > 0 ? 'var(--pos)' : 'var(--neg)'}">${Math.abs(d) < 0.005 ? '—' : sgn(d)}</td></tr>`;
  };

  const dirty = classes.some(s => Math.abs((pgWeights[s] || 0) - (Object.fromEntries(m.byClass)[s] || 0)) > 1e-9);

  return `<span class="eyebrow">Sandbox</span><h1>The Playground</h1>
   <p class="sub">Change the mix and see where the exposures and the stress scores go. Nothing here is saved, and no allocation changes as a result.</p>

   <div class="card" style="margin-bottom:14px">
    <h2>Model</h2>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
     ${models.map(x => `<span class="click" data-pgmodel="${esc(x.id)}" style="cursor:pointer;padding:4px 10px;border-radius:6px;font-size:12px;background:${x.id === m.id ? 'var(--panel2)' : 'transparent'};color:${x.id === m.id ? 'var(--text)' : 'var(--muted)'}">${esc(x.name)}</span>`).join('')}
    </div>
    ${dirty ? '<span class="click chip" data-pgreset="1" style="cursor:pointer">Reset to the model\'s actual weights</span>' : '<span style="color:var(--muted);font-size:12px">Showing the model\'s actual weights.</span>'}
   </div>

   <div class="card" style="margin-bottom:14px"><h2>Mix <span class="num" style="float:right;color:${Math.abs(total - 1) < 0.005 ? 'var(--muted)' : 'var(--warn)'}">${pct(total)}</span></h2>
    <table><thead><tr><th>Asset class</th><th>Role</th><th class="num">Model</th><th class="num">What-if</th><th></th></tr></thead><tbody>
    ${classes.map(s => {
      const cur = Object.fromEntries(m.byClass)[s] || 0;
      const w = pgWeights[s] || 0;
      const d = w - cur;
      return `<tr><td><b>${esc(D.classNames[s] || s)}</b></td>
       <td><span style="color:${ROLE_COLORS[roleOf(s)]};font-size:12px">${esc(roleOf(s))}</span></td>
       <td class="num" style="color:var(--muted)">${pct(cur)}</td>
       <td class="num" style="color:${Math.abs(d) < 1e-9 ? 'var(--text)' : d > 0 ? 'var(--pos)' : 'var(--neg)'}">${pct(w)}</td>
       <td style="white-space:nowrap">
        <span class="click" data-pgadj="${esc(s)}|-0.05" style="cursor:pointer;padding:1px 7px;border:1px solid var(--line);border-radius:4px">−5</span>
        <span class="click" data-pgadj="${esc(s)}|-0.01" style="cursor:pointer;padding:1px 7px;border:1px solid var(--line);border-radius:4px">−1</span>
        <span class="click" data-pgadj="${esc(s)}|0.01"  style="cursor:pointer;padding:1px 7px;border:1px solid var(--line);border-radius:4px">+1</span>
        <span class="click" data-pgadj="${esc(s)}|0.05"  style="cursor:pointer;padding:1px 7px;border:1px solid var(--line);border-radius:4px">+5</span>
       </td></tr>`;
    }).join('')}
    </tbody></table>
    <p class="note">Weights are in percentage points of the whole model. They are not forced to sum to 100% — if the total drifts it is shown above in amber, because a mix that does not add up is a legitimate thing to look at on the way to one that does, and silently renormalising would hide it.</p>
   </div>

   <div class="card" style="margin-bottom:14px"><h2>Net exposure</h2>
    <table><thead><tr><th>Factor</th><th class="num">Model</th><th class="num">What-if</th><th class="num">Change</th></tr></thead><tbody>
    ${D.factors.map((f, i) => {
      const b = base.net[i], n = now.net[i], d = n - b;
      return `<tr><td>${esc(fname(f))}</td>
       <td class="num"><span class="cell" style="${heat(b)}">${sgn(b)}</span></td>
       <td class="num"><span class="cell" style="${heat(n)}">${sgn(n)}</span></td>
       <td class="num" style="color:${Math.abs(d) < 0.005 ? 'var(--muted)' : d > 0 ? 'var(--pos)' : 'var(--neg)'}">${Math.abs(d) < 0.005 ? '—' : sgn(d)}</td></tr>`;
    }).join('')}
    </tbody></table>
    <p class="note">Weight-summed asset-class loadings, the same arithmetic the model itself uses — so a number that moves here means what it means everywhere else. Loadings are subjective drafts. Coverage ${pct(now.coverage, 0)} of the mix has a loading.</p>
   </div>

   <div class="card" style="margin-bottom:14px"><h2>Stress scores</h2>
    ${scenarios.length ? `<table><thead><tr><th>Scenario</th><th class="num">Model</th><th class="num">What-if</th><th class="num">Change</th></tr></thead><tbody>
    ${scenarios.map(scRow).join('')}</tbody></table>` : '<div class="empty">No scenarios loaded.</div>'}
    <p class="note">Each score is the exposure vector dotted with the scenario's shock. A <b>directional score, not a predicted return</b>. The historical replay on the model page cannot be recomputed here, because it needs holding-level prices rather than class weights.</p>
   </div>

   <div class="card"><h2>Role split</h2>
    <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
     ${donutSvg(roleParts, 170)}
     <table style="flex:1;min-width:180px;margin:0"><tbody>
      ${roleParts.map(p => `<tr><td><b style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${p.color};margin-right:7px"></b>${esc(p.label)}</td><td class="num">${pct(p.v / (roleParts.reduce((s, x) => s + x.v, 0) || 1))}</td></tr>`).join('')}
     </tbody></table>
    </div>
    <p class="note">Roles are a draft; see the note on any model page. This is a share of allocation, not the signed exposure above.</p>
   </div>`;
}

// ---------- Decisions (Annie) and Briefs (Sisyphus) ----------
// Both read agent_outputs, which is populated by jobs/sync-agent-outputs.mjs from the workspace.
// Bodies are rendered with md() above, which escapes before formatting.
function outputsFor(agent, kinds) {
  return (D.outputs || []).filter(o => o.agent === agent && (!kinds || kinds.includes(o.kind)));
}

// ---------- Annie: the decision coach ----------
//
// Two kinds of thing live on this page and they must never be made to look alike. The scorecard,
// the position scores and the trade journal are ARITHMETIC, computed from dated snapshots and
// adjusted prices by jobs/compute-decision-ledger.mjs. The reflexivity, bias, steel-man, Kahneman
// and Monday-morning sections are JUDGMENT, written by the Annie agent after reading something.
// The second kind carries its sources and the date it was formed; the first carries its flags.
let annieWindow = 'ITD';

function annie() {
  // Same two helpers the other pages declare locally; keep them in step if they ever move to
  // module scope.
  const n = v => v === null || v === undefined ? null : +v;
  const col = v => v === null ? 'var(--muted)' : v >= 0 ? 'var(--pos)' : 'var(--neg)';
  const stats = D.decisionStats || [];
  const trades = D.trades || [];
  const scores = D.positionScores || [];
  const assess = D.assessments || [];
  const modelName = id => (D.models.find(m => m.id === id) || {}).name || '—';
  const bare = s => String(s || '').replace(/\s*\([^)]*\)/g, '');

  // ---- scorecard, one row per model that has a ledger at all ----
  const scorecard = (() => {
    if (!stats.length) {
      return `<div class="card" style="margin-bottom:14px"><h2>Scorecard</h2>
        <div class="empty">No model has a dated holdings history loaded, so there are no trades to grade. Load one with jobs/load-holdings-history.mjs and run jobs/compute-decision-ledger.mjs.</div></div>`;
    }
    const missing = (D.models || []).filter(m => !stats.some(s => s.strategy_id === m.id));
    const kpi = (lab, val, sub, title) => `<div class="card kpi" title="${esc(title)}">
      <span class="eyebrow">${esc(lab)}</span><b style="font-size:26px">${val}</b><small>${esc(sub)}</small></div>`;
    return stats.map(s => {
      const ba = n(s.batting_average), sl = n(s.slugging_bps);
      const w = n(s.win_bps) || 0, l = n(s.loss_bps) || 0;
      const beat = n(s.n_beat_benchmark), ex = n(s.excess_bps_total);
      const beatRate = beat === null || !s.n_closed ? null : beat / s.n_closed;
      return `<div class="card" style="margin-bottom:14px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
          <h2 style="margin:0">${esc(bare(modelName(s.strategy_id)))} — scorecard</h2>
          <span style="font-size:12px;color:var(--muted)">${esc(s.first_snapshot)} to ${esc(s.last_snapshot)} · ${s.n_closed} completed, ${s.n_open} open</span></div>
        <div class="kpis" style="grid-template-columns:repeat(5,1fr);margin-top:12px">
          ${kpi('Batting average', ba === null ? '—' : ba.toFixed(3).replace(/^0/, ''),
                `${s.n_wins} of ${s.n_closed} exited profitable`,
                'Share of completed trades that exited with a positive return. Ted Williams by way of Buffett: it counts hits, not distance.')}
          ${kpi('Beat the benchmark', beatRate === null ? '—' : beatRate.toFixed(3).replace(/^0/, ''),
                `${s.n_beat_benchmark} of ${s.n_closed} beat the index`,
                'The same completed trades, counted against what the benchmark would have given the same money. A trade can exit profitable having cost the model everything the index would have paid instead, which is why this sits beside the batting average rather than behind it.')}
          ${kpi('Slugging', sl === null ? '—' : `${sl >= 0 ? '+' : ''}${(sl / 100).toFixed(2)}%`,
                'of model return per completed trade',
                'Average contribution to the model\'s return per completed trade. The distance on the hits — a model can bat .700 and still lose money by sizing its winners small. Two decimals because the figure is a per-trade average and a basis point of it is real money.')}
          ${kpi('Wins vs losses', `<span style="color:var(--pos)">${s.n_wins}</span><span style="color:var(--muted)">/</span><span style="color:var(--neg)">${s.n_losses}</span>`,
                `+${w.toFixed(0)} bps won, ${l.toFixed(0)} bps lost`,
                'Completed trades split by whether they exited profitable, with the basis points each side contributed.')}
          ${kpi('Median position', s.median_weight === null ? '—' : pct(+s.median_weight),
                'the size a verdict is judged against',
                'The median weight this model gives a position. The sizing verdict on each trade is read against it.')}
        </div>
        <p class="note">${beatRate !== null && ba !== null && beatRate < ba - 0.05
          ? `<b>These two counts disagree, and the disagreement is the finding.</b> ${s.n_wins} of ${s.n_closed} trades exited profitable; ${beat} of the same ${s.n_closed} beat the benchmark${ex === null ? '' : `, and the per-trade excess sums to ${ex >= 0 ? '+' : ''}${ex.toFixed(0)} bps`}. A trade can exit profitable having cost the model everything the index would have paid instead — a cash line is the clean case, with a permanent perfect batting average and a permanently negative decision score in a rising market. <i>That excess total is a rough aggregate across trades that ran over different, non-overlapping spans; it answers "how did these decisions fare against the index, added up" and is not the model's underperformance over any period.</i> ` : ''}${s.n_unpriced ? `<b>${s.n_unpriced} position${s.n_unpriced === 1 ? '' : 's'} could not be priced</b> and ${s.n_unpriced === 1 ? 'is' : 'are'} excluded from every figure here. ` : ''}${s.gap_days ? `The history has a ${s.gap_days}-day hole, and a round trip that opened and closed inside it is invisible — not counted as a win or a loss, simply absent. ` : ''}Trades are derived from the dated snapshots, not from a broker file: a ticker present in one snapshot and absent from the one before was bought, present and then absent was sold. A round trip that opened and closed between two snapshots cannot be seen at all.</p></div>`;
    }).join('') + (!missing.length ? '' : `<div class="card" style="margin-bottom:14px"><h2>Not yet gradeable</h2>
      <div class="empty">${missing.map(m => esc(bare(m.name))).join(', ')} — these models have target weights but no dated holdings history, so there is nothing to compare over time and no trades to grade.</div></div>`);
  })();

  // ---- decision score per open position, across the owner's windows ----
  const positions = (() => {
    if (!scores.length) {
      return `<div class="card" style="margin-bottom:14px"><h2>Current positions</h2>
        <div class="empty">No open positions scored yet. Run jobs/compute-decision-ledger.mjs.</div></div>`;
    }
    const WINS = [['ITD', 'Inception to date'], ['1W', '1 week'], ['1M', '1 month'], ['6M', '6 months'], ['12M', '12 months']];
    const rows = scores.filter(r => r.window_key === annieWindow)
      .sort((a, b) => (n(b.decision_bps) ?? -1e9) - (n(a.decision_bps) ?? -1e9));
    const tabs = `<div class="tabs" style="margin:0">${WINS.map(([k, lbl]) =>
      `<button class="tab" data-anniewin="${k}" aria-selected="${k === annieWindow}" title="${esc(lbl)}">${k}</button>`).join('')}</div>`;
    const total = rows.reduce((s, r) => s + (n(r.decision_bps) || 0), 0);
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Current positions — decision score</h2>${tabs}</div>
      <div style="overflow-x:auto;margin-top:12px"><table style="min-width:720px"><thead><tr>
        <th>Position</th><th>Model</th><th class="num">Weight</th><th class="num">Position</th>
        <th class="num">Benchmark</th><th class="num">Decision score</th></tr></thead><tbody>
      <tr style="border-bottom:2px solid var(--line);background:var(--panel2)">
        <td><b>ALL POSITIONS</b></td><td></td><td class="num"></td><td class="num"></td><td class="num"></td>
        <td class="num"><b style="color:${col(total)}">${total >= 0 ? '+' : ''}${total.toFixed(0)} bps</b></td></tr>
      ${rows.map(r => {
        const d = n(r.decision_bps);
        const flags = [
          r.is_partial ? 'Younger than this window, so the score covers the position\'s life rather than the named period.' : '',
          r.starts_in_gap ? 'First appears at the snapshot after the hole in the history, so it may have been bought anywhere inside it.' : '',
        ].filter(Boolean).join(' ');
        return `<tr><td><b>${esc(r.ticker)}</b>${r.is_partial ? '<sup style="color:var(--warn)" title="partial window">·</sup>' : ''}</td>
          <td style="color:var(--muted)">${esc(bare(modelName(r.strategy_id)))}</td>
          <td class="num">${pct(+r.weight)}</td>
          <td class="num">${r.position_return === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:${col(+r.position_return)}">${(+r.position_return * 100).toFixed(1)}%</span>`}</td>
          <td class="num">${r.benchmark_return === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:var(--muted)">${(+r.benchmark_return * 100).toFixed(1)}%</span>`}</td>
          <td class="num"${flags ? ` title="${esc(flags)}"` : ''}>${d === null
            ? `<span style="color:var(--muted)" title="${esc(r.unavailable_reason || '')}">–</span>`
            : `<b style="color:${col(d)}">${d >= 0 ? '+' : ''}${d.toFixed(0)}</b>`}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="note">The decision score is <b>weight × (what the position did − what the benchmark did)</b>, in basis points: what holding this rather than the index was worth to the model. It scores the decision, not the weather — a position up 8% while the index was up 10% cost the model, and a plain return column would call that a good quarter. Positions marked <sup style="color:var(--warn)">·</sup> are younger than the window, so their score covers the position's life instead; hover for the dates.</p></div>`;
  })();

  // ---- the journal: completed trades, graded ----
  const journal = (() => {
    const closed = trades.filter(t => t.status === 'closed').slice()
      .sort((a, b) => String(b.exit_date).localeCompare(String(a.exit_date)));
    if (!closed.length) {
      return `<div class="card" style="margin-bottom:14px"><h2>Trade journal</h2>
        <div class="empty">No completed trades recovered. Run jobs/compute-decision-ledger.mjs.</div></div>`;
    }
    const VERDICT = {
      too_small:   ['Too small', 'var(--warn)', 'It won, and the model held less of it than it usually holds of anything.'],
      too_large:   ['Too large', 'var(--neg)', 'It lost, and the model held more of it than it usually holds of anything.'],
      well_sized:  ['Well sized', 'var(--pos)', 'Size and outcome pulled the same way: a winner held big, or a loser held small.'],
      about_right: ['About right', 'var(--muted)', 'Within a quarter of the model\'s median position size.'],
    };
    const divergent = closed.filter(t => t.total_return !== null && t.contribution_bps !== null
      && Math.sign(+t.total_return) !== Math.sign(+t.contribution_bps) && +t.contribution_bps !== 0);
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Trade journal</h2>
        <span style="font-size:12px;color:var(--muted)">${closed.length} completed, newest first</span></div>
      <div style="overflow-x:auto;margin-top:10px"><table style="min-width:860px"><thead><tr>
        <th>Position</th><th>Model</th><th>Held</th><th class="num">Avg size</th>
        <th class="num">Exit return</th><th class="num">Contribution</th><th class="num">Vs benchmark</th><th>Sizing</th>
      </tr></thead><tbody>
      ${closed.map(t => {
        const v = VERDICT[t.sizing_verdict] || null;
        const marks = [
          t.pre_existing ? 'Already held when the records begin, so nobody bought it on that date and this return is not evidence about a decision.' : '',
          t.starts_in_gap ? 'First appears at the snapshot after the hole in the history; it may have been bought anywhere inside it.' : '',
        ].filter(Boolean).join(' ');
        return `<tr${t.pre_existing ? ' style="opacity:.72"' : ''}>
          <td><b>${esc(t.ticker)}</b>${marks ? `<sup style="color:var(--warn)" title="${esc(marks)}">·</sup>` : ''}</td>
          <td style="color:var(--muted)">${esc(bare(modelName(t.strategy_id)))}</td>
          <td style="color:var(--muted);white-space:nowrap">${esc(t.entry_date)} → ${esc(t.exit_date)}</td>
          <td class="num">${pct(+t.avg_weight)}</td>
          <td class="num">${t.total_return === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:${col(+t.total_return)}">${(+t.total_return * 100).toFixed(1)}%</span>`}</td>
          <td class="num">${t.contribution_bps === null ? '<span style="color:var(--muted)">–</span>' : `<b style="color:${col(+t.contribution_bps)}">${+t.contribution_bps >= 0 ? '+' : ''}${(+t.contribution_bps).toFixed(0)}</b>`}</td>
          <td class="num">${t.excess_bps === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:${col(+t.excess_bps)}">${+t.excess_bps >= 0 ? '+' : ''}${(+t.excess_bps).toFixed(0)}</span>`}</td>
          <td>${v ? `<span style="color:${v[1]}" title="${esc(v[2])}">${v[0]}</span>` : '<span style="color:var(--muted)">–</span>'}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="note">Contribution is accumulated at the weight actually held in each stretch, not average size times the whole-period return, because a position trimmed before a fall contributed less than its full-size return implies — and that gap is the entire sizing question.${divergent.length ? ` <b>${divergent.length} trade${divergent.length === 1 ? '' : 's'} here exited profitable but contributed negatively, or the reverse</b> (${divergent.slice(0, 4).map(t => esc(t.ticker)).join(', ')}${divergent.length > 4 ? '…' : ''}); when those two disagree the path is the story, not the entry and exit.` : ''} Faded rows were already held on the first day of the records, so their return is measured from where the file starts rather than from a decision. Exits are dated at the snapshot where the position was first absent, which is on or after the day it was sold.</p></div>`;
  })();

  // ---- the written sections ----
  const KINDS = [
    ['reflexivity', 'Reflexivity', 'Soros\'s two-way feedback: does the price move the fundamentals here, or only reflect them? A position where belief changes the thing being believed in behaves differently from one where it does not.',
     'Nothing scored yet. Annie writes these after reading the research in the inbox and what is being said publicly about the name, then loads them with jobs/load-annie-assessments.mjs. Run the Annie agent to fill this in.'],
    ['confirmation_bias', 'Confirmation bias', 'The three biases most likely at work entering a position, drawn from what the desk was reading at the time.',
     'Nothing written yet. Annie derives these from the research pieces actually in the inbox, so there is something to point at rather than a generic list of biases.'],
    ['steel_man', 'The steel man', 'The strongest honest case against each position — not the weak version that is easy to dismiss.',
     'Nothing written yet. A steel man is only worth reading if it was built from real opposing evidence, so this fills in once Annie has sources to build it from.'],
    ['kahneman', 'Thinking fast and slow', 'Where a decision looks like system one: anchoring, availability, loss aversion, substituting an easy question for a hard one.',
     'Nothing written yet. Annie reads this page\'s own ledger alongside the decision journal to spot the pattern, which needs both to exist first.'],
    ['monday_qb', 'Monday morning QB', 'What the desk would do differently, written after the outcome is known and graded on the reasoning rather than the result.',
     'Nothing written yet. This one is deliberately retrospective — it needs completed trades with an outcome and a recorded rationale to compare.'],
    ['sizing_recommendation', 'Position sizing', 'What the ledger implies about size on the next one, from how this model\'s own winners and losers were actually sized.',
     'Nothing written yet. The arithmetic above is the input: the sizing verdicts and the median position weight are what a recommendation has to argue from.'],
  ];
  const written = KINDS.map(([kind, title, blurb, empty]) => {
    const rows = assess.filter(a => a.kind === kind)
      .sort((a, b) => String(b.as_of).localeCompare(String(a.as_of)) || (n(b.score) ?? -1e9) - (n(a.score) ?? -1e9));
    return `<div class="card" style="margin-bottom:14px"><h2>${esc(title)}</h2>
      <p class="note" style="margin:0 0 10px">${blurb}</p>
      ${!rows.length ? `<div class="empty">${esc(empty)}</div>` : rows.map(a => {
        const src = Array.isArray(a.sources) ? a.sources : [];
        return `<details style="margin-bottom:8px"${rows.indexOf(a) === 0 ? ' open' : ''}>
          <summary style="cursor:pointer;padding:6px 0">
            ${a.ticker ? `<b>${esc(a.ticker)}</b> ` : a.strategy_id ? `<b>${esc(bare(modelName(a.strategy_id)))}</b> ` : '<b>Desk</b> '}
            ${esc(a.headline)}
            ${a.score !== null && a.score !== undefined ? `<span class="chip" title="${esc(a.score_scale || 'No scale recorded for this score')}">${(+a.score).toFixed(1)}</span>` : ''}
            <span class="chip">${esc(a.as_of)}</span>
            ${a.confidence ? `<span class="chip">${esc(a.confidence)} confidence</span>` : ''}</summary>
          <div style="padding-top:6px">${md(a.body_md)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px">${src.length
            ? 'Read: ' + src.map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a>` : esc(s.title || '')).join(' · ')
            : '<b>No sources recorded.</b> Treat this as an opinion rather than a finding.'}</div></details>`;
      }).join('')}</div>`;
  }).join('');

  // ---- Annie's own written output, from the workspace ----
  const outs = (kinds) => (D.outputs || []).filter(o => o.agent === 'annie' && kinds.includes(o.kind))
    .slice().sort((a, b) => b.as_of.localeCompare(a.as_of));
  const open = outs(['open_decisions']);
  const note = (title, list, emptyMsg) => `<div class="card" style="margin-bottom:14px"><h2>${esc(title)}</h2>
    ${list.length ? list.map(o => `<div style="margin-bottom:10px"><div class="eyebrow">as of ${esc(o.as_of)}</div>${md(o.body_md)}</div>`).join('')
                  : `<div class="empty">${esc(emptyMsg)}</div>`}</div>`;

  return `<span class="eyebrow">Annie</span><h1>Decision Coach</h1>
   <p class="sub">OODA — Observe, Orient, Decide, Assess.</p>
   ${scorecard}
   ${positions}
   ${journal}
   ${note('Open decisions', open, 'Nothing open. Annie records a decision before it is made, not after.')}
   ${written}
   <p class="note">Everything above the written sections is arithmetic: the trades come from dated holdings snapshots and the returns from adjusted closing prices, computed by <code>jobs/compute-decision-ledger.mjs</code>. Everything in the written sections is judgment formed by reading something, and each one carries the date it was formed and what it was formed from. The two are kept apart on purpose — a batting average and a steel man are not the same kind of claim, and a page that styles them alike invites them to be trusted alike.</p>`;
}

function briefs() {
  const morning = outputsFor('sisyphus', ['morning_brief']).slice().sort((a, b) => b.as_of.localeCompare(a.as_of));
  const primers = outputsFor('sisyphus', ['sunday_primer']).slice().sort((a, b) => b.as_of.localeCompare(a.as_of));
  const list = (title, rows, emptyMsg) => `
   <div class="card" style="margin-bottom:14px"><h2>${esc(title)}</h2>
    ${rows.length ? rows.map((o, i) => `<details ${i === 0 ? 'open' : ''} style="margin-bottom:8px">
        <summary style="cursor:pointer;padding:6px 0"><b>${esc(o.title)}</b></summary>
        <div style="padding-top:6px">${md(o.body_md)}</div></details>`).join('')
      : `<div class="empty">${esc(emptyMsg)}</div>`}</div>`;
  return `<span class="eyebrow">Sisyphus</span><h1>Briefs</h1>
   <p class="sub">The daily morning brief and the Sunday primer, synthesised across the desk.</p>
   ${list('Morning briefs', morning, 'No brief yet. Run the morning-brief skill, then jobs/sync-agent-outputs.mjs.')}
   ${list('Sunday primers', primers, 'No primer yet. The primer answers "what do we care about this week and why?"')}
   <p class="note">Briefs synthesise Adam, Stan, Megan and Annie. Sven's and Gail's data is deliberately excluded unless the owner explicitly taps it in for a specific question — that isolation is a standing rule, not an oversight, and a tap-in is recorded in their tap-ins log when it happens.</p>`;
}

// The firm's factor matrix and the owner-chosen splits. These must stay in step with
// jobs/compute-model-reporting.mjs, which computes the same pie for storage; the page computes it
// live so that classifying a holding answers immediately rather than after the nightly run.
const FA_MATRIX = {
  equities:                { growth: 'L', inflation: 'F', liquidity: 'S' },
  bonds:                   { growth: 'S', inflation: 'S', liquidity: 'L' },
  cash:                    { growth: 'F', inflation: 'S', liquidity: 'L' },
  commodities_real_assets: { growth: 'L', inflation: 'L', liquidity: 'F' },
  gold:                    { growth: 'F', inflation: 'L', liquidity: 'L' },
};
// Holdings the owner has said have no CONFIRMED asset class. This list beats whatever the
// database holds, because this desk's classifier assigns classes by return correlation and an
// inferred label is not a confirmed one.
const FA_UNCONFIRMED = new Set(['QCFIX', 'CBYYX', 'BDMIX', 'QDSIX', 'PRWCX']);
const FA_FACTORS = ['growth', 'inflation', 'liquidity'];
// The asset-class look-throughs the owner can choose. Expressed as a mix of CLASSES, not of
// factors — that is what lets the short tally be derived, since shorts belong to a class and a
// factor share does not name one. Longs, shorts and loadings are then all weighted blends of
// FA_MATRIX rows, so nothing is assumed beyond the matrix itself.
// Keep in step with jobs/compute-model-reporting.mjs.
const SPLIT_OPTIONS = [
  { key: 'eq100',          label: 'Equity',                                           mix: { equities: 1.00 } },
  { key: 'fi100',          label: 'Fixed Income',                                     mix: { bonds: 1.00 } },
  { key: 'cash100',        label: 'Cash Equivalents',                                 mix: { cash: 1.00 } },
  { key: 'cm100',          label: 'Commodities',                                      mix: { commodities_real_assets: 1.00 } },
  { key: 'eq60_fi40',      label: '60% Equity / 40% Fixed Income',                    mix: { equities: 0.60, bonds: 0.40 } },
  { key: 'eq60_fi20_cm20', label: '60% Equity / 20% Fixed Income / 20% Commodities',  mix: { equities: 0.60, bonds: 0.20, commodities_real_assets: 0.20 } },
  { key: 'eq20_fi80',      label: '20% Equity / 80% Fixed Income',                    mix: { equities: 0.20, bonds: 0.80 } },
  { key: 'eq90_cm10',      label: '90% Equity / 10% Commodities',                     mix: { equities: 0.90, commodities_real_assets: 0.10 } },
];
const SPLIT_BY_KEY = Object.fromEntries(SPLIT_OPTIONS.map(o => [o.key, o]));

// Compute the pie, the short tally and the unclassified residual for a set of holdings.
// holdings: [{ ticker, security_id, weight }]. classOf(h) -> asset class slug or null.
function computeFactorAllocation(holdings, classOf, overrideBySec) {
  const longs = { growth: 0, inflation: 0, liquidity: 0 };
  const shorts = { growth: 0, inflation: 0, liquidity: 0 };
  // Who is in each slice, so the donut can name the holdings behind a wedge rather than only its
  // size. A holding long in two factors appears in both, each carrying the half-weight the pie
  // rule gave it — the same arithmetic the slice is made of, not a second version of it.
  const members = { growth: [], inflation: [], liquidity: [], unclassified: [] };
  const add = (f, h, w) => { if (w > 0) members[f].push({ ticker: h.ticker, w }); };
  let unclassified = 0;
  const unresolved = [], resolved = [];
  for (const h of holdings) {
    const w = +h.weight;
    const ov = h.security_id ? overrideBySec[h.security_id] : null;
    if (ov && SPLIT_BY_KEY[ov.split]) {
      // A look-through is a blend of real asset classes, so it earns both sides of the matrix:
      // the long pie AND the short tally, each weighted by the class share.
      for (const [cls, share] of Object.entries(SPLIT_BY_KEY[ov.split].mix)) {
        const row = FA_MATRIX[cls];
        if (!row) continue;
        const lf = FA_FACTORS.filter(f => row[f] === 'L');
        for (const f of lf) { longs[f] += w * share / lf.length; add(f, h, w * share / lf.length); }
        for (const f of FA_FACTORS) if (row[f] === 'S') shorts[f] += w * share;
      }
      resolved.push({ ...h, split: ov.split });
      continue;
    }
    const slug = FA_UNCONFIRMED.has(h.ticker) ? null : classOf(h);
    const row = slug ? FA_MATRIX[slug] : null;
    if (!row) { unclassified += w; unresolved.push(h); add('unclassified', h, w); continue; }
    const lf = FA_FACTORS.filter(f => row[f] === 'L');
    for (const f of lf) { longs[f] += w / lf.length; add(f, h, w / lf.length); }
    for (const f of FA_FACTORS) if (row[f] === 'S') shorts[f] += w;
  }
  // A holding split across classes can land in the same slice twice (60/40 equity and bonds are
  // both long nothing in common, but 60/20/20 is). Fold those together so a ticker is named once.
  for (const f of Object.keys(members)) {
    const byTicker = new Map();
    for (const e of members[f]) byTicker.set(e.ticker, (byTicker.get(e.ticker) || 0) + e.w);
    members[f] = [...byTicker].map(([ticker, w]) => ({ ticker, w })).sort((a, b) => b.w - a.w);
  }
  return { longs, shorts, unclassified, unresolved, resolved, members };
}

// Commit the staged classifications in one go. The dropdowns only stage a choice; nothing is
// written until Update is pressed. That is deliberate for client data — a classification changes
// what the allocation chart reports, so it should be an action taken rather than a side effect of
// brushing a dropdown. Writes are optimistic: local state updates first so the chart answers at
// once, and a failure puts it back and says so rather than leaving the screen disagreeing with
// the database.
async function commitSplits() {
  const pending = { ...repPending };
  const keys = Object.keys(pending);
  if (!keys.length) return;
  const prev = D.factorOverrides.slice();
  for (const [sid, split] of Object.entries(pending)) {
    D.factorOverrides = D.factorOverrides.filter(o => o.security_id !== sid);
    if (split) D.factorOverrides.push({ security_id: sid, split, author: 'site', as_of: new Date().toISOString().slice(0, 10) });
  }
  repPending = {}; repSaveError = null;
  openModel(repModelId);
  try {
    const ups = Object.entries(pending).filter(([, v]) => v)
      .map(([security_id, split]) => ({ security_id, split, author: 'site', as_of: new Date().toISOString().slice(0, 10) }));
    const dels = Object.entries(pending).filter(([, v]) => !v).map(([k]) => k);
    if (ups.length) { const { error } = await sb.from('holding_factor_overrides').upsert(ups, { onConflict: 'security_id' }); if (error) throw new Error(error.message); }
    for (const sid of dels) { const { error } = await sb.from('holding_factor_overrides').delete().eq('security_id', sid); if (error) throw new Error(error.message); }
  } catch (ex) {
    D.factorOverrides = prev;
    repSaveError = `Could not save ${keys.length === 1 ? 'that classification' : 'those classifications'}: ${ex.message}. The chart has been put back to what the database holds.`;
    openModel(repModelId);
  }
}

// ---------- Per-model dashboard, laid out to the owner's reference ----------
//
// Governing rule, from docs/claude-code-handoff.md: never show a number that was not computed
// from real data. A missing input renders an empty state naming what is missing and what would
// fill it — never a zero, never a blank that could be mistaken for one. Each statistic therefore
// carries a hover note saying how it WILL be calculated, so a dash is self-explanatory.
let repPeriod = '1YR', repDdPeriod = '1YR', repModelId = null, repSaveError = null;
let repPending = {};   // securityId -> split, staged by the dropdowns until Update is pressed
const REP_PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1YR', '3YR', '5YR', '10YR', 'ALL'];
const FCOLOR = { growth: 'var(--growth)', inflation: 'var(--inflation)', liquidity: 'var(--liquidity)', unclassified: 'var(--unclass)' };

// Drawdown within a window, peak reset at the window start — the prototype's tested rule:
// [100,110,99,120] must give [0%, 0%, -10%, 0%].
function drawdownSeries(points, get) {
  let peak = -Infinity;
  return points.map(p => { const v = get(p); if (v === null || v === undefined) return null; if (v > peak) peak = v; return v / peak - 1; });
}

// What a wedge says on hover: its own size, then the holdings inside it at the weight the pie
// rule actually gave them. A holding long in two factors shows half its weight in each, because
// that is what the slice is made of — showing its full weight in both would add up to more book
// than the model holds.
function sliceTip(d) {
  const head = `${d.label} — ${pct(d.v)} of the model`;
  const ms = d.members || [];
  if (!ms.length) return `${head}\nNothing in this slice.`;
  const lines = ms.map(x => `${x.ticker}  ${pct(x.w)}`);
  const shown = lines.slice(0, 18).join('\n');
  return `${head}\n${shown}${lines.length > 18 ? `\n+${lines.length - 18} more` : ''}`;
}

// A single hover panel, positioned at the cursor, shared by anything carrying data-tip. The donut
// wedges needed more than a native title tooltip could carry: a browser tooltip takes a second to
// appear and truncates a list of fifteen tickers unpredictably across browsers.
// Built on first hover rather than at load: nothing should touch document.body while the module
// is still evaluating, and it keeps the module importable in a headless harness.
let tipEl = null;
const tip = () => {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'hovertip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
};
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (!t) return;
  const el = tip();
  el.textContent = t.dataset.tip;
  el.hidden = false;
});
document.addEventListener('mousemove', e => {
  if (!tipEl || tipEl.hidden) return;
  // Flip to the other side of the cursor near an edge, so the panel never runs off the window.
  const pad = 14, r = tipEl.getBoundingClientRect();
  const x = e.clientX + pad + r.width > window.innerWidth ? e.clientX - pad - r.width : e.clientX + pad;
  const y = e.clientY + pad + r.height > window.innerHeight ? Math.max(4, e.clientY - pad - r.height) : e.clientY + pad;
  tipEl.style.left = `${Math.max(4, x)}px`;
  tipEl.style.top = `${y}px`;
});
document.addEventListener('mouseout', e => {
  if (tipEl && e.target.closest('[data-tip]')) tipEl.hidden = true;
});

// Donut with the growth share called out in the middle, per the reference.
function factorDonut(slices, size = 236) {
  const total = slices.reduce((s, d) => s + d.v, 0) || 1;
  const cx = size / 2, cy = size / 2, rO = size * 0.44, rI = size * 0.28;
  const arc = (a0, a1) => {
    const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const big = (a1 - a0) > Math.PI ? 1 : 0;
    const [x1, y1] = p(rO, a0), [x2, y2] = p(rO, a1), [x3, y3] = p(rI, a1), [x4, y4] = p(rI, a0);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)}A${rO} ${rO} 0 ${big} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}L${x3.toFixed(1)} ${y3.toFixed(1)}A${rI} ${rI} 0 ${big} 0 ${x4.toFixed(1)} ${y4.toFixed(1)}Z`;
  };
  let a = -Math.PI / 2, out = '';
  for (const d of slices) {
    if (d.v <= 0) continue;
    const a1 = a + (d.v / total) * Math.PI * 2;
    out += `<path d="${arc(a, Math.min(a1, a + Math.PI * 2 - 1e-6))}" fill="${FCOLOR[d.k] || 'var(--unclass)'}" stroke="var(--panel)" stroke-width="2"
      style="cursor:default" data-tip="${esc(sliceTip(d))}"></path>`;
    a = a1;
  }
  const g = slices.find(s => s.k === 'growth');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;overflow:visible">${out}
    <text class="hero" x="${cx}" y="${cy + 2}" text-anchor="middle">${pct(g ? g.v : 0)}</text>
    <text class="herolab" x="${cx}" y="${cy + 20}" text-anchor="middle">growth</text></svg>`;
}

// How each statistic will be computed. Shown on hover so an empty cell explains itself rather
// than looking like a bug.
const STAT_HOW = {
  model_return:     'Model return over the period, time-weighted. Reconstructed from holdings weights and daily adjusted prices, so it is gross of fees and approximate between trade dates.',
  benchmark_return: "The model's peer benchmark over the same window, on the same basis.",
  max_drawdown:     'Largest fall from a running peak inside the window. The peak resets at the window start, so each period begins at 0%.',
  upside_capture:   "Model return during the benchmark's up days divided by the benchmark's return on those days.",
  downside_capture: "Model return during the benchmark's down days divided by the benchmark's return on those days.",
  beta_sp500:       'Slope of model returns regressed on the S&P 500 over the window. Read R² alongside it: a beta from a poor fit is a number without a meaning.',
  dividend_yield:   "Weighted average of each holding's yield at current weights. No instrument-level yield source is connected, so this cannot be computed at all.",
  coverage:         'Share of model weight that was actually priced at the thinnest point of the window. A return computed over part of the model is not the model’s return.',
};

// Renders the dashboard body for ONE model. Lives in the model drawer rather than on a page of
// its own: the drawer is already per-model, so a selector would be a second way to do the same
// thing. Returns cards only — the caller supplies the heading and the holdings table.
function modelDashboard(m) {
  repModelId = m.id;

  const n = v => v === null || v === undefined ? null : +v;
  const pc = (v, d = 2) => v === null ? null : (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
  const col = v => v === null ? 'var(--muted)' : v >= 0 ? 'var(--pos)' : 'var(--neg)';

  const stats = (D.periodStats || []).filter(r => r.strategy_id === m.id);
  const stat = stats.find(r => r.period === repPeriod) || null;
  const series = (D.valueSeries || []).filter(v => v.strategy_id === m.id);
  const contrib = (D.contribution || []).filter(c => c.strategy_id === m.id && c.period === repPeriod);
  const integ = (D.snapIntegrity || []).filter(i => i.strategy_id === m.id);
  const hasHistory = series.length > 0;

  // ---- model statistics strip ----
  const cells = [
    ['Total return', stat && !stat.unavailable_reason ? pc(n(stat.model_return)) : null, 'model_return'],
    ['Benchmark', stat && !stat.unavailable_reason ? pc(n(stat.benchmark_return)) : null, 'benchmark_return'],
    ['Max drawdown', stat && !stat.unavailable_reason ? pc(n(stat.max_drawdown)) : null, 'max_drawdown'],
    ['Upside capture', stat && n(stat.upside_capture) !== null ? (n(stat.upside_capture) * 100).toFixed(0) + '%' : null, 'upside_capture'],
    ['Downside capture', stat && n(stat.downside_capture) !== null ? (n(stat.downside_capture) * 100).toFixed(0) + '%' : null, 'downside_capture'],
    ['Beta vs S&P 500', stat && n(stat.beta_sp500) !== null ? n(stat.beta_sp500).toFixed(2) + '×' : null, 'beta_sp500'],
    ['Dividend yield', null, 'dividend_yield'],
    ['Weight priced', stat && n(stat.min_coverage) !== null ? (n(stat.min_coverage) * 100).toFixed(0) + '%' : null, 'coverage'],
  ];
  const missing = cells.filter(c => c[1] === null).length;
  const statNote = !hasHistory ? 'No dated holdings history for this model — load one with jobs/load-holdings-history.mjs'
    : stat && stat.unavailable_reason ? esc(stat.unavailable_reason)
    : missing ? `${missing} of ${cells.length} awaiting data` : '';
  const statsCard = `<div class="card" style="margin-bottom:18px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-bottom:12px">
      <h2 style="margin:0">Model statistics</h2>
      <span style="font-size:12px;color:var(--muted)">${statNote}</span></div>
    <div class="tabs">${REP_PERIODS.map(p => { const s = stats.find(r => r.period === p); const dead = !hasHistory || (s && s.unavailable_reason);
      return `<button class="tab" data-repperiod="${p}" aria-selected="${p === repPeriod}" ${dead ? `disabled title="${esc(s && s.unavailable_reason || 'Needs a dated holdings history')}"` : ''}>${p}</button>`; }).join('')}</div>
    ${stat && !stat.unavailable_reason ? `<p class="sub" style="margin:4px 0 12px">${esc(stat.start_date)} to ${esc(stat.end_date)}${stat.window_starts_in_gap ? ' · <b style="color:var(--warn)">window start fell inside the history gap and was pulled back</b>' : ''}</p>` : ''}
    <div class="statstrip">${cells.map(([lab, val, how]) => `<div class="stat" title="${esc(STAT_HOW[how])}">
      <div class="slab">${lab}</div><div class="sval${val === null ? ' pending' : ''}" ${val !== null && /^[+-]/.test(val) ? `style="color:${col(parseFloat(val))}"` : ''}>${val === null ? '—' : esc(val)}</div></div>`).join('')}</div>
    <p class="note">Hover any statistic to see how it is calculated. ${stat && stat.method_note ? `<b>These are reconstructed, not the firm's reported figures.</b> ${esc(stat.method_note)}` : 'Nothing on this row is estimated or filled in by hand.'}</p></div>`;

  // ---- the two allocation panels ----
  const ovBySec = Object.fromEntries((D.factorOverrides || []).map(o => [o.security_id, o]));
  const staged = { ...ovBySec };
  for (const [sid, split] of Object.entries(repPending)) staged[sid] = split ? { security_id: sid, split } : undefined;
  const actualH = (D.currentHoldings || []).filter(h => h.strategy_id === m.id);
  const targetH = (m.holdings || []).filter(h => h.security_id);
  const clsOfSec = id => (D.markets.find(x => x.id === id) || {}).cls || null;

  const panel = (title, asof, holdings, classOf) => {
    if (!holdings.length) {
      return `<section class="card"><h2>${esc(title)}</h2><p class="asof" style="font-size:12px;color:var(--muted);margin:0 0 10px">${esc(asof)}</p>
        <div class="empty">No dated holdings snapshot for this model. Load one with jobs/load-holdings-history.mjs and the panel fills in.</div></section>`;
    }
    const r = computeFactorAllocation(holdings, classOf, staged);
    const slices = [
      { k: 'growth', label: 'Growth', v: r.longs.growth, members: r.members.growth },
      { k: 'inflation', label: 'Inflation', v: r.longs.inflation, members: r.members.inflation },
      { k: 'liquidity', label: 'Liquidity', v: r.longs.liquidity, members: r.members.liquidity },
      { k: 'unclassified', label: 'Unclassified', v: r.unclassified, members: r.members.unclassified },
    ];
    const shorts = [['Growth', r.shorts.growth], ['Inflation', r.shorts.inflation], ['Liquidity', r.shorts.liquidity]];
    const maxShort = Math.max(...shorts.map(x => x[1]));
    const top = shorts.filter(x => Math.abs(x[1] - maxShort) < 1e-9 && maxShort > 0);
    const unres = r.unresolved.slice().sort((a, b) => +b.weight - +a.weight);
    const res = r.resolved.slice().sort((a, b) => +b.weight - +a.weight);
    const rowFor = h => {
      const cur = staged[h.security_id] ? staged[h.security_id].split : '';
      return `<div class="row">
        <div><span class="tick">${esc(h.ticker)}</span><span class="wt">${pct(+h.weight)}</span></div>
        <select data-splitfor="${esc(h.security_id || '')}" ${h.security_id ? '' : 'disabled title="No matching security, so a split cannot be stored"'}>
          <option value="" ${!cur ? 'selected' : ''}>Leave unclassified</option>
          ${SPLIT_OPTIONS.map(o => `<option value="${o.key}" ${cur === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select></div>`;
    };
    const dirty = Object.keys(repPending).length > 0;
    return `<section class="card"><h2>${esc(title)}</h2><p class="asof" style="font-size:12px;color:var(--muted);margin:0 0 10px">${esc(asof)}</p>
      <div class="donutwrap">${factorDonut(slices)}</div>
      <ul class="flegend">${slices.filter(s => s.v > 0).map(s => `<li data-tip="${esc(sliceTip(s))}" style="cursor:default"><span class="sw" style="background:${FCOLOR[s.k]}"></span><span class="nm">${s.label}</span><span class="vl">${pct(s.v)}</span></li>`).join('')}</ul>
      <div class="shortbox"><div class="lab">Most short</div>
        <div class="val"><span class="pct" style="color:${maxShort > 0 ? 'var(--neg)' : 'var(--muted)'}">${pct(maxShort)}</span>
        <span class="fac">${top.length ? esc(top.map(t => t[0]).join(' and ')) : 'no short exposure'}</span></div></div>
      <div class="unc"><h3>Unclassified positions</h3>
        ${unres.length || res.length ? [...unres, ...res].map(rowFor).join('') : '<p style="color:var(--muted);font-size:12.5px;font-style:italic">None. Every position is classified.</p>'}
        ${(unres.length || res.length) ? `<button class="btn" data-repupdate="1" ${dirty ? '' : 'disabled'}>${dirty ? `Update allocation (${Object.keys(repPending).length} change${Object.keys(repPending).length === 1 ? '' : 's'})` : 'Update allocation'}</button>` : ''}
      </div></section>`;
  };

  const allocGrid = `<div class="dashgrid" style="margin-bottom:18px">
    ${panel('Target allocation', 'Current target weights', targetH, h => h.cls)}
    ${panel('Actual holdings', actualH.length ? `Snapshot ${actualH[0].as_of}` : 'No snapshot loaded', actualH, h => clsOfSec(h.security_id))}
  </div>`;

  // ---- contribution ----
  const cRows = contrib.slice().sort((a, b) => (n(b.contribution_bps) ?? -1e9) - (n(a.contribution_bps) ?? -1e9));
  const totalBps = cRows.reduce((s, c) => s + (n(c.contribution_bps) || 0), 0);
  const unpriced = cRows.filter(c => !c.priced);
  const SUSPECT = /can be simplified to|as an AI|\*\*/i;
  const contribCard = `<div class="card" style="margin-bottom:18px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Contribution summary</h2>
      <span style="font-size:12px;color:var(--muted)">${stat && !stat.unavailable_reason ? esc(stat.start_date) + ' → ' + esc(stat.end_date) : ''}</span></div>
    <div class="tabs">${REP_PERIODS.map(p => { const s = stats.find(r => r.period === p); const dead = !hasHistory || (s && s.unavailable_reason);
      return `<button class="tab" data-repperiod="${p}" aria-selected="${p === repPeriod}" ${dead ? `disabled title="${esc(s && s.unavailable_reason || 'Needs a dated holdings history')}"` : ''}>${p}</button>`; }).join('')}</div>
    ${!hasHistory ? '<div class="empty">No dated holdings history for this model.</div>'
      : stat && stat.unavailable_reason ? `<div class="empty">${esc(stat.unavailable_reason)}</div>`
      : !cRows.length ? '<div class="empty">No contribution rows for this period.</div>'
      : `<table><thead><tr><th>Ticker</th><th>Name</th><th class="num">Start wt</th><th class="num">Return</th><th class="num">End wt</th><th class="num">Contribution</th></tr></thead><tbody>
      <tr style="border-bottom:2px solid var(--line);background:var(--panel2)"><td><b>TOTAL</b></td><td></td><td class="num"><b>${pct(cRows.reduce((s, c) => s + (n(c.start_weight) || 0), 0))}</b></td><td class="num"></td><td class="num"><b>${pct(cRows.reduce((s, c) => s + (n(c.end_weight) || 0), 0))}</b></td><td class="num"><b style="color:${col(totalBps)}">${totalBps >= 0 ? '+' : ''}${totalBps.toFixed(0)} bps</b></td></tr>
      ${cRows.map(c => `<tr><td><b>${esc(c.ticker)}</b>${c.status === 'removed' ? ' <small style="color:var(--muted);font-style:italic">no longer held</small>' : c.status === 'added' ? ' <small style="color:var(--muted);font-style:italic">added in period</small>' : ''}</td>
        <td style="max-width:280px;color:var(--muted)">${SUSPECT.test(c.name_raw || '') ? `<span style="color:var(--warn)" title="This name contains AI-generated editorial text in the source export, shown verbatim">⚠ ${esc(c.name_raw)}</span>` : esc(c.name_raw || '')}</td>
        <td class="num">${n(c.start_weight) === null ? '–' : pct(n(c.start_weight))}</td>
        <td class="num">${c.priced ? `<span style="color:${col(n(c.period_return))}">${pc(n(c.period_return))}</span>` : '<span style="color:var(--muted)" title="No price for this holding across the window">no price</span>'}</td>
        <td class="num">${n(c.end_weight) === null ? '–' : pct(n(c.end_weight))}</td>
        <td class="num">${n(c.contribution_bps) === null ? '<span style="color:var(--muted)">—</span>' : `<span style="color:${col(n(c.contribution_bps))}">${n(c.contribution_bps) >= 0 ? '+' : ''}${n(c.contribution_bps).toFixed(0)} bps</span>`}</td></tr>`).join('')}
      </tbody></table>
      <p class="note">Contribution = start weight × period return, in basis points, on actual holdings. Positions added during the period start at zero weight and contribute nothing by this measure; positions sold show the weight they started at. ${unpriced.length ? `<b>${unpriced.length} holding${unpriced.length === 1 ? '' : 's'} could not be priced across this window</b>, so the total understates. ` : ''}The total approximates the period return and drifts from it over long windows, since it uses starting weights and ignores rebalancing in between.</p>`}
  </div>`;

  // ---- drawdown ----
  const ddStat = stats.find(r => r.period === repDdPeriod) || null;
  const ddCard = (() => {
    const tabs = `<div class="tabs">${REP_PERIODS.map(p => { const s = stats.find(r => r.period === p); const dead = !hasHistory || (s && s.unavailable_reason);
      return `<button class="tab" data-repdd="${p}" aria-selected="${p === repDdPeriod}" ${dead ? `disabled title="${esc(s && s.unavailable_reason || 'Needs a dated holdings history')}"` : ''}>${p}</button>`; }).join('')}</div>`;
    if (!hasHistory) return `<div class="card"><h2>Drawdown history</h2>${tabs}<div class="empty">No value series for this model. Drawdown is value divided by its running peak, so it needs a daily series for the model and its benchmark; load a dated holdings history and the chart fills in.</div></div>`;
    if (ddStat && ddStat.unavailable_reason) return `<div class="card"><h2>Drawdown history</h2>${tabs}<div class="empty">${esc(ddStat.unavailable_reason)}</div></div>`;
    const from = ddStat ? ddStat.start_date : series[0].as_of;
    const win = series.filter(p => p.as_of >= from);
    if (win.length < 2) return `<div class="card"><h2>Drawdown history</h2>${tabs}<div class="empty">Not enough points inside this window to draw a line.</div></div>`;
    const mdd = drawdownSeries(win, p => +p.value);
    const bdd = drawdownSeries(win, p => p.benchmark_value === null ? null : +p.benchmark_value);
    const all = [...mdd, ...bdd].filter(v => v !== null);
    const lo = Math.min(-0.005, ...all), niceLo = Math.floor(lo * 200) / 200;
    const W = 900, H = 260, padL = 6, padR = 58, padT = 12, padB = 22;
    const y = v => padT + (v / niceLo) * (H - padT - padB);
    const x = (i, len) => padL + (i / (len - 1 || 1)) * (W - padL - padR);
    const step = Math.abs(niceLo) > 0.08 ? 0.02 : 0.005;
    const ticks = []; for (let v = 0; v >= niceLo - 1e-9; v -= step) ticks.push(v);
    const grid = ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text class="ddaxis" x="${W - padR + 7}" y="${(y(t) + 3.4).toFixed(1)}">${(t * 100).toFixed(2)}%</text>`).join('');
    const band = (vals, color) => {
      const pts = vals.map((v, i) => ({ v, i })).filter(p => p.v !== null);
      if (pts.length < 2) return '';
      const line = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i, vals.length).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
      const fill = `${line}L${x(pts.at(-1).i, vals.length).toFixed(1)} ${y(0).toFixed(1)}L${x(pts[0].i, vals.length).toFixed(1)} ${y(0).toFixed(1)}Z`;
      return `<path d="${fill}" fill="${color}" opacity="0.30"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    };
    const worst = v => { const f = v.filter(z => z !== null); return f.length ? Math.min(...f) : null; };
    const leg = (label, vals, color) => `<span class="ddleg" style="display:flex;align-items:center;gap:7px;font-size:12.5px"><span class="sw" style="width:11px;height:11px;border-radius:3px;background:${color}"></span>${esc(label)}<b style="font-variant-numeric:tabular-nums;color:var(--muted)">${vals.at(-1) === null ? '—' : (vals.at(-1) * 100).toFixed(2) + '%'}</b></span>`;
    return `<div class="card"><div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Drawdown history</h2><span style="font-size:12px;color:var(--muted)">${esc(win[0].as_of)} → ${esc(win.at(-1).as_of)}</span></div>
     ${tabs}
     <div style="display:flex;gap:16px;flex-wrap:wrap;margin:11px 0 2px">${leg(m.name, mdd, 'var(--growth)')}${leg('Benchmark', bdd, 'var(--unclass)')}</div>
     <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:auto;display:block" role="img">
       ${grid}${band(bdd, 'var(--unclass)')}${band(mdd, 'var(--growth)')}
       <line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-width="1.5"/></svg>
     <div class="ddworst">
       <div>Max drawdown · ${esc(m.name)}<b>${worst(mdd) === null ? '—' : (worst(mdd) * 100).toFixed(2) + '%'}</b></div>
       <div>Max drawdown · benchmark<b class="${worst(bdd) === null ? 'pending' : ''}">${worst(bdd) === null ? '—' : (worst(bdd) * 100).toFixed(2) + '%'}</b></div></div>
     <p class="note">Drawdown is value divided by its running peak, minus one, computed <b>within the selected window</b> — so each period starts at 0% and a loss carried in from before the window is not shown.${ddStat && ddStat.window_starts_in_gap ? ' <b style="color:var(--warn)">The start of this window fell inside the history gap and was pulled back, so it covers more time than its label suggests.</b>' : ''} Whether the peak should instead carry in from before the window is an open decision.</p></div>`;
  })();

  // ---- Trailing returns against the model's benchmark ----
  const trailingCard = (() => {
    const rows = (D.trailing || []).filter(r => r.strategy_id === m.id)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    if (!rows.length) {
      return `<div class="card" style="margin-top:18px"><h2>Trailing returns</h2>
        <div class="empty">Not computed yet. Run jobs/compute-trailing-returns.mjs.</div></div>`;
    }
    const LBL = { '1D': '1 Day', '1W': '1 Week', '1M': '1 Month', '3M': '3 Month', MTD: 'MTD', QTD: 'QTD',
                  YTD: 'YTD', '1Y': '1 Year', '3Y': '3 Year CAGR', '5Y': '5 Year CAGR', '10Y': '10 Year CAGR' };
    const basis = rows[0].basis;
    const benchLabel = m.benchmarkLabel || 'Benchmark';
    const cell = (v, reason) => v === null || v === undefined
      ? `<td class="num"><span style="color:var(--muted)" ${reason ? `title="${esc(reason)}"` : ''}>–</span></td>`
      : `<td class="num"><span style="color:${+v >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(+v >= 0 ? '' : '') + (+v * 100).toFixed(2)}%</span></td>`;
    const head = rows.map(r => `<th class="num">${esc(LBL[r.period] || r.period)}</th>`).join('');
    // Any window reaching back past the first post-gap snapshot carries weights that were held
    // unchanged across the hole — worth saying once rather than on every cell.
    const integ = (D.snapIntegrity || []).filter(i => i.strategy_id === m.id);
    const gap = integ.find(i => i.gap_days_before && +i.gap_days_before > 60);
    const spansGap = gap && rows.some(r => r.start_date && r.start_date < gap.as_of);

    // ---- Monthly returns grid, under the trailing table on the same card ----
    //
    // Colour is the OWNER'S rule, not the sign of the number: green where the model beat its
    // benchmark that month, red where it did not. That is deliberately different from the
    // reference screen, which colours by whether the month was positive — a model can lose money
    // in a month it won, and the question this grid is here to answer is the second one. The
    // colour therefore means the same thing on all three tabs, so switching to Benchmark still
    // shows which months the model took.
    const monthlyBlock = (() => {
      const all = (D.monthly || []).filter(r => r.strategy_id === m.id);
      if (!all.length) return '';
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const key = { portfolio: 'model_return', benchmark: 'benchmark_return', excess: 'excess_return' }[monthlyTab];
      const at = (y, mo) => all.find(r => r.year === y && r.month === mo) || null;
      // A year with nothing in it is a year of blanks, which teaches a reader nothing and pushes
      // the years that do have figures off the screen.
      const years = [...new Set(all.map(r => r.year))].sort()
        .filter(y => all.some(r => r.year === y && r.month > 0 && r.model_return !== null));
      if (!years.length) return '';

      const cell = (r, isAnnual) => {
        if (!r || r[key] === null || r[key] === undefined) {
          const why = r?.unavailable_reason;
          return `<td class="num" style="color:var(--muted)"${why ? ` title="${esc(why)}"` : ''}>–</td>`;
        }
        const v = +r[key];
        // No excess means no verdict, so no colour — an uncoloured cell is a figure without a
        // benchmark behind it, not a flat month.
        const ex = r.excess_return === null || r.excess_return === undefined ? null : +r.excess_return;
        const bg = ex === null ? 'transparent' : ex >= 0 ? 'var(--winbg)' : 'var(--losebg)';
        const tips = [
          r.is_partial ? 'Part of a month only — the series begins or ends inside it.' : '',
          r.in_gap ? 'Inside the stretch with no holdings snapshot: the weights were carried forward unchanged through this month.' : '',
          ex === null ? 'No benchmark figure for this month, so there is no verdict to colour.' : `${ex >= 0 ? 'Ahead of' : 'Behind'} the benchmark by ${Math.abs(ex * 100).toFixed(2)}%.`,
        ].filter(Boolean).join(' ');
        return `<td class="num" style="background:${bg};${isAnnual ? 'font-weight:600;' : ''}${r.is_partial ? 'font-style:italic;' : ''}" title="${esc(tips)}">${(v * 100).toFixed(2)}%${r.in_gap ? '<sup style="color:var(--warn)">·</sup>' : ''}</td>`;
      };

      const tabs = `<div class="tabs" style="margin:0">${[['portfolio', 'Portfolio'], ['benchmark', 'Benchmark'], ['excess', 'Vs. Benchmark']]
        .map(([k, lbl]) => `<button class="tab" data-monthtab="${k}" aria-selected="${k === monthlyTab}">${lbl}</button>`).join('')}</div>`;

      const anyGap = all.some(r => r.in_gap && r.month > 0);
      const anyPartial = all.some(r => r.is_partial && r.month > 0);

      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:26px">
          <h2 style="margin:0">Monthly returns</h2>${tabs}</div>
        <div style="overflow-x:auto;margin-top:10px"><table class="monthgrid" style="min-width:760px"><thead><tr>
          <th>Year</th><th class="num">Annual</th>${MON.map(x => `<th class="num">${x}</th>`).join('')}
        </tr></thead><tbody>
        ${years.map(y => `<tr><td><b>${y}</b></td>${cell(at(y, 0), true)}${MON.map((_, i) => cell(at(y, i + 1), false)).join('')}</tr>`).join('')}
        </tbody></table></div>
        <p class="note"><b>Green is a month the model beat ${esc(benchLabel)}; red is a month it did not</b> — not whether the month made money, which is a different question and the one a reader usually assumes. The colour means the same thing on all three tabs, so the Benchmark tab still shows which months the model took. Annual is that year's own months compounded, and a year missing any month is withheld rather than compounded over the hole.${anyPartial ? ' Italic figures are part-months, where the series begins or ends inside them.' : ''}${anyGap ? ` Months marked <sup style="color:var(--warn)">·</sup> fell inside the stretch with no holdings snapshot — the prices are real, but the weights were carried forward unchanged, so a run of green there is a book nobody rebalanced rather than a decision that worked.` : ''} Hover any cell for its margin over the benchmark.</p>`;
    })();

    return `<div class="card" style="margin-top:18px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Trailing returns</h2>
        <span style="font-size:12px;color:var(--muted)">against ${esc(benchLabel)} · ${basis === 'holdings' ? 'from the dated holdings history' : 'from current target weights'}</span></div>
      <div style="overflow-x:auto;margin-top:10px"><table style="min-width:860px"><thead><tr><th>Period</th>${head}</tr></thead><tbody>
        <tr><td><b>${esc(m.name.replace(/\s*\([^)]*\)/g, ''))}</b></td>${rows.map(r => cell(r.model_return, r.unavailable_reason)).join('')}</tr>
        <tr><td>${esc(benchLabel)}</td>${rows.map(r => cell(r.benchmark_return, r.unavailable_reason)).join('')}</tr>
        <tr style="border-top:2px solid var(--line)"><td><b>Vs. Benchmark</b></td>${rows.map(r => cell(r.excess_return, r.unavailable_reason)).join('')}</tr>
      </tbody></table></div>
      <p class="note">${basis === 'holdings'
        ? 'Computed from the dated holdings history, so it follows what the model actually held.'
        : '<b>Computed from current target weights held fixed back through each window</b>, because this model has no dated holdings history loaded. It answers how today’s allocation would have done, not what the model did — load a history and this switches to the real thing.'}
      Returns are gross of fees. The three annualised columns are CAGR rather than cumulative and are withheld entirely where the price history does not reach back that far, or where the window would start inside a gap in the holdings history — annualising over a span that does not match the label is wrong rather than approximate, so a dash there is deliberate. Hover a dash for the reason.${spansGap ? ` <b>Windows reaching before ${esc(gap.as_of)} include the ${gap.gap_days_before}-day stretch where the holdings were carried forward unchanged</b>, so the longer periods reflect a book that was not rebalanced through it.` : ''}</p>
      ${monthlyBlock}</div>`;
  })();

  // ---- Portfolio breakdown: sector / equity-factor mix against the benchmark ----
  //
  // The percentages are of the model's EQUITY sleeve, not of the whole model, because a sector
  // or factor weight only means anything inside equity — that is also what the owner asked for.
  // Both sides renormalise over the part that resolved, so the comparison is of mix rather than
  // of level, and the coverage line says how much of each side that was.
  const breakdownCard = (() => {
    const all = (D.styleExposure || []).filter(r => r.strategy_id === m.id);
    if (!all.length) {
      return `<div class="card" style="margin-top:18px"><h2>Portfolio breakdown</h2>
        <div class="empty">Not computed yet. Run jobs/compute-style-exposure.mjs.</div></div>`;
    }
    const lens = breakdownLens;
    const rows = all.filter(r => r.lens === lens).sort((a, b) => a.sort_order - b.sort_order);
    const cov = (D.styleCoverage || []).find(r => r.strategy_id === m.id && r.lens === lens);
    const benchLabel = m.benchmarkLabel || 'Benchmark';
    const modelLabel = m.name.replace(/\s*\([^)]*\)/g, '');
    const alloc = rows.filter(r => r.kind === 'allocation');
    const comps = rows.filter(r => r.kind === 'composite');

    const tabs = `<div class="tabs" style="margin:0">
      ${[['sector', 'Sector'], ['factor', 'Equity factors']].map(([k, lbl]) =>
        `<button class="tab" data-breakdown="${k}" aria-selected="${k === lens}">${lbl}</button>`).join('')}</div>`;

    const have = v => v !== null && v !== undefined;
    const scale = Math.max(0.01, ...rows.filter(r => r.kind === 'allocation').flatMap(r => [+r.model_weight || 0, +r.benchmark_weight || 0]));
    const diffs = alloc.map(r => have(r.model_weight) && have(r.benchmark_weight) ? +r.model_weight - +r.benchmark_weight : null);
    const dScale = Math.max(0.005, ...diffs.filter(d => d !== null).map(Math.abs));
    const p1 = v => (v * 100).toFixed(1) + '%';

    const bar = (v, color, muted) => have(v)
      ? `<div style="display:flex;align-items:center;gap:6px">
           <div style="height:9px;width:${+v > 0 ? Math.max(0.6, (+v / scale) * 100) : 0}%;background:${color};border-radius:2px"></div>
           <small style="color:${muted ? 'var(--muted)' : 'var(--text)'};white-space:nowrap">${p1(+v)}</small></div>`
      : `<div><small style="color:var(--muted)">not resolved</small></div>`;

    // The bar diverges from a centre line and the figure sits in its own fixed column beside it.
    // Putting the figure next to the end of the bar reads better but clips the largest row off the
    // edge of the card, which is the one row nobody can afford to lose.
    const diffCell = d => {
      if (d === null) return '<td style="width:190px"></td>';
      const flat = Math.abs(d) < 0.0005;
      const w = (Math.abs(d) / dScale) * 48;                 // 48% of the bar track each side of centre
      const up = d >= 0, col = flat ? 'var(--muted)' : up ? 'var(--pos)' : 'var(--neg)';
      return `<td style="width:190px"><div style="display:flex;align-items:center;gap:8px">
        <div style="position:relative;height:20px;flex:1;min-width:90px">
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--line)"></div>
          ${flat ? '' : `<div style="position:absolute;top:5px;height:10px;background:${col};border-radius:2px;${up ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></div>`}
        </div>
        <small style="color:${col};white-space:nowrap;width:52px;text-align:right">${flat ? '0.0%' : (up ? '+' : '−') + (Math.abs(d) * 100).toFixed(1) + '%'}</small>
      </div></td>`;
    };

    const allocRows = alloc.map((r, i) => `<tr>
      <td style="width:210px">${esc(r.label)}</td>
      <td>${bar(r.model_weight, 'var(--accent)', false)}${bar(r.benchmark_weight, 'var(--bench)', true)}</td>
      ${diffCell(diffs[i])}</tr>`).join('');

    const compRows = !comps.length ? '' : `<tr><td colspan="3" style="padding-top:14px">
      <div style="border-top:1px solid var(--line);padding-top:10px;font-size:12px;color:var(--muted)">
        Derived from the rows above, not additional to them</div></td></tr>` +
      comps.map(r => {
        const d = have(r.model_weight) && have(r.benchmark_weight) ? +r.model_weight - +r.benchmark_weight : null;
        return `<tr><td style="width:210px;color:var(--muted)">${esc(r.label)}</td>
          <td>${bar(r.model_weight, 'var(--accent)', false)}${bar(r.benchmark_weight, 'var(--bench)', true)}</td>
          ${diffCell(d)}</tr>`;
      }).join('');

    const un = (cov?.unresolved || []);
    const unBlock = !un.length ? '' : `<details style="margin-top:10px;font-size:13px">
      <summary style="cursor:pointer;color:var(--text)">${un.length} holding${un.length === 1 ? '' : 's'} could not be placed</summary>
      <table style="margin-top:8px"><thead><tr><th>Ticker</th><th>Side</th><th class="num">Weight</th><th>Why</th></tr></thead><tbody>
      ${un.map(u => `<tr><td><b>${esc(u.ticker || '—')}</b></td><td>${esc(u.side)}</td>
        <td class="num">${(+u.weight * 100).toFixed(1)}%</td>
        <td style="max-width:460px;color:var(--muted)">${esc(u.reason)}</td></tr>`).join('')}
      </tbody></table></details>`;

    const covLine = !cov ? '' : `Equity is ${p1(+cov.model_equity_weight)} of this model${cov.basis === 'target' ? ' on target weights' : ''}. `
      + `The bars describe ${have(cov.model_resolved) ? p1(+cov.model_resolved) : 'none'} of that equity and `
      + `${have(cov.benchmark_resolved) ? p1(+cov.benchmark_resolved) : 'none'} of the benchmark's.`;

    return `<div class="card" style="margin-top:18px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Portfolio breakdown</h2>
        <span style="font-size:12px;color:var(--muted)">
          <span style="display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:2px;margin-right:5px"></span>${esc(modelLabel)}
          <span style="display:inline-block;width:9px;height:9px;background:var(--bench);border-radius:2px;margin:0 5px 0 12px"></span>${esc(benchLabel)}</span></div>
      <div style="margin-top:10px">${tabs}</div>
      <div style="overflow-x:auto;margin-top:12px"><table style="min-width:680px"><thead><tr>
        <th>${lens === 'sector' ? 'Sector' : 'Factor'}</th><th>Share of resolved equity</th><th>Over / under weight</th>
      </tr></thead><tbody>${allocRows}${compRows}</tbody></table></div>
      ${unBlock}
      <p class="note"><b>These are estimated from returns, not read from holdings.</b> No data source connected to this desk publishes what the funds in these models own, so each fund's daily returns are fitted to a basis of real index ETFs — the eleven sector SPDRs for the sector view, iShares' value, momentum, quality and min-vol funds plus the S&P 500 for factors — with weights that cannot go negative and must sum to one. That measures how a fund <i>behaves</i>. A fund can be placed in a sector it owns no shares of, if it moves like one. ${covLine}
      ${lens === 'factor'
        ? 'AQR defines <b>Defensive</b> as quality combined with low volatility, and <b>Multi-Factor</b> as several styles run in one framework, so both are made out of the four rows above rather than sitting alongside them — they are shown separately because adding them in would count the same holding twice. Multi-factor counts the equity held in funds carrying at least three of the four styles at once, which is a property of the fund and not of the blend: one pure value fund beside one pure momentum fund is not a multi-factor model.'
        : 'Non-US equity keeps its own row instead of being pushed into US sectors. Fitting the international and emerging-market indices to the sector SPDRs was tried and rejected — it explained two thirds and a half of their movement respectively, and returned an emerging-market mix with no financials at all in an index that is roughly a quarter financials.'}
      A fund whose fit explains less than 70% of its own daily movement is left out by name rather than spread across the others${un.length ? ' — the list above' : ''}, and the percentages renormalise over what remains.${cov?.window_start ? ` Fitted on daily returns from ${esc(cov.window_start)} to ${esc(cov.window_end)}.` : ''}</p></div>`;
  })();

  // ---- data quality ----
  const offSum = integ.filter(i => i.weight_off);
  const gaps = integ.filter(i => n(i.gap_days_before) !== null && +i.gap_days_before > 60);
  const suspect = integ.filter(i => +i.n_suspect_names > 0);
  const dq = [
    gaps.length ? `<li><b>${gaps.map(g => `${esc(g.as_of)} (${g.gap_days_before} days since the previous snapshot)`).join(', ')}</b> — the history has a hole. Any window opening inside it falls back to the snapshot before it, and the period says so when that happens.</li>` : '',
    offSum.length ? `<li><b>${offSum.length} snapshot${offSum.length === 1 ? '' : 's'} do not sum to 100%</b>: ${offSum.map(o => `${esc(o.as_of)} at ${(+o.weight_total * 100).toFixed(2)}%`).join(', ')}. Loaded exactly as exported and <i>not</i> corrected — a discrepancy in the source records, not a rounding artefact.</li>` : '',
    suspect.length ? `<li><b>Editorial text in the name field</b> on ${suspect.length} snapshot${suspect.length === 1 ? '' : 's'}. At least one holding's name in the export contains AI-generated commentary rather than a fund name. Names render verbatim below so this stays visible.</li>` : '',
  ].filter(Boolean).join('');
  const dqCard = !integ.length ? '' : `<div class="card" style="margin-bottom:18px;border-left:3px solid var(--warn)">
    <h2>Data quality</h2>${dq ? `<ul style="margin:6px 0 0 18px;line-height:1.6">${dq}</ul>` : '<div class="empty">No integrity problems found.</div>'}
    <p class="note">Reported, never silently repaired. ${integ.length} snapshots loaded, ${esc(integ[0].as_of)} to ${esc(integ.at(-1).as_of)}.</p></div>`;

  return `<p class="sub">Each holding's weight splits evenly across the factors it is long. Shorts are tallied separately, so they do not sum with the pie. Classify the unclassified positions and press Update to refresh.</p>
   ${repSaveError ? `<div class="card" style="margin-bottom:18px;border-left:3px solid var(--neg)"><p style="margin:0">${esc(repSaveError)}</p></div>` : ''}
   ${dqCard}${statsCard}${allocGrid}${contribCard}${ddCard}${trailingCard}${breakdownCard}
   <details style="margin-top:22px;font-size:13px;color:var(--muted)">
     <summary style="cursor:pointer;color:var(--text)">The classification matrix</summary>
     <table style="margin-top:10px"><thead><tr><th>Asset class</th><th>Growth</th><th>Inflation</th><th>Cost of liquidity</th></tr></thead><tbody>
       <tr><td>Equities</td><td>Long</td><td>Flat</td><td>Short</td></tr>
       <tr><td>Fixed income</td><td>Short</td><td>Short</td><td>Long <i>(override)</i></td></tr>
       <tr><td>Cash</td><td>Flat</td><td>Short</td><td>Long</td></tr>
       <tr><td>Commodities / real assets</td><td>Long</td><td>Long</td><td>Flat</td></tr>
       <tr><td>Gold</td><td>Flat</td><td>Long</td><td>Long</td></tr>
     </tbody></table>
     <p class="note">Equities are treated as flat on inflation; the framework chart reads "flat / short". Fixed income is long the cost of liquidity, the single documented override to that chart, re-confirmed by the owner on 2026-10-13.</p>
   </details>`;
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

  const masterCard = speedLimitMasterCard();
  const modelCard = speedLimitModelCard();

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

// ---------- Contribution and attribution ----------


function openModel(id) {
  const m = D.models.find(x => x.id === id); if (!m) return;
  // The drawer is the model's dashboard, laid out to the owner's reference, plus the holdings
  // table. The earlier contents — the exposure KPI row, the asset-class stack, the stress,
  // attribution and earn-its-place cards — were removed on the owner's instruction: the dashboard
  // covers the same ground in the agreed layout, and keeping both would have shown the same
  // figures twice in two different shapes.
  $('#drawer').innerHTML = `<button class="close" data-go="#stan">Close</button>
   <span class="eyebrow">Model · ${esc(m.label)}</span><h1>${esc(m.name)}</h1>
   ${modelDashboard(m)}
   <div class="card" style="margin-top:18px"><h2>Holdings <span class="chip draft">draft loadings</span></h2><table><thead><tr><th>Holding</th><th>Class</th><th class="num">Weight</th>${D.factors.map(f => `<th class="num">${esc(f.slug[0].toUpperCase())}</th>`).join('')}</tr></thead><tbody>
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
    hist = await qSoft(sb.from('strategy_exposure_history').select('factor_id,as_of,net_exposure,coverage')
      .eq('strategy_id', strategyId).order('as_of', { ascending: true }), 'exposure history');
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

// Signal-to-noise per source over trailing windows. A hit rate rewards being right about things
// that barely moved; this asks whether the calls were right AND whether the moves mattered.
function stnCard() {
  const rows = D.signalToNoise || [];
  const WINDOWS = ['1M', '1Q', '6M', 'YTD'];
  const sources = [...new Set(rows.map(r => r.source))].sort();
  const thin = rows.length && rows.every(r => r.too_few_to_judge);
  if (!sources.length) {
    return `<div class="card" style="margin-bottom:14px"><h2>Signal to noise</h2>
     <div class="empty">Nothing scored yet. Each call is settled against its asset class's benchmark once its horizon passes; the first were logged 2026-09-24 and settle from December 2026.</div>
     <p class="note">This will measure whether a source's calls were right <b>and</b> whether the moves were big enough to matter: signal is the mean return in the direction of the call, noise its standard deviation, the ratio the two divided. Being right by a hair every time scores below being right by a lot.</p></div>`;
  }
  const get = (src, w) => rows.find(r => r.source === src && r.window_label === w);
  const cell = r => {
    if (!r || !r.n_scored) return '<td class="num" style="color:var(--muted)">–</td>';
    const v = r.signal_to_noise;
    return `<td class="num" title="${r.n_scored} scored, hit rate ${r.hit_rate === null ? '–' : (+r.hit_rate * 100).toFixed(0) + '%'}, signal ${r.signal === null ? '–' : (+r.signal * 100).toFixed(1) + '%'}, noise ${r.noise === null ? '–' : (+r.noise * 100).toFixed(1) + '%'}"
      style="opacity:${r.too_few_to_judge ? 0.5 : 1};color:${v === null ? 'var(--muted)' : +v > 0 ? 'var(--pos)' : 'var(--neg)'}">${v === null ? '–' : (+v).toFixed(2)}<br><small style="color:var(--muted)">n=${r.n_scored}</small></td>`;
  };
  return `<div class="card" style="margin-bottom:14px"><h2>Signal to noise ${thin ? '<span class="chip">too few to judge</span>' : ''}</h2>
   <table><thead><tr><th>Source</th><th>Lens</th>${WINDOWS.map(w => `<th class="num">${w}</th>`).join('')}</tr></thead><tbody>
   ${sources.map(src => `<tr><td><b>${esc(src)}</b></td><td><small style="color:var(--muted)">${esc(get(src, 'YTD')?.category || rows.find(r => r.source === src)?.category || '')}</small></td>
     ${WINDOWS.map(w => cell(get(src, w))).join('')}</tr>`).join('')}
   </tbody></table>
   <p class="note">Signal is the mean return in the <b>direction</b> of the call; noise is its standard deviation; the figure shown is the two divided. So a source right by a hair every time scores below one right by a lot, and a scattered source scores below a consistent one at the same hit rate — an information ratio applied to opinions. Windows are anchored on when the call was <b>made</b>, not when it settled. Hover for the underlying hit rate, signal and noise. ${thin ? '<b>Every row here is below ten scored calls, which is too few to mean anything</b> — they are shown faded for that reason. The intended use, once there is volume, is to let consistently strong sources earn more weight in the traffic lights than the framework\'s flat lens weights give them.' : ''}</p></div>`;
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
  ${stnCard()}
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
  // If an optional dataset failed to load, say so here rather than letting its card render empty
  // and read as "nothing to show". An empty panel and a broken query look identical otherwise.
  const degraded = (D.softFailures || []).length ? `<div class="card" style="margin-bottom:14px;border-left:3px solid var(--warn)">
    <h2>Some data could not be loaded</h2>
    <p class="sub" style="margin-top:0">The rest of the site is fine; these panels will be empty until it resolves. Most often this is a migration that has not finished deploying.</p>
    <ul style="margin:6px 0 0 18px;color:var(--muted)">${D.softFailures.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '';
  const byArea = new Map();
  for (const it of items) { if (!byArea.has(it.area)) byArea.set(it.area, []); byArea.get(it.area).push(it); }
  const doneCount = items.filter(i => i.status === 'done').length;
  const dot = s => ({ done: 'var(--pos)', in_progress: 'var(--flat)', deferred: 'var(--muted)', not_started: 'var(--neg)' }[s] || 'var(--muted)');
  const label = s => ({ done: 'Done', in_progress: 'In progress', deferred: 'Deferred', not_started: 'Not started' }[s] || s);
  return `<span class="eyebrow">Allocation model</span><h1>Status</h1><p class="sub">What's built, in progress, or not started — kept in sync with the project roadmap.</p>
  ${degraded}
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
// Scatter period tabs, on the Stan page.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-scatter]');
  if (!t || t.disabled) return;
  scatterPeriod = t.dataset.scatter;
  $('#app').innerHTML = stan();
});
// Portfolio / Benchmark / Vs. Benchmark tabs on the monthly returns grid.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-monthtab]');
  if (!t) return;
  monthlyTab = t.dataset.monthtab;
  const arg = (location.hash.split('/')[1] || '');
  if (arg) openModel(arg);
});
// Decision-score window tabs on Annie's page.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-anniewin]');
  if (!t) return;
  annieWindow = t.dataset.anniewin;
  $('#app').innerHTML = annie();
});
// Sector / equity-factor toggle inside the model drawer.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-breakdown]');
  if (!t) return;
  breakdownLens = t.dataset.breakdown;
  const arg = (location.hash.split('/')[1] || '');
  if (arg) openModel(arg);
});
// SNR window tabs, inside the signal-to-noise drawer.
document.addEventListener('click', e => {
  const w = e.target.closest('[data-snrwin]');
  if (!w) return;
  snrWindow = w.dataset.snrwin;
  const arg = (location.hash.split('/')[1] || '');
  if (arg.startsWith('snr-')) $('#drawer').innerHTML = snrDrawer(arg.slice(4));
});
// Donut and period toggles re-render the model drawer from data already loaded.
// Playground controls: all client-side, nothing saved.
// Reporting page controls. The split dropdown is a change event, not a click.
document.addEventListener('change', e => {
  const sel = e.target.closest('[data-splitfor]');
  if (!sel) return;
  repSaveError = null;
  repPending[sel.dataset.splitfor] = sel.value || null;
  openModel(repModelId);   // the donut previews the staged choice before it is saved
});
document.addEventListener('click', e => {
  const rp = e.target.closest('[data-repperiod]'), rm = e.target.closest('[data-repmodel]');
  const rd = e.target.closest('[data-repdd]'), ru = e.target.closest('[data-repupdate]');
  if (!rp && !rm && !rd && !ru) return;
  if (rp && !rp.disabled) repPeriod = rp.dataset.repperiod;
  if (rd && !rd.disabled) repDdPeriod = rd.dataset.repdd;
  if (rm) { repModelId = rm.dataset.repmodel; repPending = {}; repSaveError = null; }
  if (ru) { commitSplits(); return; }
  openModel(repModelId);
});
document.addEventListener('click', e => {
  const adj = e.target.closest('[data-pgadj]'), pm = e.target.closest('[data-pgmodel]'), rs = e.target.closest('[data-pgreset]');
  if (!adj && !pm && !rs) return;
  if (pm) { pgModelId = pm.dataset.pgmodel; pgWeights = null; }
  if (rs) { const m = D.models.find(x => x.id === pgModelId); if (m) pgReset(m); }
  if (adj) {
    const [slug, delta] = adj.dataset.pgadj.split('|');
    pgWeights[slug] = Math.max(0, Math.round(((pgWeights[slug] || 0) + (+delta)) * 10000) / 10000);
  }
  $('#app').innerHTML = playground();
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
