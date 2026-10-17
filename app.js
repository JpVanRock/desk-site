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
      history.replaceState(null, '', location.pathname + '#sisyphus');
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
  // The signed-in address used to sit in a badge beside Sign out. It was taking header width
  // the mark needed, and it is still one hover away rather than gone.
  $('#signout').title = `Signed in as ${session.user.email}`;
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
// Paging read, for the one dataset that is a genuine time series rather than a per-run snapshot.
// PostgREST caps a response at 1000 rows and signals it only in a header, so a table that crosses
// the line comes back truncated and entirely healthy-looking. model_value_series gains a row per
// trading day and was at 992 when this was written: without paging, the drawdown chart would have
// started quietly losing its oldest days about a week later, with nothing to show for it.
// `make` is a thunk because a builder cannot be re-ranged once awaited.
async function qAllSoft(make, label) {
  const page = 1000, out = [];
  try {
    for (let from = 0; ; from += page) {
      const got = await q(make().range(from, from + page - 1));
      out.push(...got);
      if (got.length < page) return out;
      if (from > 200000) throw new Error('paged past 200k rows; refusing to loop further');
    }
  } catch (ex) {
    softFailures.push(`${label}: ${ex.message}`);
    console.warn(`[desk] optional dataset "${label}" unavailable:`, ex.message);
    return out;
  }
}
function latestBy(rows, keyFn) { const m = new Map(); for (const r of rows) { const k = keyFn(r); const p = m.get(k); if (!p || r.as_of > p.as_of) m.set(k, r); } return m; }

async function load() {
  // CAUTION: this is POSITIONAL destructuring over a long Promise.all. A query inserted
  // anywhere but the end silently shifts every binding after it, and the page still renders
  // — it just renders the wrong table's rows. That happened: five queries added before the
  // signal-to-noise one made the statistics block read contribution rows. The rule is append
  // only: add the query at the END of the array and its name at the END of this list.
  const [strategies, alloc, secs, classes, factors, cLoad, sLoad, runs, outputs, prices, technicals, macro, views, roadmap, sources, calls, routingLog, contribs, scenarios, stress, perf, attrib, speedLimit, modelSpeed, rocBoard, trigHits, trigRules, stn, periodStats, contribution, factorAlloc, valueSeries, snapIntegrity, currentHoldings, factorOverrides, lensSnr, holdingRR, trailing, styleExposure, styleCoverage, monthly, trades, positionScores, decisionStats, assessments, tradeReviews, svenRules, newsFailure, beautyReading, beautyComponents, macroRegime, beautyRanks, beautyHistory, modelVar, tailRisk, firmMetrics, firmExposures, firmStress, blendFit, modelDuration, geoExposure, geoCoverage, fingerprint, fingerprintCov, taxEff, taxCov] = await Promise.all([
    q(sb.from('strategies').select('id,name,label,sort_order,benchmark,aum,aum_as_of,equity_weight').order('sort_order')),
    q(sb.from('target_allocations').select('strategy_id,security_id,asset_class_id,target_weight,effective_from').is('effective_to', null)),
    q(sb.from('securities').select('id,ticker,name,asset_class_id,role,high_potential,high_potential_since,high_potential_note')),
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
    qSoft(sb.from('latest_holding_contributions').select('strategy_id,security_id,as_of,weight,risk_share,risk_ratio,corr_to_rest,max_corr,closest_peer_id,verdict,rationale').order('as_of', { ascending: false }), 'holding contributions'),
    qSoft(sb.from('stress_scenarios').select('id,slug,name,description,shocks').order('sort_order'), 'stress scenarios'),
    qSoft(sb.from('latest_strategy_stress_results').select('strategy_id,scenario_id,as_of,factor_score,coverage,n_windows,mean_return,worst_return,best_return,replay_coverage,windows,factor_detail').order('as_of', { ascending: false }), 'stress results'),
    qSoft(sb.from('latest_strategy_performance').select('strategy_id,period,as_of,start_date,end_date,portfolio_return,peer_benchmark_return,policy_benchmark_return,coverage,max_drawdown,peer_max_drawdown,gold_return,btc_return,weighted_expense_ratio,expense_coverage,cpi_return,cpi_window_start,cpi_window_end,model_return_cpi_window').order('as_of', { ascending: false }), 'performance'),
    qSoft(sb.from('latest_strategy_attribution').select('strategy_id,period,as_of,asset_class_id,w_portfolio,w_benchmark,r_portfolio,r_benchmark,contribution,allocation_effect,selection_effect,interaction_effect,attributable').order('as_of', { ascending: false }), 'attribution'),
    qSoft(sb.from('latest_speed_limit_readings').select('as_of,category,score,light,weight,n_calls,n_recorded,target_beta_low,target_beta_high,sign_label').order('as_of', { ascending: false }), 'speed limit'),
    qSoft(sb.from('latest_strategy_speed_limit').select('strategy_id,as_of,actual_beta,r_squared,n_obs,target_low,target_high,light,note').order('as_of', { ascending: false }), 'model speed limit'),
    qSoft(sb.from('market_roc_board').select('as_of,security_id,label,sort_order,close,price_roc_1d,price_roc_1w,price_roc_1m,volume_roc_1w,vol_ann,vol_roc_1m').order('sort_order'), 'ROC board'),
    qSoft(sb.from('trigger_hits').select('as_of,headline,value,rule_id,security_id,strategy_id').order('as_of', { ascending: false }).limit(200), 'trigger hits'),
    qSoft(sb.from('trigger_rules').select('id,name,kind,enabled'), 'trigger rules'),
    qSoft(sb.from('source_signal_to_noise').select('source,category,window_label,n_scored,hit_rate,signal,noise,signal_to_noise,too_few_to_judge'), 'signal to noise'),
    qSoft(sb.from('latest_model_period_stats').select('strategy_id,period,as_of,start_date,end_date,model_return,benchmark_return,max_drawdown,benchmark_max_drawdown,upside_capture,downside_capture,beta_sp500,beta_r2,dividend_yield,min_coverage,window_starts_in_gap,unavailable_reason,method_note').order('as_of', { ascending: false }), 'model period stats'),
    // Eight models of holdings across ten periods is over a thousand rows in a SINGLE run, so
    // the newest-run view is not enough on its own — this one has to page as well.
    qAllSoft(() => sb.from('latest_model_contribution').select('strategy_id,period,as_of,ticker,name_raw,start_weight,end_weight,period_return,contribution_bps,status,priced').order('as_of', { ascending: false }), 'model contribution'),
    qSoft(sb.from('latest_model_factor_allocation').select('strategy_id,as_of,basis,long_growth,long_inflation,long_liquidity,short_growth,short_inflation,short_liquidity,unclassified,detail').order('as_of', { ascending: false }), 'model factor allocation'),
    qAllSoft(() => sb.from('model_value_series').select('strategy_id,as_of,value,benchmark_value,coverage').order('as_of', { ascending: true }), 'model value series'),
    qSoft(sb.from('holdings_snapshot_integrity').select('strategy_id,as_of,n_holdings,weight_total,weight_off,n_unmatched,n_suspect_names,gap_days_before').order('as_of', { ascending: true }), 'holdings integrity'),
    qSoft(sb.from('current_holdings').select('strategy_id,as_of,ticker,security_id,name_raw,weight'), 'current holdings'),
    qSoft(sb.from('holding_factor_overrides').select('security_id,split,note,author,as_of'), 'factor overrides'),
    qSoft(sb.from('lens_signal_to_noise').select('category,window_label,n_scored,n_sources,hit_rate,signal,noise,signal_to_noise,too_few_to_judge'), 'lens signal to noise'),
    qSoft(sb.from('latest_holding_risk_return').select('security_id,period,as_of,start_date,end_date,total_return,sharpe,vol_ann,n_obs'), 'holding risk/return'),
    qSoft(sb.from('latest_model_trailing_returns').select('strategy_id,period,as_of,sort_order,start_date,end_date,model_return,benchmark_return,excess_return,is_cagr,basis,unavailable_reason').order('sort_order'), 'trailing returns'),
    qSoft(sb.from('latest_model_style_exposure').select('strategy_id,lens,as_of,bucket,label,sort_order,kind,model_weight,benchmark_weight').order('sort_order'), 'style exposure'),
    qSoft(sb.from('latest_model_style_coverage').select('strategy_id,lens,as_of,basis,window_start,window_end,model_equity_weight,model_resolved,benchmark_resolved,unresolved'), 'style coverage'),
    qSoft(sb.from('latest_model_monthly_returns').select('strategy_id,as_of,year,month,model_return,benchmark_return,excess_return,coverage,is_partial,in_gap,basis,unavailable_reason'), 'monthly returns'),
    qSoft(sb.from('latest_model_trades').select('strategy_id,as_of,ticker,entry_date,exit_date,avg_weight,entry_weight,exit_weight,total_return,contribution_bps,excess_bps,status,sizing_verdict,starts_in_gap,pre_existing,unavailable_reason'), 'trade ledger'),
    qSoft(sb.from('latest_position_decision_scores').select('strategy_id,as_of,ticker,window_key,sort_order,start_date,end_date,weight,position_return,benchmark_return,decision_bps,is_partial,starts_in_gap,unavailable_reason').order('sort_order'), 'position decision scores'),
    qSoft(sb.from('latest_model_decision_stats').select('strategy_id,as_of,n_closed,n_open,n_wins,n_losses,batting_average,slugging_bps,win_bps,loss_bps,median_weight,n_unpriced,first_snapshot,last_snapshot,gap_days,n_beat_benchmark,excess_bps_total,n_type_i,type_i_bps,n_type_ii,type_ii_reason,avg_hold_days,n_trades_ytd'), 'decision stats'),
    qSoft(sb.from('annie_assessments').select('as_of,kind,strategy_id,ticker,headline,body_md,score,score_scale,confidence,sources,author').order('as_of', { ascending: false }), 'Annie assessments'),
    qSoft(sb.from('latest_annie_trade_reviews').select('strategy_id,as_of,ticker,entry_date,exit_date,held_return,held_excess_bps,days_since_exit,after_return,after_bench,after_excess,held_instead_bps,better_ticker,better_return,better_gain_bps,n_alternatives,exit_verdict,entry_verdict,headline,lesson,unavailable_reason'), 'trade reviews'),
    qSoft(sb.from('latest_sven_rule_signals').select('as_of,ticker,rule_key,rule_no,rule_title,state,headline,detail,method,adapted').order('rule_no'), 'Raschke rules'),
    qSoft(sb.from('latest_news_failure_readings').select('as_of,ticker,label,asset_class,window_days,n_releases,n_positive,n_negative,n_series,n_factors,agreement,price_change,made_new_high,made_new_low,verdict,headline,held_in,impacted'), 'news failure'),
    qSoft(sb.from('macro_beauty_readings').select('as_of,score,stance,n_live,n_total,headline').order('as_of', { ascending: false }).limit(1), 'beauty reading'),
    qSoft(sb.from('latest_macro_beauty_components').select('as_of,component,label,score,status,headline,measure,value_text,source,how_to_supply,data_as_of'), 'beauty components'),
    qSoft(sb.from('latest_macro_regime_readings').select('as_of,regime,growth_z,inflation_z,conviction,n_growth,n_inflation,data_as_of,stale_days,liquidity_z,n_liquidity,rate_driver,term_premium_z,breakeven_z'), 'macro regime'),
    qSoft(sb.from('latest_beauty_contest_rankings').select('as_of,dimension,regime,rank,prefer,avoid,prefer_tkr,avoid_tkr,spread_1m,spread_3m,confirmed,headline,unavailable_reason'), 'beauty contest'),
    qSoft(sb.from('macro_beauty_readings').select('as_of,score,stance').order('as_of', { ascending: true }).limit(500), 'beauty history'),
    qSoft(sb.from('latest_model_var').select('as_of,strategy_id,scope,horizon_days,horizon_label,confidence,var_return,es_return,worst_return,n_obs,n_independent,window_start,window_end,unavailable_reason'), 'value at risk'),
    qSoft(sb.from('latest_tail_risk_estimates').select('as_of,scope,strategy_id,method,episode,episode_label,window_start,window_end,estimate,benchmark_est,coverage,detail,note'), 'tail risk'),
    qSoft(sb.from('latest_firm_metrics').select('as_of,period,metric,label,sort_order,value,unit,benchmark_value,n_obs,detail,unavailable_reason').order('sort_order'), 'firm metrics'),
    qSoft(sb.from('latest_firm_exposures').select('as_of,ticker,name,asset_class,usd,firm_weight,n_models,models,largest_in,largest_wt').order('usd', { ascending: false }), 'firm exposures'),
    // helps/hurts (current holdings, in firm dollars) are deliberately not fetched: the card ranks
    // the whole universe now, and the held-only lists were the thing being replaced.
    qSoft(sb.from('latest_firm_stress_results').select('as_of,scenario_id,factor_score,by_factor,coverage,aum_covered,n_models,universe_helps,universe_hurts,universe_meta'), 'firm stress'),
    qSoft(sb.from('latest_security_class_blend_fit').select('security_id,vol_asset,window_from,window_to,n_weeks,chosen_mix,vol_chosen,ratio_chosen,passes,suggested_mix,vol_suggested,ratio_suggested,suggested_corr,tolerance,achievable'), 'class blend fit'),
    qSoft(sb.from('latest_model_duration').select('strategy_id,as_of,fi_duration,fi_weight,total_duration,n_fi_holdings,n_priced,n_unmeasured,n_insignificant,coverage'), 'model duration'),
    qAllSoft(() => sb.from('latest_model_geo_exposure').select('strategy_id,as_of,scope,code,label,region,model_weight,benchmark_weight'), 'model geography'),
    qSoft(sb.from('latest_model_geo_coverage').select('strategy_id,as_of,basis,model_equity_weight,model_resolved,benchmark_resolved,unresolved,window_start,window_end'), 'model geography coverage'),
    qSoft(sb.from('latest_factor_fingerprint').select('scope,strategy_id,as_of,factor,label,model_beta,benchmark_beta,active_beta,sort_order'), 'factor fingerprint'),
    qSoft(sb.from('latest_factor_fingerprint_coverage').select('scope,strategy_id,as_of,model_equity_weight,model_resolved,benchmark_resolved,unresolved,window_start,window_end'), 'factor fingerprint coverage'),
    qSoft(sb.from('latest_model_tax_efficiency').select('strategy_id,as_of,year,st_gain_bps,st_loss_bps,lt_gain_bps,lt_loss_bps,n_st,n_lt,bps_from_trims,n_sales,n_full_exits,n_trims'), 'tax efficiency'),
    qSoft(sb.from('latest_model_tax_coverage').select('strategy_id,as_of,first_snapshot,last_snapshot,n_lots_opened,n_sales,n_partial_sales,opening_lot_bps,unpriced_sales'), 'tax coverage'),
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
    return { id: st.id, name: st.name, label: st.label, benchmarkLabel: st.benchmark || null, aum: st.aum === null || st.aum === undefined ? null : +st.aum, equityWeight: st.equity_weight === null || st.equity_weight === undefined ? null : +st.equity_weight, holdings, total, net: net.map(x => +x.toFixed(3)), cov: total ? cov / total : 0,
      byClass: Object.entries(byClass).sort((a, b) => b[1] - a[1]), last: rows.map(r => r.effective_from).sort().pop() || null };
  });
  const classNames = Object.fromEntries(classes.map(c => [c.slug, c.name])); classNames.unclassified = 'Unclassified';
  const matrix = classes.map(c => ({ slug: c.slug, name: c.name, v: factors.map(f => (cl.get(c.id + '|' + f.id) || {}).loading ?? null) }));
  const priceBySec = Object.fromEntries(prices.map(p => [p.security_id, p]));
  const techBySec = Object.fromEntries(technicals.map(t => [t.security_id, t]));
  const markets = secs.map(s => ({ id: s.id, ticker: s.ticker, name: s.name, role: s.role, cls: cls[s.asset_class_id]?.slug || 'unclassified', price: priceBySec[s.id] || null, tech: techBySec[s.id] || null,
    hp: !!s.high_potential, hpSince: s.high_potential_since || null, hpNote: s.high_potential_note || null }))
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
    assessments: assessments || [], tradeReviews: tradeReviews || [],
    svenRules: newest(svenRules), newsFailure: newest(newsFailure),
    beautyReading: beautyReading || [], beautyComponents: beautyComponents || [], macroRegime: macroRegime || [],
    beautyRanks: beautyRanks || [], beautyHistory: beautyHistory || [], modelVar: modelVar || [], tailRisk: tailRisk || [],
    firmMetrics: firmMetrics || [], firmExposures: firmExposures || [], firmStress: firmStress || [],
    blendFit: blendFit || [], modelDuration: modelDuration || [],
    geoExposure: geoExposure || [], geoCoverage: geoCoverage || [],
    fingerprint: fingerprint || [], fingerprintCov: fingerprintCov || [],
    taxEff: taxEff || [], taxCov: taxCov || [] };
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
  let [page, arg] = (location.hash || '#sisyphus').slice(1).split('/');
  // #decisions was this page's hash before it was named after the agent who writes it. Anything
  // already bookmarked or pasted into a note still has to land, so the old name redirects rather
  // than falling through to the default page and looking like it had been deleted.
  if (page === 'decisions') { location.replace('#annie'); return; }
  // #overview was this page's hash before it was named after the agent whose brief it summarises.
  // It is also the hash anything bookmarked before today will carry, and it was the DEFAULT, so a
  // stale link is more likely here than anywhere else on the site.
  if (page === 'overview') { location.replace('#sisyphus' + (arg ? '/' + arg : '')); return; }
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + page));
  closeDrawer();
  // Keyed lookup, so this order is cosmetic rather than load-bearing — but it is kept in step
  // with the nav in index.html so the two read the same way.
  const pages = { sisyphus, stan, adam, sven, markets, views: viewsPage, signals, playground, agents, annie, briefs, inbox, status, sources };
  $('#app').innerHTML = (pages[page] || sisyphus)();
  if (page === 'stan' && arg) {
    // One route, three drawers. Keeping them on the hash means Escape, the scrim and the back
    // button all close them the same way a model drawer closes.
    if (arg === 'speed-limit') { $('#drawer').innerHTML = speedLimitDrawer(); $('#drawer').hidden = false; $('#scrim').hidden = false; }
    else if (arg.startsWith('snr-')) { $('#drawer').innerHTML = snrDrawer(arg.slice(4)); $('#drawer').hidden = false; $('#scrim').hidden = false; }
    else if (arg.startsWith('top3-')) { $('#drawer').innerHTML = top3Drawer(arg.slice(5)); $('#drawer').hidden = false; $('#scrim').hidden = false; }
    else openModel(arg);
  }
  if (page === 'annie' && arg && arg.startsWith('steel-')) {
    $('#drawer').innerHTML = steelManDrawer(arg.slice(6)); $('#drawer').hidden = false; $('#scrim').hidden = false;
  }
  if (page === 'sven' && arg) { $('#drawer').innerHTML = svenDrawer(arg); $('#drawer').hidden = false; $('#scrim').hidden = false; }
  if (page === 'markets' && arg) openChart(arg);
  if (page === 'sisyphus' && arg) openExposureChart(arg);
  if (page === 'views' && arg) openMacroChart(arg);
}

function sisyphus() {
  const M = D.models, latest = M.map(m => m.last).filter(Boolean).sort().pop();
  const gaps = M.filter(m => m.cov < 0.95), off = M.filter(m => Math.abs(m.total - 1) > 0.005);
  const alerts = [];
  if (!M.some(m => m.holdings.length)) alerts.push('No allocations are loaded in the database yet.');
  gaps.forEach(m => alerts.push(`<b>${esc(m.name)}</b>: only ${pct(m.cov, 0)} of weight has a loading.`));
  off.forEach(m => alerts.push(`<b>${esc(m.name)}</b>: latest weights sum to ${pct(m.total)}.`));
  M.filter(m => m.last && latest && m.last < latest).forEach(m => alerts.push(`<b>${esc(m.name)}</b>: last allocation ${m.last}, older than ${latest}.`));
  const run = D.run;
  // ---- Firm-wide, weighted by AUM ----
  const firmCard = (() => {
    const met = D.firmMetrics || [];
    const expo = D.firmExposures || [];
    if (!met.length) return '';
    const n = v => v === null || v === undefined ? null : +v;
    const periods = [...new Set(met.map(m => m.period))].sort((a, b) => ['YTD', '1Y', '3Y', 'ITD'].indexOf(a) - ['YTD', '1Y', '3Y', 'ITD'].indexOf(b));
    const at = (p, k) => met.find(m => m.period === p && m.metric === k) || null;
    const ORDER = [...new Map(met.map(m => [m.metric, m])).values()].sort((a, b) => a.sort_order - b.sort_order);
    const show = (r, v) => {
      if (v === null || v === undefined) return '<span style="color:var(--muted)">–</span>';
      if (r.unit === 'pct') return `${(v * 100).toFixed(2)}%`;
      if (r.unit === 'x') return `${v.toFixed(2)}×`;
      return v.toFixed(2);
    };
    const tone = (k, v) => v === null ? 'var(--muted)'
      : ['max_drawdown', 'current_drawdown', 'worst_month'].includes(k) ? 'var(--neg)'
      : ['return', 'excess', 'best_month'].includes(k) ? (v >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--text)';
    const aum = (D.models || []).filter(m => m.aum).reduce((a, m) => a + +m.aum, 0);
    const unfunded = (D.models || []).filter(m => !m.aum);

    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Firm-wide</h2>
        <span style="font-size:12px;color:var(--muted)">$${(aum / 1e6).toFixed(0)}M across ${(D.models || []).filter(m => m.aum).length} funded models${unfunded.length ? ` · ${unfunded.map(m => esc(m.name.replace(/\s*\([^)]*\)/g, ''))).join(', ')} excluded, no AUM supplied` : ''}</span></div>
      <div style="overflow-x:auto;margin-top:12px"><table style="min-width:620px"><thead><tr>
        <th>Metric</th>${periods.map(p => `<th class="num">${esc(p)}</th>`).join('')}</tr></thead><tbody>
      ${ORDER.map(r => `<tr><td${r.detail ? ` title="${esc(r.detail)}"` : ''}>${esc(r.label)}${r.detail ? '<sup style="color:var(--muted)">·</sup>' : ''}</td>
        ${periods.map(p => { const c = at(p, r.metric); const v = c ? n(c.value) : null;
          return `<td class="num" style="color:${tone(r.metric, v)}"${c && c.benchmark_value !== null ? ` title="benchmark ${(+c.benchmark_value * 100).toFixed(2)}%"` : ''}>${show(r, v)}${c && c.benchmark_value !== null ? `<br><small style="color:var(--muted)">${(+c.benchmark_value * 100).toFixed(2)}%</small>` : ''}</td>`;
        }).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="note">Every figure is the <b>AUM-weighted composite</b> of the funded models, measured against the same blend of their own benchmarks — so the firm is judged against the sum of its mandates rather than one index nobody runs to. Grey second lines are the benchmark. Hover a metric for what it is and where it misleads: <b>down capture</b> rests on far fewer observations than up capture in a rising market, <b>information ratio</b> is least stable exactly when it looks most impressive, and <b>Sharpe</b> is excess of BIL rather than of zero because using zero flatters every book through a period when bills paid 4–5%.</p>
      ${!expo.length ? '' : `<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
        <div class="eyebrow" style="margin-bottom:8px">Largest firm exposures</div>
        <table><thead><tr><th>Position</th><th>Class</th><th class="num">Firm dollars</th><th class="num">% of firm</th><th class="num">Models</th><th>Largest single weight</th></tr></thead><tbody>
        ${expo.slice(0, 12).map(e => `<tr><td><b>${esc(e.ticker)}</b></td>
          <td style="color:var(--muted)">${esc(e.asset_class || '—')}</td>
          <td class="num">$${(+e.usd / 1e6).toFixed(1)}M</td>
          <td class="num"><b>${(+e.firm_weight * 100).toFixed(1)}%</b></td>
          <td class="num" title="${esc((e.models || []).join(', '))}">${e.n_models}</td>
          <td style="color:var(--muted)">${pct(+e.largest_wt)} in ${esc(e.largest_in || '—')}</td></tr>`).join('')}
        </tbody></table>
        <p class="note">A name held at a modest weight in several models is a larger firm exposure than its largest single weight suggests, and no per-model view shows that. ${expo[0] ? `${esc(expo[0].ticker)} is ${(+expo[0].firm_weight * 100).toFixed(1)}% of the firm across ${expo[0].n_models} models while never exceeding ${pct(+expo[0].largest_wt)} in any one of them.` : ''}</p></div>`}
    </div>`;
  })();

  // ---- Stress scenarios, with the factor split the owner asked for ----
  const stressCard = (() => {
    // Firm level, AUM-weighted across every funded model. Reading one model's row as "the firm"
    // over-weights whichever model is shown and ignores the rest of the money.
    const res = D.firmStress || [], scen = D.scenarios || [];
    if (!res.length || !scen.length) return '';
    const models = D.models || [];
    const byScen = scen.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const fnum = v => v === null || v === undefined ? '–' : `${+v >= 0 ? '+' : ''}${(+v).toFixed(2)}`;
    const um = res[0] && res[0].universe_meta ? res[0].universe_meta : null;
    const ftone = v => v === null || v === undefined ? 'var(--muted)' : +v > 0.02 ? 'var(--pos)' : +v < -0.02 ? 'var(--neg)' : 'var(--muted)';
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Stress scenarios</h2>
        <span style="font-size:12px;color:var(--muted)">firm-wide, AUM-weighted${res[0] ? ` · ${(+res[0].coverage * 100).toFixed(0)}% of the book carries a factor loading` : ''}</span></div>
      <p class="note" style="margin:0 0 12px">Ten shocks, each expressed in the desk's own factor units. The score is net exposure times the shock — a <b>directional ranking, not a predicted return</b>; nothing here claims the book falls a given percent. What it does say is which sleeve carries a model and which one is being hurt, which a single score hides.</p>
      <p class="note" style="margin:0 0 12px"><b>Helped by</b> and <b>hurt by</b> range over the entire investable universe${um ? ` — all ${um.n_scored} securities the desk could buy, not the ${um.n_held_in_universe} it currently holds` : ''}. A name the firm already owns is marked <span style="color:var(--fg)">●</span>; the rest are candidates. <b>Expressible</b> is what the desk's 12% single-position limit leaves of the idea: no name can hold more than 12%, so a book built only from the names that help a scenario reaches 12% times however many of them there are. Nine is the first count that fills a book, which is why the lists stop at nine. Where the figure falls short of 100% the universe cannot express the scenario at all, and the shortfall is the finding — that much of the book has to sit in the shock rather than against it.</p>
      <div style="overflow-x:auto"><table style="min-width:1060px"><thead><tr>
        <th>Scenario</th><th class="num">Growth</th><th class="num">Inflation</th><th class="num">Liquidity</th>
        <th class="num">Net</th><th class="num">Expressible</th><th>Helped by</th><th>Hurt by</th></tr></thead><tbody>
      ${byScen.map(sc => {
        const r = res.find(x => x.scenario_id === sc.id);
        if (!r) return '';
        const f = r.by_factor || {};
        const uh = r.universe_helps || [], uu = r.universe_hurts || [];
        const sh = sc.shocks || {};
        const m = r.universe_meta || {};
        // Four names fit the column; the title carries all nine with the fit behind each, because
        // a beta is worth what its R-squared says it is worth and the cell has no room to say so.
        const cell = (list, tone) => {
          if (!list.length) return '<span style="color:var(--muted)">—</span>';
          const full = list.map(x => `${x.ticker}${x.held ? ' (held)' : ''}  ${(+x.score >= 0 ? '+' : '') + (+x.score).toFixed(2)}%/wk, R² ${x.r2 === null ? 'n/a' : (+x.r2).toFixed(2)}, ${x.n_weeks}w`).join('\n');
          return `<span title="${esc(full)}" style="color:${tone};font-size:12px">${list.slice(0, 4).map(x => `${x.held ? '<span style="color:var(--fg)">●</span>' : ''}${esc(x.ticker)}`).join(', ')}${list.length > 4 ? ` <span style="color:var(--muted)">+${list.length - 4}</span>` : ''}</span>`;
        };
        const cov = m.help_coverage;
        return `<tr><td title="${esc(sc.description || '')}"><b>${esc(sc.name)}</b><br><small style="color:var(--muted)">G ${fnum(sh.growth)} · I ${fnum(sh.inflation)} · L ${fnum(sh.liquidity_cost)}</small></td>
          <td class="num" style="color:${ftone(f.growth)}">${fnum(f.growth)}</td>
          <td class="num" style="color:${ftone(f.inflation)}">${fnum(f.inflation)}</td>
          <td class="num" style="color:${ftone(f.liquidity_cost)}">${fnum(f.liquidity_cost)}</td>
          <td class="num"><b style="color:${ftone(r.factor_score)}">${fnum(r.factor_score)}</b></td>
          <td class="num" style="font-size:12px;color:${cov === undefined || cov === null ? 'var(--muted)' : +cov >= 0.999 ? 'var(--muted)' : 'var(--neg)'}" title="${uh.length} name${uh.length === 1 ? '' : 's'} in the universe measurably help this scenario, capped at 12% each.">${cov === undefined || cov === null ? '–' : (+cov * 100).toFixed(0) + '%'}</td>
          <td>${cell(uh, 'var(--pos)')}</td>
          <td>${cell(uu, 'var(--neg)')}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="note">Weighted by AUM across every funded model, so a name held small in a large book counts for more than the same name held large in a small one. The three factor columns are the same arithmetic as the net score, kept split: a model can come through a stagflation shock because its inflation sleeve carries it while its growth sleeve is being hurt, and the net figure alone would not say so. One scenario is deliberately benign — a stress set whose members all point the same way tests one thing repeatedly, and having no exposure to a good outcome is also a position. Hover a scenario for what it describes, or a ticker list for every name in it with the fit behind it.</p>
      ${um ? `<p class="note" style="color:var(--muted)">Universe ranking: each security's weekly excess return regressed on three priced factor legs — growth ${esc(um.legs.growth)}, inflation ${esc(um.legs.inflation)}, liquidity ${esc(um.legs.liquidity_cost)} — and scored as beta × shock × the leg's own weekly volatility, so the figure is an expected weekly excess return rather than an index. ${um.n_scored} of ${um.n_universe} securities cleared the ${um.min_weeks}-week minimum (${um.n_short_history} too short). A leg whose beta sits inside two standard errors of zero is not counted, which is why a fund can appear on neither list: no measurable exposure is a finding, not a score of zero. Returns-based throughout — these are estimated exposures, never a holdings look-through${(um.truncated || []).length ? `, and ${esc((um.truncated || []).map(x => x.split(' ')[0]).join(', '))} is fitted only on history after a corrupt price break` : ''}.</p>` : ''}</div>`;
  })();

  // ---- Tail risk: what a crisis would actually do, which VaR cannot say ----
  const tailCard = (() => {
    const all = D.tailRisk || [];
    if (!all.length) return '';
    const n = v => v === null || v === undefined ? null : +v;
    const scopes = [...new Set(all.map(r => r.scope))];
    const ordered = ['Firm', ...scopes.filter(s => s !== 'Firm')];
    const eps = [...new Map(all.filter(r => r.method === 'crisis_replay').map(r => [r.episode, r])).values()];
    const pc = v => v === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:var(--neg)">${(v * 100).toFixed(1)}%</span>`;
    const firmRho = all.find(r => r.scope === 'Firm' && r.method === 'stressed_correlation');
    const firmWorst = all.filter(r => r.scope === 'Firm' && r.method === 'crisis_replay')
      .reduce((a, b) => (a && +a.estimate < +b.estimate) ? a : b, null);
    const var99 = (D.modelVar || []).find(r => r.scope === 'Book-wide' && r.horizon_days === 21 && Math.abs(+r.confidence - 0.99) < 1e-9);

    return `<div class="card" style="margin-bottom:14px;border-left:3px solid var(--warn)">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Tail risk — what a crisis would actually do</h2>
        <span style="font-size:12px;color:var(--muted)">estimates from asset-class proxies, not a replay of the funds</span></div>
      <p class="note" style="margin:8px 0 14px"><b>The VaR above cannot answer this, and the gap is not small.</b> The series it is computed from begins 2022-10-31 — within days of the market bottom — and contains no crisis at all; the worst single day in it is −2.4%. Its 99% monthly reading of ${var99 && var99.var_return !== null ? `${(+var99.var_return * 100).toFixed(1)}%` : '—'} is a claim about the worst month of a four-year bull run.${firmWorst ? ` Run today's weights through the acute weeks of 2008 instead and the firm estimates <b style="color:var(--neg)">${(+firmWorst.estimate * 100).toFixed(1)}%</b>.` : ''} Today's book cannot be replayed directly: eleven of its twenty-eight positions did not exist before 2022.</p>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
        ${firmWorst ? `<div class="card kpi" title="${esc(firmWorst.note || '')}">
          <span class="eyebrow">Worst crisis replay · firm</span>
          <b style="font-size:26px;color:var(--neg)">${(+firmWorst.estimate * 100).toFixed(1)}%</b>
          <small>${esc(firmWorst.episode_label)}, ${esc(firmWorst.window_start)} to ${esc(firmWorst.window_end)}</small></div>` : ''}
        ${firmRho ? `<div class="card kpi" title="${esc(firmRho.note || '')}">
          <span class="eyebrow">Correlations to 1 · 99% month</span>
          <b style="font-size:26px;color:var(--neg)">${(+firmRho.estimate * 100).toFixed(1)}%</b>
          <small>at ${((firmRho.detail || {}).stressed_vol * 100).toFixed(1)}% volatility, against ${(((firmRho.detail || {}).actual_vol || 0) * 100).toFixed(1)}% today</small></div>` : ''}
        ${firmRho && (firmRho.detail || {}).diversification_ratio ? `<div class="card kpi" title="The book's actual volatility as a share of its correlation-1 limit. The gap to 1 is the risk reduction that depends on correlations holding — and a left-tail event is precisely when they do not.">
          <span class="eyebrow">Diversification relied on</span>
          <b style="font-size:26px">${((1 - +firmRho.detail.diversification_ratio) * 100).toFixed(0)}%</b>
          <small>of the firm's risk reduction is correlation, not cash</small></div>` : ''}
      </div>
      <div style="overflow-x:auto;margin-top:14px"><table style="min-width:860px"><thead><tr>
        <th>Scope</th>${eps.map(e => `<th class="num" title="${esc(e.window_start + ' to ' + e.window_end)}">${esc(e.episode_label)}</th>`).join('')}
        <th class="num">ρ→1 month</th><th class="num">Covered</th></tr></thead><tbody>
      ${ordered.map(sc => {
        const rho = all.find(r => r.scope === sc && r.method === 'stressed_correlation');
        const any = all.find(r => r.scope === sc);
        return `<tr${sc === 'Firm' ? ' style="background:var(--panel2)"' : ''}>
          <td>${sc === 'Firm' ? `<b>${esc(sc)}</b>` : esc(sc.replace(/\s*\([^)]*\)/g, ''))}</td>
          ${eps.map(e => { const r = all.find(x => x.scope === sc && x.method === 'crisis_replay' && x.episode === e.episode);
            return `<td class="num">${r ? pc(n(r.estimate)) : '<span style="color:var(--muted)">–</span>'}</td>`; }).join('')}
          <td class="num"><b>${rho ? pc(n(rho.estimate)) : '–'}</b></td>
          <td class="num" style="color:${any && +any.coverage < 0.9 ? 'var(--warn)' : 'var(--muted)'}" title="Alternatives carry no crisis proxy and are excluded.">${any ? (+any.coverage * 100).toFixed(0) + '%' : '–'}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="note"><b>Crisis replay</b> maps today's weights onto the liquid proxy for each asset class — SPY, AGG, GLD, DBC, BIL, which carry twenty years of history — and runs them through the real episode with the correlations that actually prevailed. It is <i>not</i> a replay of the actual funds, which track their proxies imperfectly and in a crisis probably worse, since several are materially less liquid than an index ETF.
      <b>ρ→1</b> forces every pairwise correlation to one, the arithmetic limit where diversification contributes nothing, and reports a 99% one-month loss at that volatility with no drift credited.
      <b>Covered</b> is the share of the book the estimate can see. <b>Alternatives are excluded and deliberately not given a proxy</b>: they are bought precisely on the claim that they do not go to one with everything else, so mapping them to equities would assume the claim is false and mapping them to cash would assume it is true. Both would invent the answer to the question being asked, and the uncovered share is itself the finding — whether that sleeve holds up is the untested part of the book.</p></div>`;
  })();

  // ---- Value at Risk: the left tail, book-wide and per model ----
  //
  // Historical, not parametric. A normal curve understates exactly the tail this exists to
  // describe, so the figures are the empirical percentiles of the book's own past returns. The
  // independent-observation count is shown beside the monthly readings on purpose: a 99% monthly
  // VaR drawn from 43 independent months is one observation deep in the tail.
  const varCard = (() => {
    const rows = D.modelVar || [];
    if (!rows.length) {
      return `<div class="card" style="margin-bottom:14px"><h2>Value at Risk</h2>
        <div class="empty">Not computed yet. Run jobs/compute-var.mjs.</div></div>`;
    }
    const HOR = [[1, 'Daily'], [5, 'Weekly'], [21, 'Monthly']];
    const at = (scope, h, c) => rows.find(r => r.scope === scope && r.horizon_days === h && Math.abs(+r.confidence - c) < 1e-9) || null;
    const scopes = [...new Set(rows.map(r => r.scope))];
    const others = scopes.filter(s => s !== 'Book-wide');
    const pc = v => v === null || v === undefined ? '<span style="color:var(--muted)">–</span>'
      : `<span style="color:var(--neg)">${(+v * 100).toFixed(2)}%</span>`;
    const book = h => HOR.find(x => x[0] === h);

    const headline = `<div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-top:12px">
      ${HOR.map(([h, label]) => {
        const r95 = at('Book-wide', h, 0.95), r99 = at('Book-wide', h, 0.99);
        return `<div class="card kpi" title="${esc(r99 && r99.unavailable_reason ? r99.unavailable_reason : `${r99 ? r99.n_obs : 0} overlapping ${label.toLowerCase()} windows, about ${r99 ? r99.n_independent : 0} independent. Worst in the sample ${r99 && r99.worst_return !== null ? (+r99.worst_return * 100).toFixed(2) + '%' : '—'}.`)}">
          <span class="eyebrow">${esc(label)} · book-wide</span>
          <b style="font-size:26px;color:var(--neg)">${r95 && r95.var_return !== null ? (+r95.var_return * 100).toFixed(2) + '%' : '—'}</b>
          <small>at 95% · ${r99 && r99.var_return !== null ? (+r99.var_return * 100).toFixed(2) + '%' : '—'} at 99%</small></div>`;
      }).join('')}</div>`;

    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Value at Risk — the left tail</h2>
        <span style="font-size:12px;color:var(--muted)">${esc(rows[0].window_start || '')} to ${esc(rows[0].window_end || '')}</span></div>
      ${headline}
      <div style="overflow-x:auto;margin-top:14px"><table style="min-width:820px"><thead><tr>
        <th>Scope</th><th>Horizon</th><th class="num">VaR 95%</th><th class="num">Shortfall 95%</th>
        <th class="num">VaR 99%</th><th class="num">Shortfall 99%</th><th class="num">Worst</th><th class="num">Sample</th>
      </tr></thead><tbody>
      ${['Book-wide', ...others].map(scope => HOR.map(([h, label], i) => {
        const a = at(scope, h, 0.95), b = at(scope, h, 0.99);
        const thin = b && b.n_independent !== null && +b.n_independent < 60;
        return `<tr${scope === 'Book-wide' ? ' style="background:var(--panel2)"' : ''}>
          <td>${i === 0 ? `<b>${esc(scope)}</b>` : '<span style="color:var(--muted)">·</span>'}</td>
          <td>${esc(label)}</td>
          <td class="num">${pc(a?.var_return)}</td><td class="num">${pc(a?.es_return)}</td>
          <td class="num"><b>${pc(b?.var_return)}</b></td><td class="num">${pc(b?.es_return)}</td>
          <td class="num" style="color:var(--muted)">${b && b.worst_return !== null ? (+b.worst_return * 100).toFixed(2) + '%' : '–'}</td>
          <td class="num" style="color:${thin ? 'var(--warn)' : 'var(--muted)'}" title="${esc(`${b ? b.n_obs : 0} overlapping windows, about ${b ? b.n_independent : 0} independent`)}">${b ? b.n_independent : '–'}${thin ? '<sup>·</sup>' : ''}</td></tr>`;
      }).join('')).join('')}
      </tbody></table></div>
      <p class="note"><b>Historical, not parametric.</b> These are the empirical percentiles of each book's own past returns — the 5th worst period in a hundred and the 1st worst — with no normal curve assumed. That is deliberate: a normal curve understates exactly the tail this measure exists to describe, and the cost is that it can only show tails the sample actually contains.
      <b>Shortfall</b> is the average loss in the periods worse than VaR. VaR says how bad the threshold is and nothing about what lies past it, so when the two diverge the shortfall is the number to read.
      Weekly and monthly use overlapping windows, because non-overlapping ones would leave about 200 weeks and 47 months — too few to read a 99th percentile from at all. <b>Sample</b> is the effective independent count, and a figure under 60 is marked: a 99% monthly reading drawn from 43 independent months is one observation deep in the tail.
      <b>Book-wide is equal-weighted across the models</b>, because this desk records no capital figure per model. It is a real portfolio — the same amount in each — not a guess at how the money is actually split.</p></div>`;
  })();

  return `<span class="eyebrow">Sisyphus · the desk at a glance</span><h1>Sisyphus</h1>
  <p class="sub">Eight models, viewed as net long or short growth, inflation and the cost of liquidity.</p>
  ${firmCard}
   ${fingerprintCard('firm', null, 'Firm', 'Blended benchmark', 'Factor fingerprint — firm-wide equity')}
   ${varCard}
   ${tailCard}
   ${stressCard}
  <div class="kpis">
   <div class="card kpi"><span class="eyebrow">Models</span><b>${M.length}</b><small>10/90 to 80/20</small></div>
   <div class="card kpi"><span class="eyebrow">Latest allocation</span><b style="font-size:20px">${esc(latest || '—')}</b><small>most recent trade date</small></div>
   <div class="card kpi"><span class="eyebrow">Exposure coverage</span><b>${M.length - gaps.length}/${M.length}</b><small>models with ≥95% scored</small></div>
   <div class="card kpi"><span class="eyebrow">Prices</span><b style="font-size:20px" class="${run && run.status !== 'ok' ? 'stale' : ''}">${esc(run ? run.latest_price_date || run.status : 'no run yet')}</b><small>${run ? 'last job: ' + esc(run.status) : 'daily job not run'}</small></div>
  </div>
  <div class="grid2"><div class="card"><h2>Net exposure by model <span class="chip draft">draft loadings</span></h2>
   <table><thead><tr><th>Model</th>${factorHeads()}<th class="num">Scored</th></tr></thead><tbody>
   ${M.map(m => `<tr class="click" data-go="#sisyphus/${esc(m.id)}"><td><b>${esc(m.name)}</b> <span class="chip">${esc(m.label)}</span></td>${netCells(m)}<td class="num">${pct(m.cov, 0)}</td></tr>`).join('')}</tbody></table>
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
  // The return step adapts to the span. Fixed at 5% it drew 49 ticks across the five-year window,
  // whose labels ran together into an unreadable band along the bottom of the chart — the axis
  // was correct and illegible at the same time. Aim for about ten gridlines whatever the range.
  const xSpan = Math.max(...pts.map(p => p.x)) - Math.min(0, ...pts.map(p => p.x));
  const xStep = [0.05, 0.1, 0.25, 0.5, 1].find(st => xSpan / st <= 12) || 2;
  const [x0, x1] = nice(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x)), xStep);
  const [y0, y1] = nice(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)), 0.5);
  const X = v => pad.l + ((v - x0) / ((x1 - x0) || 1)) * (W - pad.l - pad.r);
  const Y = v => Hh - pad.b - ((v - y0) / ((y1 - y0) || 1)) * (Hh - pad.t - pad.b);

  const xTicks = [], yTicks = [];
  for (let v = x0; v <= x1 + 1e-9; v += xStep) xTicks.push(+v.toFixed(4));
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
    // Left of the vertical zero line is a position that lost money over the window. Marked red in
    // both the dot and its ticker, so it reads at a glance rather than by tracing the axis — the
    // Sharpe line is a separate division and keeps its own meaning in the note.
    const lost = p.x < 0;
    const col = lost ? 'var(--neg)' : 'var(--growth)';
    return `<g><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="${col}">
        <title>${esc(p.t)} · return ${(p.x * 100).toFixed(1)}% · Sharpe ${p.y.toFixed(2)} · vol ${(p.vol * 100).toFixed(0)}% · ${p.n} days${lost ? ' · lost money over this window' : ''}</title></circle>
      <text x="${cx.toFixed(1)}" y="${(cy + (below ? 17 : -10)).toFixed(1)}" font-size="10" fill="${col}"${lost ? ' font-weight="600"' : ''} text-anchor="middle">${esc(p.t)}</text></g>`;
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
      <div class="card kpi"><span class="eyebrow">Lost money</span><b style="color:${pts.some(p => p.x < 0) ? 'var(--neg)' : 'var(--text)'}">${pts.filter(p => p.x < 0).length}</b><small>negative return, marked red</small></div>
      <div class="card kpi"><span class="eyebrow">Positions plotted</span><b>${pts.length}</b><small>held across all models</small></div>
    </div>
    <p class="note">Every security currently held anywhere in the book, plotted by its total return against its Sharpe ratio over the window. <b>Sharpe is excess of BIL</b>, the desk's cash proxy, not of zero — across a period when cash paid 4–5% that distinction decides whether a low-volatility fund looks good or merely looks calm. <b>A position left of the vertical zero line lost money over the window, and is drawn red</b> — dot and ticker both. That is a different division from the horizontal line: anything below <i>that</i> failed to beat cash once its own volatility is allowed for, whatever its return did, so a holding can be red for losing money and still sit above the Sharpe line, or sit below it having made money. A holding without enough price history for a window is not plotted rather than shown on a short sample; hover any point for its volatility and the number of days behind it.</p></div>`;
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
          : (() => {
              // The beta itself is deliberately not here: it is the next column over, and showing
              // it twice invited reading this cell as a measurement when its only job is the
              // verdict — inside the band the Speed Limit calls for, or outside it.
              // The dot follows the BAND, not the master light: green inside, red outside. The
              // light already has its own column, and a dot repeating it said nothing about the
              // band it sits in.
              const inBand = bandState === 'inside';
              const col = bandState === null ? 'var(--muted)' : inBand ? 'var(--pos)' : 'var(--neg)';
              const tip = [b.note,
                b.target_low === null ? '' : `Band ${(+b.target_low).toFixed(2)}×–${(+b.target_high).toFixed(2)}×`,
                bandState === 'below' ? 'Below the band is more defensive than the lights call for, not worse.' : '',
                bandState === 'above' ? 'Above the band is carrying more market risk than the lights call for.' : '',
              ].filter(Boolean).join(' · ');
              return `<span title="${esc(tip)}"><small style="white-space:nowrap">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};vertical-align:middle"></span>
                <span style="color:${col};font-weight:600"> ${esc(bandState || b.light)}</span>${b.target_low === null ? '' : `<span style="color:var(--muted)"> ${(+b.target_low).toFixed(2)}–${(+b.target_high).toFixed(2)}</span>`}</small></span>`;
            })()}</td>
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
   <p class="note"><b>Beta vs band</b> says only whether the model sits inside, below or above the band the master Speed Limit calls for, with the band beside it — green inside, red outside. The beta itself is the next column, not this one: carrying it twice invited reading the verdict cell as a measurement. Below the band is more defensive than the lights call for rather than worse, which is why the colour marks conformity and not quality. <b>Beta vs bench</b> is the figure itself, against that model's own benchmark — read R² first, since below 0.5 the regression is not describing risk posture and the band cell shows "unrated" instead. <b>Top-3 risk</b> is the share of model volatility carried by its three largest contributors, against the weight those same three hold; click it for the names. Performance is year-to-date on <b>target weights for every model</b>, gross of fees, so the eight are comparable with each other. That is not the same number a model's own drawer shows: where a model has a dated holdings history its drawer measures what it actually held, and the two will differ — for Balanced Core by several points. Cash is priced as BIL rather than dropped, which it used to be. <b>vs CPI</b>, <b>vs Gold</b> and <b>vs BTC</b> restate the model in that numeraire — (1+model)÷(1+numeraire)−1 — so green means the model held its value against that yardstick rather than merely rose. Gold is GLD and bitcoin is Tiingo spot, both over the model's own window. <b>CPI is different and the cell is honest about it:</b> headline CPI is monthly and published in arrears, so the newest reading always covers a month that ended some time ago. Rather than divide a longer investment return by a shorter inflation one — which would quietly flatter every model here — the comparison runs over the months CPI has actually reported, with the model re-measured over exactly those dates. Hover the cell for the window.</p></div>`;

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

// ---------- Equity curve, from the trade ledger ----------
//
// The curve is the running sum of what each completed trade CONTRIBUTED to the model, in order of
// exit, plotted against trade number rather than against time. That is deliberate and it is a
// different question from the monthly grid on a model's own page: this one asks how the decisions
// compounded, so a quiet year takes no space and a flurry of trades takes a lot.
//
// Every figure in the panel beside it is computed here from the same two sources the rest of the
// page uses — the ledger for anything per-trade, the daily value series for anything per-calendar
// — so nothing can drift from the journal underneath. Which source each one uses is stated,
// because "profitable days" and "winrate" sound like the same kind of number and are not.
function equityCurve(trades, series) {
  const closed = trades
    .filter(t => t.status === 'closed' && t.total_return !== null && t.contribution_bps !== null)
    .sort((a, b) => String(a.exit_date).localeCompare(String(b.exit_date)));
  if (!closed.length) return null;

  const pts = [];
  let cum = 0;
  for (const t of closed) { cum += (+t.contribution_bps) / 100; pts.push({ t, cum }); }

  // Max drawdown on the curve itself: the deepest give-back from a running high, in points of
  // cumulative return. Not the model's drawdown — this one only moves when a trade closes.
  let peak = 0, mdd = 0, flat = 0, longestFlat = 0;
  for (const p of pts) {
    if (p.cum > peak) { peak = p.cum; flat = 0; } else { flat += 1; longestFlat = Math.max(longestFlat, flat); }
    mdd = Math.min(mdd, p.cum - peak);
  }

  const wins = closed.filter(t => +t.total_return > 0);
  const losses = closed.filter(t => +t.total_return <= 0);
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const avgWin = mean(wins.map(t => +t.total_return));
  const avgLoss = mean(losses.map(t => +t.total_return));
  const grossWin = closed.filter(t => +t.contribution_bps > 0).reduce((s, t) => s + +t.contribution_bps, 0);
  const grossLoss = Math.abs(closed.filter(t => +t.contribution_bps < 0).reduce((s, t) => s + +t.contribution_bps, 0));

  // Profit concentration: how much of the gross profit the best tenth of trades produced. A high
  // number is not a compliment — it says the record rests on a handful of trades, and a sample
  // that rests on a handful is a sample that has not been tested.
  const posContrib = closed.map(t => +t.contribution_bps).filter(v => v > 0).sort((a, b) => b - a);
  const topN = Math.max(1, Math.ceil(closed.length * 0.1));
  const concentration = grossWin > 0 ? posContrib.slice(0, topN).reduce((s, v) => s + v, 0) / grossWin : null;

  // Calendar measures come from the daily value series, NOT the trade list: a profitable day is a
  // property of the book, and most days have no trade in them at all.
  const daily = (series || []).slice().sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));
  const rets = [];
  for (let i = 1; i < daily.length; i++) {
    const a = +daily[i - 1].value, b = +daily[i].value;
    if (a > 0 && b > 0) rets.push({ d: daily[i].as_of, r: b / a - 1 });
  }
  const share = arr => arr.length ? arr.filter(v => v > 0).length / arr.length : null;
  const bucket = (keyOf) => {
    const m = new Map();
    for (const x of rets) { const k = keyOf(x.d); m.set(k, (m.get(k) ?? 1) * (1 + x.r)); }
    return [...m.values()].map(v => v - 1);
  };
  const isoWeek = d => { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day); return dt.toISOString().slice(0, 10); };
  const weekly = bucket(isoWeek), monthly = bucket(d => d.slice(0, 7));
  const sd = a => { if (a.length < 2) return null; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

  // Recent performance, measured over trades that CLOSED inside each window.
  const end = closed.at(-1).exit_date;
  const recent = [30, 90, 180].map(days => {
    const from = new Date(Date.parse(end) - days * 864e5).toISOString().slice(0, 10);
    const sub = closed.filter(t => t.exit_date > from);
    if (!sub.length) return { days, n: 0 };
    let c = 0, pk = 0, dd = 0;
    for (const t of sub) { c += (+t.contribution_bps) / 100; if (c > pk) pk = c; dd = Math.min(dd, c - pk); }
    return {
      days, n: sub.length, ret: c,
      winrate: sub.filter(t => +t.total_return > 0).length / sub.length,
      avgTrade: mean(sub.map(t => +t.total_return)),
      mdd: dd,
    };
  });

  return {
    pts, closed, mdd, longestFlat,
    total: cum,
    winrate: closed.length ? wins.length / closed.length : null,
    avgWin, avgLoss,
    rrr: (avgWin !== null && avgLoss !== null && avgLoss < 0) ? avgWin / Math.abs(avgLoss) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    concentration, topN,
    pDays: share(rets.map(x => x.r)), pWeeks: share(weekly), pMonths: share(monthly),
    weeklySd: sd(weekly),
    nDays: rets.length, nWeeks: weekly.length, nMonths: monthly.length,
    recent,
  };
}

// The curve itself. Hand-rolled SVG like every other chart here, split at zero so the area reads
// green above and red below without a gradient library.
function equitySvg(E) {
  const W = 560, H = 300, pad = { l: 40, r: 12, t: 12, b: 34 };
  const xs = E.pts.length;
  const lo = Math.min(0, ...E.pts.map(p => p.cum)), hi = Math.max(0, ...E.pts.map(p => p.cum));
  const span = (hi - lo) || 1;
  const X = i => pad.l + (i / Math.max(1, xs - 1)) * (W - pad.l - pad.r);
  const Y = v => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b);
  const line = E.pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.cum).toFixed(1)}`).join('');
  const area = `${line}L${X(xs - 1).toFixed(1)} ${Y(0).toFixed(1)}L${X(0).toFixed(1)} ${Y(0).toFixed(1)}Z`;
  const ticks = 5;
  const grid = Array.from({ length: ticks + 1 }, (_, i) => {
    const v = lo + (span * i) / ticks;
    return `<line x1="${pad.l}" y1="${Y(v).toFixed(1)}" x2="${W - pad.r}" y2="${Y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
      <text x="${pad.l - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${v.toFixed(0)}</text>`;
  }).join('');
  // One invisible hit column per trade, so hovering anywhere above a point names it.
  const hits = E.pts.map((p, i) => {
    const w = (W - pad.l - pad.r) / Math.max(1, xs);
    const r = +p.t.total_return, c = +p.t.contribution_bps;
    const tip = `${p.t.ticker} · trade ${i + 1} of ${xs}\nClosed ${p.t.exit_date} · held from ${p.t.entry_date}\nReturn ${(r >= 0 ? '+' : '') + (r * 100).toFixed(1)}% · contributed ${(c >= 0 ? '+' : '') + c.toFixed(0)} bps\nCurve at ${p.cum.toFixed(2)}%`;
    return `<rect x="${(X(i) - w / 2).toFixed(1)}" y="${pad.t}" width="${w.toFixed(1)}" height="${H - pad.t - pad.b}" fill="transparent" data-tip="${esc(tip)}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    <defs><linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--pos)" stop-opacity=".55"/><stop offset="100%" stop-color="var(--pos)" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#eqfill)"/>
    <path d="${line}" fill="none" stroke="var(--pos)" stroke-width="2"/>
    <line x1="${pad.l}" y1="${Y(0).toFixed(1)}" x2="${W - pad.r}" y2="${Y(0).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="${pad.l}" y="${H - 8}" font-size="10" fill="var(--muted)">1</text>
    <text x="${W - pad.r}" y="${H - 8}" font-size="10" fill="var(--muted)" text-anchor="end">${xs}</text>
    <text x="${(pad.l + W - pad.r) / 2}" y="${H - 8}" font-size="10" fill="var(--muted)" text-anchor="middle">Trades</text>
    ${hits}</svg>`;
}

// ---------- Adam: the Macro Beauty Contest ----------
//
// Keynes's contest is about picking what others will pick, not what deserves to win. So the page
// puts two things side by side: what the REGIME says should be favoured, from the owner's
// forty-two factor chart, and what the MARKET is already paying for. Agreement is a candidate
// others are already voting for. Disagreement is the row worth reading, and it is not hidden — a
// contest that only ever confirms itself is a mirror.
const REGIME_LOOK = {
  goldilocks: { label: 'Goldilocks', tone: 'var(--pos)',  blurb: 'Growth rising, inflation falling. The risk-on quadrant with no price pressure.' },
  reflation:  { label: 'Reflation',  tone: 'var(--flat)', blurb: 'Growth rising, inflation rising. Risk-on, but with price pressure building.' },
  inflation:  { label: 'Inflation',  tone: 'var(--neg)',  blurb: 'Growth falling, inflation rising. The stagflationary quadrant.' },
  deflation:  { label: 'Deflation',  tone: 'var(--neg)',  blurb: 'Growth falling, inflation falling. Defensive assets over risk.' },
};
const STANCE_LOOK = {
  risk_on:  ['Risk On',  'var(--pos)'],
  neutral:  ['Neutral',  'var(--flat)'],
  risk_off: ['Risk Off', 'var(--neg)'],
};

function adam() {
  const n = v => v === null || v === undefined ? null : +v;
  const reading = (D.beautyReading || [])[0] || null;
  const comps = D.beautyComponents || [];
  const regime = (D.macroRegime || [])[0] || null;
  const ranks = D.beautyRanks || [];
  const hist = D.beautyHistory || [];

  if (!reading && !regime && !ranks.length) {
    return `<span class="eyebrow">Macro</span><h1>Adam</h1>
     <p class="sub">The Macro Beauty Contest.</p>
     <div class="card"><div class="empty">Nothing computed yet. Run jobs/compute-macro-regime.mjs and jobs/compute-beauty-contest.mjs.</div></div>`;
  }

  // ---- the winners, at the top ----
  const scored = ranks.filter(r => r.rank !== null).slice().sort((a, b) => a.rank - b.rank);
  const winners = scored.filter(r => r.confirmed);
  const against = scored.filter(r => r.confirmed === false);
  const unscored = ranks.filter(r => r.rank === null);
  const pc = v => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : ''}${(+v * 100).toFixed(1)}%`;

  const podium = !winners.length ? '' : `<div class="podium">
    ${winners.slice(0, 3).map((w, i) => `<div class="pod pod${i + 1}">
      <div class="podrank">${i + 1}</div>
      <div class="poddim">${esc(w.dimension)}</div>
      <div class="podwin">${esc(w.prefer)}</div>
      <div class="podover">over ${esc(w.avoid)}</div>
      <div class="podspread" style="color:var(--pos)">${pc(w.spread_3m ?? w.spread_1m)}<small> 3 months</small></div>
      ${w.prefer_tkr ? `<div class="podtkr">${esc(w.prefer_tkr)} vs ${esc(w.avoid_tkr)}</div>` : ''}
    </div>`).join('')}</div>`;

  const contestCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">This week's beauty contest</h2>
      <span style="font-size:12px;color:var(--muted)">${regime ? esc(regime.as_of) : ''} · ${winners.length} of ${scored.length} dimensions have the tape agreeing with the regime</span></div>
    ${!regime ? '<div class="empty">No regime reading, so there is nothing to run the contest against.</div>' : `
    <p class="note" style="margin:8px 0 14px">The regime is <b style="color:${REGIME_LOOK[regime.regime].tone}">${esc(REGIME_LOOK[regime.regime].label)}</b>, and these are the dimensions where the market is <b>already paying</b> for what it prefers. Keynes's point was that the contest rewards picking what others pick — a preference the tape has not started confirming is a judgment, not a candidate.</p>
    ${podium}
    ${winners.length > 3 ? `<table style="margin-top:14px"><thead><tr><th class="num">#</th><th>Dimension</th><th>Favoured</th><th class="num">1 month</th><th class="num">3 months</th></tr></thead><tbody>
      ${winners.slice(3).map(w => `<tr><td class="num">${w.rank}</td><td>${esc(w.dimension)}</td>
        <td><b>${esc(w.prefer)}</b> <span style="color:var(--muted)">over ${esc(w.avoid)}</span></td>
        <td class="num" style="color:${(n(w.spread_1m) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(w.spread_1m)}</td>
        <td class="num" style="color:var(--pos)">${pc(w.spread_3m)}</td></tr>`).join('')}
      </tbody></table>` : ''}
    ${!against.length ? '' : `<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Where the regime and the tape disagree</div>
      <table><thead><tr><th>Dimension</th><th>Regime prefers</th><th class="num">1 month</th><th class="num">3 months</th></tr></thead><tbody>
      ${against.map(w => `<tr><td>${esc(w.dimension)}</td>
        <td><b>${esc(w.prefer)}</b> <span style="color:var(--muted)">over ${esc(w.avoid)}</span></td>
        <td class="num" style="color:${(n(w.spread_1m) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(w.spread_1m)}</td>
        <td class="num" style="color:var(--neg)">${pc(w.spread_3m)}</td></tr>`).join('')}
      </tbody></table>
      <p class="note">These are the rows worth reading. Either the regime call is early, or it is wrong, and a contest that only ever confirmed itself would be a mirror. ${regime && +regime.conviction < 0.5 ? `<b>Conviction on the regime is ${(+regime.conviction).toFixed(2)}</b>, which is close enough to the boundary between quadrants that disagreement here is unsurprising.` : ''}</p></div>`}
    ${!unscored.length ? '' : `<p class="note" style="margin-top:12px"><b>${unscored.length} dimension${unscored.length === 1 ? '' : 's'} could not be scored against the tape</b> — ${unscored.map(u => esc(u.dimension)).join(', ')}. The regime still states a preference; there is simply no tracked proxy to test it with, and filling that in from the chart would make the framework unfalsifiable.</p>`}`}
  </div>`;

  // ---- the headline reading ----
  const score = reading ? n(reading.score) : null;
  const [stLabel, stTone] = reading && reading.stance ? STANCE_LOOK[reading.stance] : ['Not yet reading', 'var(--muted)'];
  const dialPos = score === null ? 50 : score;
  const gauge = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Macro Beauty Contest</h2>
      <span style="font-size:12px;color:var(--muted)">${reading ? `${reading.n_live} of ${reading.n_total} legs live` : ''}${regime ? ' · as of ' + esc(regime.as_of) : ''}</span></div>
    <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap;margin-top:14px">
      <div style="min-width:150px">
        <div style="font-size:52px;font-weight:700;line-height:1;color:${stTone}">${score === null ? '—' : score.toFixed(0)}</div>
        <div style="font-size:17px;font-weight:600;color:${stTone};margin-top:4px">${esc(stLabel)}</div>
      </div>
      <div style="flex:1;min-width:260px">
        <div class="dialtrack"><div class="dialmark" style="left:${dialPos}%;background:${score === null ? 'var(--line)' : stTone}"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px">
          <span>Risk Off</span><span>Neutral</span><span>Risk On</span></div>
      </div>
    </div>
    <p class="note">${reading ? esc(reading.headline) : 'No reading computed yet.'}</p></div>`;

  // ---- the four legs ----
  const legCard = c => {
    const s = n(c.score);
    const live = c.status === 'live', stale = c.status === 'stale';
    const tone = s === null ? 'var(--muted)' : s >= 60 ? 'var(--pos)' : s <= 40 ? 'var(--neg)' : 'var(--flat)';
    return `<div class="card">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
        <h2 style="margin:0;font-size:13px">${esc(c.label)}</h2>
        <span class="chip" style="color:${live ? 'var(--pos)' : stale ? 'var(--warn)' : 'var(--muted)'}">${live ? 'live' : stale ? 'stale' : 'awaiting data'}</span></div>
      <div style="font-size:34px;font-weight:700;color:${tone};margin:8px 0 2px">${s === null ? '—' : s.toFixed(0)}</div>
      <div style="font-size:13px;margin-bottom:8px">${esc(c.headline)}</div>
      ${c.value_text ? `<div style="font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums">${esc(c.value_text)}</div>` : ''}
      ${c.measure ? `<p class="note" style="margin-top:8px">${esc(c.measure)}</p>` : ''}
      ${c.how_to_supply ? `<p class="note" style="margin-top:6px;color:var(--warn)">${esc(c.how_to_supply)}</p>` : ''}
      <div style="font-size:11px;color:var(--muted);margin-top:8px">Source: ${esc(c.source)}${c.data_as_of ? ` · data to ${esc(c.data_as_of)}` : ''}</div></div>`;
  };
  const order = ['global_liquidity', 'macro_regime', 'positioning', 'move_index'];
  const legs = `<div class="card" style="margin-bottom:14px">
    <h2>The four legs</h2>
    <p class="note" style="margin:0 0 12px">Equally weighted; the headline is their mean. A leg with no data scores <b>null, never zero</b> — a zero on a 0-100 risk scale reads as maximum risk-off, which is the most misleading thing an empty leg could say.</p>
    <div class="dashgrid" style="grid-template-columns:repeat(auto-fit,minmax(255px,1fr))">
      ${order.map(k => comps.find(c => c.component === k)).filter(Boolean).map(legCard).join('')}</div></div>`;

  // ---- the regime quadrant ----
  const quad = !regime ? '' : (() => {
    const g = +regime.growth_z, i = +regime.inflation_z;
    const lq = regime.liquidity_z === null || regime.liquidity_z === undefined ? null : +regime.liquidity_z;
    const DRIVER = {
      term_premium: ['term premium', 'Long rates are rising because investors want more compensation to hold duration, not because they expect more inflation. An inflation-hedged book is least prepared for this one.'],
      breakevens: ['breakevens', 'Long rates are rising on expected inflation rather than on the price of duration risk. Real assets and breakeven-linked holdings are the ones that answer it.'],
      mixed: ['mixed', 'Term premium and breakevens are moving together, so the move in long rates does not separate into a real-rate story or an inflation story.'],
    };
    const drv = regime.rate_driver ? DRIVER[regime.rate_driver] : null;
    const S = 300, cx = S / 2, cy = S / 2, k = 55;   // 55px per standard deviation
    const x = Math.max(16, Math.min(S - 16, cx + Math.max(-2.4, Math.min(2.4, g)) * k));
    const y = Math.max(16, Math.min(S - 16, cy - Math.max(-2.4, Math.min(2.4, i)) * k));
    const lab = (tx, ty, t, on) => `<text x="${tx}" y="${ty}" font-size="11" text-anchor="middle" fill="${on ? REGIME_LOOK[t.toLowerCase()].tone : 'var(--muted)'}" font-weight="${on ? 700 : 400}">${t}</text>`;
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Macro regime</h2>
        <span style="font-size:12px;color:var(--muted)">data to ${esc(regime.data_as_of || '—')}${regime.stale_days > 45 ? ` · ${regime.stale_days} days old` : ''}</span></div>
      <div style="display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <svg viewBox="0 0 ${S} ${S}" style="width:300px;max-width:100%;height:auto;flex:none">
          <rect x="0" y="0" width="${cx}" height="${cy}" fill="var(--panel2)" opacity=".5"/>
          <rect x="${cx}" y="0" width="${cx}" height="${cy}" fill="var(--panel2)" opacity=".8"/>
          <rect x="0" y="${cy}" width="${cx}" height="${cy}" fill="var(--panel2)" opacity=".3"/>
          <rect x="${cx}" y="${cy}" width="${cx}" height="${cy}" fill="var(--panel2)" opacity=".6"/>
          <line x1="${cx}" y1="0" x2="${cx}" y2="${S}" stroke="var(--line)"/>
          <line x1="0" y1="${cy}" x2="${S}" y2="${cy}" stroke="var(--line)"/>
          ${lab(cx / 2, 22, 'Inflation', regime.regime === 'inflation')}
          ${lab(cx + cx / 2, 22, 'Reflation', regime.regime === 'reflation')}
          ${lab(cx / 2, S - 12, 'Deflation', regime.regime === 'deflation')}
          ${lab(cx + cx / 2, S - 12, 'Goldilocks', regime.regime === 'goldilocks')}
          <text x="${S - 4}" y="${cy - 6}" font-size="10" text-anchor="end" fill="var(--muted)">growth →</text>
          <text x="${cx + 6}" y="12" font-size="10" fill="var(--muted)">inflation ↑</text>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${REGIME_LOOK[regime.regime].tone}"/>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="none" stroke="${REGIME_LOOK[regime.regime].tone}" stroke-opacity=".4"/>
        </svg>
        <div style="flex:1;min-width:240px">
          <div style="font-size:24px;font-weight:700;color:${REGIME_LOOK[regime.regime].tone}">${esc(REGIME_LOOK[regime.regime].label)}</div>
          <p style="margin:4px 0 10px;color:var(--muted);font-size:13px">${esc(REGIME_LOOK[regime.regime].blurb)}</p>
          <div style="font-variant-numeric:tabular-nums;font-size:13px">
            Growth <b style="color:${g >= 0 ? 'var(--pos)' : 'var(--neg)'}">${g >= 0 ? '+' : ''}${g.toFixed(2)}σ</b> across ${regime.n_growth} series<br>
            Inflation <b style="color:${i >= 0 ? 'var(--neg)' : 'var(--pos)'}">${i >= 0 ? '+' : ''}${i.toFixed(2)}σ</b> across ${regime.n_inflation} series<br>
            Conviction <b>${(+regime.conviction).toFixed(2)}</b></div>
          ${lq === null ? '' : `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-variant-numeric:tabular-nums;font-size:13px">
            Cost of liquidity <b style="color:${lq >= 0 ? 'var(--neg)' : 'var(--pos)'}">${lq >= 0 ? '+' : ''}${lq.toFixed(2)}σ</b> across ${regime.n_liquidity} series
            <span style="color:var(--muted)"> · ${lq >= 0 ? 'getting dearer' : 'getting cheaper'}</span>
            ${drv ? `<br>Long rates driven by <b title="${esc(drv[1])}">${esc(drv[0])}</b>${regime.term_premium_z !== null && regime.breakeven_z !== null ? ` <span style="color:var(--muted)">(term premium ${+regime.term_premium_z >= 0 ? '+' : ''}${(+regime.term_premium_z).toFixed(2)}σ vs breakevens ${+regime.breakeven_z >= 0 ? '+' : ''}${(+regime.breakeven_z).toFixed(2)}σ)</span>` : ''}` : ''}</div>`}
        </div></div>
      <p class="note">Each series is reduced to how its recent change compares with its own history of that change, signed so a fall in unemployment reads as growth rising, then averaged within its factor. <b>Conviction is the distance from the centre</b>, where the four quadrants meet: ${+regime.conviction < 0.5 ? `at ${(+regime.conviction).toFixed(2)} this reading sits close enough to the boundary that the quadrant is nearly a coin toss, and it should be read as a lean rather than a call.` : 'a reading far from the centre is a regime; one near it is a coin toss wearing a regime\'s name.'}${regime.stale_days > 45 ? ` <b>The newest observation is ${regime.stale_days} days old</b>, so this is a historical reading rather than a current one. The macro feed no longer depends on an API key — it falls back to FRED's public CSV export — so a stale reading now means a network failure, a FRED outage, or a withdrawn series, and the nightly log names which.` : ''}
      ${lq === null ? '' : `<b>The quadrant is growth against inflation only.</b> The cost of liquidity is measured and reported beside it rather than added as a third axis: the forty-two factor preference table below is keyed to these four quadrants, and a third dimension would orphan it. It still moves the risk score, at half the weight of the quadrant itself, because a book facing liquidity getting dearer is not in the same position as one facing an easing of it, whatever quadrant they share. Separating term premium from breakevens is the reason the leg was added — the inflation average alone cannot say whether a rising ten-year is the market pricing inflation or demanding to be paid for duration, and those call for opposite holdings.`}</p></div>`;
  })();

  // ---- the full preference table for this regime ----
  const prefTable = !ranks.length ? '' : `<div class="card" style="margin-bottom:14px">
    <h2>Preferences under ${esc(regime ? REGIME_LOOK[regime.regime].label : '')}</h2>
    <p class="note" style="margin:0 0 10px">The owner's forty-two factor chart, for the quadrant the data is currently in. It is a framework the desk has adopted, not a measurement — stored as data so the chart and this page cannot drift apart.</p>
    <table><thead><tr><th>Dimension</th><th>Favoured</th><th>Against</th><th class="num">3-month spread</th><th>Tape</th></tr></thead><tbody>
    ${ranks.slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)).map(r => `<tr>
      <td>${esc(r.dimension)}</td>
      <td><b>${esc(r.prefer)}</b>${r.prefer_tkr ? ` <span class="chip">${esc(r.prefer_tkr)}</span>` : ''}</td>
      <td style="color:var(--muted)">${esc(r.avoid)}${r.avoid_tkr ? ` <span class="chip">${esc(r.avoid_tkr)}</span>` : ''}</td>
      <td class="num">${r.spread_3m === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:${+r.spread_3m >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(r.spread_3m)}</span>`}</td>
      <td>${r.confirmed === null ? `<span style="color:var(--muted)" title="${esc(r.unavailable_reason || '')}">unscored</span>`
        : r.confirmed ? '<span style="color:var(--pos)">agrees</span>' : '<span style="color:var(--neg)">disagrees</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;

  // ---- history ----
  const histCard = `<div class="card" style="margin-bottom:14px">
    <h2>History</h2>
    ${hist.length < 2
      ? `<div class="empty">${hist.length ? 'One reading so far, taken ' + esc(hist[0].as_of) + '. The chart needs a run of them.' : 'No readings yet.'} The contest is evaluated on every nightly run and kept, so this fills in on its own.</div>`
      : (() => {
        const W = 760, Hh = 150, pad = { l: 34, r: 10, t: 10, b: 20 };
        const pts = hist.filter(h => h.score !== null).slice().sort((a, b) => a.as_of.localeCompare(b.as_of));
        if (pts.length < 2) return '<div class="empty">Not enough published readings to draw a line — the headline is withheld while fewer than half the legs are live.</div>';
        const X = i => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
        const Y = v => pad.t + (1 - v / 100) * (Hh - pad.t - pad.b);
        return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto">
          ${[0, 40, 60, 100].map(v => `<line x1="${pad.l}" y1="${Y(v)}" x2="${W - pad.r}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pad.l - 5}" y="${Y(v) + 3.5}" font-size="10" text-anchor="end" fill="var(--muted)">${v}</text>`).join('')}
          <path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(+p.score).toFixed(1)}`).join('')}" fill="none" stroke="var(--accent)" stroke-width="2"/>
          <text x="${pad.l}" y="${Hh - 5}" font-size="10" fill="var(--muted)">${esc(pts[0].as_of)}</text>
          <text x="${W - pad.r}" y="${Hh - 5}" font-size="10" text-anchor="end" fill="var(--muted)">${esc(pts.at(-1).as_of)}</text></svg>`;
      })()}
    <p class="note">Every nightly run writes a reading and keeps it, so the contest can be graded later against what the market actually did. That is the point of keeping it rather than only showing today.</p></div>`;

  return `<span class="eyebrow">Macro</span><h1>Adam</h1>
   <p class="sub">The Macro Beauty Contest — what the regime favours, and what the market is already paying for.</p>
   ${contestCard}${gauge}${legs}${quad}${prefTable}${histCard}`;
}

// ---------- Sven: market internals ----------
//
// Two dashboards. The rule matrix is Linda Raschke's twelve technical rules evaluated nightly on
// daily bars; the news-failure table asks whether an asset is responding to its own news. Both are
// arithmetic — nothing on this page is written by an agent — and both carry what they cannot see.
const RULE_STATE = {
  bullish:       { dot: 'var(--pos)',   label: 'bullish' },
  bearish:       { dot: 'var(--neg)',   label: 'bearish' },
  neutral:       { dot: 'var(--muted)', label: 'neutral' },
  not_evaluable: { dot: 'transparent',  label: 'not evaluable on daily bars' },
};
const GROUPS = [['US equity', 'US equity'], ['International', 'International'], ['Commodity', 'Commodity']];
const SVEN_GROUP = { SPY: 'US equity', QQQ: 'US equity', MDY: 'US equity', IWM: 'US equity', DIA: 'US equity', EFA: 'International', EEM: 'International', GLD: 'Commodity', USO: 'Commodity' };
// The order the owner reads them in, broad market first. Kept here rather than left to whatever
// order the rows arrive in, which is the database's business and not a reading order.
const SVEN_ORDER = ['SPY', 'QQQ', 'MDY', 'IWM', 'DIA', 'EFA', 'EEM', 'GLD', 'USO'];
const SVEN_LABEL = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', MDY: 'S&P MidCap 400', IWM: 'Russell 2000', DIA: 'Dow Industrials', EFA: 'Developed ex-US', EEM: 'Emerging markets', GLD: 'Gold', USO: 'Crude oil', AGG: 'US aggregate bonds' };
// The colour marks the VERDICT, not the direction it implies: any news failure is red, a
// confirming read is green. An earlier cut coloured by market implication, so a negative failure
// -- bad news that did not sink the asset, which is bullish -- came out green while sitting in a
// column headed by the word failure. One of the two had to give, and the column heading wins:
// green means the tape agreed with its news, red means it did not. Which WAY a failure cuts is
// still in the label and the tooltip, where it reads as a sentence rather than as a colour.
const FAILURE_STYLE = {
  positive_failure: ['Positive news failure', 'var(--neg)', 'Good news that did not lift it — the warning to sell.'],
  negative_failure: ['Negative news failure', 'var(--neg)', 'Bad news that did not sink it — bullish in direction, but still a failure of price to follow its news.'],
  confirming:       ['Confirming', 'var(--pos)', 'News and price agreed. The ordinary case, and not a signal.'],
  none:             ['No read', 'var(--muted)', 'Nothing could be called from this window.'],
  insufficient:     ['Insufficient', 'var(--muted)', 'Too little to call anything.'],
};
let newsWindow = 30;

function sven() {
  const rules = D.svenRules || [];
  const news = D.newsFailure || [];
  const n = v => v === null || v === undefined ? null : +v;

  if (!rules.length && !news.length) {
    return `<span class="eyebrow">Market internals</span><h1>Sven</h1>
     <p class="sub">Raschke's rules across the major indices, and whether assets are responding to their own news.</p>
     <div class="card"><div class="empty">Nothing computed yet. Run jobs/compute-raschke-rules.mjs and jobs/compute-news-failure.mjs.</div></div>`;
  }

  // ---- the rule matrix ----
  const tickers = [...new Set(rules.map(r => r.ticker))]
    .sort((a, b) => {
      const ia = SVEN_ORDER.indexOf(a), ib = SVEN_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  const ruleCols = [...new Map(rules.map(r => [r.rule_key, r])).values()].sort((a, b) => a.rule_no - b.rule_no || a.rule_key.localeCompare(b.rule_key));
  const asOf = rules.map(r => r.as_of).sort().pop();
  const cellFor = (t, key) => rules.find(r => r.ticker === t && r.rule_key === key) || null;

  const matrix = !tickers.length ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Price is King Rule Matrix</h2>
      <span style="font-size:12px;color:var(--muted)">${esc(asOf)} · ${ruleCols.length} rules × ${tickers.length} indices · click an index for the detail</span></div>
    <div style="overflow-x:auto;margin-top:12px"><table style="min-width:720px"><thead><tr>
      <th>Index</th>${ruleCols.map(c => `<th class="num" style="font-size:11px" title="${esc(c.rule_title)}">${c.rule_no}${/^r11/.test(c.rule_key) ? c.rule_key.slice(3, 4) : ''}</th>`).join('')}
      <th class="num">Net</th></tr></thead><tbody>
    ${GROUPS.map(([g]) => {
      const rows = tickers.filter(t => SVEN_GROUP[t] === g);
      if (!rows.length) return '';
      return `<tr><td colspan="${ruleCols.length + 2}" style="padding-top:10px;color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase">${esc(g)}</td></tr>` +
        rows.map(t => {
          const mine = ruleCols.map(c => cellFor(t, c.rule_key));
          const bull = mine.filter(r => r && r.state === 'bullish').length;
          const bear = mine.filter(r => r && r.state === 'bearish').length;
          const net = bull - bear;
          return `<tr><td class="click" data-go="#sven/${esc(t)}" style="cursor:pointer"><b>${esc(t)}</b> <span style="color:var(--muted)">${esc(SVEN_LABEL[t] || '')}</span></td>
            ${mine.map(r => {
              if (!r) return '<td class="num">·</td>';
              const st = RULE_STATE[r.state];
              const tip = `${r.rule_no}. ${r.rule_title}\n${r.headline}${r.adapted ? '\n[adapted to daily bars]' : ''}`;
              return `<td class="num" data-tip="${esc(tip)}" style="cursor:default">${r.state === 'not_evaluable'
                ? '<span style="color:var(--line)">–</span>'
                : `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${st.dot}"></span>`}${r.adapted ? '<sup style="color:var(--warn);font-size:9px">a</sup>' : ''}</td>`;
            }).join('')}
            <td class="num"><b style="color:${net > 0 ? 'var(--pos)' : net < 0 ? 'var(--neg)' : 'var(--muted)'}">${net > 0 ? '+' : ''}${net}</b></td></tr>`;
        }).join('');
    }).join('')}
    </tbody></table></div>
    <p class="note">Columns are Raschke's rules in her numbering; <b>11a–11d</b> are the four principles of price behaviour she lists under rule 11. A dot is the rule's read on that index today — green bullish, red bearish, grey neutral — and <b>Net</b> is bullish rules minus bearish. Hover a cell for what the rule says; click an index for all of it with the numbers.
    Rules marked <sup style="color:var(--warn)">a</sup> are <b>adapted</b>: Raschke wrote for an intraday screen, and where a daily bar can carry the spirit of a rule but not the rule itself — a close in the top third of the range standing in for "the last hour" — the substitution is named rather than hidden. <b>Rules 3, 9 and 10 are not evaluable at all</b> and show a dash: they are entirely about when inside the session something happened, and a daily bar has no inside. Approximating them would be inventing the number the rule turns on.</p></div>`;

  // ---- news failure ----
  // Which positions a reading reaches, in firm dollars, and which way. The direction is the
  // verdict's: a confirming read is good for the holdings it touches, a failure is bad for them.
  // A reading that called nothing reaches nothing, so "no read" and "insufficient" say so rather
  // than listing holdings beside a verdict that never concluded.
  const impactedCell = (r, fail) => {
    const list = r.impacted || [];
    if (!list.length) return '<span style="color:var(--muted)">No Impact to Models</span>';
    const tone = fail ? 'var(--neg)' : 'var(--pos)';
    const sign = fail ? '−' : '+';
    const total = list.reduce((a, x) => a + +x.usd, 0);
    const tip = `${fail ? 'Hurt' : 'Helped'} by this reading: ${list.map(x => `${x.ticker} ${(+x.firm_weight * 100).toFixed(1)}% of the firm${x.partial ? ' (its share of this class only)' : ''}`).join(', ')}.`;
    return `<span title="${esc(tip)}"><span style="color:${tone};font-weight:600">${sign}</span> ${list.map(x =>
      `<span style="color:var(--text)">${esc(x.ticker)}</span><span style="color:var(--muted)">${x.partial ? '*' : ''} $${(+x.usd / 1e6).toFixed(0)}M</span>`).join(', ')}
      <br><small style="color:var(--muted)">$${(total / 1e6).toFixed(0)}M ${fail ? 'exposed' : 'supported'}</small></span>`;
  };
  const wins = [...new Set(news.map(r => r.window_days))].sort((a, b) => a - b);
  const rowsN = news.filter(r => r.window_days === newsWindow)
    .sort((a, b) => {
      const rank = v => v === 'positive_failure' || v === 'negative_failure' ? 0 : v === 'confirming' ? 1 : 2;
      return rank(a.verdict) - rank(b.verdict) || String(a.ticker).localeCompare(String(b.ticker));
    });
  const failures = rowsN.filter(r => /failure$/.test(r.verdict));
  const newsCard = !news.length ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">News failure</h2>
      <div class="tabs" style="margin:0">${wins.map(w => `<button class="tab" data-newswin="${w}" aria-selected="${w === newsWindow}">${w} days</button>`).join('')}</div></div>
    ${failures.length ? `<div style="margin-top:10px;padding:10px 12px;border-left:3px solid var(--warn);background:var(--panel2);border-radius:8px;font-size:13px">
      <b>${failures.length} asset${failures.length === 1 ? '' : 's'} not responding to ${failures.length === 1 ? 'its' : 'their'} own news</b> over ${newsWindow} days: ${failures.map(f => `${esc(f.ticker)} (${esc(FAILURE_STYLE[f.verdict][0].toLowerCase())})`).join(', ')}.</div>` : ''}
    <div style="overflow-x:auto;margin-top:12px"><table style="min-width:860px"><thead><tr>
      <th>Asset</th><th>Class</th><th>Verdict</th><th class="num">News flow</th><th class="num">Breadth</th>
      <th class="num">Price</th><th>Impacted Holdings</th></tr></thead><tbody>
    ${rowsN.map(r => {
      const st = FAILURE_STYLE[r.verdict] || FAILURE_STYLE.none;
      const fail = /failure$/.test(r.verdict);
      const ch = n(r.price_change);
      return `<tr${fail ? ' style="background:var(--panel2)"' : ''}>
        <td><b>${esc(r.ticker)}</b><br><small style="color:var(--muted)">${esc(r.label)}</small></td>
        <td style="color:var(--muted)">${esc(r.asset_class || '—')}</td>
        <td><span style="color:${st[1]};font-weight:${fail ? '700' : '400'}" title="${esc(st[2])}">${esc(st[0])}</span>
          <br><small style="color:var(--muted);max-width:360px;display:inline-block">${esc(r.headline)}</small></td>
        <td class="num">${r.n_releases ? `${r.n_positive}+ / ${r.n_negative}−<br><small style="color:var(--muted)">${n(r.agreement) === null ? '' : (n(r.agreement) * 100).toFixed(0) + '% one way'}</small>` : '<span style="color:var(--muted)">–</span>'}</td>
        <td class="num" title="Distinct series and distinct factors behind the flow. Agreement alone cannot tell one story told eight times from eight stories that agree.">${r.n_series ?? '–'} series<br><small style="color:var(--muted)">${r.n_factors ?? '–'} factor${r.n_factors === 1 ? '' : 's'}</small></td>
        <td class="num">${ch === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:${ch >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(ch * 100).toFixed(1)}%</span>`}
          <br><small style="color:var(--muted)">${r.made_new_high ? 'new high' : r.made_new_low ? 'new low' : 'no new extreme'}</small></td>
        <td style="font-size:12px">${impactedCell(r, fail)}</td></tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="note"><b>Impacted Holdings</b> names the firm's own positions in the asset class a reading describes, in firm dollars, largest first — not the models, which hold every class and so repeated the same eight names on every row. A confirming read supports those positions and a failure puts them at risk, so the column takes its sign from the verdict rather than storing one that could drift from it. A ticker marked <b>*</b> counts only its share of that class: QDSIX is classified 60% equity, 20% fixed income and 20% commodities, so a commodity reading reaches a fifth of its position and not all of it. Where a verdict concluded nothing the column reads <b>No Impact to Models</b> — a reading that called no direction reaches no holding. <b>Failures sort to the top of the table</b>, since they are the only rows that ask for a decision.
    <b>Good news is not a property of a release on its own</b> — a strong payroll print is good news for equities and bad news for bonds. Each release is scored by which way it moved its factor, multiplied by how that asset class loads on that factor, so both halves come from tables the desk already keeps rather than from a judgment made here.
    A <b>positive news failure</b> is a stream of good news the asset did not rise on; a <b>negative news failure</b> is a stream of bad news it did not fall on. Neither is called on fewer than five releases, on a flow more split than 65/35, or on a single factor — one factor moving is one story told many times, and agreement cannot tell that from many stories agreeing, which is why breadth sits beside it.
    Only weekly, monthly and quarterly series count: the daily ones here are market prices, not announcements. <b>Publication dates are assumed from frequency, not recorded</b> — a release covering August is treated as published a month later — because this desk stores the period an observation covers and not the day it came out.</p></div>`;

  return `<span class="eyebrow">Market internals</span><h1>Sven</h1>
   <p class="sub">Raschke's twelve rules across the major indices, and whether assets are responding to their own news.</p>
   ${matrix}${newsCard}`;
}

// All twelve rules for one index, with the numbers and the method behind each.
function svenDrawer(ticker) {
  const rows = (D.svenRules || []).filter(r => r.ticker === ticker).sort((a, b) => a.rule_no - b.rule_no || a.rule_key.localeCompare(b.rule_key));
  if (!rows.length) return `<button class="close" data-go="#sven">Close</button><h1>${esc(ticker)}</h1><div class="card"><div class="empty">No rule signals for this index.</div></div>`;
  return `<button class="close" data-go="#sven">Close</button>
   <span class="eyebrow">Raschke's rules · ${esc(rows[0].as_of)}</span><h1>${esc(ticker)} — ${esc(SVEN_LABEL[ticker] || '')}</h1>
   ${rows.map(r => {
     const st = RULE_STATE[r.state];
     return `<div class="card" style="margin-bottom:10px;border-left:3px solid ${r.state === 'not_evaluable' ? 'var(--line)' : st.dot}">
       <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap">
         <h2 style="margin:0;font-size:13px">${r.rule_no}. ${esc(r.rule_title)}</h2>
         <span class="chip" style="color:${st.dot === 'transparent' ? 'var(--muted)' : st.dot}">${esc(st.label)}</span></div>
       <p style="margin:8px 0 0">${esc(r.headline)}</p>
       ${r.detail ? `<p style="margin:6px 0 0;color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums">${esc(r.detail)}</p>` : ''}
       ${r.method ? `<p class="note" style="margin-top:8px">${r.adapted ? '<b>Adapted to daily bars.</b> ' : ''}${esc(r.method)}</p>` : ''}</div>`;
   }).join('')}`;
}

// ---------- Annie: the decision coach ----------
//
// Two kinds of thing live on this page and they must never be made to look alike. The scorecard,
// the position scores and the trade journal are ARITHMETIC, computed from dated snapshots and
// adjusted prices by jobs/compute-decision-ledger.mjs. The reflexivity, bias, steel-man, Kahneman
// and Monday-morning sections are JUDGMENT, written by the Annie agent after reading something.
// The second kind carries its sources and the date it was formed; the first carries its flags.
// The pitch scale, in the owner's words: 10 is a fat pitch, 1 is filthy. Stated everywhere the
// number appears, because a bare 7 invites the reader to invent a scale and they invent a
// flattering one.
const PITCH_SCALE = '1 to 10. 10 is a fat pitch — a strong, identifiable two-way feedback loop. 1 is filthy — the loop is absent and the ordinary analysis applies.';
const PITCH_NOTE = 'The reflexivity score is Soros\'s two-way feedback: does price action here change the fundamentals — flows bending a producer\'s behaviour, a price that funds the expansion it is pricing in — or does it only reflect them? <b>' + PITCH_SCALE + '</b> A low score is not bearish. It says the setup is ordinary, which is a different claim from saying the idea is bad. Scores and the case against each name are written by Annie after reading something, and each one carries its sources — unlike everything in the scorecard above, none of this is arithmetic.';
const pitchLabel = v => v >= 8.5 ? 'fat pitch' : v >= 6.5 ? 'hittable' : v >= 4 ? 'ordinary' : 'filthy';
// Which error the desk is exposed to on a name right now, from the master Speed Limit. The light
// is the prior on H0 ("no edge here"): a red light says H0 is probably true, so acting anyway is
// where a Type I error comes from; a green light says it is probably false, so passing is where a
// Type II error comes from. Yellow is the honest case — the signal is not calling it, and the
// reflexivity score is left to tip it, which it only does at the ends of the scale.
function errorRisk(light, score) {
  if (!light) return { k: null, label: '—', why: 'No master Speed Limit reading, so there is no signal to be wrong against.' };
  if (light === 'red') return { k: 'I', label: 'Type I', why: 'The Speed Limit is red: the signal says take less risk, so opening here is acting against it. If the signal is right, this is the swing at nothing.' };
  if (light === 'green') return { k: 'II', label: 'Type II', why: 'The Speed Limit is green: the signal says risk is paid, so NOT opening here is acting against it. If the signal is right, this is the strike watched go by.' };
  if (score !== null && score >= 6.5) return { k: 'II', label: 'Type II lean', why: 'The Speed Limit is yellow, so the signal is not calling it. The reflexivity score is high enough that passing is the likelier mistake — a strong two-way loop does not wait for permission.' };
  if (score !== null && score < 4) return { k: 'I', label: 'Type I lean', why: 'The Speed Limit is yellow, so the signal is not calling it. The reflexivity score is low enough that acting is the likelier mistake — an ordinary setup taken on an ambiguous signal is the swing at nothing.' };
  return { k: null, label: 'both live', why: 'The Speed Limit is yellow and the reflexivity score is mid-scale. Neither mistake is the obvious one, which is a real answer rather than a missing one: this is the case where the decision rests on something other than the signal.' };
}
const RISK_COLOR = { I: 'var(--neg)', II: 'var(--flat)' };
const pitchColor = v => v >= 8.5 ? 'var(--pos)' : v >= 6.5 ? 'var(--flat)' : v >= 4 ? 'var(--muted)' : 'var(--neg)';
// An I-beam in cross-section: two flanges and a web. Drawn rather than fetched so it inherits the
// theme colour and costs no request.
const IBEAM = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M2 2h12v2.6H9.3v6.8H14V14H2v-2.6h4.7V4.6H2z"/></svg>';

// Type I and Type II, with the null hypothesis written down. H0 for a trade: "this position has
// no edge — the model is better off holding its benchmark." Rejecting it means taking the
// position, and the textbook table then maps exactly: a Type I error took a position that trailed
// the benchmark, a Type II error passed on one that would have beaten it.
//
// NOT A HYPOTHESIS TEST. No alpha is set, no beta estimated, no distribution assumed. The
// vocabulary is a way of asking which mistake the desk is more exposed to right now — swinging at
// nothing, or watching a strike go by. Every surface that uses the words says so, because a reader
// who sees "Type I error" and infers a significance test has been misled by the label.
const ERROR_CAVEAT = 'Borrowed vocabulary, not a significance test: no α is set, no β is estimated and no distribution is assumed. H0 here is <b>"this position has no edge — the model is better off in its benchmark"</b>, so rejecting it means taking the position. A <b>Type I error</b> took one that then trailed the benchmark; a <b>Type II error</b> passed on one that would have beaten it.';

let annieWindow = 'ITD';
// Which scorecard tab is showing: 'overall' or a strategy id.
let annieModel = 'overall';
// Which rate set the tax card is reading. Module scope for the same reason as annieModel: the
// card is rebuilt on every render and a local would reset the toggle each time.
let taxBracket = 'standard';
// The two readings the desk offers. Nothing stored carries a tax figure -- the job keeps the
// four pre-tax components per year and these are applied here, so one dataset serves both and
// the two can never drift apart.
const TAX_RATES = {
  standard: { lt: 0.15, st: 0.24, label: 'Standard', note: '15% long-term · 24% short-term' },
  hnw:      { lt: 0.20, st: 0.37, label: 'HNW',      note: '20% long-term · 37% short-term' },
};

// Short-term losses net against short-term gains, long-term against long-term, and a leftover
// loss of either character then offsets a remaining gain of the other. This is the actual rule,
// and it matters here: taxing gross gains would bill a desk with 99 losing trades for every one
// of them while ignoring the deduction they earn.
function netTax(r, rate) {
  let st = +r.st_gain_bps - +r.st_loss_bps;
  let lt = +r.lt_gain_bps - +r.lt_loss_bps;
  if (st < 0 && lt > 0) { const use = Math.min(-st, lt); lt -= use; st += use; }
  else if (lt < 0 && st > 0) { const use = Math.min(-lt, st); st -= use; lt += use; }
  const stTax = Math.max(0, st) * rate.st, ltTax = Math.max(0, lt) * rate.lt;
  return { st, lt, stTax, ltTax, total: stTax + ltTax };
}

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

  // ---- Scorecard, one tab per model plus an equal-weighted Overall ----
  //
  // Only models with a loaded snapshot history have a ledger. The rest get the same card with
  // every figure blank, because the shape of what is missing is itself worth seeing: a reader
  // comparing models should be able to tell "this one has not been graded" from "this one scored
  // badly", and a model quietly absent from a tab strip teaches neither.
  // The hot-hand card. A playing card because this is a scorecard about betting well, and the
  // three faces are the three things a 90-day win rate can be telling you. Exactly 50% gets the
  // desk's own mark rather than a verdict: it is the one reading that is genuinely neither, and
  // picking a side there would be inventing a signal out of a coin landing on its edge.
  const HOT_FACE = {
    hot:  { tone: 'var(--neg)',  label: 'Hot hand',    sub: 'running well' },
    even: { tone: 'var(--text)', label: 'Keep pushing', sub: 'at the line' },
    cold: { tone: 'var(--accent)', label: 'Cold hand',  sub: 'running cold' },
  };
  function hotHandCard(rate, wins, n, windowDays) {
    if (rate === null) {
      return `<div class="pcard pcard-none" title="No trade has closed in the last ${windowDays} days, so there is no current form to read. Blank rather than cold: nothing closing is not the same as closing badly.">
        <div class="pcorner">—</div><div class="pface" style="color:var(--muted);font-size:20px">?</div>
        <div class="plabel">No trades</div></div>`;
    }
    const pct = rate * 100;
    // The owner's thresholds: 51% or above is hot, exactly 50% is even, below 50% is cold. That
    // leaves 50 to 51 unspecified, and it cannot be cold without contradicting "below 50% is
    // cold" -- so the band between them takes the middle face. Keep pushing is exactly what a
    // rate half a point over even deserves.
    const k = pct >= 51 ? 'hot' : pct >= 50 ? 'even' : 'cold';
    const f = HOT_FACE[k];
    const glyph = k === 'hot'
      ? `<svg viewBox="0 0 24 24" width="31" height="31" aria-hidden="true"><path d="M12 2c.6 3.2-1.4 4.6-2.8 6.1C7.6 9.8 6 11.5 6 14.2 6 17.9 8.9 21 12.3 21c3.4 0 6-2.6 6-6 0-2.4-1-3.8-2.3-5.3-.5 1-1.2 1.7-2 2 .5-2.6-.6-6.4-4-9.7z" fill="currentColor"/></svg>`
      : k === 'cold'
      ? `<svg viewBox="0 0 24 24" width="31" height="31" aria-hidden="true" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7"/><path d="M12 5.4 9.6 3.6M12 5.4l2.4-1.8M12 18.6l-2.4 1.8M12 18.6l2.4 1.8M5.1 9.2 4.3 6.4M5.1 9.2 2.2 9.5M18.9 14.8l.8 2.8M18.9 14.8l2.9-.3M5.1 14.8l-2.9-.3M5.1 14.8l-.8 2.8M18.9 9.2l2.9.3M18.9 9.2l.8-2.8"/></svg>`
      : `<svg class="logo" style="width:31px;height:31px" role="img" aria-label="Sisyphus"><use href="#sisyphus-mark"/></svg>`;
    const tip = `${f.label} — ${wins} of ${n} trades closed in the last ${windowDays} days exited profitable (${pct.toFixed(0)}%). ${
      k === 'hot' ? 'At or above 51% the desk is running well.'
      : k === 'cold' ? 'Below 50% the desk is running cold.'
      : `${pct === 50 ? 'Exactly even' : 'Over even but not yet 51%'}: neither hot nor cold, so the card shows the desk mark rather than a verdict.`}`;
    return `<div class="pcard pcard-${k}" title="${esc(tip)}">
      <div class="pcorner" style="color:${f.tone}">${pct.toFixed(0)}%</div>
      <div class="pface" style="color:${f.tone}">${glyph}</div>
      <div class="plabel">${esc(f.label)}</div></div>`;
  }

  const scorecard = (() => {
    const kpi = (lab, val, sub, title) => `<div class="card kpi" title="${esc(title)}">
      <span class="eyebrow">${esc(lab)}</span><b style="font-size:26px">${val}</b><small>${esc(sub)}</small></div>`;
    const DASH = '<span style="color:var(--muted)">—</span>';
    const graded = (D.models || []).filter(m => stats.some(s => s.strategy_id === m.id));

    const tabs = `<div class="tabs" style="margin:0">
      ${[{ id: 'overall', label: 'Overall' }, ...(D.models || []).map(m => ({ id: m.id, label: bare(m.name) }))]
        .map(t => {
          const has = t.id === 'overall' ? graded.length > 0 : stats.some(s => s.strategy_id === t.id);
          return `<button class="tab" data-anniemodel="${esc(t.id)}" aria-selected="${t.id === annieModel}"
            ${has ? '' : 'title="No dated holdings history for this model, so there are no trades to grade"'}
            style="${has ? '' : 'opacity:.6'}">${esc(t.label)}</button>`;
        }).join('')}</div>`;

    // Overall is the EQUAL-WEIGHTED average across the models that can be graded: a model with
    // four trades counts the same as one with fifty, which is what "equally weighted" has to mean
    // if it is to mean anything. Models with no ledger are left out rather than entered as zero —
    // averaging in a zero would say they graded badly when the truth is they were not graded.
    const avg = key => {
      const vals = stats.map(s => n(s[key])).filter(v => v !== null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const sum = key => stats.reduce((a, s) => a + (n(s[key]) || 0), 0);
    const overall = !graded.length ? null : {
      batting_average: avg('batting_average'),
      slugging_bps: avg('slugging_bps'),
      beatRate: (() => {
        const vals = stats.filter(s => s.n_closed).map(s => (n(s.n_beat_benchmark) || 0) / s.n_closed);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      })(),
      n_closed: sum('n_closed'), n_open: sum('n_open'), n_wins: sum('n_wins'), n_losses: sum('n_losses'),
      n_beat_benchmark: sum('n_beat_benchmark'), win_bps: sum('win_bps'), loss_bps: sum('loss_bps'),
      excess_bps_total: sum('excess_bps_total'), n_unpriced: sum('n_unpriced'),
      n_type_i: sum('n_type_i'), type_i_bps: sum('type_i_bps'), n_type_ii: null,
      type_ii_reason: stats.map(x => x.type_ii_reason).find(Boolean) || null,
      first_snapshot: stats.map(s => s.first_snapshot).filter(Boolean).sort()[0],
      last_snapshot: stats.map(s => s.last_snapshot).filter(Boolean).sort().pop(),
      gap_days: sum('gap_days') || null,
    };

    // Past decision errors. Type I is countable from the ledger; Type II is not, by construction,
    // and shows the reason rather than a zero — a zero would say no opportunity was ever missed.
    const errorsBlock = (s, isOverall) => {
      const t1 = s ? n(s.n_type_i) : null, t1bps = s ? n(s.type_i_bps) : null, t2 = s ? n(s.n_type_ii) : null;
      const reason = (s && s.type_ii_reason) || 'Needs the high-potential shortlist: a holdings snapshot records what was bought and is silent on what was passed over.';
      const cell = (lab, val, sub, title) => `<div style="flex:1;min-width:190px;padding:10px 12px;border:1px solid var(--line);border-radius:10px" title="${esc(title)}">
        <div class="eyebrow">${esc(lab)}</div><b style="font-size:22px">${val}</b>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${sub}</div></div>`;
      return `<div style="margin-top:14px">
        <div class="eyebrow" style="margin-bottom:8px">Decision errors${isOverall ? ' — all graded models' : ''}</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${cell('Type I — swung at nothing', t1 === null ? '<span style="color:var(--muted)">—</span>' : `<span style="color:var(--neg)">${t1}</span>`,
                 t1 === null ? 'no trades to grade' : `cost ${t1bps === null ? '—' : t1bps.toFixed(0) + ' bps'} against the benchmark`,
                 'Positions taken that then trailed what the benchmark would have given the same money — H0 rejected when it was true. Pre-existing positions are excluded: nobody decided to open them inside this record.')}
          ${cell('Type II — watched a strike go by', t2 === null ? '<span style="color:var(--muted)">—</span>' : `<span style="color:var(--neg)">${t2}</span>`,
                 t2 === null ? 'not observable yet' : 'shortlisted, never bought, then beat the benchmark',
                 reason)}
        </div></div>`;
    };

    // The last ten completed trades, NEWEST on the left. Taken straight from the ledger rather
    // than stored: it is ten rows of a table already here, and a stored copy would be one more
    // thing that can disagree with the journal below it.
    const streakBox = list => {
      const chips = list.map(t => {
        const won = +t.total_return > 0;
        const r = n(t.total_return);
        const tip = `${t.ticker} · opened ${t.entry_date}\n${won ? 'Win' : 'Loss'} ${r === null ? '—' : (r >= 0 ? '+' : '') + (r * 100).toFixed(1) + '%'} · closed ${t.exit_date}`
          + (t.n_models > 1 ? `\nOne call across ${t.n_models} models${t.split ? ` — ${t.split}, so this is their average` : ', averaged'}` : '');
        return `<span class="stk ${won ? 'w' : 'l'}" data-tip="${esc(tip)}">${won ? 'W' : 'L'}</span>`;
      }).join('');
      return `<div class="card kpi" title="${isOverall ? 'The last ten allocation decisions, most recent on the left. One call made across several models counts once here, not once per model.' : 'The last ten completed trades, most recent on the left.'} Hover one for the ticker, the date it was opened and what it returned.">
        <span class="eyebrow">Current streak</span>
        <div style="display:flex;gap:5px;margin:6px 0 4px;flex-wrap:wrap">${chips || '<span style="color:var(--muted);font-size:22px">—</span>'}</div>
        <small>${list.length ? `last ${list.length}, most recent first${isOverall ? ' · one per decision' : ''}` : 'no closed trades'}</small></div>`;
    };

    const isOverall = annieModel === 'overall';
    const s = isOverall ? overall : (stats.find(x => x.strategy_id === annieModel) || null);
    const label = isOverall ? 'Overall' : bare(modelName(annieModel));

    // On Overall, the ledger carries one row per model per trade, so a single allocation call
    // made across seven models arrives as seven rows. Left as rows, the last ten chips showed
    // the AGGH exit of 2026-09-29 seven times and read 3W/7L — a 30% streak sitting beside a
    // 75% batting average, which is how this was caught. They are collapsed to DECISIONS here:
    // the same ticker leaving on the same date is one call, however many models held it.
    //
    // Per-model tabs are left alone. There one row already is one trade, and collapsing would
    // merge genuine re-entries of the same name.
    const rawClosed = trades
      .filter(t => t.status === 'closed' && t.total_return !== null && (isOverall || t.strategy_id === annieModel))
      .sort((a, b) => String(b.exit_date).localeCompare(String(a.exit_date)));
    const closedTrades = !isOverall ? rawClosed : (() => {
      const by = new Map();
      for (const t of rawClosed) {
        const k = `${t.ticker}|${t.exit_date}`;
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(t);
      }
      return [...by.values()].map(v => {
        const ret = v.reduce((a, t) => a + +t.total_return, 0) / v.length;
        const wins = v.filter(t => +t.total_return > 0).length;
        return {
          ...v[0], total_return: ret, n_models: v.length,
          // Ten of the 165 decisions split: the same name left on the same day having made money
          // in one model and lost it in another, because the models bought it on different dates.
          // The chip follows the average, and the tooltip says the models disagreed.
          split: wins > 0 && wins < v.length ? `${wins} of ${v.length} models profited` : null,
          entry_date: v.map(t => t.entry_date).sort()[0],
        };
      }).sort((a, b) => String(b.exit_date).localeCompare(String(a.exit_date)));
    })();
    const streak = closedTrades.slice(0, 10);

    // Trade events per calendar year: entries plus exits, not round trips. Counted on the same
    // rule compute-decision-ledger.mjs uses for n_trades_ytd -- a pre-existing position is not an
    // entry, because its "entry date" is the first day of the records rather than a purchase --
    // so the bars and the figure beside them cannot disagree. Checked against the stored value:
    // both give 231 for 2026.
    const tradeYears = (() => {
      const mine = trades.filter(t => isOverall || t.strategy_id === annieModel);
      const count = y => mine.filter(t => !t.pre_existing && String(t.entry_date).startsWith(y)).length
                       + mine.filter(t => t.exit_date && String(t.exit_date).startsWith(y)).length;
      const thisYear = new Date().getUTCFullYear();
      return [thisYear - 2, thisYear - 1, thisYear].map(y => ({ year: y, n: count(String(y)), ytd: y === thisYear }));
    })();
    // How far through the year we are, so the partial bar can say what it is a part of. A usage
    // chart compares this period with the last and is explicit that this one is unfinished; 231
    // set beside 308 without that would read as a slowdown when it is ten months against twelve.
    const yearElapsed = (() => {
      const now = new Date(), y = now.getUTCFullYear();
      return (now.getTime() - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1));
    })();

    const tradesBox = (years, elapsed) => {
      const max = Math.max(1, ...years.map(y => y.n));
      const ytdYear = years.find(y => y.ytd);
      const pace = elapsed > 0.02 ? Math.round(ytdYear.n / elapsed) : null;
      const bars = years.map(y => {
        const h = Math.max(2, Math.round((y.n / max) * 44));
        const col = y.ytd ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 36%, var(--panel2))';
        const tip = y.ytd
          ? `${y.n} trade events so far in ${y.year} — ${(elapsed * 100).toFixed(0)}% of the year gone${pace === null ? '' : `, a pace of about ${pace} for the full year`}.`
          : `${y.n} trade events in ${y.year}, the full year.`;
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1" title="${esc(tip)}">
          <small style="font-size:10px;color:${y.ytd ? 'var(--text)' : 'var(--muted)'};font-variant-numeric:tabular-nums">${y.n}</small>
          <div style="width:100%;height:46px;display:flex;align-items:flex-end">
            <div style="width:100%;height:${h}px;background:${col};border-radius:2px 2px 0 0${y.ytd ? ';border-top:2px dashed var(--accent)' : ''}"></div></div>
          <small style="font-size:9.5px;color:var(--muted)">${y.ytd ? 'YTD' : y.year}</small></div>`;
      }).join('');
      return `<div class="card kpi" title="Trade events per calendar year — entries plus exits, not round trips. A position bought in March and sold in September is two. The newest bar is the year so far rather than a full year, and its dashed top says so.">
        <span class="eyebrow">Trades YTD</span>
        <div style="display:flex;align-items:flex-end;gap:7px;margin:4px 0 2px">${bars}</div>
        <small>${ytdYear.n} in ${ytdYear.year} · ${(elapsed * 100).toFixed(0)}% of the year gone${pace === null ? '' : ` · ~${pace} at this pace`}</small></div>`;
    };

    // Hot hand, over the last ninety days of CLOSED trades. A rolling window rather than the
    // all-time batting average beside it: the point of the card is current form, and a desk that
    // batted .750 across four years can still be cold now. Ninety days of nothing closing is not
    // a cold hand -- it is no hand, and the card says so rather than reading as a loss.
    const HOT_WINDOW_DAYS = 90;
    const cutoff = new Date(Date.now() - HOT_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
    const recent90 = closedTrades.filter(t => String(t.exit_date) >= cutoff);
    const wins90 = recent90.filter(t => +t.total_return > 0).length;
    const rate90 = recent90.length ? wins90 / recent90.length : null;
    const hold = !s ? null : isOverall ? (() => { const v = stats.map(x => n(x.avg_hold_days)).filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })() : n(s.avg_hold_days);
    const ytd = !s ? null : isOverall ? stats.reduce((a, x) => a + (n(x.n_trades_ytd) || 0), 0) : n(s.n_trades_ytd);
    const ba = s ? n(s.batting_average) : null;
    const sl = s ? n(s.slugging_bps) : null;
    const beatRate = !s ? null : isOverall ? s.beatRate : (s.n_closed ? (n(s.n_beat_benchmark) || 0) / s.n_closed : null);
    const ex = s ? n(s.excess_bps_total) : null;
    const w = s ? n(s.win_bps) || 0 : 0, l = s ? n(s.loss_bps) || 0 : 0;

    // ---- equity curve and its stats panel, at the foot of the scorecard ----
    const curveBlock = (() => {
      const scoped = trades.filter(t => isOverall || t.strategy_id === annieModel);
      const vs = (D.valueSeries || []).filter(v => isOverall ? stats.some(x => x.strategy_id === v.strategy_id) : v.strategy_id === annieModel);
      const E = equityCurve(scoped, vs);
      if (!E) return '';
      const p1 = (v, d = 2) => v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`;
      const num = (v, d = 2) => v === null || v === undefined ? '—' : v.toFixed(d);
      const stat = (lab, val, sub) => `<div style="min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--text)">${esc(lab)}</div>
        <div style="font-size:24px;font-weight:700;margin:2px 0 3px">${val}</div>
        <div style="font-size:11.5px;color:var(--muted);line-height:1.45">${esc(sub)}</div></div>`;
      const section = (title, blurb, body) => `<div style="padding:14px 0;border-top:1px solid var(--line)">
        <div style="border-left:3px solid var(--accent);padding-left:10px;margin-bottom:12px">
          <div style="font-size:16px;font-weight:700">${esc(title)}</div>
          <div style="font-size:12px;color:var(--muted)">${esc(blurb)}</div></div>
        ${body}</div>`;
      const grid = cells => `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px 18px">${cells.join('')}</div>`;

      const snapshot = section('Performance Snapshot', 'Core numbers across every completed trade in this scope.', grid([
        stat('Return', `<span style="color:${col(E.total)}">${num(E.total)}%</span>`, 'Sum of what each completed trade contributed to the model.'),
        stat('Winrate', p1(E.winrate, 1), 'Share of closed trades that exited profitable.'),
        stat('Avg. RRR', E.rrr === null ? '—' : `${num(E.rrr)}:1`, 'Average winning return divided by the average losing return.'),
        stat('Avg. Win and Loss', `${p1(E.avgWin)} / ${p1(E.avgLoss)}`, 'Mean return of winning trades and of losing trades.'),
        stat('Profit Factor', num(E.profitFactor), 'Basis points won divided by basis points lost.'),
        stat('Max Drawdown', `<span style="color:var(--neg)">${num(E.mdd)}%</span>`, 'Deepest give-back from a high on this curve. It only moves when a trade closes, so it is not the model’s own drawdown.'),
      ]));

      const quality = section('Consistency & Curve Quality', 'How steady, reliable and repeatable the record has been.', grid([
        stat('Profitable Days', p1(E.pDays, 1), `Share of the ${E.nDays} trading days in the value series that ended positive.`),
        stat('Profitable Weeks', p1(E.pWeeks, 1), `Share of ${E.nWeeks} weeks that ended positive.`),
        stat('Profitable Months', p1(E.pMonths, 1), `Share of ${E.nMonths} months that ended positive.`),
        stat('Profit Concentration', p1(E.concentration, 1), `Share of all basis points won that came from the best ${E.topN} trade${E.topN === 1 ? '' : 's'} — the top tenth. A high number is not a compliment.`),
        stat('Weekly Performance Std Dev', p1(E.weeklySd), 'How much weekly returns moved around from one week to the next.'),
        stat('Longest Flat Stretch', `${E.longestFlat}`, 'Longest run of completed trades without setting a new high on this curve.'),
      ]));

      const recent = section('Recent Performance', 'How the most recent trades compare with the whole record.',
        `<table style="font-size:12.5px"><thead><tr><th></th><th class="num">Return</th><th class="num">Winrate</th><th class="num">Avg. trade</th><th class="num">Max DD</th></tr></thead><tbody>
        ${E.recent.map(r => `<tr><td><b>${r.days} days</b></td>
          ${r.n ? `<td class="num" style="color:${col(r.ret)}">${num(r.ret)}%</td>
          <td class="num">${p1(r.winrate, 1)}</td>
          <td class="num" style="color:${col(r.avgTrade)}">${p1(r.avgTrade)}</td>
          <td class="num" style="color:var(--neg)">${num(r.mdd)}%</td>`
          : `<td class="num" colspan="4" style="color:var(--muted)">no trade closed in this window</td>`}</tr>`).join('')}
        </tbody></table>
        <p class="note" style="margin-top:8px">Measured over trades that <b>closed</b> inside each window, counted back from the last exit in the record rather than from today — the newest snapshot is ${esc(E.closed.at(-1).exit_date)}, so a window counted from today would report a quiet stretch that is really just the end of the file.</p>`);

      return `<div style="margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
        <div style="display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:18px" class="eqwrap">
          <div style="min-width:0">
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">Return, gain sum (%)</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Cumulative contribution across ${E.pts.length} completed trades, in order of exit.</div>
            ${equitySvg(E)}
            <p class="note" style="margin-top:6px">Move over the graph to inspect a trade.</p>
          </div>
          <div style="min-width:0">
            <div style="font-size:15px;font-weight:700">Equity Curve Stats</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Return, consistency and recent performance for the curve beside it.</div>
            <div class="eqscroll">${snapshot}${quality}${recent}</div>
          </div>
        </div></div>`;
    })();

    // ---- tax efficiency -------------------------------------------------------------------
    // Short against long term across the whole recorded trade history, by FIFO lot so partial
    // sales count -- roughly half the realisations in these models are trims, and a round-trip
    // ledger cannot see one.
    const taxCard = (() => {
      const all = (D.taxEff || []).filter(r => isOverall || r.strategy_id === annieModel);
      if (!all.length) return '';
      const rate = TAX_RATES[taxBracket];
      const years = [...new Set(all.map(r => r.year))].sort();
      // Overall averages the models that have a ledger, each counting once -- the same rule the
      // rest of this page uses. These are basis points of a model's own value, so summing them
      // across eight models would describe a portfolio nobody holds.
      const perYear = years.map(y => {
        const rows = all.filter(r => r.year === y);
        const k = isOverall ? rows.length : 1;
        const agg = rows.reduce((a, r) => ({
          st_gain_bps: a.st_gain_bps + +r.st_gain_bps, st_loss_bps: a.st_loss_bps + +r.st_loss_bps,
          lt_gain_bps: a.lt_gain_bps + +r.lt_gain_bps, lt_loss_bps: a.lt_loss_bps + +r.lt_loss_bps,
          n_st: a.n_st + r.n_st, n_lt: a.n_lt + r.n_lt, trims: a.trims + +r.bps_from_trims,
          // Counts are totals even on Overall: these are decisions the desk made, and a decision
          // taken in one model is still one decision. Only the basis-point figures are averaged,
          // because those are shares of a model's own value.
          n_sales: a.n_sales + r.n_sales, n_full_exits: a.n_full_exits + r.n_full_exits, n_trims: a.n_trims + r.n_trims,
        }), { st_gain_bps: 0, st_loss_bps: 0, lt_gain_bps: 0, lt_loss_bps: 0, n_st: 0, n_lt: 0, trims: 0, n_sales: 0, n_full_exits: 0, n_trims: 0 });
        for (const f of ['st_gain_bps', 'st_loss_bps', 'lt_gain_bps', 'lt_loss_bps']) agg[f] /= k;
        agg.trims /= k;
        return { year: y, ...agg, tax: netTax(agg, rate), models: rows.length };
      });
      const totalTax = perYear.reduce((a, p) => a + p.tax.total, 0);
      const avgTax = totalTax / perYear.length;
      const grossGains = perYear.reduce((a, p) => a + p.st_gain_bps + p.lt_gain_bps, 0);
      const ltShare = grossGains > 0 ? perYear.reduce((a, p) => a + p.lt_gain_bps, 0) / grossGains : null;
      const cov = (D.taxCov || []).filter(c => isOverall || c.strategy_id === annieModel);
      const nPartial = cov.reduce((a, c) => a + c.n_partial_sales, 0);
      const nSales = cov.reduce((a, c) => a + c.n_sales, 0);
      const openingBps = cov.reduce((a, c) => a + +c.opening_lot_bps, 0);
      const realisedAll = all.reduce((a, r) => a + +r.st_gain_bps + +r.lt_gain_bps + +r.st_loss_bps + +r.lt_loss_bps, 0);

      const maxBar = Math.max(1, ...perYear.map(p => Math.max(p.st_gain_bps, p.lt_gain_bps)));
      const bars = perYear.map(p => {
        const hST = Math.round((p.st_gain_bps / maxBar) * 64);
        const hLT = Math.round((p.lt_gain_bps / maxBar) * 64);
        const tip = `${p.year}: ${(p.lt_gain_bps / 100).toFixed(2)}% of long-term gains and ${(p.st_gain_bps / 100).toFixed(2)}% short-term, less ${((p.lt_loss_bps + p.st_loss_bps) / 100).toFixed(2)}% of losses, from ${p.n_sales} sell decisions. Tax at ${rate.note} comes to ${(p.tax.total / 100).toFixed(2)}%.`;
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;min-width:52px" title="${esc(tip)}">
          <small style="font-size:11px;font-weight:700;color:var(--neg);font-variant-numeric:tabular-nums">−${(p.tax.total / 100).toFixed(2)}%</small>
          <div style="width:100%;height:68px;display:flex;align-items:flex-end;gap:3px">
            <div style="flex:1;height:${hLT}px;background:var(--pos);border-radius:2px 2px 0 0;min-height:2px"></div>
            <div style="flex:1;height:${hST}px;background:var(--flat);border-radius:2px 2px 0 0;min-height:2px"></div>
          </div>
          <small style="font-size:10px;color:var(--muted)">${p.year}</small></div>`;
      }).join('');

      const rows = perYear.map(p => {
        const net = p.tax.st + p.tax.lt;
        const pc2 = v => (v / 100).toFixed(2) + '%';
        return `<tr><td><b>${p.year}</b></td>
          <td class="num" style="color:var(--pos)">${pc2(p.lt_gain_bps)}</td>
          <td class="num" style="color:var(--flat)">${pc2(p.st_gain_bps)}</td>
          <td class="num" style="color:var(--muted)">−${pc2(p.lt_loss_bps + p.st_loss_bps)}</td>
          <td class="num">${net >= 0 ? '' : '−'}${pc2(Math.abs(net))}</td>
          <td class="num"><b style="color:var(--neg)">−${pc2(p.tax.total)}</b></td>
          <td class="num" style="color:var(--muted)" title="${p.n_full_exits} full exits and ${p.n_trims} trims, reaching back through ${p.n_lt + p.n_st} tax lots.">${p.n_sales}<br><small>${p.n_trims} trims</small></td></tr>`;
      }).join('');

      const toggle = `<div class="tabs" style="margin:0">${Object.entries(TAX_RATES).map(([k, v]) =>
        `<button class="tab" data-taxbracket="${k}" aria-selected="${k === taxBracket}" title="${esc(v.note)}">${esc(v.label)}</button>`).join('')}</div>`;

      // The score is the drag itself, in the units the question was asked in. A letter grade would
      // be the desk inventing a scale; basis points a year is a number the owner can act on.
      const grade = avgTax < 100 ? ['Light', 'var(--pos)'] : avgTax < 200 ? ['Moderate', 'var(--flat)'] : ['Heavy', 'var(--neg)'];

      return `<div class="card" style="margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
          <h2 style="margin:0">${isOverall ? 'Tax Drag <span style="font-weight:400;font-size:13px;color:var(--muted)">(estimated across all models)</span>' : 'Estimated Tax Drag'}</h2>${toggle}</div>
        <div style="display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start;margin-top:14px">
          <div style="flex:none;min-width:190px">
            <div class="eyebrow">Tax impact</div>
            <div style="font-size:30px;font-weight:700;color:${grade[1]};line-height:1.1">−${(avgTax / 100).toFixed(2)}<span style="font-size:19px">%</span> <span style="font-size:15px;font-weight:600">/yr</span></div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(grade[0])} · ${esc(rate.note)}</div>
            <div style="margin-top:12px;font-size:13px">
              <div><b style="color:var(--pos)">${ltShare === null ? '—' : (ltShare * 100).toFixed(0) + '%'}</b> <span style="color:var(--muted)">of gains were long-term</span></div>
              <div style="margin-top:3px"><b>${nSales}</b> <span style="color:var(--muted)">sell decisions, ${nPartial} of them trims</span></div>
              <div style="margin-top:3px"><b>−${(totalTax / 100).toFixed(2)}%</b> <span style="color:var(--muted)">over ${perYear.length} year${perYear.length === 1 ? '' : 's'}</span></div>
            </div>
          </div>
          <div style="flex:1;min-width:230px">
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px">
              <span style="display:inline-block;width:9px;height:9px;background:var(--pos);border-radius:2px;margin-right:4px"></span>long-term gains
              <span style="display:inline-block;width:9px;height:9px;background:var(--flat);border-radius:2px;margin:0 4px 0 10px"></span>short-term
              <span style="color:var(--neg);margin-left:10px">− = tax owed</span></div>
            <div style="display:flex;align-items:flex-end;gap:8px">${bars}</div>
          </div>
        </div>
        <div style="overflow-x:auto;margin-top:16px"><table style="min-width:520px"><thead><tr>
          <th>Year</th><th class="num">LT gains</th><th class="num">ST gains</th><th class="num">Losses</th>
          <th class="num">Net taxable</th><th class="num">Tax</th><th class="num">Sell decisions</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
        <p class="note">Every figure is a <b>percentage of the model's own value</b>, measured by FIFO lot across the whole recorded trade history${cov[0] ? ` (${esc(cov[0].first_snapshot)} onward)` : ''}. <b>Partial sales count</b>: ${nPartial} of ${nSales} sell decisions here were trims rather than exits, and a round-trip ledger cannot see a trim at all — it only knows a position was present and then absent. One sale can produce both a short-term and a long-term result, because it reaches back through lots of different ages, which is what happens in a real account.
        <b>Sell decisions is not the same count as trades</b>, and the two are not meant to agree. The Trades box above counts entries plus exits and cannot see a trim; this counts every recorded fall in a weight, to zero or not. In ${perYear.at(-1).year} that is ${perYear.at(-1).n_sales} sell decisions — ${perYear.at(-1).n_full_exits} full exits and ${perYear.at(-1).n_trims} trims — against the ${perYear.at(-1).n_lt + perYear.at(-1).n_st} tax lots they reached back through. Only sells create a liability, so purchases are not counted here at all.
        Losses are netted the way the rule actually works — short against short, long against long, and a leftover loss of either character against a remaining gain of the other — so this is tax that would have been owed, not tax on gross gains.
        ${isOverall ? '<b>Overall averages the models that have a ledger, each counting once.</b> These are basis points of a single model&#39;s own value, so adding eight of them together would describe a portfolio nobody holds. ' : ''}
        <b>Three things make this an understatement rather than a precise bill.</b> Gains are measured on adjusted closes, so distributions are folded into price appreciation — in a real account a dividend is taxable the year it is paid, usually at the higher rate, and it does not wait for a sale. ${openingBps > 0 ? `About ${openingBps.toFixed(0)} bps of what is realised here came from positions already held when the records begin, whose basis and holding period are the first snapshot's rather than the true purchase; their real holding period is longer, so a few of these may be graded short-term when they were not. ` : ''}And weights are targets at allocation dates, so lot sizes are intended rather than executed quantities. Nothing here is tax advice or a filing figure.
        <b>Rates applied:</b> ${esc(TAX_RATES.standard.note)} on the Standard tab; ${esc(TAX_RATES.hnw.note)} on HNW. Federal rates only — no state tax, no net investment income tax, no wash-sale adjustment.</p></div>`;
    })();

    const head = !s
      ? '<span style="font-size:12px;color:var(--muted)">no dated holdings history — nothing to grade</span>'
      : `<span style="font-size:12px;color:var(--muted)">${esc(s.first_snapshot)} to ${esc(s.last_snapshot)} · ${s.n_closed} completed, ${s.n_open} open${isOverall ? ` · ${graded.length} of ${(D.models || []).length} models graded` : ''}</span>`;

    const note = !s
      ? `This model has target weights but no dated holdings history, so there is nothing to compare over time and no trades to grade. The boxes are blank rather than zero — a zero would say it batted .000, which is a different and much worse claim than "not measured". Load a history with <code>jobs/load-holdings-history.mjs</code> and the figures compute themselves.`
      : `${isOverall ? `<b>Overall averages the ${graded.length} model${graded.length === 1 ? '' : 's'} that can be graded, each counting once</b> — a model with four trades weighs the same as one with fifty. The ${(D.models || []).length - graded.length} without a holdings history are left out rather than entered as zero: averaging in a zero would say they graded badly when the truth is they were not graded. Rates are that equal-weighted average; the counts beside them are totals. ` : ''}${beatRate !== null && ba !== null && beatRate < ba - 0.05
          ? `<b>These two counts disagree, and the disagreement is the finding.</b> ${s.n_wins} of ${s.n_closed} trades exited profitable; ${s.n_beat_benchmark} of the same ${s.n_closed} beat the benchmark${ex === null ? '' : `, and the per-trade excess sums to ${ex >= 0 ? '+' : ''}${ex.toFixed(0)} bps`}. A trade can exit profitable having cost the model everything the index would have paid instead — a cash line is the clean case, with a permanent perfect batting average and a permanently negative decision score in a rising market. <i>That excess total is a rough aggregate across trades that ran over different, non-overlapping spans; it answers "how did these decisions fare against the index, added up" and is not the model's underperformance over any period.</i> ` : ''}${isOverall ? `<b>The streak and the hot-hand card count DECISIONS, not ledger rows.</b> A single call made across several models arrives here as one row per model, and left that way the last ten chips showed one AGGH exit seven times — a 30% streak sitting beside a 75% batting average. The same ticker leaving on the same date is collapsed into one chip, averaged across the models that held it; ten of the 165 decisions made money in one model and lost it in another, because the models bought in on different dates, and those chips say so on hover. The batting average beside them is a different figure and stays row-based, averaged equally across models over the whole record rather than over the last ninety days. ` : ''}${s.n_unpriced ? `<b>${s.n_unpriced} position${s.n_unpriced === 1 ? '' : 's'} could not be priced</b> and ${s.n_unpriced === 1 ? 'is' : 'are'} excluded from every figure here. ` : ''}${s.gap_days ? `The history has a ${s.gap_days}-day hole, and a round trip that opened and closed inside it is invisible — not counted as a win or a loss, simply absent. ` : ''}Trades are derived from the dated snapshots, not from a broker file: a ticker present in one snapshot and absent from the one before was bought, present and then absent was sold. A round trip that opened and closed between two snapshots cannot be seen at all. ${ERROR_CAVEAT}`;

    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Scorecard</h2>
        <div style="display:flex;align-items:center;gap:14px;margin-left:auto">${head}${hotHandCard(rate90, wins90, recent90.length, HOT_WINDOW_DAYS)}</div></div>
      <div style="margin-top:10px">${tabs}</div>
      <div class="kpis" style="grid-template-columns:repeat(5,1fr);margin-top:14px">
        ${kpi('Batting average', ba === null ? DASH : ba.toFixed(3).replace(/^0/, ''),
              s ? `${s.n_wins} of ${s.n_closed} exited profitable` : 'no trades to grade',
              'Share of completed trades that exited with a positive return. Ted Williams by way of Buffett: it counts hits, not distance.')}
        ${kpi('Beat the benchmark', beatRate === null ? DASH : beatRate.toFixed(3).replace(/^0/, ''),
              s ? `${s.n_beat_benchmark} of ${s.n_closed} beat the index` : 'no trades to grade',
              'The same completed trades, counted against what the benchmark would have given the same money. A trade can exit profitable having cost the model everything the index would have paid instead, which is why this sits beside the batting average rather than behind it.')}
        ${kpi('Slugging', sl === null ? DASH : `${sl >= 0 ? '+' : ''}${(sl / 100).toFixed(2)}%`,
              s ? 'of model return per completed trade' : 'no trades to grade',
              'Average contribution to the model\'s return per completed trade. The distance on the hits — a model can bat .700 and still lose money by sizing its winners small. Two decimals because the figure is a per-trade average and a basis point of it is real money.')}
        ${kpi('Wins vs losses', !s ? DASH : `<span style="color:var(--pos)">${s.n_wins}</span><span style="color:var(--muted)">/</span><span style="color:var(--neg)">${s.n_losses}</span>`,
              s ? `+${w.toFixed(0)} bps won, ${l.toFixed(0)} bps lost` : 'no trades to grade',
              'Completed trades split by whether they exited profitable, with the basis points each side contributed. Counts, so on Overall these are totals rather than an average.')}
        ${kpi('Backwards K', DASH, 'needs a loss threshold per trade',
              'Called out on strikes: positions sold at a loss BIGGER than the threshold set when the trade was entered. It cannot be counted yet — no trade here carries a recorded threshold, because the entry journal does not exist. Deliberately blank rather than zero: a zero would read as "no position has ever blown through its stop", which is a flattering claim nobody has earned. Build the entry journal and this counts itself.')}
      </div>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr);margin-top:10px">
        ${kpi('Average hold time', hold === null ? DASH : `${hold.toFixed(0)}`,
              hold === null ? 'no closed trades' : 'days, entry to exit',
              'Mean days from entry to exit across closed trades the desk actually opened. An upper bound: an exit is dated at the snapshot where the position was first absent, so every hold is measured to a date at or beyond the real one. Pre-existing positions are excluded — their entry date is the first day of the records, not a purchase.')}
        ${ytd === null ? kpi('Trades YTD', DASH, 'no ledger',
              'Trade events this calendar year — entries plus exits, not round trips.') : tradesBox(tradeYears, yearElapsed)}
        ${streakBox(streak)}
      </div>
      ${errorsBlock(s, isOverall)}
      ${taxCard}
      <p class="note">${note}</p>
      ${curveBlock}</div>`;
  })();

  // ---- Hunting Pitches: the shortlist, graded for reflexivity ----
  //
  // Not every column here can be filled yet and the ones that cannot are left blank rather than
  // guessed. Swing size in particular: there is an obvious temptation to derive it from the
  // reflexivity score with some tidy mapping, and that mapping would be invented here rather than
  // argued from anything. It stays Annie's to write.
  const hunting = (() => {
    const shortlist = (D.markets || []).filter(s => s.hp);
    const sl = (D.speedLimit || []).find(r => r.category === 'master') || null;
    const masterLight = sl ? sl.light : null;
    const slLabel = sl && sl.sign_label ? sl.sign_label.replace(/^Speed Limit\s*/i, '') : null;
    const refl = a => assess.find(x => x.kind === 'reflexivity' && x.ticker === a);
    const steel = a => assess.find(x => x.kind === 'steel_man' && x.ticker === a);
    const swing = a => assess.find(x => x.kind === 'sizing_recommendation' && x.ticker === a);

    const head = `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Hunting Pitches</h2>
      <span style="font-size:12px;color:var(--muted)">${shortlist.length ? `${shortlist.length} name${shortlist.length === 1 ? '' : 's'} on the shortlist` : 'shortlist empty'}</span></div>`;

    if (!shortlist.length) {
      return `<div class="card" style="margin-bottom:14px">${head}
        <div class="empty" style="margin-top:10px">Nothing is tagged high potential yet, so there is nothing to swing at.
        Tag names with <code>node jobs/tag-high-potential.mjs --add TICKER</code> and they appear here; the Playground will own this once the watchlist moves there.
        The shortlist is deliberately not seeded from the sector and factor proxies already carrying the watchlist role — those are measurement tools, not ideas anyone had.</div>
        <p class="note">${PITCH_NOTE} Once names are tagged, each carries an <b>error risk</b> read off the master Speed Limit${slLabel ? `, currently ${esc(slLabel)}` : ''}: which of the two mistakes the signal exposes you to on that name right now. ${ERROR_CAVEAT}</p></div>`;
    }

    return `<div class="card" style="margin-bottom:14px">${head}
      <div style="overflow-x:auto;margin-top:10px"><table style="min-width:760px"><thead><tr>
        <th>Ticker</th><th>Name</th><th>Asset class</th><th class="num">Reflexivity score</th>
        <th class="num">Swing size</th><th>Error risk</th><th>Steel man</th></tr></thead><tbody>
      ${shortlist.slice().sort((a, b) => {
        const ra = n(refl(a.ticker)?.score), rb = n(refl(b.ticker)?.score);
        return (rb === null ? -1 : rb) - (ra === null ? -1 : ra) || a.ticker.localeCompare(b.ticker);
      }).map(s => {
        const r = refl(s.ticker), sm = steel(s.ticker), sw = swing(s.ticker);
        const sc = n(r?.score);
        return `<tr>
          <td><b>${esc(s.ticker)}</b>${s.hpSince ? `<br><small style="color:var(--muted)">since ${esc(s.hpSince)}</small>` : ''}</td>
          <td style="max-width:280px">${esc(s.name || '—')}${s.hpNote ? `<br><small style="color:var(--muted)">${esc(s.hpNote)}</small>` : ''}</td>
          <td style="color:var(--muted)">${esc(D.classNames[s.cls] || s.cls)}</td>
          <td class="num">${sc === null
            ? `<span style="color:var(--muted)" title="Annie has not scored this one yet. Run the Annie agent and load with jobs/load-annie-assessments.mjs.">–</span>`
            : `<b style="color:${pitchColor(sc)}" title="${esc(r.score_scale || '')}">${sc.toFixed(1)}</b><br><small style="color:${pitchColor(sc)}">${esc(pitchLabel(sc))}</small>`}</td>
          <td class="num">${sw && sw.score !== null && sw.score !== undefined
            ? `<b>${(+sw.score).toFixed(1)}%</b><br><small style="color:var(--muted)">${esc(sw.headline.slice(0, 28))}</small>`
            : `<span style="color:var(--muted)" title="No swing size written for this name. It is deliberately not derived from the reflexivity score — that mapping would be invented here rather than argued from the desk's own record, which is Annie's job.">–</span>`}</td>
          <td>${(() => { const e = errorRisk(masterLight, sc); return `<span style="color:${RISK_COLOR[e.k] || 'var(--muted)'}" title="${esc(e.why)}">${esc(e.label)}</span>`; })()}</td>
          <td>${sm
            ? `<button class="ibeam" data-go="#annie/steel-${esc(s.ticker)}" title="Read the case against ${esc(s.ticker)}">${IBEAM}</button>`
            : `<span class="ibeam off" title="Annie has not written a steel man for ${esc(s.ticker)} yet.">${IBEAM}</span>`}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="note">${PITCH_NOTE} <b>Error risk</b> reads off the master Speed Limit${slLabel ? `, currently ${esc(slLabel)}` : ''}${masterLight ? ` and showing ${esc(masterLight)}` : ''}: the light is the prior on H0. A red light says take less risk, so acting anyway is where a Type I error comes from; a green light says risk is paid, so passing is where a Type II comes from. On yellow the signal is not calling it and only an extreme reflexivity score tips it — "both live" is a real answer, not a missing one. ${ERROR_CAVEAT}</p></div>`;
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
    const medianWeight = n((stats.find(x => trades.some(t => t.strategy_id === x.strategy_id)) || {}).median_weight);
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
      <p class="note">${medianWeight === null ? '' : `<b>Sizing is judged against this model's median position of ${pct(medianWeight)}</b>: a winner held well below it was too small, a loser held well above it was too large, and within a quarter either way is about right. `}Contribution is accumulated at the weight actually held in each stretch, not average size times the whole-period return, because a position trimmed before a fall contributed less than its full-size return implies — and that gap is the entire sizing question.${divergent.length ? ` <b>${divergent.length} trade${divergent.length === 1 ? '' : 's'} here exited profitable but contributed negatively, or the reverse</b> (${divergent.slice(0, 4).map(t => esc(t.ticker)).join(', ')}${divergent.length > 4 ? '…' : ''}); when those two disagree the path is the story, not the entry and exit.` : ''} Faded rows were already held on the first day of the records, so their return is measured from where the file starts rather than from a decision. Exits are dated at the snapshot where the position was first absent, which is on or after the day it was sold.</p></div>`;
  })();

  // ---- The compliance audit: every closed trade, graded after the fact ----
  //
  // The point is to grade the DECISION, not the outcome. A sale that looked wrong for a month and
  // right for a year is not two different decisions, so the evidence is kept separate rather than
  // collapsed into a score: what the position did since, what the benchmark did over the same
  // stretch, and which tracked alternative would have done better over the holding period.
  const reviewCard = (() => {
    // isOverall is local to the scorecard closure; the scorecard's tab selection is module-level.
    const isOverall = annieModel === 'overall';
    const all = (D.tradeReviews || []).filter(r => isOverall || r.strategy_id === annieModel);
    if (!all.length) {
      return `<div class="card" style="margin-bottom:14px"><h2>Trade review</h2>
        <div class="empty">No reviews computed yet. Run jobs/compute-trade-reviews.mjs.</div></div>`;
    }
    const V = {
      sold_too_early: ['Sold too early', 'var(--neg)'],
      good_exit:      ['Good exit',      'var(--pos)'],
      neutral_exit:   ['Neutral',        'var(--muted)'],
      unscored:       ['Unscored',       'var(--muted)'],
    };
    const cnt = k => all.filter(r => r.exit_verdict === k).length;
    const scored = all.filter(r => r.held_instead_bps !== null);
    const med = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const earlyBps = scored.filter(r => r.exit_verdict === 'sold_too_early').map(r => +r.held_instead_bps);
    const goodBps = scored.filter(r => r.exit_verdict === 'good_exit').map(r => +r.held_instead_bps);
    const pc = v => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : ''}${(+v * 100).toFixed(1)}%`;
    const bp = v => v === null || v === undefined ? '–' : `${+v >= 0 ? '+' : ''}${(+v).toFixed(0)}`;

    // Biggest lessons first: the exits that cost the most, then the ones that saved the most.
    const ranked = scored.slice().sort((a, b) => Math.abs(+b.held_instead_bps) - Math.abs(+a.held_instead_bps)).slice(0, 25);
    const kpi = (lab, val, sub, title) => `<div class="card kpi" title="${esc(title)}">
      <span class="eyebrow">${esc(lab)}</span><b style="font-size:24px">${val}</b><small>${esc(sub)}</small></div>`;

    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Trade review — the compliance audit</h2>
        <span style="font-size:12px;color:var(--muted)">${all.length} closed trades graded${isOverall ? ' across every model' : ''}</span></div>
      <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-top:12px">
        ${kpi('Sold too early', `<span style="color:var(--neg)">${cnt('sold_too_early')}</span>`,
              `median ${bp(med(earlyBps))} bps left behind`,
              'Positions sold that have since beaten the benchmark. The exit cost the model what holding would have added.')}
        ${kpi('Good exits', `<span style="color:var(--pos)">${cnt('good_exit')}</span>`,
              `median ${bp(med(goodBps))} bps saved`,
              'Positions sold that have since trailed the benchmark. The exit saved the model what holding would have cost.')}
        ${kpi('Neutral', `${cnt('neutral_exit')}`, 'tracked the benchmark within 2%',
              'The sale neither helped nor hurt against the benchmark since.')}
        ${kpi('Not yet reviewable', `${cnt('unscored')}`, 'too recent, or no price history',
              'Sold inside the last three weeks, or with no usable price series since. A review needs hindsight before it is saying anything.')}
      </div>
      <p class="note">${cnt('sold_too_early') > cnt('good_exit') * 1.3
        ? `<b>Sold-too-early outnumbers good exits ${cnt('sold_too_early')} to ${cnt('good_exit')}.</b> That is a pattern rather than a run of bad luck, and it is the one this audit exists to find: the desk cuts positions that go on to work. It is the mirror of the sizing finding — winners held small, and sold early.`
        : `Exits split ${cnt('good_exit')} good to ${cnt('sold_too_early')} early.`}
      Every verdict is measured <b>against the benchmark since the sale</b>, not against zero: selling into a falling market is not skill if everything fell, and holding through a rally is not an error if the position merely kept up.</p>
      <div style="overflow-x:auto;margin-top:12px"><table style="min-width:900px"><thead><tr>
        <th>Position</th><th>Held</th><th class="num">While held</th><th>Exit</th>
        <th class="num">Since the sale</th><th class="num">Holding instead</th><th>The better decision</th>
      </tr></thead><tbody>
      ${ranked.map(r => {
        const v = V[r.exit_verdict] || V.unscored;
        const cost = r.held_instead_bps === null ? null : +r.held_instead_bps;
        return `<tr>
          <td><b>${esc(r.ticker)}</b><br><small style="color:var(--muted)">${esc(((D.models || []).find(m => m.id === r.strategy_id) || {}).name || '').replace(/\s*\([^)]*\)/g, '')}</small></td>
          <td style="color:var(--muted);white-space:nowrap;font-size:12px">${esc(r.entry_date)}<br>→ ${esc(r.exit_date)}</td>
          <td class="num"${r.held_excess_bps !== null ? ` title="${esc(`${bp(r.held_excess_bps)} bps against the benchmark while held`)}"` : ''}>${r.held_return === null ? '–' : `<span style="color:${+r.held_return >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(r.held_return)}</span>`}</td>
          <td><span style="color:${v[1]};font-weight:${r.exit_verdict === 'sold_too_early' || r.exit_verdict === 'good_exit' ? '600' : '400'}">${v[0]}</span>
            <br><small style="color:var(--muted)">${r.days_since_exit === null ? '' : r.days_since_exit + 'd ago'}</small></td>
          <td class="num" title="${esc(r.headline || '')}">${r.after_excess === null ? '<span style="color:var(--muted)">–</span>'
            : `<span style="color:${+r.after_excess >= 0 ? 'var(--neg)' : 'var(--pos)'}">${pc(r.after_excess)}</span><br><small style="color:var(--muted)">vs bench</small>`}</td>
          <td class="num"><b style="color:${cost === null ? 'var(--muted)' : cost > 0 ? 'var(--neg)' : 'var(--pos)'}">${bp(cost)}</b><br><small style="color:var(--muted)">bps</small></td>
          <td style="max-width:300px;font-size:12px">${r.better_ticker
            ? `<b>${esc(r.better_ticker)}</b> <span style="color:var(--muted)">${pc(r.better_return)}</span>${r.better_gain_bps !== null && +r.better_gain_bps > 10 ? `<br><span style="color:var(--warn)">+${(+r.better_gain_bps).toFixed(0)} bps forgone</span>` : '<br><span style="color:var(--muted)">instrument choice was sound</span>'}`
            : '<span style="color:var(--muted)">no tracked alternative</span>'}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="note">Ranked by how much the exit was worth, largest first — the costly ones and the saves both. <b>Holding instead</b> is what keeping the position at its exit weight would have added to the model since the sale, in basis points; positive means the exit cost that much.
      <b>The better decision is picked with hindsight on purpose.</b> It is the best-performing security the desk already tracks in the same asset class over that holding period — a real comparison, since the desk could have bought it and the prices are real. It is <i>not</i> a claim the alternative was knowable at the time, and reading it as one would turn every review into a reprimand for not being clairvoyant. The useful version is the pattern: where the same bet in a different vehicle would repeatedly have done better, the lesson is about instrument choice rather than about the call.
      Figures are not summed across trades — they run over different, overlapping periods in different models, and adding them would produce a number that describes nothing.</p></div>`;
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
   <p class="sub">OODA — Observe, Orient, Decide, Act.</p>
   ${scorecard}
   ${hunting}
   ${positions}
   ${journal}
   ${reviewCard}
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
const CLASS_LABEL = { equities: 'Equity', bonds: 'Fixed Income', cash: 'Cash', commodities_real_assets: 'Commodities', gold: 'Gold' };
// A custom blend is stored as class weights in `mix`; the named options stay in `split`. Reading
// an override goes through here so the two cannot drift apart, and a mix always wins: it is the
// more specific statement, and it is what the volatility check was run against.
const mixOf = ov => !ov ? null
  : (ov.mix && Object.keys(ov.mix).length ? ov.mix : (SPLIT_BY_KEY[ov.split] || {}).mix || null);
const mixLabel = mix => !mix ? '—' : Object.entries(mix).filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${Math.round(v * 100)}% ${CLASS_LABEL[k] || k}`).join(' / ');
const mixKey = mix => 'custom:' + Object.entries(mix).filter(([, v]) => v > 0).sort().map(([k, v]) => `${k}=${v}`).join(',');
const mixFromKey = k => !k || !k.startsWith('custom:') ? null
  : Object.fromEntries(k.slice(7).split(',').filter(Boolean).map(p => { const [a, b] = p.split('='); return [a, +b]; }));

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
    const ovMix = mixOf(ov);
    if (ov && ovMix) {
      // A look-through is a blend of real asset classes, so it earns both sides of the matrix:
      // the long pie AND the short tally, each weighted by the class share.
      for (const [cls, share] of Object.entries(ovMix)) {
        const row = FA_MATRIX[cls];
        if (!row) continue;
        const lf = FA_FACTORS.filter(f => row[f] === 'L');
        for (const f of lf) { longs[f] += w * share / lf.length; add(f, h, w * share / lf.length); }
        for (const f of FA_FACTORS) if (row[f] === 'S') shorts[f] += w * share;
      }
      resolved.push({ ...h, split: ov.split, mix: ovMix });
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
    if (!split) continue;
    const cm = mixFromKey(split);
    D.factorOverrides.push({ security_id: sid, split: cm ? null : split, mix: cm, author: 'site', as_of: new Date().toISOString().slice(0, 10) });
  }
  repPending = {}; repSaveError = null;
  openModel(repModelId);
  try {
    const ups = Object.entries(pending).filter(([, v]) => v)
      .map(([security_id, split]) => { const cm = mixFromKey(split);
        return { security_id, split: cm ? null : split, mix: cm, author: 'site', as_of: new Date().toISOString().slice(0, 10) }; });
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
  fi_duration:      'Weighted duration of the model’s fixed income, in years: roughly what the sleeve loses for every one point the 10-year Treasury yield rises. Measured, not sourced — no duration vendor is connected and there is no holdings look-through, so each fund’s rate sensitivity is regressed from its own weekly returns against the 10-year. The bond share of a blended fund counts through its classification, so a 20/80 fund held at 10% contributes 8% of the model here.',
};

// Renders the dashboard body for ONE model. Lives in the model drawer rather than on a page of
// its own: the drawer is already per-model, so a selector would be a second way to do the same
// thing. Returns cards only — the caller supplies the heading and the holdings table.
// ---------- Factor fingerprint ----------
//
// Five axes, plotted as a radar so the SHAPE is the fingerprint: two books with the same average
// tilt but different distributions look different here, which a row of numbers hides. The zero
// ring is drawn, because every one of these can be negative and a radar without it reads as if
// the centre were zero — it is not, it is the bottom of the scale.
function factorRadar(rows, benchLabel, modelLabel) {
  const vals = rows.flatMap(r => [r.model_beta, r.benchmark_beta]).filter(v => v !== null && v !== undefined).map(v => Math.abs(+v));
  const M = Math.max(0.30, ...vals);                 // symmetric scale, never tighter than +/-0.30
  const S = 300, cx = S / 2, cy = S / 2 + 6, R = 104;
  const n = rows.length;
  const ang = i => (-Math.PI / 2) + (i * 2 * Math.PI / n);
  const rad = v => R * ((+v + M) / (2 * M));
  const pt = (i, v) => [cx + rad(v) * Math.cos(ang(i)), cy + rad(v) * Math.sin(ang(i))];
  const poly = (key, color, fill) => {
    const got = rows.map(r => r[key]).every(v => v !== null && v !== undefined);
    if (!got) return '';
    const d = rows.map((r, i) => pt(i, +r[key]).map(x => x.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${d}" fill="${fill}" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
  };
  const grid = [0.25, 0.5, 0.75, 1].map(f => {
    const d = rows.map((_, i) => [cx + R * f * Math.cos(ang(i)), cy + R * f * Math.sin(ang(i))].map(x => x.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${d}" fill="none" stroke="var(--line)" stroke-width="1"/>`;
  }).join('');
  const zero = `<polygon points="${rows.map((_, i) => pt(i, 0).map(x => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`;
  const spokes = rows.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${(cx + R * Math.cos(ang(i))).toFixed(1)}" y2="${(cy + R * Math.sin(ang(i))).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`).join('');
  const labels = rows.map((r, i) => {
    const a = ang(i), lx = cx + (R + 26) * Math.cos(a), ly = cy + (R + 26) * Math.sin(a);
    const anchorFor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
    return `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchorFor}" font-size="11" fill="var(--muted)">${esc(r.label)}</text>`;
  }).join('');
  // The viewBox reaches past the plot on both sides: the axis labels sit 26px beyond the outer
  // ring and "Low Volatility" is wider than that margin, so a box drawn to the radar alone clips
  // them to "mall)" and "Mom".
  return `<svg viewBox="-58 0 ${S + 116} ${S + 18}" style="width:340px;max-width:100%;height:auto;flex:none" role="img" aria-label="Factor fingerprint">
    ${grid}${spokes}${zero}
    ${poly('benchmark_beta', 'var(--bench)', 'color-mix(in srgb, var(--bench) 18%, transparent)')}
    ${poly('model_beta', 'var(--accent)', 'color-mix(in srgb, var(--accent) 22%, transparent)')}
    ${labels}
    <text x="${cx}" y="${S + 14}" text-anchor="middle" font-size="10" fill="var(--muted)">dashed ring = no tilt · scale ±${M.toFixed(2)}</text></svg>`;
}

// scope: 'model' with a strategy id, or 'firm'. Same card either way, so the two cannot drift.
function fingerprintCard(scope, strategyId, modelLabel, benchLabel, heading) {
  const rows = (D.fingerprint || []).filter(r => r.scope === scope && (scope === 'firm' || r.strategy_id === strategyId))
    .slice().sort((a, b) => a.sort_order - b.sort_order);
  const cov = (D.fingerprintCov || []).find(r => r.scope === scope && (scope === 'firm' || r.strategy_id === strategyId)) || null;
  if (!rows.length) return '';
  const have = v => v !== null && v !== undefined;
  const b2 = v => have(v) ? (+v >= 0 ? '+' : '−') + Math.abs(+v).toFixed(2) : '—';
  const tone = v => !have(v) ? 'var(--muted)' : Math.abs(+v) < 0.025 ? 'var(--muted)' : +v > 0 ? 'var(--pos)' : 'var(--neg)';
  const un = (cov?.unresolved || []).filter(u => u.side === 'model');
  const p1 = v => have(v) ? (+v * 100).toFixed(1) + '%' : '—';

  const table = `<table style="min-width:420px"><thead><tr>
      <th>Factor</th><th class="num">${esc(modelLabel)}</th><th class="num">${esc(benchLabel)}</th><th class="num">Active</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.label)}</td>
      <td class="num" style="color:${tone(r.model_beta)}">${b2(r.model_beta)}</td>
      <td class="num" style="color:var(--muted)">${b2(r.benchmark_beta)}</td>
      <td class="num" style="color:${tone(r.active_beta)}"><b>${b2(r.active_beta)}</b></td></tr>`).join('')}
    </tbody></table>`;

  // The largest active bet, named. A fingerprint read as five numbers invites picking the biggest
  // absolute tilt, which is usually the one the benchmark already carried.
  const biggest = rows.filter(r => have(r.active_beta)).slice().sort((a, b) => Math.abs(+b.active_beta) - Math.abs(+a.active_beta))[0];

  const unBlock = !un.length ? '' : `<details style="margin-top:10px;font-size:13px">
    <summary style="cursor:pointer;color:var(--text)">${un.length} equity holding${un.length === 1 ? '' : 's'} could not be fingerprinted</summary>
    <table style="margin-top:8px"><thead><tr><th>Ticker</th><th class="num">Weight</th><th>Why</th></tr></thead><tbody>
    ${un.map(u => `<tr><td><b>${esc(u.ticker || '—')}</b></td><td class="num">${(+u.weight * 100).toFixed(1)}%</td>
      <td style="max-width:460px;color:var(--muted)">${esc(u.reason)}</td></tr>`).join('')}
    </tbody></table></details>`;

  return `<div class="card" style="margin-top:18px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">${esc(heading)}</h2>
      <span style="font-size:12px;color:var(--muted)">
        <span style="display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:2px;margin-right:5px"></span>${esc(modelLabel)}
        <span style="display:inline-block;width:9px;height:9px;background:var(--bench);border-radius:2px;margin:0 5px 0 12px"></span>${esc(benchLabel)}</span></div>
    <div style="display:flex;gap:26px;align-items:center;flex-wrap:wrap;margin-top:12px">
      ${factorRadar(rows, benchLabel, modelLabel)}
      <div style="flex:1;min-width:320px;overflow-x:auto">${table}</div>
    </div>
    ${unBlock}
    <p class="note">Each fund's excess return is regressed on the market plus five long/short factor legs, every one built as a factor index <i>minus</i> the market — ${esc('VLUE−SPY')} for value, ${esc('MTUM−SPY')} for momentum, ${esc('QUAL−SPY')} for quality, ${esc('USMV−SPY')} for low volatility, and ${esc('IWM−SPY')} for size. Subtracting the market is what makes each leg a factor rather than an index: VLUE on its own is mostly market, VLUE minus the market is the value tilt and nothing else.
    <b>These are tilts, and a tilt has a sign.</b> That is the difference from the allocation this replaced, which could not go negative and so reported every model as some positive mixture of the five whether or not it leaned toward any of them. A reading of ${esc('−0.12')} on quality means the book leans away from quality; an allocation had no way to say that.
    Each fund's tilts are divided by its own equity beta, so they are expressed <b>per unit of equity exposure</b> — without that a 60/40 fund would look untilted simply for holding bonds. Developed and emerging market legs are included as controls, not as factors, so the five tilts measure style rather than geography; without them an international fund could not be fitted at all.
    ${biggest ? `The largest active bet here is <b>${esc(biggest.label.toLowerCase())}</b> at ${b2(biggest.active_beta)} against the benchmark${Math.abs(+biggest.model_beta) > Math.abs(+biggest.active_beta) ? ' — larger in absolute terms elsewhere, but much of that is a tilt the benchmark already carried rather than one the desk chose' : ''}. ` : ''}
    ${cov ? `Equity is ${p1(cov.model_equity_weight)} of ${scope === 'firm' ? 'the firm' : 'this model'}${have(cov.model_resolved) ? `, and the fingerprint describes ${p1(cov.model_resolved)} of it` : ''}. ` : ''}Equity only: a bond fund has no style tilt, and averaging one in at zero would read as "no tilt" rather than as "this does not apply to that part of the book". A fund whose fit explains less than 70% of its own daily movement is left out by name${un.length ? ' — the list above' : ''}.${cov?.window_start ? ` Fitted on daily returns from ${esc(cov.window_start)} to ${esc(cov.window_end)}.` : ''}</p></div>`;
}

// ---------- A flat world map, by region ----------
//
// Simplified landmasses on an equirectangular frame, grouped into the same five geographic
// regions the job aggregates to. It is a schematic, not a projection to measure from: the
// outlines are deliberately coarse because their only job is to say WHERE, while the number
// beside each one says HOW MUCH. Mexico is drawn with Latin America rather than with the North
// American landmass, so the shading matches the regional figure it carries.
const GEO_REGION_PATHS = {
  north_america: [
    'M33.3 66.7 L111.1 55.6 L144.4 55.6 L236.1 50.0 L272.2 47.2 L327.8 63.9 L344.4 105.6 L316.7 116.7 L305.6 130.6 L288.9 147.2 L275.0 177.8 L266.7 166.7 L250.0 169.4 L230.6 177.8 L225.0 188.9 L208.3 188.9 L183.3 172.2 L175.0 161.1 L155.6 138.9 L152.8 113.9 L122.2 86.1 L83.3 80.6 L41.7 75.0 Z',
    'M375.0 83.3 L438.9 55.6 L444.4 38.9 L416.7 19.4 L338.9 22.2 L327.8 38.9 L347.2 69.4 Z',
    'M336.1 119.4 L352.8 119.4 L352.8 108.3 L336.1 108.3 Z',
  ],
  latin_america: [
    'M208.3 188.9 L225.0 188.9 L230.6 205.6 L247.2 200.0 L255.6 205.6 L266.7 222.2 L283.3 227.8 L269.4 227.8 L255.6 213.9 L236.1 208.3 L211.1 200.0 Z',
    'M283.3 227.8 L300.0 219.4 L327.8 219.4 L355.6 236.1 L361.1 250.0 L377.8 255.6 L402.8 266.7 L391.7 294.4 L366.7 319.4 L350.0 344.4 L338.9 358.3 L316.7 402.8 L300.0 394.4 L297.2 375.0 L302.8 341.7 L305.6 300.0 L288.9 266.7 L277.8 250.0 L283.3 236.1 Z',
  ],
  europe: [
    'M475.0 147.2 L475.0 130.6 L494.4 130.6 L500.0 116.7 L486.1 116.7 L502.8 108.3 L511.1 105.6 L522.2 100.0 L527.8 91.7 L522.2 88.9 L513.9 80.6 L533.3 66.7 L550.0 58.3 L566.7 52.8 L583.3 55.6 L588.9 69.4 L605.6 80.6 L622.2 91.7 L633.3 105.6 L611.1 116.7 L600.0 125.0 L583.3 125.0 L577.8 136.1 L566.7 138.9 L552.8 138.9 L538.9 144.4 L533.3 127.8 L522.2 127.8 L508.3 130.6 L500.0 138.9 Z',
    'M486.1 111.1 L500.0 108.3 L497.2 100.0 L491.7 86.1 L483.3 88.9 L486.1 100.0 Z',
    'M433.3 72.2 L461.1 69.4 L455.6 66.7 L436.1 66.7 Z',
  ],
  africa_mideast: [
    'M452.8 208.3 L455.6 191.7 L472.2 175.0 L483.3 150.0 L527.8 147.2 L555.6 158.3 L588.9 163.9 L597.2 183.3 L608.3 205.6 L619.4 216.7 L641.7 216.7 L641.7 233.3 L616.7 255.6 L613.9 280.6 L611.1 297.2 L597.2 316.7 L583.3 336.1 L569.4 344.4 L550.0 344.4 L536.1 313.9 L533.3 294.4 L525.0 252.8 L505.6 233.3 L477.8 236.1 L463.9 225.0 Z',
    'M597.2 166.7 L616.7 166.7 L633.3 166.7 L658.3 183.3 L661.1 194.4 L644.4 205.6 L622.2 216.7 L608.3 205.6 Z',
    'M619.4 286.1 L638.9 294.4 L633.3 319.4 L622.2 311.1 Z',
  ],
  asia_pacific: [
    'M633.3 105.6 L661.1 102.8 L694.4 105.6 L722.2 111.1 L750.0 119.4 L777.8 119.4 L805.6 111.1 L833.3 102.8 L866.7 116.7 L894.4 100.0 L930.6 88.9 L972.2 77.8 L994.4 66.7 L977.8 52.8 L944.4 52.8 L888.9 44.4 L819.4 44.4 L763.9 33.3 L708.3 47.2 L666.7 52.8 L638.9 61.1 L622.2 91.7 Z',
    'M622.2 91.7 L638.9 125.0 L638.9 138.9 L633.3 166.7 L658.3 183.3 L672.2 180.6 L688.9 183.3 L700.0 194.4 L702.8 208.3 L713.9 227.8 L722.2 213.9 L733.3 188.9 L744.4 191.7 L755.6 188.9 L761.1 205.6 L772.2 222.2 L777.8 213.9 L791.7 222.2 L802.8 213.9 L797.2 194.4 L805.6 191.7 L827.8 183.3 L838.9 163.9 L838.9 138.9 L855.6 130.6 L875.0 116.7 L894.4 100.0 L866.7 116.7 L833.3 102.8 L805.6 111.1 L777.8 119.4 L750.0 119.4 L722.2 111.1 L694.4 105.6 L661.1 102.8 L633.3 105.6 Z',
    'M861.1 158.3 L877.8 150.0 L891.7 136.1 L902.8 127.8 L894.4 125.0 L880.6 147.2 L863.9 155.6 Z',
    'M763.9 236.1 L791.7 247.2 L827.8 261.1 L861.1 263.9 L891.7 258.3 L891.7 272.2 L861.1 275.0 L827.8 275.0 L794.4 269.4 L766.7 250.0 Z',
    'M833.3 200.0 L850.0 200.0 L850.0 233.3 L836.1 233.3 Z',
    'M816.7 311.1 L838.9 300.0 L861.1 283.3 L877.8 283.3 L894.4 280.6 L905.6 302.8 L919.4 316.7 L925.0 327.8 L916.7 352.8 L905.6 358.3 L888.9 355.6 L875.0 347.2 L858.3 338.9 L841.7 344.4 L819.4 344.4 L813.9 322.2 Z',
    'M980.6 347.2 L994.4 358.3 L986.1 366.7 L972.2 377.8 L963.9 375.0 L977.8 363.9 Z',
    'M833.3 180.6 L838.9 180.6 L838.9 188.9 L833.3 188.9 Z',
  ],
};
// Shading is relative to the largest region in the model, so a book that is 80% one place still
// reads as a map rather than a single dark blob beside four invisible ones.
function worldMap(byRegion, labelOf) {
  const max = Math.max(0.0001, ...Object.values(byRegion).map(v => +v || 0));
  const shade = v => {
    const t = Math.max(0, Math.min(1, (+v || 0) / max));
    return `color-mix(in srgb, var(--accent) ${(10 + t * 78).toFixed(0)}%, var(--panel2))`;
  };
  const paths = Object.entries(GEO_REGION_PATHS).map(([slug, ds]) => {
    const v = byRegion[slug];
    const pct = v === null || v === undefined ? 'not resolved' : `${(+v * 100).toFixed(1)}%`;
    return `<g><title>${esc(labelOf(slug))} — ${esc(pct)}</title>
      ${ds.map(d => `<path d="${d}" fill="${v === null || v === undefined ? 'var(--panel2)' : shade(v)}" stroke="var(--line)" stroke-width="1"/>`).join('')}</g>`;
  }).join('');
  // Labels sit over the centre of mass of each region's drawn shape, nudged by hand so none of
  // them lands in the sea or on top of another.
  // Anchored at a real coordinate inside each region -- roughly central Canada, Brazil, central
  // Europe, equatorial Africa and central Asia -- so the figure sits on land and not in the sea.
  const LABEL_AT = { north_america: [222, 117], latin_america: [339, 283], europe: [556, 100], africa_mideast: [556, 244], asia_pacific: [764, 139] };
  const labels = Object.entries(LABEL_AT).map(([slug, [x, y]]) => {
    const v = byRegion[slug];
    if (v === null || v === undefined) return '';
    return `<text x="${x}" y="${y}" text-anchor="middle" font-size="15" font-weight="700" fill="var(--text)" style="paint-order:stroke;stroke:var(--bg);stroke-width:3px">${(+v * 100).toFixed(0)}%</text>`;
  }).join('');
  // Equirectangular: x = (lon+180) x 1000/360, y = (90-lat) x 500/180. Cropped below 410 because
  // Antarctica holds no equity and its absence buys height for everything that does.
  return `<svg viewBox="20 15 980 400" style="width:100%;height:auto;display:block" role="img" aria-label="Equity allocation by region">${paths}${labels}</svg>`;
}


// Geography: a world map of where the equity is, and the ten largest countries beside the
// benchmark. Equity only -- a bond fund or a gold trust has no country mix to estimate, and the
// job excludes them rather than listing them as gaps.
function geographyCard(m) {
  const rows = (D.geoExposure || []).filter(r => r.strategy_id === m.id);
  const cov = (D.geoCoverage || []).find(r => r.strategy_id === m.id) || null;
  if (!rows.length) {
    return `<div class="card" style="margin-top:18px"><h2>Portfolio breakdown</h2>
      <div class="empty">No geographic fit for this model yet. Run jobs/compute-geo-exposure.mjs.</div></div>`;
  }
  const benchLabel = m.benchmarkLabel || 'Benchmark';
  const modelLabel = m.name.replace(/\s*\([^)]*\)/g, '');
  const have = v => v !== null && v !== undefined;
  const p1 = v => (+v * 100).toFixed(1) + '%';

  const regions = rows.filter(r => r.scope === 'region');
  const labelOf = slug => (regions.find(r => r.code === slug) || {}).label || slug;
  const byRegionModel = Object.fromEntries(regions.map(r => [r.code, r.model_weight]));
  const anyModel = regions.some(r => have(r.model_weight));

  const tabs = `<div class="tabs" style="margin:0">
    ${[['sector', 'Sector'], ['geography', 'Geography']].map(([k, lbl]) =>
      `<button class="tab" data-breakdown="${k}" aria-selected="${k === 'geography'}">${lbl}</button>`).join('')}</div>`;

  const regionRows = regions.slice().sort((a, b) => (+b.model_weight || 0) - (+a.model_weight || 0)).map(r => {
    const d = have(r.model_weight) && have(r.benchmark_weight) ? +r.model_weight - +r.benchmark_weight : null;
    return `<tr><td>${esc(r.label)}</td>
      <td class="num">${have(r.model_weight) ? p1(r.model_weight) : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="num" style="color:var(--muted)">${have(r.benchmark_weight) ? p1(r.benchmark_weight) : '—'}</td>
      <td class="num" style="color:${d === null ? 'var(--muted)' : Math.abs(d) < 0.0005 ? 'var(--muted)' : d > 0 ? 'var(--pos)' : 'var(--neg)'}">${d === null ? '—' : (d >= 0 ? '+' : '−') + (Math.abs(d) * 100).toFixed(1) + '%'}</td></tr>`;
  }).join('');

  // Top ten by MODEL weight where the model resolved, otherwise by benchmark weight -- a model
  // with no placeable equity should still show what its benchmark holds rather than ten dashes.
  const countries = rows.filter(r => r.scope === 'country');
  const key = anyModel ? 'model_weight' : 'benchmark_weight';
  const top = countries.slice().sort((a, b) => (+b[key] || 0) - (+a[key] || 0)).slice(0, 10);
  const scale = Math.max(0.01, ...top.flatMap(r => [+r.model_weight || 0, +r.benchmark_weight || 0]));
  const bar = (v, color, muted) => have(v)
    ? `<div style="display:flex;align-items:center;gap:6px">
         <div style="height:9px;width:${+v > 0 ? Math.max(0.6, (+v / scale) * 100) : 0}%;background:${color};border-radius:2px"></div>
         <small style="color:${muted ? 'var(--muted)' : 'var(--text)'};white-space:nowrap">${p1(v)}</small></div>`
    : `<div><small style="color:var(--muted)">not resolved</small></div>`;
  const countryRows = top.map(r => {
    const d = have(r.model_weight) && have(r.benchmark_weight) ? +r.model_weight - +r.benchmark_weight : null;
    return `<tr><td style="width:190px">${esc(r.label)}<br><small style="color:var(--muted)">${esc(labelOf(r.region))}</small></td>
      <td>${bar(r.model_weight, 'var(--accent)', false)}${bar(r.benchmark_weight, 'var(--bench)', true)}</td>
      <td class="num" style="width:90px;color:${d === null ? 'var(--muted)' : Math.abs(d) < 0.0005 ? 'var(--muted)' : d > 0 ? 'var(--pos)' : 'var(--neg)'}">${d === null ? '—' : (d >= 0 ? '+' : '−') + (Math.abs(d) * 100).toFixed(1) + '%'}</td></tr>`;
  }).join('');

  const un = (cov?.unresolved || []).filter(u => u.side === 'model');
  const unBlock = !un.length ? '' : `<details style="margin-top:10px;font-size:13px">
    <summary style="cursor:pointer;color:var(--text)">${un.length} equity holding${un.length === 1 ? '' : 's'} could not be placed on the map</summary>
    <table style="margin-top:8px"><thead><tr><th>Ticker</th><th class="num">Weight</th><th>Why</th></tr></thead><tbody>
    ${un.map(u => `<tr><td><b>${esc(u.ticker || '—')}</b></td><td class="num">${(+u.weight * 100).toFixed(1)}%</td>
      <td style="max-width:460px;color:var(--muted)">${esc(u.reason)}</td></tr>`).join('')}
    </tbody></table></details>`;

  const covLine = !cov ? '' : `Equity is ${p1(cov.model_equity_weight)} of this model${cov.basis === 'target' ? ' on target weights' : ''}. `
    + `The map and the table describe ${have(cov.model_resolved) ? p1(cov.model_resolved) : 'none'} of that equity and `
    + `${have(cov.benchmark_resolved) ? p1(cov.benchmark_resolved) : 'none'} of the benchmark's.`;

  return `<div class="card" style="margin-top:18px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Portfolio breakdown</h2>
      <span style="font-size:12px;color:var(--muted)">
        <span style="display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:2px;margin-right:5px"></span>${esc(modelLabel)}
        <span style="display:inline-block;width:9px;height:9px;background:var(--bench);border-radius:2px;margin:0 5px 0 12px"></span>${esc(benchLabel)}</span></div>
    <div style="margin-top:10px">${tabs}</div>
    ${!anyModel ? `<div class="empty" style="margin-top:12px">None of this model's equity could be placed geographically${un.length ? ` — ${esc(un.map(u => u.ticker).join(', '))} ${un.length === 1 ? 'is' : 'are'} the holding${un.length === 1 ? '' : 's'} involved` : ''}. The benchmark's own geography is shown below for reference.</div>`
      : `<div style="margin-top:14px">${worldMap(byRegionModel, labelOf)}</div>`}
    <div style="overflow-x:auto;margin-top:6px"><table style="min-width:520px"><thead><tr>
      <th>Region</th><th class="num">Model</th><th class="num">${esc(benchLabel)}</th><th class="num">Over / under</th>
    </tr></thead><tbody>${regionRows}</tbody></table></div>
    <h3 style="margin:20px 0 0;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Ten largest countries</h3>
    <div style="overflow-x:auto;margin-top:8px"><table style="min-width:620px"><thead><tr>
      <th>Country</th><th>Share of resolved equity</th><th class="num">Over / under</th>
    </tr></thead><tbody>${countryRows}</tbody></table></div>
    ${unBlock}
    <p class="note"><b>These are estimated from returns, not read from holdings.</b> No source connected to this desk publishes what these funds own, so geography is measured in two stages. Each fund is first fitted to a small set of well-separated regional indices — US large, mid and small cap, Canada, developed ex-North-America and emerging — with weights that cannot go negative and must sum to one. Those regional indices are then decomposed into their own countries, once, which is the step that makes the country table trustworthy: a regional index really is a basket of countries, so the regression recovers a composition that exists rather than inventing one. EFA resolves at an R² of 0.996 into Japan 23.8%, the UK 16.2%, France 10.8% and Switzerland 10.4%, against published MSCI EAFE weights of roughly 22, 15, 11 and 10.
    Fitting a fund <i>directly</i> against twenty single-country indices was rejected: country indices correlate 0.7 to 0.9, so the solver can move weight between France and Germany almost freely without changing the fit, and the answer would be close to arbitrary.
    <b>Fixed income, cash, commodity and gold holdings are excluded entirely</b> — they have no country mix to estimate, and listing them as unplaced would read as a gap in the analysis rather than as the model simply holding things that are not equity. ${covLine}
    A fund whose fit explains less than 70% of its own daily movement is left out by name rather than spread across the others${un.length ? ' — the list above' : ''}, and the percentages renormalise over what remains. Regions are geographic: "emerging markets" is not a place and a map cannot shade it, so Korea and Japan are both Asia-Pacific here.${cov?.window_start ? ` Fitted on daily returns from ${esc(cov.window_start)} to ${esc(cov.window_end)}.` : ''}</p></div>`;
}


function modelDashboard(m) {
  repModelId = m.id;

  const n = v => v === null || v === undefined ? null : +v;
  const pc = (v, d = 2) => v === null ? null : (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
  const col = v => v === null ? 'var(--muted)' : v >= 0 ? 'var(--pos)' : 'var(--neg)';

  const dur = (D.modelDuration || []).find(r => r.strategy_id === m.id) || null;
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
    ['FI duration', dur && n(dur.fi_duration) !== null ? n(dur.fi_duration).toFixed(2) + ' yrs' : null, 'fi_duration'],
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
    ${dur ? `<p class="note" style="margin-bottom:6px"><b>Fixed income is ${(n(dur.fi_weight) * 100).toFixed(1)}% of this model</b>, carrying ${dur.fi_duration === null ? 'no measurable' : `${n(dur.fi_duration).toFixed(2)} years of`} duration${dur.total_duration === null ? '' : `, which puts the whole book at ${n(dur.total_duration).toFixed(2)} years`}. Duration is regressed from each fund's own weekly returns against the 10-year Treasury yield, so it is what the holding <i>did</i> when rates moved rather than what a factsheet states — a credit fund usually shows far less than its stated figure, and that is the true number for risk.${dur.n_unmeasured ? ` <b>${dur.n_unmeasured} of ${dur.n_fi_holdings} fixed income holdings have too little history to measure</b>, so the sleeve figure covers ${(n(dur.coverage) * 100).toFixed(0)}% of its weight.` : ''}${dur.n_insignificant ? ` ${dur.n_insignificant} of ${dur.n_priced} measured holdings have a rate sensitivity inside two standard errors — their point estimates are still used, since rounding them to zero would push the average down one way only.` : ''}</p>` : ''}
    <p class="note">Hover any statistic to see how it is calculated. ${stat && stat.method_note ? `<b>These are reconstructed, not the firm's reported figures.</b> ${esc(stat.method_note)}` : 'Nothing on this row is estimated or filled in by hand.'}</p></div>`;

  // ---- the two allocation panels ----
  const ovBySec = Object.fromEntries((D.factorOverrides || []).map(o => [o.security_id, o]));
  const staged = { ...ovBySec };
  for (const [sid, split] of Object.entries(repPending)) {
    if (!split) { staged[sid] = undefined; continue; }
    const cm = mixFromKey(split);
    staged[sid] = cm ? { security_id: sid, split: null, mix: cm } : { security_id: sid, split };
  }
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
    // A classification carries no residual, so nothing ever disagreed with a wrong one. The
    // volatility check is the disagreement: if a fund is really 60/40, a portfolio holding 60%
    // SPY and 40% AGG over the same weeks should have about the same standard deviation. Within
    // 10% earns the tick; outside it, the label is describing a different instrument and the row
    // says so and offers a blend that is not.
    const fitBySec = Object.fromEntries((D.blendFit || []).map(f => [f.security_id, f]));
    const rowFor = h => {
      const st = staged[h.security_id];
      const stagedMix = st ? mixOf(st) : null;
      const cur = st ? (st.mix && Object.keys(st.mix).length ? mixKey(st.mix) : st.split || '') : '';
      const f = fitBySec[h.security_id] || null;
      const vol = v => v === null || v === undefined ? '—' : (+v * 100).toFixed(1) + '%';
      // The verdict follows what is STAGED, not what was last computed: a dropdown change the
      // owner has not saved yet must not keep showing the old mix's tick.
      let volBlend = null, ratio = null, ok = null;
      if (f && stagedMix) {
        const sameAsComputed = f.chosen_mix && mixKey(f.chosen_mix) === mixKey(stagedMix);
        const sameAsSuggested = f.suggested_mix && mixKey(f.suggested_mix) === mixKey(stagedMix);
        if (sameAsComputed) { volBlend = f.vol_chosen; ratio = f.ratio_chosen; }
        else if (sameAsSuggested) { volBlend = f.vol_suggested; ratio = f.ratio_suggested; }
        if (ratio !== null && ratio !== undefined) ok = Math.abs(+ratio - 1) <= +(f.tolerance ?? 0.10);
      }
      const tol = Math.round((f ? +(f.tolerance ?? 0.10) : 0.10) * 100);
      const mark = !f ? `<span class="vmark" style="color:var(--muted)" title="No volatility measured for this holding yet — it needs at least a year of weekly prices.">–</span>`
        : ok === true ? `<span class="vmark" style="color:var(--pos)" title="The chosen blend's standard deviation is ${vol(volBlend)} against the fund's ${vol(f.vol_asset)} — within ${tol}%.">&#10003;</span>`
        : ok === false ? `<span class="vmark" style="color:var(--neg)" title="The chosen blend's standard deviation is ${vol(volBlend)} against the fund's ${vol(f.vol_asset)}, a ratio of ${(+ratio).toFixed(2)}. Outside ${tol}%, so the label is describing a different instrument.">&#10007;</span>`
        : `<span class="vmark" style="color:var(--muted)" title="Pick a classification and the blend's volatility is compared with the fund's.">–</span>`;
      // Offer the suggestion as a real option. A blend the owner cannot select is not a suggestion,
      // and the eight named splits cannot match every fund's volatility.
      const sug = f && f.suggested_mix ? { key: mixKey(f.suggested_mix), label: mixLabel(f.suggested_mix) } : null;
      const curIsCustom = cur.startsWith('custom:');
      const customOpt = curIsCustom && (!sug || sug.key !== cur) ? { key: cur, label: mixLabel(mixFromKey(cur)) } : null;
      return `<div class="row">
        <div><span class="tick">${esc(h.ticker)}</span><span class="wt">${pct(+h.weight)}</span>
          ${f ? `<span class="wt" title="The fund's own annualised standard deviation over ${f.n_weeks} weekly returns from ${esc(f.window_from)} — its longest available history.">vol ${vol(f.vol_asset)}</span>` : ''}
          ${mark}</div>
        <select data-splitfor="${esc(h.security_id || '')}" ${h.security_id ? '' : 'disabled title="No matching security, so a split cannot be stored"'}>
          <option value="" ${!cur ? 'selected' : ''}>Leave unclassified</option>
          ${SPLIT_OPTIONS.map(o => `<option value="${o.key}" ${cur === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
          ${sug ? `<option value="${esc(sug.key)}" ${cur === sug.key ? 'selected' : ''}>Suggested — ${esc(sug.label)}</option>` : ''}
          ${customOpt ? `<option value="${esc(customOpt.key)}" selected>Custom — ${esc(customOpt.label)}</option>` : ''}
        </select></div>
        ${f && ok === false && f.suggested_mix ? `<div class="vsug">Blend is ${vol(volBlend)} against the fund's ${vol(f.vol_asset)}. <b>${esc(mixLabel(f.suggested_mix))}</b> gives ${vol(f.vol_suggested)}${f.suggested_corr !== null && f.suggested_corr !== undefined && +f.suggested_corr < 0.3 ? ` — though it correlates only ${(+f.suggested_corr).toFixed(2)} with the fund, so this matches the volatility and not the behaviour` : ''}.</div>` : ''}
        ${f && ok === false && !f.suggested_mix && !f.achievable ? `<div class="vsug">No blend of equities, fixed income, cash, commodities and gold reaches ${vol(f.vol_asset)} within ${tol}%. This fund sits outside the range those five can express.</div>` : ''}`;
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
        ${(unres.length || res.length) ? `<p class="note" style="margin:8px 0 0;font-size:11.5px">A classification is stored against the security, not this model, so it applies everywhere the name is held${(() => {
          const ids = [...unres, ...res].map(h => h.security_id).filter(Boolean);
          const others = (D.models || []).filter(x => x.id !== m.id && ((D.currentHoldings || []).some(c => c.strategy_id === x.id && ids.includes(c.security_id)) || (x.holdings || []).some(c => ids.includes(c.security_id))));
          return others.length ? ` — these names are also held by ${others.length} other model${others.length === 1 ? '' : 's'}` : '';
        })()}. The tick compares the chosen blend's standard deviation with the fund's own over the fund's longest history; within ${Math.round(((D.blendFit || [])[0]?.tolerance ?? 0.10) * 100)}% passes.</p>` : ''}
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
        // Two different rules, and the difference is deliberate. A MONTH is coloured against the
        // benchmark, which is the owner's rule and the question the grid was built to answer: did
        // this month beat the index. The ANNUAL cell is coloured by its own sign — did the year
        // make money — because that is the question a year asks, and a red figure beside a
        // positive annual return reads as a loss however the note explains it.
        const ex = r.excess_return === null || r.excess_return === undefined ? null : +r.excess_return;
        const basis = isAnnual ? v : ex;
        const bg = basis === null ? 'transparent' : basis >= 0 ? 'var(--winbg)' : 'var(--losebg)';
        const tips = [
          r.is_partial ? 'Part of a month only — the series begins or ends inside it.' : '',
          r.in_gap ? 'Inside the stretch with no holdings snapshot: the weights were carried forward unchanged through this month.' : '',
          isAnnual
            ? `${v >= 0 ? 'Made' : 'Lost'} ${Math.abs(v * 100).toFixed(2)}% over the year${ex === null ? '' : `, ${ex >= 0 ? 'ahead of' : 'behind'} the benchmark by ${Math.abs(ex * 100).toFixed(2)}%`}.`
            : ex === null ? 'No benchmark figure for this month, so there is no verdict to colour.' : `${ex >= 0 ? 'Ahead of' : 'Behind'} the benchmark by ${Math.abs(ex * 100).toFixed(2)}%.`,
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
        <p class="note"><b>The annual column is coloured by its own sign</b> — green where the year made money, red where it lost it — because that is the question a year asks. The months beside it keep the benchmark rule: <b>green is a month the model beat ${esc(benchLabel)}; red is a month it did not</b> — not whether the month made money, which is a different question and the one a reader usually assumes. The colour means the same thing on all three tabs, so the Benchmark tab still shows which months the model took. Annual is that year's own months compounded, and a year missing any month is withheld rather than compounded over the hole.${anyPartial ? ' Italic figures are part-months, where the series begins or ends inside them.' : ''}${anyGap ? ` Months marked <sup style="color:var(--warn)">·</sup> fell inside the stretch with no holdings snapshot — the prices are real, but the weights were carried forward unchanged, so a run of green there is a book nobody rebalanced rather than a decision that worked.` : ''} Hover any cell for its margin over the benchmark.</p>`;
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
    if (lens === 'geography') return geographyCard(m);
    const rows = all.filter(r => r.lens === lens).sort((a, b) => a.sort_order - b.sort_order);
    const cov = (D.styleCoverage || []).find(r => r.strategy_id === m.id && r.lens === lens);
    const benchLabel = m.benchmarkLabel || 'Benchmark';
    const modelLabel = m.name.replace(/\s*\([^)]*\)/g, '');
    const alloc = rows.filter(r => r.kind === 'allocation');
    const comps = rows.filter(r => r.kind === 'composite');

    const tabs = `<div class="tabs" style="margin:0">
      ${[['sector', 'Sector'], ['geography', 'Geography']].map(([k, lbl]) =>
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
        <th>Sector</th><th>Share of resolved equity</th><th>Over / under weight</th>
      </tr></thead><tbody>${allocRows}${compRows}</tbody></table></div>
      ${unBlock}
      <p class="note"><b>These are estimated from returns, not read from holdings.</b> No data source connected to this desk publishes what the funds in these models own, so each fund's daily returns are fitted to a basis of real index ETFs — the eleven sector SPDRs for the sector view, iShares' value, momentum, quality and min-vol funds plus the S&P 500 for factors — with weights that cannot go negative and must sum to one. That measures how a fund <i>behaves</i>. A fund can be placed in a sector it owns no shares of, if it moves like one. ${covLine}
      Non-US equity keeps its own row instead of being pushed into US sectors. Fitting the international and emerging-market indices to the sector SPDRs was tried and rejected — it explained two thirds and a half of their movement respectively, and returned an emerging-market mix with no financials at all in an index that is roughly a quarter financials.
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
   ${dqCard}${statsCard}${allocGrid}${contribCard}${ddCard}${trailingCard}${fingerprintCard('model', m.id, m.name.replace(/\s*\([^)]*\)/g, ''), m.benchmarkLabel || 'Benchmark', 'Factor fingerprint')}${breakdownCard}
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


// The case against a name, opened from the I-beam in Hunting Pitches. On the hash like the Stan
// drawers, so Escape, the scrim and the back button all close it the same way.
function steelManDrawer(ticker) {
  const a = (D.assessments || []).find(x => x.kind === 'steel_man' && x.ticker === ticker);
  const sec = (D.markets || []).find(x => x.ticker === ticker);
  const src = a && Array.isArray(a.sources) ? a.sources : [];
  return `<button class="close" data-go="#annie">Close</button>
   <span class="eyebrow">The case against</span><h1>${esc(ticker)}${sec && sec.name ? ` — ${esc(sec.name)}` : ''}</h1>
   ${!a ? '<div class="card"><div class="empty">Annie has not written a steel man for this name yet.</div></div>'
   : `<div class="card">
      <h2>${esc(a.headline)}</h2>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Written ${esc(a.as_of)}${a.confidence ? ` · ${esc(a.confidence)} confidence` : ''}</div>
      ${md(a.body_md)}
      <p class="note">${src.length
        ? 'Read: ' + src.map(x => x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || x.url)}</a>` : esc(x.title || '')).join(' · ')
        : '<b>No sources recorded.</b> Treat this as an opinion rather than a finding.'}</p></div>
      <p class="note">A steel man is the strongest honest case against the position, not the weak version that is easy to dismiss. It is written to be <i>believed</i> for the length of a read — if it is not uncomfortable, it is not doing its job.</p>`}`;
}

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
  $('#drawer').innerHTML = `<button class="close" data-go="#sisyphus">Close</button>
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
  $('#drawer').innerHTML = `<button class="close" data-go="#sisyphus">Close</button>
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
// News-failure window tabs on Sven's page.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-newswin]');
  if (!t) return;
  newsWindow = +t.dataset.newswin;
  $('#app').innerHTML = sven();
});
// Scorecard model tabs on Annie's page.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-anniemodel]');
  if (!t) return;
  annieModel = t.dataset.anniemodel;
  $('#app').innerHTML = annie();
});
// Standard vs HNW rates on Annie's tax card. Only the rates change — the stored figures are
// pre-tax, so the toggle is a re-read of one dataset rather than a second fetch.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-taxbracket]');
  if (!t || !TAX_RATES[t.dataset.taxbracket]) return;
  taxBracket = t.dataset.taxbracket;
  $('#app').innerHTML = annie();
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
  // Only the two lenses that exist. The equity-factor lens was removed in favour of geography,
  // and compute-style-exposure.mjs still writes its rows, so without this guard a stale
  // data-breakdown="factor" anywhere would render a view that is no longer reachable by design.
  if (t.dataset.breakdown !== 'sector' && t.dataset.breakdown !== 'geography') return;
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
const closeDrawerHash = () => { location.hash = (location.hash || '#sisyphus').split('/')[0]; };
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
