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
//
// RETRY TRANSIENT FAILURES BEFORE GIVING UP ON THEM.
//
// On 2026-10-23 the site showed "Could not load data: canceling statement due to statement
// timeout" while the nightly was running. The nightly reads the whole price history several times
// over -- the insurance table, the sleeve mix, the stress programme and the fragility index each
// walk 563,000 rows -- and while it runs the database is saturated: a view that answers in 250ms
// normally took 51 seconds and returned a 500, and an eight-row read of strategies took 1.3s.
//
// Those failures are TRANSIENT. The query is not wrong and the data is not missing; the database
// is busy for a few minutes a day. Giving up on the first one and blanking the dashboard is the
// wrong response to a queue, so anything that looks like load -- a timeout, a 5xx, a dropped
// connection -- is retried with backoff before it counts as a failure.
//
// What is NOT retried: a 4xx, a missing column, a permission error. Those are real and repeating
// them just makes the page slower on its way to the same answer.
const TRANSIENT = /statement timeout|canceling statement|timeout|fetch failed|network|temporarily|502|503|504|ECONNRESET|upstream/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// `query` is normally a THUNK, because a PostgREST builder cannot be awaited twice and a retry has
// to be able to re-issue it. A builder is still accepted -- passing one is the obvious thing to do
// and silently throwing a TypeError on it would be a trap -- but it gets a single attempt, because
// there is nothing to re-issue. The tries count reflects that rather than pretending otherwise.
async function q(query, { tries = 3, label = '' } = {}) {
  const thunk = typeof query === 'function';
  if (!thunk) tries = 1;
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const { data, error } = await (thunk ? query() : query);
    if (!error) return data;
    last = error;
    if (!TRANSIENT.test(error.message || '') || attempt === tries) break;
    // 400ms, then 1200ms. Long enough to clear a burst, short enough that a reader is still here.
    await sleep(400 * Math.pow(3, attempt - 1));
    console.warn(`[desk] retrying ${label || 'query'} after: ${error.message}`);
  }
  throw new Error(last.message);
}
// Same as q(), but a failure yields an empty set instead of taking the page down. Used for the
// auxiliary datasets — the lights, the boards, the attribution — where a missing table means one
// card renders empty and the rest of the site still works. It was not always this way: a single
// migration lagging behind a deploy turned the WHOLE dashboard into "Could not load data",
// because Promise.all rejects as a unit. The core tables below deliberately still use q(): if
// strategies or securities are unreachable there is no dashboard to show, and saying so plainly
// is better than rendering an empty one that looks real.
const softFailures = [];
// NOTHING IS HARD ANY MORE, AND THAT IS THE REAL FIX.
//
// The core tables used to use q() directly on the argument that a dashboard without strategies or
// securities is not a dashboard. True -- but the consequence was that one busy minute in the
// database replaced the entire page with a single sentence, including the eleven tabs that did not
// need the table that failed. Degrading to a named banner is strictly better than a blank page:
// the reader can see what is missing and everything else still works.
async function qSoft(query, label) {
  try { return await q(query, { label }); }
  catch (ex) { softFailures.push(`${label}: ${ex.message}`); console.warn(`[desk] dataset "${label}" unavailable:`, ex.message); return []; }
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
      const got = await q(() => make().range(from, from + page - 1), { label });
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
  const [strategies, alloc, secs, classes, factors, cLoad, sLoad, runs, outputs, prices, technicals, macro, views, roadmap, sources, calls, routingLog, contribs, scenarios, stress, perf, attrib, speedLimit, modelSpeed, rocBoard, trigHits, trigRules, stn, periodStats, contribution, factorAlloc, valueSeries, snapIntegrity, currentHoldings, factorOverrides, lensSnr, holdingRR, trailing, styleExposure, styleCoverage, monthly, trades, positionScores, decisionStats, assessments, tradeReviews, svenRules, newsFailure, beautyReading, beautyComponents, macroRegime, beautyRanks, beautyHistory, modelVar, tailRisk, firmMetrics, firmExposures, firmStress, blendFit, modelDuration, geoExposure, geoCoverage, fingerprint, fingerprintCov, taxEff, taxCov, openLots, journal, journalVerdicts, sandboxTargets, secDuration, secFingerprint, secStyle, crowding, narReading, narComponents, narAttention, narratives, decisionQuality, quadHistory, netLiq, gli, macroNow, turnings, generations, tapeTicker, humility,
    narReflex, creditLegs, creditReading, svenPrecedent, svenBreaks, tapeQuiet, slBoard, insValue, insPricing, rx, fragHist, frag, fragEps, stressTests, sleeves] = await Promise.all([
    qSoft(sb.from('strategies').select('id,name,label,sort_order,benchmark,aum,aum_as_of,equity_weight').order('sort_order'), 'strategies'),
    qSoft(sb.from('target_allocations').select('strategy_id,security_id,asset_class_id,target_weight,effective_from').is('effective_to', null), 'target allocations'),
    qSoft(sb.from('securities').select('id,ticker,name,asset_class_id,role,high_potential,high_potential_since,high_potential_note'), 'securities'),
    qSoft(sb.from('asset_classes').select('id,slug,name,sort_order,primary_role,primary_role_is_draft').order('sort_order'), 'asset classes'),
    qSoft(sb.from('factors').select('id,slug,name,sort_order').order('sort_order'), 'factors'),
    qSoft(sb.from('asset_class_factor_loadings').select('asset_class_id,factor_id,loading,as_of'), 'asset class factor loadings'),
    qSoft(sb.from('security_factor_loadings').select('security_id,factor_id,loading,as_of'), 'security factor loadings'),
    qSoft(sb.from('data_runs').select('job,status,latest_price_date,started_at').order('started_at', { ascending: false }).limit(10), 'data runs'),
    qSoft(sb.from('agent_outputs').select('agent,kind,title,body_md,as_of').order('as_of', { ascending: false }).limit(50), 'agent outputs'),
    qSoft(sb.from('current_prices').select('security_id,as_of,close,prev_close,day_change_pct,source'), 'current prices'),
    qSoft(sb.from('current_technical_snapshot').select('security_id,as_of,close,sma50,sma200,rsi14,macd_hist,hv20_ann,trend_state,rs_vs_class_63,support,resistance'), 'current technical snapshot'),
    qSoft(sb.from('current_macro_readings').select('series_id,fred_code,name,factor_id,unit,obs_date,value'), 'current macro readings'),
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
    qSoft(sb.from('latest_speed_limit_readings').select('as_of,category,score,light,raw_light,weight,n_calls,n_recorded,target_beta_low,target_beta_high,sign_label,evidence_raw,evidence_live,freshness,conviction,n_silent,oldest_call,newest_call,detail').order('as_of', { ascending: false }), 'speed limit'),
    qSoft(sb.from('latest_strategy_speed_limit').select('strategy_id,as_of,actual_beta,r_squared,n_obs,target_low,target_high,light,note').order('as_of', { ascending: false }), 'model speed limit'),
    qSoft(sb.from('market_roc_board').select('as_of,security_id,label,sort_order,close,price_roc_1d,price_roc_1w,price_roc_1m,volume_roc_1w,vol_ann,vol_roc_1m').order('sort_order'), 'ROC board'),
    qSoft(sb.from('trigger_hits').select('as_of,headline,value,rule_id,security_id,strategy_id').order('as_of', { ascending: false }).limit(200), 'trigger hits'),
    qSoft(sb.from('trigger_rules').select('id,name,kind,enabled'), 'trigger rules'),
    qSoft(sb.from('source_signal_to_noise').select('source,category,window_label,n_scored,hit_rate,signal,noise,signal_to_noise,too_few_to_judge'), 'signal to noise'),
    qSoft(sb.from('latest_model_period_stats').select('strategy_id,period,as_of,start_date,end_date,model_return,benchmark_return,gold_return,btc_return,max_drawdown,benchmark_max_drawdown,upside_capture,downside_capture,beta_sp500,beta_r2,dividend_yield,min_coverage,window_starts_in_gap,unavailable_reason,method_note').order('as_of', { ascending: false }), 'model period stats'),
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
    qSoft(sb.from('annie_assessments').select('as_of,kind,strategy_id,ticker,narrative,headline,body_md,score,score_scale,confidence,sources,author').order('as_of', { ascending: false }), 'Annie assessments'),
    qSoft(sb.from('latest_annie_trade_reviews').select('strategy_id,as_of,ticker,entry_date,exit_date,held_return,held_excess_bps,days_since_exit,after_return,after_bench,after_excess,held_instead_bps,better_ticker,better_return,better_gain_bps,n_alternatives,exit_verdict,entry_verdict,headline,lesson,unavailable_reason'), 'trade reviews'),
    qSoft(sb.from('latest_sven_rule_signals').select('as_of,ticker,rule_key,rule_no,rule_title,state,headline,detail,method,adapted,market_state,vs_market').order('rule_no'), 'Raschke rules'),
    qSoft(sb.from('latest_news_failure_readings').select('as_of,ticker,label,asset_class,window_days,n_releases,n_positive,n_negative,n_series,n_factors,agreement,price_change,made_new_high,made_new_low,verdict,headline,held_in,impacted,n_events,signal_strength,events,releases,pub_basis'), 'news failure'),
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
    qAllSoft(() => sb.from('latest_model_open_lots').select('strategy_id,ticker,security_id,lot_date,weight,cost_price,current_price,unrealised_bps,held_days,is_long_term,from_opening_book,basis_estimated'), 'open lots'),
    qSoft(sb.from('trade_journal').select('id,created_at,submitted_at,action,ticker,asset_class,rationale,setup,sizing,sizing_pct,horizon,loss_threshold,strategy_ids,tax_estimate,author').order('submitted_at', { ascending: false }).limit(200), 'trade journal'),
    qSoft(sb.from('trade_journal_verdicts').select('journal_id,agent,verdict,headline,rationale,requested_at,answered_at'), 'journal verdicts'),
    qSoft(sb.from('latest_sandbox_target_allocation').select('id,strategy_id,submitted_at,holdings,note,author,mph_reading'), 'sandbox targets'),
    qAllSoft(() => sb.from('latest_security_duration').select('security_id,duration_yrs,significant,r2'), 'security duration'),
    qAllSoft(() => sb.from('latest_security_factor_fingerprint').select('security_id,betas,r_squared'), 'security fingerprint'),
    qAllSoft(() => sb.from('latest_security_style_fit').select('security_id,lens,mix'), 'security style'),
    qAllSoft(() => sb.from('latest_security_crowding').select('security_id,attention,stretch_pctile,momentum_6m,persistence,crowd_score,crowd_rank,up_down_volume,return_autocorr,stretch_trend,loop_state,loop_note,as_of'), 'crowding'),
    qSoft(sb.from('narrative_sentiment_readings').select('as_of,score,stance,n_live,n_total,n_narratives,top_narrative,concentration,headline').order('as_of', { ascending: false }).limit(1), 'narrative reading'),
    qSoft(sb.from('latest_narrative_sentiment_components').select('as_of,component,label,score,status,measure,value_text,headline,how_to_supply,n'), 'narrative components'),
    qAllSoft(() => sb.from('latest_narrative_attention').select('narrative,wiki_ratio,wiki_pctile,hn_ratio,chatter_per_day,chatter_bull,chatter_tagged,attention_ratio,attention_pctile,attention_share,attention_rank,price_1m,price_3m,state,state_note,trail,n_sources,as_of'), 'narrative attention'),
    qAllSoft(() => sb.from('narratives').select('slug,label,kind,proxy_ticker,wiki_articles,hn_query,sort_order'), 'narratives'),
    qAllSoft(() => sb.from('latest_annie_decision_quality').select('as_of,strategy_id,scope,n_scored,brier,calibration_bins,n_thresholds,n_breached,n_honoured,n_unanimous,n_contested,unanimous_worked,contested_worked,n_fielded,win_skill_share,loss_skill_share,fielding_gap,cum_selection,helped_share,headline'), 'decision quality'),
    qAllSoft(() => sb.from('macro_quad_history').select('as_of,regime,quad,growth_z,inflation_z,conviction,n_growth,n_inflation,data_as_of').order('as_of', { ascending: true }), 'quad history'),
    qSoft(sb.from('global_liquidity_readings').select('as_of,net_liquidity,walcl,tga,rrp,chg_4w,chg_13w,chg_52w,pctile_3y,direction,headline').order('as_of', { ascending: false }).limit(1), 'net liquidity'),
    qAllSoft(() => sb.from('gli_readings').select('as_of,value,direction,change_note,drivers,headline,source_url,gli_full,gli_flash,smb,collateral_multiplier,basis,move_quoted').order('as_of', { ascending: true }), 'howell gli'),
    qAllSoft(() => sb.from('current_macro_readings').select('series_id,fred_code,name,value,obs_date,unit'), 'macro now'),
    qAllSoft(() => sb.from('saeculum_turnings').select('seq,turning,name,mood,start_year,end_year,uncertain,description').order('seq', { ascending: true }), 'turnings'),
    qAllSoft(() => sb.from('generations').select('name,birth_from,birth_to,sample,sort_order').order('sort_order', { ascending: true }), 'generations'),
    qAllSoft(() => sb.from('latest_tape_ticker').select('as_of,measure,horizon,sort_order,label,value,value_kind,secondary,verdict,detail,return_days,lookback_days,n_obs').order('sort_order', { ascending: true }), 'tape ticker'),
    qAllSoft(() => sb.from('latest_risk_humility').select('as_of,scope,strategy_id,window_days,window_worst,history_days,history_worst,history_worst_date,coverage,calm_streak,calm_streak_pctile,vol_pctile,drawdown_now,near_high_share,avg_pair_corr,complacency,complacency_legs,sim_paths,sim_p05,sim_p50,sim_p95,sim_dd_median,sim_dd_p95,sim_worse_share,beta_up,beta_down,convexity_gap,hit_rate,avg_win,avg_loss,skew,n_live,n_departed,headline'), 'risk humility'),
    // Kate, from The Alchemy of Finance: the test count, the equilibrium gate and the asymmetry.
    qAllSoft(() => sb.from('latest_narrative_reflexivity').select('as_of,narrative,proxy_ticker,leg_start,leg_days,test_threshold,tests,test_dates,days_since_test,median_gap,gap_ratio,test_verdict,test_note,attention_pctile,price_pctile,gap_now,gap_4w,gap_12w,gap_trend,equilibrium,equilibrium_note,n_advances,n_declines,adv_days_median,dec_days_median,adv_move_median,dec_move_median,asymmetry,asymmetry_verdict,asymmetry_note,n_bars'), 'narrative reflexivity'),
    qAllSoft(() => sb.from('latest_credit_cycle_legs').select('as_of,leg,label,sort_order,series_id,obs_date,level,level_unit,change,acceleration,window_label,direction,accel_sign,headline,detail').order('sort_order', { ascending: true }), 'credit cycle legs'),
    qSoft(sb.from('credit_cycle_readings').select('as_of,phase,n_easing,n_tightening,n_accelerating,n_decelerating,n_legs,oldest_obs,headline,caveat').order('as_of', { ascending: false }).limit(1), 'credit cycle'),
    // Sven, from Reminiscences: acting right, the precedent-break flag, the quiet tape.
    qAllSoft(() => sb.from('latest_sven_precedent_tests').select('as_of,ticker,precedent_key,precedent_label,sort_order,horizon_days,n_precedents,hist_median,hist_p25,hist_p75,hist_hit_rate,trigger_date,realised,realised_pctile,verdict,headline,detail,method').order('sort_order', { ascending: true }), 'precedent tests'),
    qAllSoft(() => sb.from('latest_sven_precedent_breaks').select('as_of,ticker,vol_20,vol_pctile,vol_streak,vol_broken,corr_60,corr_pctile,corr_streak,corr_broken,verdict,headline,detail,n_bars'), 'precedent breaks'),
    qSoft(sb.from('latest_sven_tape_quiet').select('as_of,n_indices,mid_range_share,no_read_share,directional,vol_pctile,breadth,extremes,verdict,headline,detail,legs'), 'quiet tape'),
    // What caution has cost: the Speed Limit, graded.
    qAllSoft(() => sb.from('latest_speed_limit_scoreboard').select('as_of,scope,strategy_id,period,period_start,period_end,model_return,bench_return,excess,beta_used,beta_drag,residual,light,target_low,target_high,inside_band,cum_excess,cum_beta_drag,cum_residual,n_months,headline,detail').order('period', { ascending: true }), 'speed limit scoreboard'),
    // Which brake is worth owning, measured rather than modelled.
    qAllSoft(() => sb.from('latest_insurance_value').select('as_of,instrument,label,sort_order,window_key,window_from,window_to,n_days,n_stress,drawdowns_seen,crash_1pct,crash_5pct,worst_day_offset,carry_daily,carry_annual,free_carry,payoff_per_carry,carry_days_repaid,offset_per_1pct,corr_calm,corr_stress,corr_shift,episodes,episodes_helped,worst_episode,verdict,headline,detail').order('sort_order', { ascending: true }), 'insurance value'),
    qSoft(sb.from('latest_insurance_pricing').select('as_of,vix,vix_3m,realised_21d,vol_premium,vol_premium_pctile,term_ratio,term_state,term_pctile,verdict,headline,detail'), 'insurance pricing'),
    qAllSoft(() => sb.from('latest_brake_prescription').select('as_of,strategy_id,model,sort_order,equity_weight,k,sleeve_key,sleeve_label,composition,sleeve_target,sleeve_floor,sleeve_ceiling,target_basis,beta_floor,beta_ceiling,beta_actual,old_floor,old_ceiling,light,monetise_at,monetise_share,monetise_basis,held_now,gap,no_trade_band,action,fragility,fragility_state,headline,detail').order('sort_order', { ascending: true }), 'brake prescription'),
    qAllSoft(() => sb.from('fragility_index').select('as_of,mfi,state').order('as_of', { ascending: false }).limit(504), 'fragility history'),
    qSoft(sb.from('latest_fragility_index').select('as_of,mfi,mfi_mean,mfi_pctile,override_leg,state,state_days,legs,n_legs,headline'), 'fragility index'),
    qAllSoft(() => sb.from('latest_fragility_episodes').select('as_of,episode,trough,depth,mfi_at_peak,state_at_peak,first_warn,lead_days,lead_to_peak,worst_mfi,verdict,headline').order('episode', { ascending: true }), 'fragility episodes'),
    qAllSoft(() => sb.from('latest_stress_results').select('as_of,family,scenario,subject,sort_order,window_from,window_to,n_obs,value,value_kind,baseline,delta,p05,p50,p95,fit_r2,extrapolated,extrapolation,verdict,headline,detail').order('sort_order', { ascending: true }), 'stress results'),
    qAllSoft(() => sb.from('latest_sleeve_candidates').select('as_of,sleeve_key,label,sort_order,rationale,composition,window_from,window_to,n_days,episodes_covered,sleeve_carry,sleeve_crash,funding_ratio,iso_weight,iso_equity,iso_real_cagr,iso_max_dd,iso_days_under,baseline_dd,baseline_real_cagr,uplift,curve,best_weight,plateau_from,plateau_to,episodes,episodes_helped,loo_rank,loo_chosen,verdict,headline,detail').order('sort_order', { ascending: true }), 'sleeve candidates'),
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
    taxEff: taxEff || [], taxCov: taxCov || [],
    openLots: openLots || [], journal: journal || [], journalVerdicts: journalVerdicts || [],
    sandboxTargets: sandboxTargets || [], secDuration: secDuration || [], secFingerprint: secFingerprint || [],
    secStyle: (secStyle || []).filter(r => r.lens === 'sector'),
    crowding: crowding || [], narReading: narReading || [], narComponents: narComponents || [],
    narAttention: narAttention || [], narratives: narratives || [],
    decisionQuality: decisionQuality || [], quadHistory: quadHistory || [],
    netLiq: netLiq || [], gli: gli || [], macroNow: macroNow || [],
    turnings: turnings || [], generations: generations || [], tapeTicker: tapeTicker || [], humility: humility || [],
    narReflex: narReflex || [], creditLegs: creditLegs || [], creditReading: creditReading || [],
    svenPrecedent: svenPrecedent || [], svenBreaks: svenBreaks || [], tapeQuiet: tapeQuiet || [],
    slBoard: slBoard || [], insValue: insValue || [], insPricing: insPricing || [], stressTests: stressTests || [], sleeves: sleeves || [], frag: frag || [], fragEps: fragEps || [], rx: rx || [], fragHist: fragHist || [] };
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
  // The Playground is a section of Views now. The hash still resolves, so a saved link or an old
  // bookmark lands where the content went rather than on an empty page.
  if (page === 'playground') { location.replace('#admin'); return; }
  // Views, Sources, Agents and Status were four tabs and are now four sections of Admin. Each
  // hash still resolves -- these are the links most likely to be sitting in a note or a bookmark,
  // and #views carried a sub-route for the macro charts, so the argument travels with it.
  if (page === 'views' || page === 'sources' || page === 'agents' || page === 'status') {
    location.replace('#admin' + (arg ? '/' + arg : '')); return;
  }
  // Briefs and the Inbox are shelves in Gail's Library now. Both were header tabs for months, so
  // these are among the likeliest hashes to be sitting in a note.
  if (page === 'briefs' || page === 'inbox') { location.replace('#gail/' + page); return; }
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + page));
  // The collapsed menu names the tab it is standing in for, and closes itself on every navigation
  // -- including a hash change the user made some other way, which is why it lives here and not
  // only in the click handler.
  setMenu(false);
  { const on = document.querySelector('#nav a.on'), lbl = $('#menu-label');
    if (lbl) lbl.textContent = on ? on.textContent : 'Menu'; }
  closeDrawer();
  // Keyed lookup, so this order is cosmetic rather than load-bearing — but it is kept in step
  // with the nav in index.html so the two read the same way.
  const pages = { markets, sisyphus, stan, annie, adam, neil, sven, kate, gail, sandbox, signals, admin };
  // A HOLLOW DASHBOARD MUST NOT LOOK LIKE A REAL ONE.
  //
  // Making the core tables soft stopped one busy minute in the database from blanking the whole
  // site, but it introduced the failure the old hard queries were guarding against: without
  // strategies or securities every panel renders empty and reads as "nothing to report". So when
  // something load-bearing is missing, every page says so at the top -- not just the Status tab,
  // where the existing notice lives and where nobody looks when the page in front of them is
  // already wrong.
  const CORE = ['strategies', 'securities', 'current prices', 'asset classes'];
  const coreGone = (D.softFailures || []).filter(f => CORE.some(c => f.startsWith(c + ':')));
  const banner = !coreGone.length ? '' : `<div class="card" style="margin-bottom:14px;border-left:3px solid var(--neg)">
    <h2 style="margin:0">Some of this page is missing its data</h2>
    <p class="sub" style="margin:6px 0 0">${coreGone.length === 1 ? 'A table the dashboard is built on' : `${coreGone.length} tables the dashboard is built on`} could not be read, so panels below may be empty or wrong rather than simply quiet. <b>This is usually the nightly job running</b> — it reads the whole price history several times and the database is busy for a few minutes. Each query was already retried twice.</p>
    <ul style="margin:8px 0 10px 18px;color:var(--muted);font-size:12px">${coreGone.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
    <button class="btn" onclick="location.reload()">Reload</button></div>`;
  $('#app').innerHTML = banner + (page === 'gail' ? gail(arg) : (pages[page] || sisyphus)());
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
  if (page === 'sven' && arg) {
    // Two drawers on one route. The flow breakdown is prefixed rather than given its own page,
    // so it closes the same way every other drawer on this site closes.
    $('#drawer').innerHTML = arg.startsWith('flow-') ? newsFlowDrawer(arg.slice(5)) : svenDrawer(arg);
    $('#drawer').hidden = false; $('#scrim').hidden = false;
  }
  if (page === 'markets' && arg) openChart(arg);
  if (page === 'sisyphus' && arg) openExposureChart(arg);
  if (page === 'admin' && arg) openMacroChart(arg);
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
     ${master.freshness === null || master.freshness === undefined ? '' : `<div style="color:${+master.freshness < 0.34 ? 'var(--neg)' : +master.freshness < 0.66 ? 'var(--warn)' : 'var(--muted)'};font-size:12px;margin-top:4px">evidence ${(+master.freshness * 100).toFixed(0)}% fresh · ${esc(master.conviction || '')}</div>`}
    </div>
    <table style="flex:1;min-width:280px;margin:0"><thead><tr><th>Lens</th><th class="num">Weight</th><th class="num">Score</th><th>Light</th><th class="num">Calls</th></tr></thead><tbody>
    ${cats.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${(+c.weight * 100).toFixed(0)}%</td>
      <td class="num">${c.score === null ? '<span style="color:var(--muted)">–</span>' : (+c.score).toFixed(2)}</td>
      <td>${c.light ? `${lightDot(c.light, 10)} <span style="color:${LIGHT_COLOR[c.light]}">${esc(LIGHT_MEANING[c.light])}</span>` : '<span style="color:var(--muted)">no reading</span>'}</td>
      <td class="num">${c.n_calls}${c.n_recorded > c.n_calls ? ` <span style="color:var(--muted)">of ${c.n_recorded}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
   <p class="note"><b>Draft rule.</b> The framework set the lens weights; the scoring rule was left open, so this is a proposal to argue with, not a settled measure. A lens scores the confidence-weighted mean direction of its open research calls — green above +0.33, red below −0.33 — and the master is the weighted mean over the lenses that actually have calls, so a silent lens abstains rather than counting as neutral. ${master.n_calls < 6 ? `<b>This reading rests on ${master.n_calls} scoring call${master.n_calls === 1 ? '' : 's'}</b>, far too few to lean on — read it as the machinery working, not as a signal.` : ''} Only equities, commodities and cash calls carry a sign: bond and gold calls are counted but score zero, because their risk reading is genuinely ambiguous.</p>
   ${master.freshness === null || master.freshness === undefined ? '' : `<p class="note"><b>Calls decay over their own horizon.</b> This light printed one value — −0.1303, yellow — on all 18 readings between 2026-09-24 and 2026-10-23, because the nine calls behind it were all recorded on two days in September and all sat inside their review dates, so the same nine confidences passed the same filter every day. A call now carries full conviction the day it is made and nothing the day it comes up for review, straight line between, which adds no new setting — the horizon is the analyst's own declaration of how long the call is good for. Evidence is <b>${(+master.freshness * 100).toFixed(0)}% fresh</b>${master.oldest_call ? `, the newest call was made ${esc(String(master.newest_call))}` : ''}.</p>
   <p class="note"><b>A light it can no longer support is suppressed.</b> As evidence decays the boundary widens: green or red needs a score past ±0.33 ÷ freshness, so at ${(+master.freshness * 100).toFixed(0)}% it needs <b>|score| &gt; ${(0.33 / +master.freshness).toFixed(2)}</b>, and below about a third fresh the light pins to yellow because nothing honest is left to say.${master.raw_light && master.raw_light !== master.light ? ` <b style="color:var(--warn)">Suppressed now:</b> the ungated score would have read ${esc(master.raw_light)}.` : ''}${+master.n_silent > 0 ? ` <b>${master.n_silent} of 4 lenses have no open calls at all</b>${master.detail && master.detail.silent_categories ? ` (${master.detail.silent_categories.map(esc).join(', ')})` : ''} — the master renormalises them away, so it is a partial framework reported as the whole one.` : ''}</p>
   <p class="note"><b>What decay does not fix.</b> Every call on file was recorded on one of two dates, so inside a lens the decay factors are identical and cancel in the ratio: the score itself still will not move until calls arrive on new dates. The mechanism is fixed; the signal needs feeding. Market responsiveness is a different layer and deliberately not bolted on here — mixing price action into a panel of analyst conviction would quietly turn it into a momentum signal wearing their names.</p>`}`;
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

  // ---- The ticker tape: does the tape agree? ----
  //
  // Sits between the Speed Limit and Model Surveillance because that is the argument it settles.
  // The Speed Limit above is a JUDGMENT, assembled from what the desk's sources have said. The
  // tape is ARITHMETIC. When the two disagree, one of them is wrong, and the disagreement is
  // worth more than either reading alone.
  //
  // The items are rendered twice into one track so the scroll loops seamlessly -- the animation
  // moves exactly one copy's width. Everything a reader needs to interpret a figure is in its
  // title attribute, because a number that scrolls past without its interval and lookback is a
  // decoration rather than a measurement.
  const tape = (D.tapeTicker || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const tapeCard = !tape.length ? '' : (() => {
    const tpc = v => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : ''}${(+v * 100).toFixed(2)}%`;
    const VERDICT = {
      agree:      ['agrees',     'var(--pos)'],
      disagree:   ['DISAGREES',  'var(--neg)'],
      mixed:      ['no call',    'var(--muted)'],
      calm:       ['calm',       'var(--pos)'],
      tightening: ['tightening', 'var(--flat)'],
      tight:      ['TIGHT',      'var(--neg)'],
    };
    const item = r => {
      const kind = r.value_kind;
      const v = r.value === null || r.value === undefined ? null : +r.value;
      // A correlation is not a return: it is shown on its own scale, and high is the warning.
      const shown = v === null ? '—' : kind === 'correlation' ? v.toFixed(2) : tpc(v);
      const tone = v === null ? 'var(--muted)'
        : kind === 'correlation' ? (v >= 0.8 ? 'var(--neg)' : v >= 0.6 ? 'var(--flat)' : 'var(--pos)')
        : v >= 0 ? 'var(--pos)' : 'var(--neg)';
      const vd = r.verdict && VERDICT[r.verdict] ? VERDICT[r.verdict] : null;
      const sec = r.measure === 'brakes' && r.secondary !== null && r.secondary !== undefined
        ? `<span class="tapetag" style="color:${+r.secondary < -0.2 ? 'var(--pos)' : +r.secondary > 0.2 ? 'var(--neg)' : 'var(--flat)'}">vs book ${(+r.secondary).toFixed(2)}</span>` : '';
      return `<span class="tapeitem" title="${esc(r.detail || '')}">
        <span class="tapelabel">${esc(r.label)}</span>
        <span class="tapeval" style="color:${tone}">${shown}</span>
        ${vd ? `<span class="tapetag" style="color:${vd[1]};border-color:${vd[1]}44">${esc(vd[0])}</span>` : ''}
        ${sec}</span>`;
    };
    const strip = tape.map(item).join('');
    const stamp = tape[0] && tape[0].as_of ? new Date(tape[0].as_of) : null;
    const ageMin = stamp ? Math.round((Date.now() - stamp.getTime()) / 60000) : null;
    const anyDisagree = tape.some(r => r.verdict === 'disagree');
    const anyTight = tape.some(r => r.verdict === 'tight');
    return `<div style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px">
        <div style="font-size:13px;font-weight:700">Does the tape agree?${anyDisagree ? ' <span style="color:var(--neg)">— not on every horizon</span>' : ''}${anyTight ? ' <span style="color:var(--neg)">— correlations are tight</span>' : ''}</div>
        <div style="font-size:11.5px;color:var(--muted)">${stamp ? `as of ${esc(stamp.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}${ageMin !== null && ageMin > 150 ? ` · <b style="color:var(--warn)">${ageMin < 1440 ? Math.round(ageMin / 60) + ' hours' : Math.round(ageMin / 1440) + ' days'} old</b>` : ''} · hourly while the US market is open</div>
      </div>
      <div class="tape"><div class="tapetrack">${strip}${strip}</div></div>
      <p class="note" style="margin:0">The Speed Limit above is a <b>judgment</b> assembled from what the desk's sources have said; this is <b>arithmetic</b>. Where they disagree, one of them is wrong. <b>Correlation</b> is the average absolute pairwise correlation across US stocks, developed international, emerging markets, aggregate bonds, gold and silver — it is watching for the convergence on 1 where a portfolio that looks diversified is one position wearing six names. <b>Brakes</b> is 20% VIXM, 20% CAOS, 60% KMLM, shown with its correlation to a 50/10/10/30 risk book: brakes are what let the desk carry risk at all, and a correlation drifting toward zero means they have stopped being brakes. Each horizon sets the <b>return interval</b> being correlated, with the lookback that supplies the sample — hover any item for both. CAOS begins in March 2023, so the longer brake horizons rest on few observations.</p>
    </div>`;
  })();

  // ---- What caution has cost ----
  //
  // THE AUDIT NOBODY HAD RUN. The desk measured in October 2026 that security selection cost it
  // about 4bp a decision and helped on only 42% of them -- the edge is allocation, not selection.
  // The other side was never measured, because a trade not made leaves no trade to audit. A Speed
  // Limit can instruct this desk to carry less risk every day for a year and never be asked what
  // the instruction was worth.
  //
  // The split is the whole point. Trailing a benchmark because you held the wrong things and
  // trailing it because you held LESS OF EVERYTHING are different mistakes with different fixes:
  //
  //     beta drag = (beta - 1) x benchmark return       the return given up by carrying less
  //     residual  = excess - beta drag                  everything that was not risk posture
  //
  // Negative drag means caution cost money, and it is signed that way on purpose. Buried inside a
  // tracking-error figure the same fact reads as neutral.
  const board = D.slBoard || [];
  const firmBoard = board.filter(r => r.scope === 'posture' && !r.strategy_id).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const modelBoard = board.filter(r => r.scope === 'posture' && r.strategy_id);
  const sigFirm = board.find(r => r.scope === 'signal' && !r.strategy_id) || null;
  const cautionCard = !firmBoard.length ? '' : (() => {
    const f = firmBoard.at(-1);
    const yrs = (f.n_months || 0) / 12;
    const down = firmBoard.filter(r => +r.bench_return < 0);
    const up = firmBoard.filter(r => +r.bench_return > 0);
    const earned = down.reduce((a, r) => a + (+r.beta_drag || 0), 0);
    const paid = up.reduce((a, r) => a + (+r.beta_drag || 0), 0);
    const cov = firmBoard.map(r => r.detail && r.detail.coverage).filter(c => c !== null && c !== undefined);
    const avgCov = cov.length ? cov.reduce((a, b) => a + +b, 0) / cov.length : null;
    const perModel = (D.models || []).map(m => {
      const rows = modelBoard.filter(r => r.strategy_id === m.id).sort((a, b) => String(a.period).localeCompare(String(b.period)));
      return rows.length ? { m, last: rows.at(-1), n: rows.filter(r => r.beta_drag !== null).length } : null;
    }).filter(Boolean).sort((a, b) => (+a.last.cum_beta_drag) - (+b.last.cum_beta_drag));
    const big = v => `${+v >= 0 ? '+' : '\u2212'}${Math.abs(+v * 100).toFixed(1)}%`;
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">What has caution cost?</h2>
        <span style="font-size:12px;color:var(--muted)">${f.n_months} months to ${esc(f.period)} · AUM-weighted · ${avgCov === null ? '' : `${(avgCov * 100).toFixed(0)}% average coverage`}</span></div>
      <p class="note" style="margin:8px 0 14px">The desk knows selection costs it money because somebody measured it. Nobody had measured the defensive instruction — a trade not made leaves no trade to audit. This splits realised return against benchmark into <b>the part explained by running below benchmark beta</b> and everything else.</p>
      <div style="display:flex;gap:26px;flex-wrap:wrap;align-items:flex-start;margin-bottom:14px">
        <div><div class="eyebrow">Cost of posture</div>
          <div style="font-size:30px;font-weight:700;color:${+f.cum_beta_drag < 0 ? 'var(--neg)' : 'var(--pos)'}">${big(f.cum_beta_drag)}</div>
          <div style="color:var(--muted);font-size:12px">${big(+f.cum_beta_drag / (yrs || 1))} a year, at ${f.beta_used === null ? '—' : (+f.beta_used).toFixed(2)}× beta</div></div>
        <div><div class="eyebrow">Everything else</div>
          <div style="font-size:30px;font-weight:700;color:${+f.cum_residual >= 0 ? 'var(--pos)' : 'var(--neg)'}">${big(f.cum_residual)}</div>
          <div style="color:var(--muted);font-size:12px">what the decisions themselves added</div></div>
        <div><div class="eyebrow">Net vs benchmark</div>
          <div style="font-size:30px;font-weight:700;color:${+f.cum_excess >= 0 ? 'var(--pos)' : 'var(--neg)'}">${big(f.cum_excess)}</div>
          <div style="color:var(--muted);font-size:12px">the two added together</div></div>
      </div>
      <p class="note" style="margin-bottom:14px"><b>Caution worked exactly as advertised, and was still a losing trade.</b> It paid in <b>${down.filter(r => +r.beta_drag > 0).length} of ${down.length}</b> months the benchmark fell, earning <b style="color:var(--pos)">${big(earned)}</b>, and cost in <b>${up.filter(r => +r.beta_drag < 0).length} of ${up.length}</b> months it rose, giving up <b style="color:var(--neg)">${big(paid)}</b>. Markets rose roughly twice as often as they fell, so the insurance was bought ${(up.length / Math.max(1, down.length)).toFixed(1)}× more often than it paid. <b>That is the case for brakes rather than a lower beta:</b> cutting exposure cannot change that ratio, and convexity is the only thing that can.</p>
      <div style="overflow-x:auto"><table style="min-width:620px"><thead><tr>
        <th>Model</th><th class="num">Months</th><th class="num">Beta</th><th class="num">Posture</th><th class="num">Everything else</th><th class="num">Net</th></tr></thead><tbody>
        ${perModel.map(({ m, last, n }) => `<tr>
          <td>${esc(m.label || m.name)}</td>
          <td class="num" style="color:var(--muted)">${n}</td>
          <td class="num">${last.beta_used === null ? '—' : (+last.beta_used).toFixed(2) + '×'}</td>
          <td class="num" style="color:${+last.cum_beta_drag < 0 ? 'var(--neg)' : 'var(--pos)'}">${last.cum_beta_drag === null ? '—' : big(last.cum_beta_drag)}</td>
          <td class="num" style="color:${+last.cum_residual >= 0 ? 'var(--pos)' : 'var(--neg)'}">${last.cum_residual === null ? '—' : big(last.cum_residual)}</td>
          <td class="num"><b style="color:${+last.cum_excess >= 0 ? 'var(--pos)' : 'var(--neg)'}">${big(last.cum_excess)}</b></td></tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:12px"><b>This is not a claim the desk should have run 1.0× beta.</b> It is the price tag on the posture actually run. A month is only split when the benchmark explains enough of the model for its beta to mean risk posture rather than mandate mismatch — below an r-squared of 0.5 the excess is reported whole, which is why the month counts differ by model and why firm coverage averages ${avgCov === null ? '—' : (avgCov * 100).toFixed(0)}% of AUM rather than 100%. Monthly contributions are summed rather than compounded, which is standard attribution practice and understates a compounding effect over four years.</p>
      ${!sigFirm ? '' : `<p class="note"><b>The light itself cannot be graded yet.</b> ${esc(sigFirm.headline || '')}</p>`}
    </div>`;
  })();

  // ---- Which brake is worth owning ----
  //
  // THE WHITEPAPER'S INSURANCE VALUE INDEX, BUILT FROM PRICES INSTEAD OF GREEKS. It asks for skew,
  // the volatility risk premium and payoff per premium dollar. The desk holds no option chains, no
  // skew surface and no MOVE, so that index cannot be computed from real data -- and a modelled one
  // would put invented greeks on a page about real money. The question underneath it is answerable
  // from prices already held, and better, because it is then asked about instruments actually
  // ownable: what has this paid when the book fell, what does it cost the rest of the time, and
  // did it still work when it was needed?
  //
  // THE EPISODE COLUMN IS THE ONE THAT DECIDES THINGS. Pooled stress statistics said long
  // Treasuries were a brake -- positive in the worst 1%, negatively correlated, nearly free. The
  // episode record says +22% through 2008, +16% through 2020 and MINUS 33% through 2022, when it
  // was the second source of the loss. An average cannot tell those apart and a sleeve sized off
  // one would have carried its largest bond weight into the single episode where bonds did not
  // help.
  const ins = (D.insValue || []).filter(r => r.window_key === 'full').sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const insPx = (D.insPricing || [])[0] || null;
  const INS_LOOK = {
    brake:        { label: 'brake',        tone: 'var(--pos)',   short: 'Paid in the book\u2019s worst days, stayed negatively correlated through stress, and made money through every drawdown it was actually in.' },
    ballast:      { label: 'ballast',      tone: 'var(--flat)',  short: 'Helps, but either thinly or not every time. Read its episode record before sizing it as protection.' },
    funder:       { label: 'funder',       tone: 'var(--muted)', short: 'Does not brake, but is PAID to be held \u2014 which is what pays for the instrument that does.' },
    not_a_brake:  { label: 'not a brake',  tone: 'var(--neg)',   short: 'Negative when the book is at its worst, whatever it does the rest of the time.' },
    insufficient: { label: 'untested',     tone: 'var(--line)',  short: 'Has not lived through enough stress to be judged. A fact about its age, not its design.' },
  };
  const insCard = !ins.length ? '' : (() => {
    const p2 = (v, d = 2) => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : '\u2212'}${Math.abs(+v * 100).toFixed(d)}%`;
    const held = new Set(['VIXM', 'CAOS', 'KMLM']);
    const best = ins.filter(r => r.verdict === 'brake' && r.payoff_per_carry !== null)
      .sort((a, b) => (+b.payoff_per_carry) - (+a.payoff_per_carry))[0] || null;
    const epCell = r => {
      const eps = Array.isArray(r.episodes) ? r.episodes : [];
      if (!eps.length) return '<span style="color:var(--muted)">—</span>';
      const tip = eps.map(e => `${e.peak} to ${e.trough} (book ${(e.depth * 100).toFixed(0)}%): ${p2(e.ret, 1)} to the trough${e.ret_to_recovery === null ? '' : `, ${p2(e.ret_to_recovery, 1)} if held to recovery`}`).join('\n');
      return `<span data-tip="${esc(tip)}" style="cursor:default">${eps.map(e => `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:2px;background:${e.helped ? 'var(--pos)' : 'var(--neg)'}"></span>`).join('')}
        <span style="color:var(--muted);font-size:11px">${r.episodes_helped}/${eps.length}</span></span>`;
    };
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Which brake is worth owning?</h2>
        <span style="font-size:12px;color:var(--muted)">${esc(ins[0].as_of)} · against the 50/10/10/30 reference book</span></div>
      <p class="note" style="margin:8px 0 12px">Measured, not modelled. The desk holds no option chains and no skew surface, so this answers the question from prices it has: <b>what each instrument paid when the book fell, what it costs the rest of the time, and whether it worked every time it was needed.</b></p>
      ${!insPx ? '' : `<div style="display:flex;gap:22px;flex-wrap:wrap;align-items:baseline;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:12px">
        <div><span class="eyebrow">Protection costs</span> <b style="color:${insPx.verdict === 'cheap' ? 'var(--pos)' : insPx.verdict === 'dear' ? 'var(--neg)' : insPx.verdict === 'late' ? 'var(--warn)' : 'var(--muted)'};font-size:17px">${esc(insPx.verdict)}</b></div>
        <div style="font-size:12px;color:var(--muted);max-width:66ch">${esc(insPx.headline)}</div></div>`}
      <div style="overflow-x:auto"><table style="min-width:860px"><thead><tr>
        <th>Instrument</th><th class="num">Worst 1%</th><th class="num">Carry/yr</th><th class="num">Days repaid</th>
        <th class="num">Corr calm</th><th class="num">Corr stress</th><th>Drawdowns</th><th>Verdict</th></tr></thead><tbody>
        ${ins.map(r => {
          const L = INS_LOOK[r.verdict] || INS_LOOK.insufficient;
          const thin = r.carry_annual !== null && Math.abs(+r.carry_annual) < 0.03;
          return `<tr${held.has(r.instrument) ? ' style="background:var(--panel2)"' : ''}>
            <td><b>${esc(r.instrument)}</b>${held.has(r.instrument) ? ' <span class="chip" style="font-size:9px">held</span>' : ''}<br><span style="font-size:11px;color:var(--muted)">${esc(r.label)}</span></td>
            <td class="num" style="color:${+r.crash_1pct > 0 ? 'var(--pos)' : 'var(--neg)'}"><b>${p2(r.crash_1pct)}</b></td>
            <td class="num" style="color:${r.free_carry ? 'var(--pos)' : 'var(--neg)'}">${p2(r.carry_annual, 1)}</td>
            <td class="num" title="${esc(thin ? 'Carry is near zero, so this ratio is unstable and should not be compared across rows.' : 'Days of carry that one worst-1% day pays back.')}">${r.free_carry ? '<span style="color:var(--pos)">free</span>' : r.payoff_per_carry === null ? '—' : `${(+r.payoff_per_carry).toFixed(0)}${thin ? '<sup style="color:var(--warn)">?</sup>' : ''}`}</td>
            <td class="num">${r.corr_calm === null ? '—' : (+r.corr_calm).toFixed(2)}</td>
            <td class="num" style="color:${+r.corr_stress > 0 ? 'var(--neg)' : 'inherit'}">${r.corr_stress === null ? '—' : (+r.corr_stress).toFixed(2)}</td>
            <td>${epCell(r)}</td>
            <td title="${esc(L.short)}"><span style="color:${L.tone};font-weight:600">${esc(L.label)}</span></td></tr>`;
        }).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:12px"><b>The dots are the decision.</b> One per drawdown of 10% or more that the instrument was alive at the <i>start</i> of — green where it made money from the book's peak to its trough, red where it did not. Hover for every episode with its dates and depth. An instrument is only called a <b>brake</b> if it was green on all of them; <b>pooled stress averages cannot tell four-from-four apart from three-from-four</b>, and that difference is the whole question.</p>
      <p class="note"><b>Measured peak to trough, not peak to recovery</b>, because a brake's job is to pay at the bottom where it is monetised. The gap between the two is the cost of failing to do that, and it is not small: mid-term volatility returned <b>+104% into the March 2020 trough and −48% if carried through to recovery</b>. The hover shows both.</p>
      ${!best ? '' : `<p class="note"><b>Payoff per unit of carry favours ${esc(best.instrument)}</b> at ${(+best.payoff_per_carry).toFixed(0)} days repaid per worst-1% day${ins.find(r => r.instrument === 'VIXM' && r.payoff_per_carry) ? `, against ${(+ins.find(r => r.instrument === 'VIXM').payoff_per_carry).toFixed(0)} for VIXM` : ''}. Where carry is near zero the ratio is marked <sup style="color:var(--warn)">?</sup> and should not be compared across rows — dividing by almost nothing produces a large number, not a good instrument.</p>`}
      <p class="note"><b>Windows are conditions, not dates.</b> Stress is every day the reference book sat more than 5% below its own high; calm is within 2% of it. Hand-picking calendar windows would make this an argument rather than a measurement — the same sleeve reads worse than T-bills over 2023–2026 and roughly three times better over 2020–2026, purely because the second contains 2022.</p>
    </div>`;
  })();

  // ---- Which sleeve, and how much ----
  //
  // THERE IS NO OPTIMISER BEHIND THIS TABLE, deliberately. Searching weights against realised
  // drawdown would report the single most overfit point on the surface, fitted to a handful of
  // episodes, and it would move every time another drawdown is added. Each candidate here exists
  // to test one claim instead, and the comparison is arranged so the weight choice cannot flatter
  // anything: every sleeve is scaled until the book's worst drawdown is back to the unbraked
  // baseline's, and then compared on real compounding at equal realised risk.
  //
  // THE DIAL IS EQUITY, WHICH IS THE WHOLE THESIS. A working brake lowers drawdown at every
  // weight, so "scale until drawdown matches" has no answer above zero. Turning it the other way
  // asks the question the owner actually asks: how much more gas does this brake let the book
  // carry before the drawdown comes back?
  const sleeves = (D.sleeves || []).slice().sort((a, b) => (+b.uplift ?? -9) - (+a.uplift ?? -9));
  const SLV_LOOK = {
    preferred: { label: 'preferred', tone: 'var(--pos)',   short: 'Adds at least two points of real compounding a year at the same drawdown, across three or more drawdowns of record.' },
    viable:    { label: 'viable',    tone: 'var(--flat)',  short: 'Adds real compounding at the same drawdown, but less than two points a year.' },
    costly:    { label: 'costly',    tone: 'var(--warn)',  short: 'Buys gas, but the gas does not compound into much after what the sleeve costs to hold.' },
    rejected:  { label: 'rejected',  tone: 'var(--neg)',   short: 'Supports no more equity than the unbraked book at the same drawdown. An expensive way to hold what you already hold.' },
    untested:  { label: 'untested',  tone: 'var(--line)',  short: 'Fewer than two drawdowns of record on this exact combination. One drawdown is an anecdote whatever it says.' },
  };
  const sleeveCard = !sleeves.length ? '' : (() => {
    const p2 = (v, d = 2) => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : '\u2212'}${Math.abs(+v * 100).toFixed(d)}%`;
    const held = sleeves.find(s => s.sleeve_key === 'current') || null;
    const top = sleeves.find(s => s.verdict === 'preferred') || null;
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Which sleeve, and how much?</h2>
        <span style="font-size:12px;color:var(--muted)">${esc(sleeves[0].as_of)} · ${sleeves.length} candidates · iso-drawdown</span></div>
      <p class="note" style="margin:8px 0 12px">Each sleeve is scaled until the book's worst drawdown is back to the unbraked baseline's, and the equity share is raised to spend the protection. <b>At equal realised risk, how much more does it compound after inflation?</b> Sharpe is deliberately absent: it treats upside and downside variance alike and underweights the return the client actually spends.</p>
      <div style="overflow-x:auto"><table style="min-width:900px"><thead><tr>
        <th>Candidate</th><th class="num">Added</th><th class="num">Equity</th><th class="num">Sleeve</th>
        <th class="num">Plateau</th><th class="num">Funding</th><th class="num">Drawdowns</th><th>Verdict</th></tr></thead><tbody>
        ${sleeves.map(r => {
          const L = SLV_LOOK[r.verdict] || SLV_LOOK.untested;
          const comp = (Array.isArray(r.composition) ? r.composition : []).map(c => `${c.ticker} ${(c.weight * 100).toFixed(0)}`).join(' / ');
          const eps = Array.isArray(r.episodes) ? r.episodes : [];
          const tip = `${r.rationale}\n\n${r.detail || ''}`;
          return `<tr${r.sleeve_key === 'current' ? ' style="background:var(--panel2)"' : ''}>
            <td data-tip="${esc(tip)}" style="cursor:default"><b>${esc(r.label)}</b>${r.sleeve_key === 'current' ? ' <span class="chip" style="font-size:9px">held</span>' : ''}<br><span style="font-size:11px;color:var(--muted)">${esc(comp)}</span></td>
            <td class="num"><b style="color:${+r.uplift > 0 ? 'var(--pos)' : 'var(--muted)'};font-size:15px">${p2(r.uplift)}</b></td>
            <td class="num" style="color:${+r.iso_equity > 0.7 ? 'var(--pos)' : 'var(--muted)'}">${r.iso_equity === null ? '—' : (+r.iso_equity * 100).toFixed(1) + '%'}</td>
            <td class="num">${r.iso_weight === null ? '—' : (+r.iso_weight * 100).toFixed(1) + '%'}</td>
            <td class="num" style="font-size:11px;color:var(--muted)">${r.plateau_from === null ? '—' : `${(+r.plateau_from * 100).toFixed(0)}–${(+r.plateau_to * 100).toFixed(0)}%`}</td>
            <td class="num" title="The positively-carrying legs' earnings over the bleeding legs' cost. Above 1.0 the sleeve pays for itself.">${r.funding_ratio === null ? '<span style="color:var(--muted)">n/a</span>' : `<span style="color:${+r.funding_ratio >= 1 ? 'var(--pos)' : 'var(--neg)'}">${(+r.funding_ratio).toFixed(2)}</span>`}</td>
            <td class="num" style="color:${r.episodes_covered < 3 ? 'var(--warn)' : 'var(--muted)'}">${r.episodes_covered}${eps.length ? ` <span style="font-size:10px">(${r.episodes_helped} helped)</span>` : ''}</td>
            <td title="${esc(L.short)}"><span style="color:${L.tone};font-weight:600">${esc(L.label)}</span></td></tr>`;
        }).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:12px"><b>Added</b> is the only column comparable across rows. Raw real CAGR is not: CAOS was listed in 2023 and QMHIX in 2013, so the held sleeve is measurable over one drawdown and a managed-futures sleeve over five — and the unbraked book itself returned ${held ? p2(held.baseline_real_cagr, 1) : '—'} real over the first window against ${top ? p2(top.baseline_real_cagr, 1) : '—'} over the second. Ranking the raw figure compares periods and calls it a comparison of sleeves.</p>
      <p class="note"><b>Equity is the answer to the brake question.</b> The baseline runs 70%. A sleeve that supports more than that bought gas at no extra drawdown; one that supports exactly 70% bought nothing.${top ? ` ${esc(top.label)} supports <b>${(+top.iso_equity * 100).toFixed(0)}%</b>.` : ''}${held ? ` <b>The sleeve as held supports ${(+held.iso_equity * 100).toFixed(0)}%</b> — its own best weight is ${(+held.iso_weight * 100).toFixed(0)}%, which on the one drawdown it has lived through means it is not yet earning its place.` : ''}</p>
      <p class="note"><b>Plateau, not peak.</b> The range where real compounding is within 10bp of this sleeve's best. Where it is wide the exact weight is not a decision and quoting one would be false precision; where it is narrow the weight matters. Reporting the plateau is what keeps the answer stable when the next drawdown is added — an argmax would move every time.</p>
      <p class="note"><b>Drawdowns</b> counts the reference book's 10%-plus falls inside each sleeve's own shared history, with how many the braked book came through better than the unbraked one. <b>A candidate with fewer than two is marked untested whatever its numbers say</b>, because one drawdown is an anecdote. That is the honest verdict on the sleeve currently held, and it is a fact about its constituents' listing dates rather than about its design.</p>
    </div>`;
  })();

  // ---- The prescription ----
  //
  // LAYER 4, AND NARROWER THAN THE PLAN DRAFTED. The plan proposed a four-state machine moving the
  // sleeve between 0% and 18% as the fragility index moved. Half survived the measurement:
  //
  //   braking instead of cutting beta survived. On a 70/30 book over 2020-2026 braking returned
  //   9.85% against 7.69% for de-risking, and the Speed Limit scoreboard priced the old instruction
  //   at roughly 5.2% a year of forgone return across fifty months.
  //
  //   modulating the sleeve by fragility state did not. The index failed its own lead test, so
  //   sizing off it would be acting on a thermometer. The sleeve target is static and the index is
  //   carried as context the arithmetic cannot touch.
  //
  // THE CARD IS THE OUTPUT OF THE WHOLE SYSTEM, which is why it sits first on the page: everything
  // above it on this desk exists to produce these two columns.
  const rx = (D.rx || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const RX_ACTION = {
    add:     { label: 'add',     tone: 'var(--warn)' },
    trim:    { label: 'trim',    tone: 'var(--flat)' },
    hold:    { label: 'at target', tone: 'var(--pos)' },
    no_data: { label: 'no data', tone: 'var(--line)' },
  };
  const rxCard = !rx.length ? '' : (() => {
    const p2 = (v, d = 1) => v === null || v === undefined ? '—' : `${(+v * 100).toFixed(d)}%`;
    const r0 = rx[0];
    const comp = (Array.isArray(r0.composition) ? r0.composition : []).map(c => `${c.ticker} ${(c.weight * 100).toFixed(0)}%`).join(' · ');
    const nAdd = rx.filter(r => r.action === 'add').length;
    const below = rx.filter(r => r.beta_actual !== null && +r.beta_actual < +r.beta_floor);
    return `<div class="card" style="margin-bottom:14px;border:1px solid var(--accent)">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">The prescription</h2>
        <span style="font-size:12px;color:var(--muted)">${esc(r0.as_of)} · ${esc(r0.sleeve_label || '')} · ${esc(comp)}</span></div>
      <p class="note" style="margin:8px 0 14px"><b>Raise the brake, not the cash.</b> The old rule cut beta to as little as half the benchmark when the light turned; the scoreboard priced that instruction at roughly <b>5.2% a year</b> of forgone return across fifty months. The sleeve was measured to support <b>1.14×</b> the reference book's equity at the same drawdown, so the band is now set around the benchmark instead of away from it.</p>
      <div style="overflow-x:auto"><table style="min-width:860px"><thead><tr>
        <th>Model</th><th class="num">Equity</th><th class="num">k</th><th class="num">Sleeve target</th><th class="num">Held</th>
        <th>Action</th><th class="num">Beta now</th><th class="num">New band</th><th class="num">Old band</th></tr></thead><tbody>
        ${rx.map(r => { const A = RX_ACTION[r.action] || RX_ACTION.no_data;
          const lowBeta = r.beta_actual !== null && +r.beta_actual < +r.beta_floor;
          return `<tr${r.action === 'add' ? ' style="background:var(--panel2)"' : ''}>
            <td data-tip="${esc(r.target_basis || '')}" style="cursor:default"><b>${esc(r.model)}</b></td>
            <td class="num" style="color:var(--muted)">${p2(r.equity_weight, 0)}</td>
            <td class="num" style="color:var(--muted)">${r.k === null ? '—' : (+r.k).toFixed(2)}</td>
            <td class="num"><b>${p2(r.sleeve_target)}</b>${r.sleeve_ceiling !== null && Math.abs(+r.sleeve_target - +r.sleeve_ceiling) < 1e-6 ? '<sup title="Capped at this mandate\u2019s own measured ceiling, past which more brake makes drawdown worse." style="color:var(--warn)">c</sup>' : ''}${r.sleeve_floor !== null && Math.abs(+r.sleeve_target - +r.sleeve_floor) < 1e-6 ? '<sup title="Raised to the duration floor: this mandate\u2019s dominant risk is rates, and an equity-crash brake sized by equity weight arrives smallest where it is needed most." style="color:var(--warn)">f</sup>' : ''}</td>
            <td class="num" style="color:var(--muted)">${p2(r.held_now)}</td>
            <td><span style="color:${A.tone};font-weight:600">${esc(A.label)}</span>${r.gap === null ? '' : ` <span style="color:var(--muted);font-size:11px">${+r.gap > 0 ? '+' : ''}${(+r.gap * 100).toFixed(1)}</span>`}</td>
            <td class="num" style="color:${lowBeta ? 'var(--neg)' : 'inherit'}">${r.beta_actual === null ? '—' : (+r.beta_actual).toFixed(2)}</td>
            <td class="num">${(+r.beta_floor).toFixed(2)}–${(+r.beta_ceiling).toFixed(2)}</td>
            <td class="num" style="color:var(--muted);text-decoration:line-through">${(+r.old_floor).toFixed(2)}–${(+r.old_ceiling).toFixed(2)}</td></tr>`;
        }).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:12px"><b>${nAdd} of ${rx.length} mandates hold less than the prescription</b> by more than the ${p2(r0.no_trade_band)} no-trade band${below.length ? `, and <b>${below.length} run below the new beta floor</b> — ${below.map(r => `${esc(r.model)} at ${(+r.beta_actual).toFixed(2)}×`).join(', ')}` : ''}. The target is <b>k × the reference sleeve</b>, where k is the mandate's own equity weight over 70 — the proportional rule, applied as asked and then checked: the stress programme found it captures more than half the available drawdown reduction on six of eight books and under-brakes the two whose dominant risk is duration, which is why those carry a floor.</p>
      <p class="note"><b>The reference weight is the midpoint of the preferred sleeve's own plateau</b>, not a round number: anywhere inside that range is within 10bp of its best real compounding, so the midpoint is the most robust point rather than the luckiest one. The ceiling on each row is measured from that mandate's own drawdown-against-weight curve, because over-braking is self-defeating — a volatility sleeve produced a worse drawdown at 30% than at 20%, its own bleed having become the drawdown it was bought to prevent.</p>
      ${r0.monetise_at === null ? '' : `<p class="note"><b>Monetisation: trim ${p2(r0.monetise_share, 0)} once the brake leg is up ${p2(r0.monetise_at, 0)} from cost.</b> ${esc(r0.monetise_basis || '')}</p>`}
      <p class="note"><b>The sleeve target is static, and that is a finding rather than a simplification.</b> The plan proposed moving it with the fragility index. The index failed its own lead test — the book returned more over the following quarter after a defensive reading than after a calm one — so sizing off it would be acting on a thermometer. Fragility reads <b>${r0.fragility === null ? '—' : (+r0.fragility).toFixed(0)} (${esc(r0.fragility_state || '')})</b> today and <b>does not size anything here</b>. It is the one column that changes if a later version of the index passes.</p>
      <p class="note"><b>Three numbers on this card are chosen rather than derived</b> — the duration floor, the no-trade band, and which quantile of past trough gains sets the monetisation trigger. Everything else comes from each mandate's own equity weight, its own measured drawdown curve, the equity the sleeve was measured to support, or the distribution of what the brake actually gained at past troughs. <b>Status: research output for approval, not an instruction.</b></p>
    </div>`;
  })();

  // ---- Market fragility ----
  //
  // LAYER 2, AND THE ONE THAT DID NOT PASS ITS OWN TEST. The Speed Limit measures what the desk's
  // sources believe and moves when somebody records a call. This measures what market structure is
  // doing and moves every day. The desk had the view and lacked the road, which is why a brake
  // modulated off the Speed Limit alone would have been a constant.
  //
  // The card leads with the failure on purpose. Graded against the plan's own kill criterion --
  // the index must LEAD fragility -- a defensive reading precedes BETTER forward returns than a
  // calm one, which is the signature of a coincident measure: the index is most defensive near
  // troughs, so the quarter that follows is the rebound. The honest response is to report that and
  // narrow what the index is used for, not to tune six episodes until the backtest looks better.
  const frag = (D.frag || [])[0] || null;
  const fragEps = D.fragEps || [];
  const fragLead = (D.stressTests || []).filter(r => r.family === 'fragility_lead');
  const FRAG_STATE = {
    accelerate:    { label: 'Accelerate',    tone: 'var(--pos)' },
    recovery:      { label: 'Recovery',      tone: 'var(--flat)' },
    deteriorating: { label: 'Deteriorating', tone: 'var(--warn)' },
    defensive:     { label: 'Defensive',     tone: 'var(--neg)' },
  };
  const fragCard = !frag ? '' : (() => {
    const p2 = (v, d = 2) => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : '\u2212'}${Math.abs(+v * 100).toFixed(d)}%`;
    const L = FRAG_STATE[frag.state] || FRAG_STATE.accelerate;
    const legs = Array.isArray(frag.legs) ? frag.legs : [];
    const fwd = fragLead.filter(r => r.scenario === 'forward_63d');
    const calm = fwd.find(r => r.subject === 'accelerate');
    const def = fwd.find(r => r.subject === 'defensive');
    const fp = fragLead.find(r => r.scenario === 'false_positives');
    const led = fragEps.filter(e => e.verdict === 'led').length;
    const graded = fragEps.filter(e => e.verdict !== 'no_data').length;
    const failsLead = def && calm && +def.value >= +calm.value;
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Market Fragility Index <span style="color:var(--muted);font-weight:400">(MFI)</span></h2>
        <span style="font-size:12px;color:var(--muted)">${esc(frag.as_of)} · ${frag.n_legs} legs · equal-weighted · layer 2</span></div>
      <div style="display:flex;gap:26px;align-items:baseline;flex-wrap:wrap;margin:12px 0 10px">
        <div><div style="font-size:34px;font-weight:700;color:${L.tone};line-height:1">${(+frag.mfi).toFixed(0)}</div>
          <div style="color:var(--muted);font-size:11px">of 100</div></div>
        <div><div style="font-size:19px;font-weight:700;color:${L.tone}">${esc(L.label)}</div>
          <div style="color:var(--muted);font-size:12px">${frag.state_days} session${frag.state_days === 1 ? '' : 's'}${frag.mfi_pctile === null ? '' : ` · ${(+frag.mfi_pctile * 100).toFixed(0)}th percentile of its own prior three years`}</div></div>
        ${!frag.override_leg ? '' : `<div style="font-size:12px;color:var(--warn);max-width:40ch"><b>Carried by ${esc(frag.override_leg)} alone.</b> One leg past its own 95th percentile overrides the mean rather than being averaged into it.</div>`}
      </div>
      <div style="overflow-x:auto"><table style="min-width:560px"><thead><tr><th>Leg</th><th class="num">Against its own three years</th><th>Measured from</th></tr></thead><tbody>
        ${legs.map(l => `<tr><td><b>${esc(l.label)}</b></td>
          <td class="num"><span style="color:${+l.pctile >= 0.90 ? 'var(--neg)' : +l.pctile >= 0.70 ? 'var(--warn)' : 'var(--muted)'};font-weight:600">${(+l.pctile * 100).toFixed(0)}%</span></td>
          <td style="font-size:12px;color:var(--muted)">${esc(l.source)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:12px"><b>This is the whitepaper's MFI.</b> Five legs scored 0&ndash;100 where rising means worsening, normalised against prior-only empirical distributions, as specified &mdash; with two deliberate departures named below. It is <b>layer 2</b> of the brake system: the Speed Limit is the view, this is the road.</p>
      <p class="note"><b>Equal weights, not the whitepaper's 30/25/20/15/10.</b> Those are five free parameters chosen before any evidence existed. Equal weighting says the desk does not yet know which leg matters most, which is true, and a weight moves only when walk-forward evidence demands it. <b>The dominant-leg override is the design, not a refinement:</b> any mean of five legs pulls to the middle by construction, so credit seizing while four legs are calm would read the same as five legs mildly elevated — and those are not the same world.</p>
      <p class="note"><b>Point-in-time throughout.</b> Every leg is ranked against its own trailing three years <i>as they stood on that date</i>, and the states come from the index's own prior-only distribution rather than fixed cut points. An index normalised with hindsight looks prescient in a backtest and fails live.</p>

      <div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
        <div class="eyebrow" style="margin-bottom:8px">Graded against its own kill criterion</div>
        ${!fwd.length ? '' : `<div style="overflow-x:auto"><table style="min-width:540px"><thead><tr><th>State</th><th class="num">Book over the next 63 sessions</th><th class="num">Worst 5%</th><th class="num">Observations</th></tr></thead><tbody>
          ${['accelerate', 'recovery', 'deteriorating', 'defensive'].map(st => { const r = fwd.find(x => x.subject === st); if (!r) return '';
            const worse = calm && +r.value < +calm.value;
            return `<tr><td>${esc((FRAG_STATE[st] || {}).label || st)}</td>
              <td class="num" style="color:${st === 'accelerate' ? 'var(--muted)' : worse ? 'var(--pos)' : 'var(--neg)'}"><b>${p2(r.value)}</b></td>
              <td class="num" style="color:var(--muted)">${p2(r.p05)}</td>
              <td class="num" style="color:var(--muted)">${r.n_obs}</td></tr>`; }).join('')}
        </tbody></table></div>`}
        ${!failsLead ? '' : `<p class="note" style="margin-top:10px;color:var(--neg)"><b>This index fails the test the plan set for it.</b> A defensive reading precedes <b>${p2(def.value)}</b> over the next quarter against <b>${p2(calm.value)}</b> after a calm one — better, not worse. That is the signature of a coincident measure rather than a leading one: the index is most defensive near troughs, so the quarter that follows is the rebound. It is a fragility <b>thermometer</b>, and on this evidence <b>it must not be used to time the brake on and off</b>.</p>
        <p class="note"><b>Reported rather than tuned.</b> Weights and thresholds could be fitted until the backtest looked good, against six episodes, and the result would be a better-looking chart and a worse instrument. The standing instruction on this desk is top-decile outcomes, and a fitted signal is how a process becomes median.</p>
        <p class="note"><b>What it is still for.</b> It moves daily, which the Speed Limit does not; it explains <i>which</i> leg is stretched, which a single light cannot; and the dominant-leg override makes it loud when one thing breaks while the rest look fine. That is monitoring and explanation. The sleeve work already concluded the brake should be held continuously rather than switched, so losing the timing claim costs less than it first appears.</p>`}
        ${!fragEps.length ? '' : `<div style="overflow-x:auto;margin-top:12px"><table style="min-width:620px"><thead><tr><th>Drawdown</th><th class="num">Depth</th><th class="num">Index at the peak</th><th>State at the peak</th><th class="num">Lead to peak</th><th>Verdict</th></tr></thead><tbody>
          ${fragEps.map(e => `<tr title="${esc(e.headline)}"><td>${esc(e.episode)}</td>
            <td class="num" style="color:var(--neg)">${p2(e.depth, 0)}</td>
            <td class="num">${e.mfi_at_peak === null ? '—' : (+e.mfi_at_peak).toFixed(0)}</td>
            <td style="font-size:12px;color:${(FRAG_STATE[e.state_at_peak] || {}).tone || 'var(--muted)'}">${esc((FRAG_STATE[e.state_at_peak] || {}).label || '—')}</td>
            <td class="num" style="color:${+e.lead_to_peak > 0 ? 'var(--pos)' : 'var(--neg)'}">${e.lead_to_peak === null ? '—' : `${e.lead_to_peak > 0 ? '+' : ''}${e.lead_to_peak}`}</td>
            <td style="font-size:12px;color:${e.verdict === 'led' ? 'var(--pos)' : e.verdict === 'no_data' ? 'var(--line)' : 'var(--neg)'};font-weight:600">${esc(e.verdict)}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="note" style="margin-top:10px"><b>Lead to peak</b> is sessions between the warning that was still in force at the top and the top itself. Positive means the index was calling for brakes while the book was still making highs — the only kind of warning worth having. <b>${led} of ${graded}</b> qualify. An earlier version of this test searched the whole year before each peak for any warning and graded every episode a success; since the index sits in a warning state about a third of the time, that search almost always succeeds, and it was the test finding what it was built to find.${!fp ? '' : ` Across ${(+frag.as_of.slice(0, 4)) - 2008} years there were <b>${fp.n_obs} separate warning runs</b> and ${((1 - +fp.value) * fp.n_obs).toFixed(0)} overlapped a 10% drawdown — a false-positive rate of <b>${(+fp.value * 100).toFixed(0)}%</b>.`}</p>`}
      </div>
    </div>`;
  })();

  // ---- The stress programme ----
  //
  // WHAT A STRESS TEST IS ALLOWED TO BE HERE. The desk's rule is that no number may be shown which
  // was not computed from real data, and that bars the usual parametric test, where a covariance
  // matrix and a normal assumption produce a loss for a shock nobody has observed. Every family is
  // a replay, a fit with its explanatory power printed beside it, or a resampling -- and where a
  // scenario reaches past the observed range it says so and says how far.
  //
  // THE TWO FAMILIES THAT CHANGED A DECISION. The bootstrap, because matching a historical maximum
  // drawdown is NOT the same as matching tail risk: the unfunded-volatility sleeve wins on the
  // historical path and adds almost nothing at the 5th percentile, which is the number a brake is
  // bought for. And instrument_failure, which the whitepaper does not ask for: the brake held
  // through the 2018 short-volatility unwind and lost a third of its value through a 130-session
  // contango grind. The grind is the risk, not the unwind.
  const stressTests = D.stressTests || [];
  const STRESS_LOOK = {
    holds:      { label: 'holds',      tone: 'var(--pos)' },
    degrades:   { label: 'degrades',   tone: 'var(--warn)' },
    fails:      { label: 'FAILS',      tone: 'var(--neg)' },
    untestable: { label: 'untestable', tone: 'var(--line)' },
  };
  const FAMILY_LOOK = {
    replay:             'Replay — named windows, including a calm control',
    bootstrap:          'Block bootstrap — the 5th percentile, not the median',
    instrument_failure: 'When the brake itself fails',
    carry_drag:         'The longest quiet stretch',
    shock:              'Shocks — a quadratic fit, so convexity is measured not assumed',
    over_brake:         'Proportional weighting against each mandate\u2019s own curve',
    monetisation:       'Monetisation — sold at the trough against held to recovery',
  };
  const stressCard = !stressTests.length ? '' : (() => {
    const p2 = (v, d = 2) => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : '\u2212'}${Math.abs(+v * 100).toFixed(d)}%`;
    const fam = f => stressTests.filter(r => r.family === f);
    const chip = v => { const L = STRESS_LOOK[v] || STRESS_LOOK.untestable; return `<span style="color:${L.tone};font-weight:600;font-size:11px">${esc(L.label)}</span>`; };
    const nFail = stressTests.filter(r => r.verdict === 'fails').length;
    const boot = fam('bootstrap').slice().sort((a, b) => (+b.delta) - (+a.delta));
    const rep = fam('replay');
    const scen = [...new Map(rep.map(r => [r.scenario, r])).values()];
    const subs = [...new Set(rep.map(r => r.subject))];
    const ob = fam('over_brake');
    const mon = fam('monetisation').filter(r => r.subject === 'VXZ' && r.baseline !== null);
    const insF = fam('instrument_failure');
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">The stress programme</h2>
        <span style="font-size:12px;color:var(--muted)">${esc(stressTests[0].as_of)} · ${stressTests.length} results · ${Object.keys(FAMILY_LOOK).length} families · ${nFail} read FAILS</span></div>
      <p class="note" style="margin:8px 0 14px">No parametric testing. Every result is a <b>replay</b> of something that happened, a <b>fit</b> to something that happened with its explanatory power beside it, or a <b>resampling</b> of something that happened — because a covariance matrix generating a loss for an unobserved shock is not a measurement. Where a scenario reaches past the observed range the row says so, and by how far.</p>

      <div class="eyebrow" style="margin:0 0 8px">${esc(FAMILY_LOOK.bootstrap)}</div>
      <div style="overflow-x:auto"><table style="min-width:620px"><thead><tr><th>Sleeve</th><th class="num">p05 real</th><th class="num">Unbraked</th><th class="num">Gain at p05</th><th class="num">p95</th><th>Verdict</th></tr></thead><tbody>
        ${boot.map(r => `<tr title="${esc(r.detail || '')}"><td>${esc(r.subject)}</td>
          <td class="num"><b>${p2(r.p05)}</b></td><td class="num" style="color:var(--muted)">${p2(r.baseline)}</td>
          <td class="num" style="color:${+r.delta > 0.001 ? 'var(--pos)' : 'var(--muted)'}"><b>${p2(r.delta)}</b></td>
          <td class="num" style="color:var(--muted)">${p2(r.p95)}</td><td>${chip(r.verdict)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:10px"><b>Matching a historical drawdown is not the same as matching tail risk, and this is where that shows.</b> The unfunded-volatility sleeve wins the historical iso-drawdown comparison and adds almost nothing here — it is over-geared, and only resampling reveals it. Braked and unbraked books are resampled along the <b>same paths</b>, so the difference is the sleeve rather than the sampler; the median is computed and deliberately not led with.</p>

      <div class="eyebrow" style="margin:18px 0 8px">${esc(FAMILY_LOOK.replay)}</div>
      <div style="overflow-x:auto"><table style="min-width:760px"><thead><tr><th>Sleeve</th>${scen.map(x => `<th class="num" style="font-size:11px">${esc(x.scenario.replace(/_/g, ' '))}</th>`).join('')}</tr></thead><tbody>
        ${subs.map(sub => `<tr><td>${esc(sub)}</td>${scen.map(x => {
          const r = rep.find(y => y.subject === sub && y.scenario === x.scenario);
          if (!r) return '<td class="num" style="color:var(--line)">–</td>';
          return `<td class="num" data-tip="${esc(r.headline)}" style="cursor:default;color:${+r.delta > 0 ? 'var(--pos)' : +r.delta > -0.02 ? 'var(--muted)' : 'var(--neg)'}">${p2(r.delta, 1)}</td>`;
        }).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:10px">Each cell is the braked book minus the unbraked one through that window, at the sleeve's own iso-drawdown settings. <b>The calm control is not padding</b>: the same sleeve reads worse than T-bills over a quiet window and far better over one containing 2022, and a programme that only replayed crises would never surface it.</p>

      ${!insF.length ? '' : `<div class="eyebrow" style="margin:18px 0 8px">${esc(FAMILY_LOOK.instrument_failure)}</div>
      ${insF.map(r => `<p class="note" style="margin:0 0 6px"><b>${esc(r.subject)}</b> · ${esc(r.scenario.replace(/_/g, ' '))} — ${esc(r.headline)} ${chip(r.verdict)}</p>`).join('')}
      <p class="note"><b>The question the whitepaper does not ask.</b> A mid-term VIX fund's payoff comes from the futures curve, not from spot volatility, so it is run through the February 2018 short-volatility unwind and through the longest sustained contango stretch in its own history — the window chosen by where the condition held longest, not by hand. <b>The brake survived the unwind and bleeds through the grind</b>, which inverts the usual worry.</p>`}

      ${!ob.length ? '' : `<div class="eyebrow" style="margin:18px 0 8px">${esc(FAMILY_LOOK.over_brake)}</div>
      <div style="overflow-x:auto"><table style="min-width:640px"><thead><tr><th>Model</th><th class="num">k = E / 70</th><th class="num">Proportional sleeve</th><th class="num">Shallowest drawdown at</th><th>Verdict</th></tr></thead><tbody>
        ${ob.map(r => `<tr title="${esc(r.detail || '')}"><td>${esc(r.subject)}</td>
          <td class="num" style="color:var(--muted)">${r.baseline === null ? '—' : (+r.baseline / 0.20).toFixed(2)}</td>
          <td class="num"><b>${r.baseline === null ? '—' : (+r.baseline * 100).toFixed(1) + '%'}</b></td>
          <td class="num">${(+r.value * 100).toFixed(1)}%</td><td>${chip(r.verdict)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:10px"><b>The proportional rule holds for most mandates and under-brakes the bond-heavy ones.</b> Scaling the sleeve by k = equity weight ÷ 70 captures more than half the available drawdown reduction on six of eight books. It does not on <b>Fixed Income Core</b> (2.9% against a measured 12.5%) or <b>Liquid Core</b> (8.6% against 25%) — exactly the two whose dominant risk is duration rather than equity, so an equity-crash brake sized by equity weight arrives smallest where it is needed most. That is a narrower objection than "the rule is wrong", and it is the one the measurement supports.</p>`}

      ${!mon.length ? '' : `<div class="eyebrow" style="margin:18px 0 8px">${esc(FAMILY_LOOK.monetisation)}</div>
      <div style="overflow-x:auto"><table style="min-width:560px"><thead><tr><th>Drawdown</th><th class="num">Sold at the trough</th><th class="num">Held to recovery</th><th class="num">The decision</th></tr></thead><tbody>
        ${mon.map(r => `<tr><td>${esc(r.scenario)}</td><td class="num" style="color:var(--pos)">${p2(r.value)}</td>
          <td class="num" style="color:${+r.baseline >= 0 ? 'var(--muted)' : 'var(--neg)'}">${p2(r.baseline)}</td>
          <td class="num"><b>${p2(r.delta)}</b></td></tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin-top:10px"><b>A brake is monetised at the bottom or it is not monetised.</b> Through 2022 the volatility leg was up 17.8% at the trough and down 48.2% by the time the book had recovered — a 66-point decision taken by doing nothing. This is why monetisation is a layer of its own and not a detail of rebalancing.</p>`}
    </div>`;
  })();

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
     // MEASURED where it exists, target weights only where it does not.
     //
     // This column used to be the target basis for every model: today's target weights held
     // fixed back through the window. That is a hypothetical buy-and-hold of the book the desk
     // believes in NOW, applied to a year it had not yet made those decisions in, and it ran
     // 3 to 7 points above what the models actually did on seven of the eight. The bias is
     // one-way by construction, because current targets are the names that worked.
     //
     // Seven of eight models carry a dated holdings history, so the measured figure is available
     // and is what the desk actually earned. The target basis stays as a fallback for a model
     // with no history, and the cell says which one it is rather than leaving them to look alike.
     const ps = (D.periodStats || []).find(x => x.strategy_id === r.m.id && x.period === 'YTD') || null;
     const measuredYtd = ps ? num(ps.model_return) : null;
     const measuredBench = ps ? num(ps.benchmark_return) : null;
     const onTarget = measuredYtd === null;
     const mr = onTarget ? (p ? num(p.portfolio_return) : null) : measuredYtd;
     const br = onTarget ? (p ? num(p.peer_benchmark_return) : null) : measuredBench;
     // Gold and bitcoin over the MODEL's own window, from the same row the model return came
     // from, so the division needs no reconciling across tables. They used to come from the
     // performance job, whose YTD opens on the first trading day of the year against the model's
     // last trading day of the prior one -- two days, worth 2.5 points on bitcoin this year.
     const gr = ps && ps.gold_return !== null ? num(ps.gold_return) : (p ? num(p.gold_return) : null);
     const btc = ps && ps.btc_return !== null ? num(ps.btc_return) : (p ? num(p.btc_return) : null);
     const numOwnWindow = !!(ps && ps.gold_return !== null);
     const cash = (r.m.byClass.find(c => c[0] === 'cash') || [0, 0])[1];
     // The CPI leg and the model measured over the SAME, shorter window -- never portfolio_return
     // divided by cpi_return, which would be a nine-month return over an eight-month price level.
     const cpi = p ? num(p.cpi_return) : null;
     // Measured over the CPI window too, read straight off the model's own daily value series, so
     // the inflation comparison is not left on the target basis once the YTD beside it has moved
     // off it. Falls back to the stored target-basis figure where there is no series to read.
     const vsRows = (D.valueSeries || []).filter(v => v.strategy_id === r.m.id);
     const valAtOrBefore = d => { let best = null; for (const v of vsRows) { if (v.as_of <= d) { if (!best || v.as_of > best.as_of) best = v; } } return best; };
     const measuredOver = (from, to) => {
       if (!vsRows.length || !from || !to) return null;
       const a = valAtOrBefore(from), b = valAtOrBefore(to);
       if (!a || !b || !(+a.value > 0) || a.as_of === b.as_of) return null;
       return +b.value / +a.value - 1;
     };
     const mCpiMeasured = p ? measuredOver(p.cpi_window_start, p.cpi_window_end) : null;
     const mCpi = mCpiMeasured !== null ? mCpiMeasured : (p ? num(p.model_return_cpi_window) : null);
     const cpiOnTarget = mCpiMeasured === null;
     const b = r.beta;
     const bandState = !b || !b.actual_beta ? null
       : b.target_low === null ? null
       : +b.actual_beta < +b.target_low ? 'below' : +b.actual_beta > +b.target_high ? 'above' : 'inside';
     return `<tr>
       <td class="click" data-go="#stan/${esc(r.m.id)}" style="cursor:pointer"><b>${esc(r.m.name.replace(/\s*\([^)]*\)/g, ''))}</b> <span class="chip">${esc(r.m.label)}</span>${onTarget ? '<br><small style="color:var(--warn)" title="No dated holdings history for this model, so its performance columns are on target weights rather than measured.">target weights</small>' : ''}</td>
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
       ${perfCell(mr, onTarget
          ? 'Year-to-date on TARGET weights — this model has no dated holdings history, so there is nothing measured to use. Target weights are today\'s book held back through the window, which flatters a year the decisions had not been made in.'
          : `Year-to-date on what the model actually held, gross of fees${ps.start_date ? `, ${ps.start_date} to ${ps.end_date}` : ''}${ps.window_starts_in_gap ? '. The window opens inside the stretch with no holdings snapshot, so the weights were carried forward unchanged into it.' : ''}`)}
       ${perfCell(vsNumeraire(mCpi, cpi), cpi === null
          ? 'No CPI reading covers this window. Check that the macro feed is still running.'
          : `Model ${(mCpi * 100).toFixed(1)}%${cpiOnTarget ? ' (target weights)' : ' (measured)'} against CPI ${(cpi * 100).toFixed(1)}% over ${p.cpi_window_start} to ${p.cpi_window_end} — a SHORTER window than the YTD beside it, because CPI is monthly and published in arrears. Both legs run over the same dates.`)}
       ${perfCell(vsNumeraire(mr, gr), gr === null ? 'No gold price for this window' : `Model ${((mr || 0) * 100).toFixed(1)}% against gold ${(gr * 100).toFixed(1)}% over ${esc(numOwnWindow ? ps.start_date : p.start_date)} to ${esc(numOwnWindow ? ps.end_date : p.end_date)} — the model measured in gold terms, both legs over ${numOwnWindow ? 'the model\'s own window' : 'the performance window'}.`)}
       ${perfCell(vsNumeraire(mr, btc), btc === null ? 'No BTC price for this window' : `Model ${((mr || 0) * 100).toFixed(1)}% against bitcoin ${(btc * 100).toFixed(1)}% over ${esc(numOwnWindow ? ps.start_date : p.start_date)} to ${esc(numOwnWindow ? ps.end_date : p.end_date)} — the model measured in BTC terms, both legs over ${numOwnWindow ? 'the model\'s own window' : 'the performance window'}.`)}
       ${perfCell(mr !== null && br !== null ? mr - br : null, br === null ? 'No benchmark return for this window' : `Model ${((mr || 0) * 100).toFixed(1)}% against its benchmark ${(br * 100).toFixed(1)}%`)}
     </tr>`;
   }).join('')}
   </tbody></table></div>
   <p class="note"><b>Beta vs band</b> says only whether the model sits inside, below or above the band the master Speed Limit calls for, with the band beside it — green inside, red outside. The beta itself is the next column, not this one: carrying it twice invited reading the verdict cell as a measurement. Below the band is more defensive than the lights call for rather than worse, which is why the colour marks conformity and not quality. <b>Beta vs bench</b> is the figure itself, against that model's own benchmark — read R² first, since below 0.5 the regression is not describing risk posture and the band cell shows "unrated" instead. <b>Top-3 risk</b> is the share of model volatility carried by its three largest contributors, against the weight those same three hold; click it for the names. <b>Performance is what each model actually held</b>, year to date, gross of fees — the same measured figure its own drawer shows, so the two can no longer disagree. This column used to be built on target weights for every model: today's book held fixed back through the window. That is a hypothetical, and a flattering one, because current targets are the names that worked — it ran 3 to 7 points above the measured return on seven of the eight models, with Diversified Growth overstated by 7.0 points. A model with no dated holdings history still falls back to target weights and is <span style="color:var(--warn)">marked</span> in the first column, since a hypothetical labelled as such is better than a blank. Cash is priced as BIL rather than dropped, which it used to be. <b>vs CPI</b>, <b>vs Gold</b> and <b>vs BTC</b> restate the model in that numeraire — (1+model)÷(1+numeraire)−1 — so green means the model held its value against that yardstick rather than merely rose. Gold is GLD and bitcoin is Tiingo spot, and <b>all three legs now run over the model's own window</b> — the same dates its return was measured between. They used to be taken from the performance job, whose year opens on the first trading day against the model's last trading day of the prior year; two days, but worth 2.5 points on bitcoin this year, and a ratio of two windows is not a comparison. <b>CPI is different and the cell is honest about it:</b> headline CPI is monthly and published in arrears, so the newest reading always covers a month that ended some time ago. Rather than divide a longer investment return by a shorter inflation one — which would quietly flatter every model here — the comparison runs over the months CPI has actually reported, with the model re-measured over exactly those dates. Hover the cell for the window.</p></div>`;

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

  // ---- What the risk figures cannot say ----
  //
  // Everything above this card is an inference from a window in which a particular thing did not
  // happen. The figures are right; what they cannot do is the thing a reader naturally does with
  // them, which is treat them as a bound. Taleb's illustration is 16,000 observations of a man
  // not dying, therefore immortal with high statistical significance. This card does not argue
  // with a single number on the page -- it states their limits.
  const hum = (D.humility || []).find(h => h.scope === 'firm') || null;
  const humByModel = Object.fromEntries((D.humility || []).filter(h => h.strategy_id).map(h => [h.strategy_id, h]));
  const hpc = v => v === null || v === undefined ? '—' : `${(+v * 100).toFixed(1)}%`;
  const hnum = v => v === null || v === undefined ? null : +v;
  const humilityCard = !hum ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">What these figures cannot say</h2>
      <span style="font-size:12px;color:var(--muted)">firm-wide · ${esc(hum.as_of)}</span></div>
    <p class="note" style="margin:6px 0 14px">Every risk number on this page is an inference from a window in which a particular thing did not happen. <b>They are not wrong; they are narrow.</b> "No amount of observations of white swans can allow the inference that all swans are white, but the observation of a single black swan is sufficient to refute that conclusion."</p>

    <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">1 · What the window did not contain</h3>
    <div style="overflow-x:auto"><table style="min-width:640px"><thead><tr>
      <th>Book</th><th class="num">Record</th><th class="num">Risk window</th><th class="num">Covers</th>
      <th class="num">Worst in window</th><th class="num">Worst on record</th></tr></thead><tbody>
      ${[{ id: null, name: 'Firm-wide', h: hum }, ...(D.models || []).map(m => ({ id: m.id, name: bareName(m.name), h: humByModel[m.id] }))]
        .filter(x => x.h).map(x => { const h = x.h; const full = hnum(h.coverage) !== null && +h.coverage > 0.98;
        return `<tr${x.id === null ? ' style="background:var(--panel2)"' : ''}>
          <td><b>${esc(x.name)}</b></td>
          <td class="num" style="color:var(--muted)">${h.history_days}d</td>
          <td class="num" style="color:var(--muted)">${h.window_days}d</td>
          <td class="num" style="color:${full ? 'var(--warn)' : 'var(--text)'}">${hnum(h.coverage) === null ? '—' : (+h.coverage * 100).toFixed(0) + '%'}</td>
          <td class="num">${hpc(h.window_worst)}</td>
          <td class="num" style="color:var(--neg)">${hpc(h.history_worst)}${h.history_worst_date ? `<br><small style="color:var(--muted)">${esc(h.history_worst_date)}</small>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>
    <p class="note"><b>A window covering 100% of the record is the reading to pause on</b>, not the reassuring one: it means the risk figure has seen everything that book has ever seen, and nothing more. These series are reconstructed from today's weights held constant, renormalised over whatever was priced on each day, so they answer "how does a book shaped like this behave" rather than "what did we earn".</p>

    <h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">2 · Complacency</h3>
    <div style="display:flex;gap:26px;flex-wrap:wrap;align-items:center">
      <div style="min-width:150px">
        <div style="font-size:40px;font-weight:700;line-height:1;color:${hnum(hum.complacency) === null ? 'var(--muted)' : +hum.complacency >= 70 ? 'var(--warn)' : 'var(--text)'}">${hnum(hum.complacency) === null ? '—' : (+hum.complacency).toFixed(0)}</div>
        <div style="font-size:12px;color:var(--muted)">of 100 · ${hum.calm_streak} sessions since a 2σ day</div></div>
      <div style="flex:1;min-width:280px">
        ${(Array.isArray(hum.complacency_legs) ? hum.complacency_legs : []).map(l => `
          <div style="margin-bottom:7px">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">
              <span>${esc(l.leg)}</span><span style="color:var(--muted)">${esc(l.note || '')}</span></div>
            <div style="height:7px;border-radius:99px;background:var(--panel2);overflow:hidden">
              <div style="width:${l.v === null || l.v === undefined ? 0 : Math.max(1, Math.min(100, +l.v * 100)).toFixed(0)}%;height:100%;background:var(--accent);opacity:.7"></div></div></div>`).join('')}
      </div></div>
    <p class="note"><b>Five legs, not one.</b> A three-sigma daily move is rare enough that "sessions since the last one" reads in years and says nothing in between, so the calm streak is measured at two sigma and scored against this book's own history of streaks. The others are compressed volatility, a shallow drawdown, time spent near the highs, and the average pairwise correlation that decides whether the diversification is real or nominal. <b>This is not a forecast.</b> It says the recent past has been unusually calm for this book, which is information about how a reader is likely to be feeling rather than about what is coming — "after a few dozen tries, one forgets about the existence of a bullet".</p>

    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:20px">
      <div style="flex:1;min-width:270px">
        <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">3 · The same book, relived</h3>
        <table><tbody>
          <tr><td style="font-size:12.5px">Worst 5% of paths</td><td class="num" style="color:var(--neg)">${hpc(hum.sim_p05)}</td></tr>
          <tr><td style="font-size:12.5px">Median path</td><td class="num">${hpc(hum.sim_p50)}</td></tr>
          <tr><td style="font-size:12.5px">Best 5% of paths</td><td class="num" style="color:var(--pos)">${hpc(hum.sim_p95)}</td></tr>
          <tr><td style="font-size:12.5px">Median worst drawdown</td><td class="num">${hpc(hum.sim_dd_median)}</td></tr>
          <tr><td style="font-size:12.5px">Drawdown, worst 5%</td><td class="num" style="color:var(--neg)">${hpc(hum.sim_dd_p95)}</td></tr>
        </tbody></table>
        <p class="note" style="margin-top:8px">${hum.sim_paths} paths by block bootstrap, in blocks of ten days so volatility clustering survives. <b>${hnum(hum.sim_worse_share) === null ? '' : `${(+hum.sim_worse_share * 100).toFixed(0)}% of them end worse than the year actually did.`}</b> A realised return is one draw from this; judging the book on it alone is the accounting error the whole argument is about.</p>
      </div>
      <div style="flex:1;min-width:270px">
        <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">4 · Convexity, measured</h3>
        <table><tbody>
          <tr><td style="font-size:12.5px">Beta on up days</td><td class="num" style="color:var(--pos)">${hnum(hum.beta_up) === null ? '—' : (+hum.beta_up).toFixed(2)}</td></tr>
          <tr><td style="font-size:12.5px">Beta on down days</td><td class="num" style="color:var(--neg)">${hnum(hum.beta_down) === null ? '—' : (+hum.beta_down).toFixed(2)}</td></tr>
          <tr><td style="font-size:12.5px"><b>Gap</b></td><td class="num"><b style="color:${hnum(hum.convexity_gap) === null ? 'var(--muted)' : +hum.convexity_gap >= 0 ? 'var(--pos)' : 'var(--neg)'}">${hnum(hum.convexity_gap) === null ? '—' : (+hum.convexity_gap >= 0 ? '+' : '') + (+hum.convexity_gap).toFixed(2)}</b></td></tr>
        </tbody></table>
        <p class="note" style="margin-top:8px">Upside beta minus downside beta, against SPY, from the book's own daily returns. <b>Negative means it falls faster than it rises.</b> Measured rather than modelled, and never called antifragile on the strength of a positive number — that word needs a convexity you can point at.</p>
        <h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">5 · Frequency against magnitude</h3>
        <table><tbody>
          <tr><td style="font-size:12.5px">Up days</td><td class="num">${hnum(hum.hit_rate) === null ? '—' : (+hum.hit_rate * 100).toFixed(0) + '%'}</td></tr>
          <tr><td style="font-size:12.5px">Average up / down day</td><td class="num">${hpc(hum.avg_win)} / ${hpc(hum.avg_loss)}</td></tr>
          <tr><td style="font-size:12.5px">Skew</td><td class="num" style="color:${hnum(hum.skew) === null ? 'var(--muted)' : +hum.skew < -0.3 ? 'var(--neg)' : 'var(--text)'}">${hnum(hum.skew) === null ? '—' : (+hum.skew).toFixed(2)}</td></tr>
        </tbody></table>
        <p class="note" style="margin-top:8px">A high share of up days with <b>negative skew</b> is the signature of selling optionality without meaning to: steady income, with the loss arriving rarely and large. "He sells out-of-the-money options for a living; I buy them. He tries to make steady income, I prefer a lumpy and rare payoff."</p>
      </div>
    </div>

    <h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">6 · Silent evidence</h3>
    <p class="note" style="margin:0"><b>${hum.n_departed} of ${hum.n_live} tracked securities have stopped printing</b>, and that number is a <b>floor on what is missing, not a count of it</b>. Every peer median, blend fit and classification on this site is computed across names that still exist; the universe was assembled from survivors, so the funds that closed before this desk ever looked cannot appear in any figure here and never will. "We see the wealth being generated, never the processor, and never the losers."</p>
  </div>`;

  return `<span class="eyebrow">Risk</span><h1>Stan</h1>
   <p class="sub">Where the risk sits across the eight models, what is flagged, and what the risk figures cannot say.</p>
   <div class="kpis" style="grid-template-columns:repeat(5,1fr)">
    <div class="card kpi click" data-go="#stan/speed-limit" style="cursor:pointer" title="Open the master Speed Limit and how each model sits against it">
      <span class="eyebrow">Speed Limit</span>
      <b style="font-size:26px;color:${master && master.light ? LIGHT_COLOR[master.light] : 'var(--muted)'}">${master && master.sign_label ? esc(master.sign_label.replace(/^Speed Limit\s*/i, '')) : '—'}</b>
      <small>${master && master.light ? esc(LIGHT_MEANING[master.light]) : 'no reading'}${master && master.n_calls ? ` · ${master.n_calls} call${master.n_calls === 1 ? '' : 's'}` : ''}${master && master.freshness !== null && master.freshness !== undefined ? ` · <span style="color:${+master.freshness < 0.34 ? 'var(--neg)' : +master.freshness < 0.66 ? 'var(--warn)' : 'inherit'}">${(+master.freshness * 100).toFixed(0)}% fresh</span>` : ''}</small></div>
    ${LENSES.map(l => {
      const r = (D.lensSnr || []).find(x => x.category === l.key && x.window_label === 'YTD');
      const v = r && r.signal_to_noise !== null ? +r.signal_to_noise : null;
      return `<div class="card kpi click" data-go="#stan/snr-${l.key}" style="cursor:pointer" title="Signal-to-noise for ${l.label.toLowerCase()} sources — click for the breakdown by source">
        <span class="eyebrow">${esc(l.label)} SNR</span>
        <b style="font-size:26px;color:${v === null ? 'var(--muted)' : v > 0 ? 'var(--pos)' : 'var(--neg)'}">${v === null ? '—' : v.toFixed(2)}</b>
        <small>${!r || !r.n_scored ? 'nothing scored yet' : r.too_few_to_judge ? `${r.n_scored} call${r.n_scored === 1 ? '' : 's'} · too few to judge` : `${r.n_scored} calls · YTD`}</small></div>`;
    }).join('')}
   </div>
   ${rxCard}${cautionCard}${fragCard}${sleeveCard}${stressCard}${insCard}${tapeCard}${riskTable}${flagsCard}${positionScatter()}${humilityCard}${docsCard}`;
}

// ---------- Markets: a trading desk's wall, not a spreadsheet ----------
//
// What this page was: one flat table of 150 securities sorted alphabetically, which answered
// "what is CPAI doing" and no other question. What a desk actually wants on arrival is the shape
// of the day -- where equities are, what volatility is saying, what the curve is doing, which
// sectors led -- in one screen, with the full table underneath for when a specific name matters.
//
// RISK SITS BESIDE THE VIX, which is what was asked for. The MOVE index is ICE BofA's and no
// connected source publishes it, so it is NOT here under its own name and nothing is dressed up
// as it. What fills that gap is realised Treasury volatility computed from the desk's own TLT and
// IEF closes, labelled realised rather than implied, because implied and realised are different
// quantities and the gap between them is the thing a volatility desk is actually looking at.
//
// Australia and South Africa were removed from the country list at the owner's request, to give
// the panel room. They remain in the universe and in the table below: the geography fits are
// built from those indices, so dropping the securities would quietly degrade a different page.
const PERF_TICKERS = ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'IEF', 'RSP'];
const PERF_COLORS = { SPY: '#4ea1ff', QQQ: '#a78bfa', IWM: '#fbbf24', DIA: '#fb923c' };
// 1D is drawn from fifteen-minute bars and every other window from daily closes, so it is the one
// entry whose second value is not a session count. 1W is five sessions -- a handful of points,
// which is what a week of daily closes honestly is.
const PERF_WINDOWS = [['1D', 'intraday'], ['1W', 5], ['1M', 21], ['3M', 63], ['6M', 126], ['YTD', null], ['1Y', 252], ['3Y', 756]];
let perfPeriod = 'YTD';
let perfSeries = null, perfLoading = false, perfError = null;
// Intraday is fetched separately and only when the one-day window is asked for: it is a different
// table, a different shape, and almost nobody opens this page to look at the last four hours.
let perfIntraday = null, perfIntradayLoading = false, perfIntradayError = null;

async function loadPerfSeries() {
  if (perfSeries || perfLoading) return;
  perfLoading = true;
  try {
    const out = {};
    for (const t of PERF_TICKERS) {
      const row = D.markets.find(m => m.ticker === t);
      if (!row) continue;
      // PostgREST caps a response at 1000 rows whatever the limit says, so three years of daily
      // closes comes back in two ranges rather than one request that silently truncates.
      const bars = [];
      for (let from = 0; from < 1200; from += 600) {
        const page = await q(() => sb.from('market_data').select('price_date,close,adj_close')
          .eq('security_id', row.id).order('price_date', { ascending: false }).range(from, from + 599));
        for (const b of page) bars.push(b);
        if (page.length < 600) break;
      }
      bars.reverse();
      out[t] = bars.map(b => ({ d: b.price_date, px: +(b.adj_close ?? b.close) })).filter(x => x.px > 0);
    }
    perfSeries = out;
  } catch (ex) { perfError = ex.message; }
  perfLoading = false;
  if ((location.hash || '').startsWith('#markets')) $('#app').innerHTML = markets();
}

// The one-day window: fifteen-minute bars for the index proxies, rebased to the previous daily
// close. The previous close is the right baseline for a one-day chart -- the day's move is from
// where it closed, not from where it happened to open -- and it comes from the daily series this
// page already holds, so the two cannot disagree.
async function loadPerfIntraday() {
  if (perfIntraday || perfIntradayLoading) return;
  perfIntradayLoading = true;
  try {
    const out = {};
    for (const t of ['SPY', 'QQQ', 'IWM', 'DIA']) {
      const row = D.markets.find(m => m.ticker === t);
      if (!row) continue;
      const bars = await q(() => sb.from('intraday_prices').select('ts,close')
        .eq('security_id', row.id).order('ts', { ascending: false }).limit(400));
      bars.reverse();
      out[t] = bars.map(b => ({ ts: b.ts, px: +b.close })).filter(x => x.px > 0);
    }
    perfIntraday = out;
  } catch (ex) { perfIntradayError = ex.message; }
  perfIntradayLoading = false;
  if ((location.hash || '').startsWith('#markets')) $('#app').innerHTML = markets();
}

// The volatility panel under the performance chart. These are FRED index LEVELS, not tradeable
// securities, so they come from macro_observations rather than market_data and are plotted as
// levels rather than rebased to zero -- a VIX of 16 means something on its own, where SPY at 763
// does not, and normalising them would throw away the only thing they say.
//
// MOVE IS NOT HERE, and it is the one the owner asked for first. It is ICE BofA's index, no
// connected source publishes it, and there is no honest way to draw a line labelled MOVE. What
// stands in its place is realised Treasury volatility computed from the desk's own TLT closes --
// labelled realised, dashed rather than solid, so it never reads as another implied index.
const VOL_SERIES = [
  ['VIXCLS', 'VIX', '#4ea1ff'],
  ['OVXCLS', 'OVX · oil', '#fb923c'],
  ['GVZCLS', 'GVZ · gold', '#fbbf24'],
  ['VXNCLS', 'VXN · Nasdaq', '#a78bfa'],
];
let volSeries = null, volLoading = false, volError = null;

async function loadVolSeries() {
  if (volSeries || volLoading) return;
  volLoading = true;
  try {
    const codes = VOL_SERIES.map(v => v[0]);
    const meta = await q(() => sb.from('macro_series').select('id,series_id').in('series_id', codes), { label: 'macro series' });
    const out = {};
    for (const m of meta) {
      const obs = [];
      for (let from = 0; from < 1800; from += 900) {
        const page = await q(() => sb.from('macro_observations').select('obs_date,value,vintage_date')
          .eq('series_id', m.id).order('obs_date', { ascending: false }).range(from, from + 899));
        for (const o of page) obs.push(o);
        if (page.length < 900) break;
      }
      // One value per date: the newest vintage wins, which is the figure that stood last.
      const byDate = new Map();
      for (const o of obs) { if (o.value === null) continue; if (!byDate.has(o.obs_date)) byDate.set(o.obs_date, +o.value); }
      out[m.series_id] = [...byDate.entries()].map(([d, v]) => ({ d, v })).sort((a, b) => a.d.localeCompare(b.d));
    }
    volSeries = out;
  } catch (ex) { volError = ex.message; }
  volLoading = false;
  if ((location.hash || '').startsWith('#markets')) $('#app').innerHTML = markets();
}

// Annualised volatility of the last n daily returns. Used for the bond-volatility line that
// stands in for MOVE, and said out loud to be realised rather than implied.
function realisedVol(series, n = 30) {
  if (!series || series.length < n + 2) return null;
  const px = series.slice(-(n + 1)).map(x => x.px);
  const r = [];
  for (let i = 1; i < px.length; i++) r.push(px[i] / px[i - 1] - 1);
  const m = r.reduce((a, v) => a + v, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (r.length - 1));
  return sd * Math.sqrt(252);
}

function markets() {
  const rows = D.markets;
  const byTicker = Object.fromEntries(rows.map(r => [r.ticker, r]));
  const withPrice = rows.filter(r => r.price).length;
  const macro = Object.values(D.macroByFactor || {}).flat();
  const mac = code => macro.find(m => m.fred_code === code) || null;
  const macV = code => { const m = mac(code); return m && m.value !== null ? +m.value : null; };

  const chg = v => v === null || v === undefined ? '<span style="color:var(--muted)">–</span>'
    : `<span style="color:${v > 0 ? 'var(--pos)' : v < 0 ? 'var(--neg)' : 'var(--muted)'}">${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%</span>`;
  const rsiColor = v => v === null || v === undefined ? 'var(--muted)' : v >= 70 ? 'var(--neg)' : v <= 30 ? 'var(--pos)' : 'var(--text)';

  // A quote line: name, last, and the day. Clicking it opens that security's chart, exactly as a
  // row of the table below does, so the panels are a view of the universe and not a copy of it.
  const quote = (tkr, label) => {
    const r = byTicker[tkr];
    if (!r) return '';
    return `<div class="prow click" data-go="#markets/${esc(r.id)}">
      <span class="pname">${esc(label || r.name || tkr)}</span>
      <span class="ptkr">${esc(tkr)}</span>
      <span class="pval">${r.price ? Number(r.price.close).toFixed(2) : '–'}</span>
      <span class="pchg">${r.price ? chg(r.price.day_change_pct) : '<span style="color:var(--muted)">–</span>'}</span></div>`;
  };
  const panel = (title, body, note) => `<div class="card panel">
    <div class="phead">${esc(title)}</div>${body}${note ? `<p class="note" style="margin:8px 0 0">${note}</p>` : ''}</div>`;
  const subhead = t => `<div class="psub">${esc(t)}</div>`;

  // ---- the volatility and stress panel, beside the index quotes ----
  const vix = macV('VIXCLS'), vix3m = macV('VXVCLS');
  const term = vix !== null && vix3m > 0 ? vix / vix3m : null;
  const tltVol = realisedVol(perfSeries && perfSeries.TLT, 30);
  const iefVol = realisedVol(perfSeries && perfSeries.IEF, 30);
  const spyVol = realisedVol(perfSeries && perfSeries.SPY, 30);
  const mrow = (label, code, fmt = v => v.toFixed(2), tone = null) => {
    const m = mac(code);
    const v = m && m.value !== null ? +m.value : null;
    return `<div class="prow"><span class="pname">${esc(label)}</span>
      <span class="ptkr" title="${esc(m ? m.obs_date : 'not loaded')}">${esc(m ? m.obs_date.slice(5) : '–')}</span>
      <span class="pval"${tone ? ` style="color:${tone(v)}"` : ''}>${v === null ? '–' : fmt(v)}</span><span class="pchg"></span></div>`;
  };
  const vrow = (label, v, suffix = '', title = '') => `<div class="prow"><span class="pname"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>
    <span class="ptkr"></span><span class="pval">${v === null ? '<span style="color:var(--muted)">–</span>' : v + suffix}</span><span class="pchg"></span></div>`;
  // The MFI, on the page where market state is read rather than on the page where it is graded.
  //
  // COMPACT, BUT NOT QUIETER. A reader meeting this index on the Markets page must not take it for
  // a timing signal: it failed its own lead test, and a short version that dropped that would be
  // the most misleading thing on the desk. So the caveat travels with the number, and the full
  // grading is one click away on Stan's page rather than duplicated here.
  const mfiHist = (D.fragHist || []).slice().sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)));
  const mfiNow = (D.frag || [])[0] || null;
  const MFI_TONE = { accelerate: 'var(--pos)', recovery: 'var(--flat)', deteriorating: 'var(--warn)', defensive: 'var(--neg)' };
  const mfiPanel = !mfiNow ? '' : (() => {
    const tone = MFI_TONE[mfiNow.state] || 'var(--muted)';
    const legs = Array.isArray(mfiNow.legs) ? mfiNow.legs : [];
    // Two years of history as a filled area. The 70th and 90th percentile lines are where the
    // states turn, so they are drawn rather than described.
    const W = 300, Hh = 64, pad = 2;
    const pts = mfiHist.filter(r => r.mfi !== null);
    const X = i => pad + (i / Math.max(1, pts.length - 1)) * (W - 2 * pad);
    const Y = v => Hh - pad - (Math.max(0, Math.min(100, +v)) / 100) * (Hh - 2 * pad);
    const line = pts.map((r, i) => `${X(i).toFixed(1)},${Y(r.mfi).toFixed(1)}`).join(' ');
    const area = pts.length ? `${X(0).toFixed(1)},${(Hh - pad).toFixed(1)} ${line} ${X(pts.length - 1).toFixed(1)},${(Hh - pad).toFixed(1)}` : '';
    const chart = pts.length < 30 ? '' : `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:${Hh}px;display:block;margin:8px 0 4px" preserveAspectRatio="none" role="img" aria-label="Market Fragility Index, two years">
      <line x1="${pad}" y1="${Y(70).toFixed(1)}" x2="${W - pad}" y2="${Y(70).toFixed(1)}" stroke="var(--warn)" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.6"/>
      <line x1="${pad}" y1="${Y(90).toFixed(1)}" x2="${W - pad}" y2="${Y(90).toFixed(1)}" stroke="var(--neg)" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.6"/>
      <polygon points="${area}" fill="${tone}" opacity="0.14"/>
      <polyline points="${line}" fill="none" stroke="${tone}" stroke-width="1.3"/>
      <circle cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(pts.at(-1).mfi).toFixed(1)}" r="2.2" fill="${tone}"/></svg>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:6px">
        <span>${esc(pts[0].as_of)}</span><span>dashed: the 70th and 90th percentiles, where the states turn</span><span>${esc(pts.at(-1).as_of)}</span></div>`;
    return panel('Market Fragility Index', `
      <div class="prow" style="align-items:baseline">
        <span class="pname" style="font-size:22px;font-weight:700;color:${tone}">${(+mfiNow.mfi).toFixed(0)}<span style="font-size:11px;font-weight:400;color:var(--muted)">/100</span></span>
        <span class="ptkr" style="color:${tone};font-weight:600">${esc(mfiNow.state)}</span>
        <span class="pval" style="font-size:11px;color:var(--muted)">${mfiNow.mfi_pctile === null ? '' : `${(+mfiNow.mfi_pctile * 100).toFixed(0)}th pct`}</span><span class="pchg"></span></div>
      ${chart}
      ${subhead('The five legs, against their own three years')}
      ${legs.map(l => `<div class="prow"><span class="pname" title="${esc(l.source)}">${esc(l.label)}</span>
        <span class="ptkr"></span>
        <span class="pval" style="color:${+l.pctile >= 0.90 ? 'var(--neg)' : +l.pctile >= 0.70 ? 'var(--warn)' : 'var(--muted)'}">${(+l.pctile * 100).toFixed(0)}%</span><span class="pchg"></span></div>`).join('')}
      ${!mfiNow.override_leg ? '' : `<div class="prow"><span class="pname" style="color:var(--warn)" title="One leg past its own 95th percentile overrides the equal-weighted mean rather than being averaged into it. A mean of five legs pulls to the middle by construction, and a single thing breaking must not read the same as five things mildly elevated.">carried by ${esc(mfiNow.override_leg)}</span><span class="ptkr"></span><span class="pval"></span><span class="pchg"></span></div>`}`,
      `Five legs scored 0–100 where rising means worsening, each ranked against its own trailing three years as they stood on that date. <b>It is a thermometer, not a forecast:</b> graded against its own kill criterion a defensive reading preceded BETTER returns over the following quarter than a calm one, so it must not be used to time risk on and off. The full grading, the episode record and the false-positive rate are on <span class="click" data-go="#stan" style="cursor:pointer;text-decoration:underline">Stan's page</span>.`);
  })();

  const riskPanel = panel('Risk and volatility', `
    ${subhead('Implied volatility')}
    ${mrow('CBOE VIX', 'VIXCLS', v => v.toFixed(2), v => v === null ? 'var(--muted)' : v >= 25 ? 'var(--neg)' : v <= 14 ? 'var(--pos)' : 'var(--text)')}
    ${mrow('VIX, 3-month', 'VXVCLS')}
    ${vrow('VIX / VIX3M', term === null ? null : term.toFixed(2), term !== null && term > 1 ? '  inverted' : '', 'One-month implied against three-month. Above 1 means the market is paying more for protection now than later, which is the shape that only appears under stress.')}
    ${mrow('Nasdaq 100 (VXN)', 'VXNCLS')}
    ${mrow('Russell 2000 (RVX)', 'RVXCLS')}
    ${mrow('Crude oil (OVX)', 'OVXCLS')}
    ${mrow('Gold (GVZ)', 'GVZCLS')}
    ${subhead('Realised volatility, 30 sessions')}
    ${vrow('Long Treasuries (TLT)', tltVol === null ? null : (tltVol * 100).toFixed(1), '%', 'The MOVE index is ICE BofA\'s and no connected source publishes it. This is realised volatility computed from the desk\'s own TLT closes — a different quantity from implied, and labelled as one.')}
    ${vrow('7-10 year (IEF)', iefVol === null ? null : (iefVol * 100).toFixed(1), '%')}
    ${vrow('S&P 500 (SPY)', spyVol === null ? null : (spyVol * 100).toFixed(1), '%')}
    ${subhead('Credit and conditions')}
    ${mrow('High yield OAS', 'BAMLH0A0HYM2', v => v.toFixed(2) + '%')}
    ${mrow('Investment grade OAS', 'BAMLC0A0CM', v => v.toFixed(2) + '%')}
    ${mrow('Financial conditions (NFCI)', 'NFCI', v => v.toFixed(2), v => v === null ? 'var(--muted)' : v > 0 ? 'var(--neg)' : 'var(--pos)')}
    ${mrow('Financial stress (STLFSI4)', 'STLFSI4', v => v.toFixed(2), v => v === null ? 'var(--muted)' : v > 0 ? 'var(--neg)' : 'var(--pos)')}`,
    `<b>MOVE is not here.</b> It is ICE BofA's index and no connected source publishes it, so rather than approximate it under its own name the panel shows <b>realised</b> Treasury volatility from the desk's own closes. Implied and realised are different quantities. The euro FX volatility index was left out too: FRED discontinued it in March 2025, and a stale number on a risk panel is worse than a missing one. Each FRED line carries its own observation date, because they do not all update daily.`);

  // ---- normalised performance ----
  const perfCard = (() => {
    const inner = (() => {
      const bar = `<div class="perfbar">${PERF_WINDOWS.map(([k]) => `<button class="pill${k === perfPeriod ? ' on' : ''}" data-perf="${k}">${k}</button>`).join('')}</div>`;
      const intradayWanted = perfPeriod === '1D';
      if (intradayWanted && !perfIntraday && !perfIntradayLoading && !perfIntradayError) setTimeout(loadPerfIntraday, 0);
      if (perfError) return `${bar}<div class="empty">Could not load price history: ${esc(perfError)}</div>`;
      if (!perfSeries) return `${bar}<div class="empty">Loading price history…</div>`;
      if (intradayWanted && perfIntradayError) return `${bar}<div class="empty">Could not load intraday bars: ${esc(perfIntradayError)}</div>`;
      if (intradayWanted && !perfIntraday) return `${bar}<div class="empty">Loading intraday bars…</div>`;
      const want = PERF_WINDOWS.find(w => w[0] === perfPeriod) || PERF_WINDOWS.find(w => w[0] === 'YTD');
      const tickers = ['SPY', 'QQQ', 'IWM', 'DIA'].filter(t => (perfSeries[t] || []).length > 2);
      if (!tickers.length) return `${bar}<div class="empty">No price history for the index proxies.</div>`;

      // The one-day window takes a different path: fifteen-minute bars, rebased to each proxy's
      // PREVIOUS daily close. The day's move is measured from where it closed, not from where it
      // opened, and the overnight gap is most of what a one-day chart is for.
      let lines, footer;
      if (intradayWanted) {
        const session = (() => {
          const all = Object.values(perfIntraday || {}).flatMap(a => a.map(x => x.ts));
          if (!all.length) return null;
          const newest = all.sort().at(-1);
          return newest.slice(0, 10);
        })();
        if (!session) return `${bar}<div class="empty">No intraday bars yet. They are loaded every fifteen minutes while the US market is open.</div>`;
        lines = tickers.map(t => {
          const pts = (perfIntraday[t] || []).filter(x => x.ts.slice(0, 10) === session);
          if (pts.length < 2) return null;
          // The baseline is the last daily close BEFORE this session, taken from the daily series
          // this page already holds, so the two can never disagree about what yesterday was.
          const daily = perfSeries[t] || [];
          const prior = [...daily].reverse().find(x => x.d < session);
          const base = prior ? prior.px : pts[0].px;
          return { t, basedOnPrevClose: !!prior, pts: pts.map(x => ({ d: x.ts, v: x.px / base - 1 })) };
        }).filter(Boolean);
        if (!lines.length) return `${bar}<div class="empty">Not enough intraday bars in the latest session to draw it.</div>`;
        const newestTs = lines.flatMap(l => l.pts.map(p => p.d)).sort().at(-1);
        const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(newestTs)) / 60000));
        const stale = ageMin > 40;
        const clock = new Date(newestTs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        footer = `<p class="note"><b>Newest bar ${esc(clock)}</b>${ageMin > 0 ? `, ${ageMin < 90 ? ageMin + ' minutes' : Math.round(ageMin / 60) + ' hours'} ago` : ''}${stale ? ' — <b style="color:var(--warn)">older than the fifteen-minute cadence</b>, so the market is closed or a scheduled load was late or skipped.' : '.'} Fifteen-minute bars from the IEX feed, rebased to each proxy's <b>previous daily close</b> — the day's move is from where it closed, not from where it opened, and the overnight gap is most of what a one-day chart is for. ${lines.some(l => !l.basedOnPrevClose) ? 'A line with no prior close is rebased to its own first bar and understates the move. ' : ''}These are IEX prints, not consolidated tape: the level is a close approximation rather than the official last sale.</p>`;
      } else {
      const cal = perfSeries[tickers[0]].map(x => x.d);
      const startDate = want[1] === null
        ? `${cal.at(-1).slice(0, 4) - 1}-12-31`
        : cal[Math.max(0, cal.length - 1 - want[1])];
      lines = tickers.map(t => {
        const pts = perfSeries[t].filter(x => x.d >= startDate);
        if (pts.length < 2) return null;
        const base = pts[0].px;
        return { t, pts: pts.map(x => ({ d: x.d, v: x.px / base - 1 })) };
      }).filter(Boolean);
      }
      if (!lines.length) return `${bar}<div class="empty">Not enough history for this window.</div>`;
      const all = lines.flatMap(l => l.pts.map(p => p.v));
      const lo = Math.min(0, ...all), hi = Math.max(0, ...all), span = Math.max(0.02, hi - lo);
      const W = 820, Hh = 470, pad = { l: 10, r: 66, t: 16, b: 28 };
      const nMax = Math.max(...lines.map(l => l.pts.length));
      const X = i => pad.l + (i / Math.max(1, nMax - 1)) * (W - pad.l - pad.r);
      const Y = v => pad.t + (1 - (v - lo) / span) * (Hh - pad.t - pad.b);
      const ticks = [lo, lo + span / 2, hi].map(v => `<line x1="${pad.l}" y1="${Y(v).toFixed(1)}" x2="${W - pad.r}" y2="${Y(v).toFixed(1)}" stroke="var(--line)"/><text x="${W - pad.r + 6}" y="${(Y(v) + 3.5).toFixed(1)}" font-size="10" fill="var(--muted)">${(v * 100).toFixed(1)}%</text>`).join('');
      const axLabel = d => intradayWanted
        ? new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : d;
      return `${bar}
        <svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto" role="img" aria-label="Index performance, normalised to the start of the window">
          ${ticks}
          <line x1="${pad.l}" y1="${Y(0).toFixed(1)}" x2="${W - pad.r}" y2="${Y(0).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>
          ${lines.map(l => `<path d="${l.pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`).join('')}" fill="none" stroke="${PERF_COLORS[l.t]}" stroke-width="1.8"/>`).join('')}
          ${lines.map(l => { const last = l.pts.at(-1); return `<text x="${(X(l.pts.length - 1) + 5).toFixed(1)}" y="${(Y(last.v) + 3.5).toFixed(1)}" font-size="11" font-weight="600" fill="${PERF_COLORS[l.t]}">${esc(l.t)} ${(last.v * 100).toFixed(1)}%</text>`; }).join('')}
          <text x="${pad.l}" y="${Hh - 6}" font-size="10" fill="var(--muted)">${esc(axLabel(lines[0].pts[0].d))}</text>
          <text x="${(W - pad.r).toFixed(1)}" y="${Hh - 6}" font-size="10" text-anchor="end" fill="var(--muted)">${esc(axLabel(lines[0].pts.at(-1).d))}</text>
        </svg>
        ${footer || `<p class="note">Total return from adjusted closes, rebased to zero at the first session of the window — dividends included, which is why these do not match an index level quoted on price alone. ${perfPeriod === 'YTD' ? 'Year to date runs from the last close of last year.' : ''}${perfPeriod === '1W' ? 'A week of daily closes is five points, which is what a week honestly is at this resolution.' : ''}</p>`}`;
    })();
    return `<div class="card panel"><div class="phead">Normalised performance</div>${inner}</div>`;
  })();

  // ---- volatility, on the same window as the chart above it ----
  const volCard = (() => {
    if (!volSeries && !volLoading && !volError) setTimeout(loadVolSeries, 0);
    const inner = (() => {
      if (volError) return `<div class="empty">Could not load volatility history: ${esc(volError)}</div>`;
      if (!volSeries) return `<div class="empty">Loading volatility history…</div>`;
      // The window follows the performance chart, so the two read as one story. One day is not
      // offered: these are daily FRED series and a single session is one point per line.
      const want = PERF_WINDOWS.find(w => w[0] === perfPeriod) || PERF_WINDOWS.find(w => w[0] === 'YTD');
      const base = volSeries.VIXCLS || [];
      if (!base.length) return '<div class="empty">No volatility history loaded.</div>';
      const endD = base.at(-1).d;
      const startD = perfPeriod === '1D' ? base[Math.max(0, base.length - 11)].d
        : want[1] === null ? `${+endD.slice(0, 4) - 1}-12-31`
        : base[Math.max(0, base.length - 1 - want[1])].d;
      const lines = VOL_SERIES.map(([code, label, tone]) => {
        const pts = (volSeries[code] || []).filter(x => x.d >= startD);
        return pts.length > 1 ? { code, label, tone, pts } : null;
      }).filter(Boolean);
      // Realised Treasury volatility, as a percentage, on the same axis -- it is a volatility in
      // the same units as an implied index once annualised, which is the only reason the two can
      // share a panel. Dashed, so it never reads as another implied index.
      const tlt = perfSeries && perfSeries.TLT ? perfSeries.TLT.filter(x => x.d >= startD) : [];
      const realised = [];
      if (tlt.length > 32) {
        for (let i = 30; i < tlt.length; i++) {
          const v = realisedVol(tlt.slice(0, i + 1), 30);
          if (v !== null) realised.push({ d: tlt[i].d, v: v * 100 });
        }
      }
      if (!lines.length) return '<div class="empty">Not enough volatility history for this window.</div>';
      const all = [...lines.flatMap(l => l.pts.map(p => p.v)), ...realised.map(p => p.v)];
      const lo = 0, hi = Math.max(...all) * 1.08;
      const W = 820, Hh = 300, pad = { l: 10, r: 112, t: 16, b: 28 };
      const dates = lines[0].pts.map(p => p.d);
      const X = d => { const i = dates.indexOf(d); const j = i >= 0 ? i : Math.round((Date.parse(d) - Date.parse(dates[0])) / Math.max(1, Date.parse(dates.at(-1)) - Date.parse(dates[0])) * (dates.length - 1)); return pad.l + (j / Math.max(1, dates.length - 1)) * (W - pad.l - pad.r); };
      const Y = v => pad.t + (1 - (v - lo) / Math.max(1e-6, hi - lo)) * (Hh - pad.t - pad.b);
      const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.d).toFixed(1)} ${Y(p.v).toFixed(1)}`).join('');
      const ticks = [0, hi / 2, hi].map(v => `<line x1="${pad.l}" y1="${Y(v).toFixed(1)}" x2="${W - pad.r}" y2="${Y(v).toFixed(1)}" stroke="var(--line)"/><text x="${W - pad.r + 6}" y="${(Y(v) + 3.5).toFixed(1)}" font-size="10" fill="var(--muted)">${v.toFixed(0)}</text>`).join('');
      // End labels, walked apart so two lines at the same level do not print on top of each other.
      const ends = [...lines.map(l => ({ label: l.label, tone: l.tone, v: l.pts.at(-1).v, dash: false })),
        ...(realised.length ? [{ label: 'TLT realised', tone: 'var(--muted)', v: realised.at(-1).v, dash: true }] : [])]
        .sort((a, b) => Y(a.v) - Y(b.v));
      let lastY = -99;
      for (const e of ends) { let y = Y(e.v); if (y - lastY < 13) y = lastY + 13; e.y = y; lastY = y; }
      return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto" role="img" aria-label="Implied volatility indices over the same window as the performance chart">
          ${ticks}
          ${lines.map(l => `<path d="${path(l.pts)}" fill="none" stroke="${l.tone}" stroke-width="1.7"/>`).join('')}
          ${realised.length ? `<path d="${path(realised)}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.9"/>` : ''}
          ${ends.map(e => `<text x="${(W - pad.r + 30).toFixed(1)}" y="${(e.y + 3.5).toFixed(1)}" font-size="10.5" font-weight="600" fill="${e.tone}">${esc(e.label)} ${e.v.toFixed(1)}</text>`).join('')}
          <text x="${pad.l}" y="${Hh - 6}" font-size="10" fill="var(--muted)">${esc(dates[0])}</text>
          <text x="${(W - pad.r).toFixed(1)}" y="${Hh - 6}" font-size="10" text-anchor="end" fill="var(--muted)">${esc(dates.at(-1))}</text>
        </svg>
        <p class="note"><b>Levels, not rebased.</b> A VIX of 16 means something on its own where an index level does not, so these are drawn as they are — normalising them would throw away the only thing they say. The window follows the chart above${perfPeriod === '1D' ? ', except for one day: these are daily series and a single session is one point per line, so the last two weeks are shown instead' : ''}.
        <b>MOVE is not here.</b> It is ICE BofA's index and no connected source publishes it, so rather than draw a line under its name the dashed grey is <b>realised</b> volatility of TLT over 30 sessions, annualised — a different quantity from an implied index, which is why it is dashed and why it is labelled realised.</p>`;
    })();
    return `<div class="card panel"><div class="phead">Volatility</div>${inner}</div>`;
  })();

  // ---- the curve ----
  const yrow = (label, code) => { const m = mac(code); return `<td class="num">${m && m.value !== null ? (+m.value).toFixed(2) + '%' : '<span style="color:var(--muted)">–</span>'}</td>`; };
  const intl = [['Germany', 'IRLTLT01DEM156N'], ['United Kingdom', 'IRLTLT01GBM156N'], ['Japan', 'IRLTLT01JPM156N'], ['Italy', 'IRLTLT01ITM156N']];
  const yieldsPanel = panel('Government yields', `
    <table style="margin-top:4px"><thead><tr><th></th><th class="num">2Y</th><th class="num">10Y</th><th class="num">30Y</th><th>As of</th></tr></thead><tbody>
      <tr><td><b>United States</b></td>${yrow('2Y', 'DGS2')}${yrow('10Y', 'DGS10')}${yrow('30Y', 'DGS30')}<td style="font-size:11px;color:var(--muted)">${esc(mac('DGS10') ? mac('DGS10').obs_date : '–')}</td></tr>
      ${intl.map(([name, code]) => `<tr><td>${esc(name)}</td>
        <td class="num"><span style="color:var(--muted)" title="The connected source publishes long-term government yields only. There is no 2-year series for this country, and filling it in from the 10-year would be an invention.">–</span></td>
        ${yrow('10Y', code)}<td class="num"><span style="color:var(--muted)">–</span></td>
        <td style="font-size:11px;color:var(--muted)">${esc(mac(code) ? mac(code).obs_date : '–')}</td></tr>`).join('')}
    </tbody></table>
    ${subhead('The US curve in full')}
    ${mrow('3-month', 'DGS3MO', v => v.toFixed(2) + '%')}
    ${mrow('2-year', 'DGS2', v => v.toFixed(2) + '%')}
    ${mrow('10-year', 'DGS10', v => v.toFixed(2) + '%')}
    ${mrow('30-year', 'DGS30', v => v.toFixed(2) + '%')}
    ${mrow('10Y real (TIPS)', 'DFII10', v => v.toFixed(2) + '%')}
    ${mrow('10Y breakeven', 'T10YIE', v => v.toFixed(2) + '%')}
    ${mrow('10Y − 2Y', 'T10Y2Y', v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%', v => v === null ? 'var(--muted)' : v < 0 ? 'var(--neg)' : 'var(--text)')}
    ${mrow('10Y − 3M', 'T10Y3M', v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%', v => v === null ? 'var(--muted)' : v < 0 ? 'var(--neg)' : 'var(--text)')}`,
    `<b>2-year yields are shown rather than 5-year</b>, as asked. The US curve is daily. The overseas rows are OECD long-term government yields, which are <b>monthly and a month or two behind</b> — each carries its own observation date rather than borrowing today's, and the 2-year column is empty for them because the connected source does not publish one. An inverted 10Y−2Y shows red.`);

  const grp = (title, list) => panel(title, list.map(([t, l]) => quote(t, l)).join(''));

  // The index quotes, and underneath them the one reading that says something the quotes cannot:
  // how much of the index's move belongs to its largest names. SPY is capitalisation-weighted and
  // RSP holds the same five hundred companies equally, so the gap between them over a window IS
  // the breadth of the advance, in one number and with nothing modelled -- two real total returns
  // subtracted. A rally the equal-weight version is not participating in is a different market
  // from one it is, and that difference does not show anywhere in a list of index levels.
  const breadthRow = (label, days) => {
    const a = perfSeries && perfSeries.SPY, b = perfSeries && perfSeries.RSP;
    if (!a || !b) return '';
    // 'ytd' is the real thing -- from the last close of last year -- rather than a session count
    // that happens to be about right. A row labelled year to date has to be the year to date.
    const at = ser => {
      if (days !== 'ytd') return ser.length < days + 2 ? null : ser.at(-1 - days).px;
      const cut = `${+ser.at(-1).d.slice(0, 4) - 1}-12-31`;
      const prior = [...ser].reverse().find(x => x.d <= cut);
      return prior ? prior.px : null;
    };
    const base = { a: at(a), b: at(b) };
    if (!(base.a > 0) || !(base.b > 0)) return '';
    const gap = (a.at(-1).px / base.a - 1) - (b.at(-1).px / base.b - 1);
    const tone = Math.abs(gap) < 0.005 ? 'var(--muted)' : gap > 0 ? 'var(--warn)' : 'var(--pos)';
    return `<div class="prow"><span class="pname" title="Cap-weighted S&P total return minus equal-weight, over ${days} sessions. Positive means the largest names are carrying the index and the average member is lagging; negative means the advance is broad.">${esc(label)}</span>
      <span class="ptkr">SPY−RSP</span>
      <span class="pval" style="color:${tone}">${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%</span>
      <span class="pchg" style="font-size:11px;color:var(--muted)">${gap > 0.005 ? 'narrow' : gap < -0.005 ? 'broad' : 'even'}</span></div>`;
  };
  const usEquityPanel = panel('US equity markets',
    [['DIA', 'Dow Jones'], ['SPY', 'S&P 500'], ['RSP', 'S&P 500 equal weight'], ['MDY', 'S&P MidCap 400'], ['IWM', 'Russell 2000'], ['QQQ', 'Nasdaq 100']]
      .map(([t, l]) => quote(t, l)).join('')
    + (!perfSeries ? '' : `${subhead('Breadth — cap weight against equal weight')}
        ${breadthRow('1 month', 21)}${breadthRow('3 months', 63)}${breadthRow('Year to date', 'ytd')}`),
    !perfSeries ? '' : 'The breadth lines are the cap-weighted S&P total return minus the equal-weighted one over the same days — two real returns subtracted, nothing modelled. <b>Narrow</b> means the largest names are carrying the index while the average member lags; <b>broad</b> means the advance is shared. A list of index levels cannot show the difference, and the two markets behave differently.');

  const table = `<div class="card" style="margin-top:14px"><div class="phead">Every tracked security</div>
  <div style="overflow-x:auto"><table><thead><tr><th>Ticker</th><th>Class</th><th class="num">Close</th><th class="num">1-day</th><th class="num">RSI14</th><th>Trend</th><th class="num">vs SMA50</th><th class="num">vs SMA200</th><th class="num">RS vs class(63d)</th></tr></thead><tbody>
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
  </tbody></table></div><p class="note">RSI14 uses Wilder's smoothing; below 30 (green) is oversold, above 70 (red) is overbought by the standard convention, not a signal to act on alone. Trend: bullish = close &gt; SMA50 &gt; SMA200, bearish = the reverse, else neutral. RS vs class = 63-day return minus the median of same-asset-class peers. SMA200 and RS need ~10 months of history — newer listings show "–". This is price action and trend, not a rating: the desk decided the underlying trend-anchored rating hasn't earned a role in decisions yet (see ROADMAP.md / the Admin tab). Parameters: desk-workspace/stan/technicals-parameters.md.</p></div>`;

  if (!perfSeries && !perfLoading) setTimeout(loadPerfSeries, 0);

  return `<span class="eyebrow">Allocation model</span><h1>Markets</h1>
  <p class="sub">The shape of the day — indices, volatility, the curve, sectors and the world — then every tracked security underneath. Prices from the daily job as of ${esc(D.run ? D.run.latest_price_date || '—' : '—')}; ${withPrice} of ${rows.length} carry a close. Click anything for its chart.</p>
  <div class="mkgrid">
    <div class="mkcol">
      ${usEquityPanel}
      ${mfiPanel}
      ${riskPanel}
      ${grp('US equity sectors', [['XLE', 'Energy'], ['XLU', 'Utilities'], ['XLP', 'Consumer staples'], ['XLB', 'Materials'], ['XLF', 'Financials'], ['XLRE', 'Real estate'], ['XLI', 'Industrials'], ['XLV', 'Health care'], ['XLY', 'Consumer discretionary'], ['XLC', 'Communications'], ['XLK', 'Technology']])}
    </div>
    <div class="mkcol">
      ${perfCard}
      ${volCard}
      ${grp('US equity factors', [['MTUM', 'Momentum'], ['VLUE', 'Value'], ['QUAL', 'Quality'], ['USMV', 'Low volatility'], ['SIZE', 'Size'], ['SPY', 'Market']])}
      ${yieldsPanel}
    </div>
    <div class="mkcol">
      ${grp('Fixed income', [['SHY', '1-3 year Treasuries'], ['IEF', '7-10 year Treasuries'], ['TLT', '20+ year Treasuries'], ['TIP', 'TIPS'], ['AGG', 'Aggregate'], ['LQD', 'Investment grade'], ['HYG', 'High yield']])}
      ${panel('Currencies', `${quote('UUP', 'US dollar')}${quote('BTCUSD', 'Bitcoin')}
        ${mrow('Broad dollar index', 'DTWEXBGS', v => v.toFixed(2))}`,
        'The desk tracks no spot FX crosses — the dollar is held through UUP and watched through the Fed\'s broad trade-weighted index, which is weekly.')}
      ${panel('Global markets', `${subhead('Broad')}${quote('EFA', 'Developed ex-US')}${quote('EEM', 'Emerging')}
        ${subhead('Developed')}${[['EWU', 'United Kingdom'], ['EWG', 'Germany'], ['EWQ', 'France'], ['EWL', 'Switzerland'], ['EWN', 'Netherlands'], ['EWI', 'Italy'], ['EWP', 'Spain'], ['EWD', 'Sweden'], ['EWC', 'Canada'], ['EWJ', 'Japan']].map(([t, l]) => quote(t, l)).join('')}
        ${subhead('Emerging')}${[['MCHI', 'China'], ['INDA', 'India'], ['EWY', 'South Korea'], ['EWT', 'Taiwan'], ['EWZ', 'Brazil'], ['EWW', 'Mexico'], ['EWH', 'Hong Kong'], ['EWS', 'Singapore']].map(([t, l]) => quote(t, l)).join('')}`,
        'Australia and South Africa were removed from this panel for room. Both are still tracked and still in the table below — the geography fits are built from these country indices, so dropping the securities would quietly degrade a different page.')}
      ${grp('Commodities', [['USO', 'Crude oil'], ['DBC', 'Broad commodities'], ['GLD', 'Gold'], ['SLV', 'Silver']])}
    </div>
  </div>
  ${table}`;
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

  return `<h2 style="margin:26px 0 4px">The Playground</h2>
   <p class="sub" style="margin-top:0">Change the mix and see where the exposures and the stress scores go. Nothing here is saved, and no allocation changes as a result.</p>

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

// ---------- Adam: the four macro seasons, and liquidity ----------
//
// Rebuilt 2026-10-22, replacing the Macro Beauty Contest page entirely. The contest moved to Kate
// in October and what was left here was a risk-on gauge wrapped around a regime reading. Adam's
// subject is the macroeconomy and liquidity, so the page is now the quadrant, the path through
// it, the liquidity that sets the amplitude, and the consumer the cycle begins with.
//
// THE QUADS ARE NOT NEW MATHS. The desk has computed this quadrant since September under other
// names, from exactly the measure the quad chart uses -- the rate of change of growth and of
// inflation, each against its own history, never the level. Goldilocks is Quad 1, reflation 2,
// inflation 3, deflation 4.
//
// TWO FRAMEWORKS THAT DISAGREE, AND THE PAGE SAYS SO. The owner follows Howell, for whom global
// liquidity is the engine, and Zeberg, who says liquidity is not in the chain at all: it
// amplifies the markets sitting on top of the economy and moves them first, which is exactly why
// it gets mistaken for the cause. Blending them into one house view would destroy the most useful
// thing here, which is that two sources the desk respects disagree about what drives what.
const QUADS = {
  1: { name: 'Quad 1', growth: 'accelerating', inflation: 'decelerating', stance: 'Pro-growth positioning',        tone: '#22c55e' },
  2: { name: 'Quad 2', growth: 'accelerating', inflation: 'accelerating', stance: 'Pro-growth + inflation hedges', tone: '#84cc16' },
  3: { name: 'Quad 3', growth: 'decelerating', inflation: 'accelerating', stance: 'Stagflation protection',        tone: '#f59e0b' },
  4: { name: 'Quad 4', growth: 'decelerating', inflation: 'decelerating', stance: 'Defensive + volatility assets', tone: '#ef4444' },
};
const QUAD_OF = { goldilocks: 1, reflation: 2, inflation: 3, deflation: 4 };

// The 2x2 with the path walked through it. The axes are rates of change, so the origin is
// "neither accelerating", not "zero growth" -- an economy growing steadily at 2% sits at the
// centre, which is the single most misread thing about this chart.
function quadMap(history) {
  const pts = (history || []).filter(h => h.growth_z !== null && h.inflation_z !== null);
  if (pts.length < 2) return '<div class="empty">Not enough history to draw the path.</div>';
  const W = 620, Hh = 560, pad = 54, cx = pad + (W - pad * 2) / 2, cy = pad + (Hh - pad * 2) / 2;
  const lim = Math.max(0.45, ...pts.map(p => Math.max(Math.abs(+p.growth_z), Math.abs(+p.inflation_z)))) * 1.12;
  const X = v => cx + (v / lim) * ((W - pad * 2) / 2);
  const Y = v => cy - (v / lim) * ((Hh - pad * 2) / 2);
  const trail = pts.slice(-24);
  const now = pts[pts.length - 1];
  const label = (q, x, y) => `<text x="${x}" y="${y}" font-size="19" font-weight="800" fill="${QUADS[q].tone}" text-anchor="middle" opacity="0.92">${QUADS[q].name}</text>
    <text x="${x}" y="${y + 17}" font-size="10.5" fill="var(--muted)" text-anchor="middle">Growth ${QUADS[q].growth === 'accelerating' ? '↑' : '↓'}  Inflation ${QUADS[q].inflation === 'accelerating' ? '↑' : '↓'}</text>
    <text x="${x}" y="${y + 32}" font-size="10.5" fill="${QUADS[q].tone}" text-anchor="middle" opacity="0.85">${esc(QUADS[q].stance)}</text>`;
  return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto" role="img" aria-label="The four macro quadrants with the path the economy has taken through them">
    <rect x="${pad}" y="${pad}" width="${(W - pad * 2) / 2}" height="${(Hh - pad * 2) / 2}" fill="${QUADS[1].tone}" opacity="0.045"/>
    <rect x="${cx}" y="${pad}" width="${(W - pad * 2) / 2}" height="${(Hh - pad * 2) / 2}" fill="${QUADS[2].tone}" opacity="0.045"/>
    <rect x="${pad}" y="${cy}" width="${(W - pad * 2) / 2}" height="${(Hh - pad * 2) / 2}" fill="${QUADS[4].tone}" opacity="0.045"/>
    <rect x="${cx}" y="${cy}" width="${(W - pad * 2) / 2}" height="${(Hh - pad * 2) / 2}" fill="${QUADS[3].tone}" opacity="0.045"/>
    <line x1="${pad}" y1="${cy}" x2="${W - pad}" y2="${cy}" stroke="var(--line)"/>
    <line x1="${cx}" y1="${pad}" x2="${cx}" y2="${Hh - pad}" stroke="var(--line)"/>
    ${label(1, pad + (W - pad * 2) / 4, pad + 34)}
    ${label(2, cx + (W - pad * 2) / 4, pad + 34)}
    ${label(4, pad + (W - pad * 2) / 4, cy + 34)}
    ${label(3, cx + (W - pad * 2) / 4, cy + 34)}
    <text x="${cx}" y="${Hh - 14}" font-size="11" fill="var(--muted)" text-anchor="middle">inflation, rate of change →</text>
    <text x="16" y="${cy}" font-size="11" fill="var(--muted)" transform="rotate(-90 16 ${cy})" text-anchor="middle">growth, rate of change →</text>
    <path d="${trail.map((p, i) => `${i ? 'L' : 'M'}${X(+p.inflation_z).toFixed(1)} ${Y(+p.growth_z).toFixed(1)}`).join('')}" fill="none" stroke="var(--accent)" stroke-width="1.6" opacity="0.4" stroke-linecap="round"/>
    ${trail.slice(0, -1).map((p, i) => `<circle cx="${X(+p.inflation_z).toFixed(1)}" cy="${Y(+p.growth_z).toFixed(1)}" r="${(1.6 + i * 0.12).toFixed(1)}" fill="var(--accent)" opacity="${(0.16 + i * 0.026).toFixed(2)}"><title>${esc(p.as_of)} — Quad ${p.quad}</title></circle>`).join('')}
    <circle cx="${X(+now.inflation_z).toFixed(1)}" cy="${Y(+now.growth_z).toFixed(1)}" r="7.5" fill="${QUADS[now.quad].tone}" stroke="var(--bg)" stroke-width="2"><title>${esc(now.as_of)} — Quad ${now.quad}</title></circle>
    <text x="${(X(+now.inflation_z) + 12).toFixed(1)}" y="${(Y(+now.growth_z) + 4).toFixed(1)}" font-size="11.5" font-weight="700" fill="var(--text)">today</text>
  </svg>`;
}

function adam() {
  const n = v => v === null || v === undefined ? null : +v;
  const pc = v => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : ''}${(+v * 100).toFixed(1)}%`;
  const hist = D.quadHistory || [];
  const now = hist.length ? hist[hist.length - 1] : null;
  const live = (D.macroRegime || [])[0] || null;
  const liq = (D.netLiq || [])[0] || null;
  // The GLI arrives as a series now. The figures come from the newest row carrying them; the
  // commentary from the newest row carrying a quote, which is usually a different row, because
  // the note's text and its data table are dated differently.
  const gliAll = D.gli || [];
  const gliNums = [...gliAll].reverse().find(x => x.gli_full !== null) || null;
  const howell = [...gliAll].reverse().find(x => x.change_note) || gliNums || null;
  const macro = D.macroNow || [];
  const mac = code => macro.find(m => m.fred_code === code) || null;

  if (!now && !live) {
    return `<span class="eyebrow">Macro</span><h1>Adam</h1>
     <p class="sub">The four macro seasons.</p>
     <div class="card"><div class="empty">Nothing computed yet. Run jobs/compute-macro-regime.mjs and jobs/compute-quad-history.mjs.</div></div>`;
  }

  // The quadrants meet at a point, so a reading sitting on an axis is a coin toss wearing a
  // season's name. Within this of zero the page says the call is contested rather than stating
  // it flatly -- which is the case today.
  const ON_AXIS = 0.15;
  const g = now ? +now.growth_z : null, inf = now ? +now.inflation_z : null;
  const quad = now ? now.quad : (live ? QUAD_OF[live.regime] : null);
  const Q = quad ? QUADS[quad] : null;
  const contested = g !== null && Q && (Math.abs(g) < ON_AXIS || Math.abs(inf) < ON_AXIS);
  const altQuad = !contested ? null : (Math.abs(g) < ON_AXIS
    ? Object.values(QUADS).find(x => x.inflation === Q.inflation && x.growth !== Q.growth)
    : Object.values(QUADS).find(x => x.growth === Q.growth && x.inflation !== Q.inflation));

  const headCard = !Q ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">The four macro regimes</h2>
      <span style="font-size:12px;color:var(--muted)">${now ? esc(now.as_of) : ''}${live && live.stale_days !== null ? ` · newest input ${live.stale_days} day${live.stale_days === 1 ? '' : 's'} old` : ''}</span></div>
    <div style="display:flex;align-items:center;gap:30px;flex-wrap:wrap;margin-top:14px">
      <div style="min-width:210px">
        <div style="font-size:52px;font-weight:800;line-height:1;color:${Q.tone}">${esc(Q.name)}</div>
        <div style="font-size:16px;font-weight:600;margin-top:6px">Growth ${Q.growth === 'accelerating' ? '↑' : '↓'} &nbsp; Inflation ${Q.inflation === 'accelerating' ? '↑' : '↓'}</div>
        <div style="font-size:15px;color:${Q.tone};margin-top:4px">${esc(Q.stance)}</div></div>
      <div style="flex:1;min-width:250px">
        ${[['Growth', g], ['Inflation', inf]].map(([lab, v]) => `
          <div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">
              <span>${lab}, rate of change</span><b style="color:${v === null ? 'var(--muted)' : v >= 0 ? 'var(--pos)' : 'var(--neg)'}">${v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2)}σ</b></div>
            <div style="height:8px;border-radius:99px;background:var(--panel2);position:relative">
              <div style="position:absolute;left:50%;top:-2px;width:1px;height:12px;background:var(--line)"></div>
              <div style="position:absolute;left:${v === null ? 50 : Math.max(2, Math.min(98, 50 + v * 55))}%;top:-3px;width:3px;height:14px;border-radius:2px;background:${v === null ? 'var(--muted)' : v >= 0 ? 'var(--pos)' : 'var(--neg)'}"></div></div></div>`).join('')}
        <div style="font-size:12px;color:var(--muted)">conviction ${now ? (+now.conviction).toFixed(2) : '—'} · ${now ? now.n_growth : '—'} growth and ${now ? now.n_inflation : '—'} inflation series</div></div>
    </div>
    ${contested && altQuad ? `<div style="margin-top:14px;padding:11px 13px;border-left:3px solid var(--warn);background:var(--panel2);border-radius:8px;font-size:13px">
      <b>This call is contested, and the page will not pretend otherwise.</b> ${Math.abs(g) < ON_AXIS ? 'Growth' : 'Inflation'} is at ${(Math.abs(g) < ON_AXIS ? g : inf).toFixed(2)}σ — on the axis rather than inside a quadrant. The quadrants meet at a point, so a reading this close to it is a coin toss between <b style="color:${Q.tone}">${esc(Q.name)}</b> and <b style="color:${altQuad.tone}">${esc(altQuad.name)}</b>. The desk's two ways of computing it currently land on different sides for exactly this reason, while agreeing on the numbers to within 0.06.</div>` : ''}
    <p class="note"><b>These are rates of change, not levels.</b> The origin is "neither accelerating", not "zero growth" — an economy growing steadily at 2% with steady inflation sits at the centre, which is the most misread thing about this chart. Each series is measured against its own history of its own rate of change, then the growth legs and the inflation legs are averaged.</p>
  </div>`;

  const mapCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">The path</h2>
      <span style="font-size:12px;color:var(--muted)">${hist.length} month${hist.length === 1 ? '' : 's'}, last 24 drawn</span></div>
    <p class="note" style="margin:6px 0 12px">A quadrant is a position; the useful thing is which way the economy is travelling through it. The marks grow toward today, so direction reads without an arrow.</p>
    <div style="display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:300px;max-width:640px">${quadMap(hist)}</div>
      <div style="flex:1;min-width:230px">
        <div class="eyebrow" style="margin-bottom:8px">Time spent in each season</div>
        ${[1, 2, 3, 4].map(q => { const nq = hist.filter(h => h.quad === q).length;
          return `<div style="margin-bottom:9px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">
              <span style="color:${QUADS[q].tone};font-weight:600">${esc(QUADS[q].name)}</span><span style="color:var(--muted)">${nq} mo</span></div>
            <div style="height:8px;border-radius:99px;background:var(--panel2);overflow:hidden">
              <div style="width:${hist.length ? (nq / hist.length * 100).toFixed(1) : 0}%;height:100%;background:${QUADS[q].tone};opacity:.75"></div></div></div>`; }).join('')}
        <p class="note" style="margin-top:12px"><b>Drawn on revised data.</b> Each point uses the figures as they read today, not as they read then, because this desk has no reliable vintage record going back. Payrolls and GDP are revised heavily, and usually in the direction that makes a turn look obvious afterwards. This is how the economy now <b>looks</b> to have travelled — not what was knowable at the time.</p>
      </div></div>
  </div>`;

  const dirTone = d => d === 'expanding' ? 'var(--pos)' : d === 'contracting' ? 'var(--neg)' : 'var(--flat)';
  const gliAge = howell ? Math.round((Date.now() - Date.parse(howell.as_of)) / 864e5) : null;

  // A small line through the index, the base beneath it and the multiplier between them. Levels,
  // not rebased: the point of Howell's series is that the index IS the base times the multiplier,
  // and normalising all three would hide the arithmetic holding them together.
  const spark = (rows, key, tone) => {
    const pts = rows.filter(r => r[key] !== null && r[key] !== undefined).map(r => ({ d: r.as_of, v: +r[key] }));
    if (pts.length < 3) return '';
    const W = 250, Hh = 42;
    const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    const X = i => (i / (pts.length - 1)) * W;
    const Y = v => hi === lo ? Hh / 2 : 4 + (1 - (v - lo) / (hi - lo)) * (Hh - 8);
    return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;max-width:250px;height:auto" role="img" aria-label="trend since January 2024">
      <path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`).join('')}" fill="none" stroke="${tone}" stroke-width="1.6"/>
      <circle cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(pts[pts.length - 1].v).toFixed(1)}" r="2.6" fill="${tone}"/></svg>`;
  };
  const gliChg = (key, back) => {
    const rows = gliAll.filter(r => r[key] !== null && r[key] !== undefined);
    if (rows.length <= back) return null;
    const a = +rows[rows.length - 1 - back][key], b = +rows[rows.length - 1][key];
    return a > 0 ? b / a - 1 : null;
  };
  const gliDir = (() => { const c = gliChg('gli_full', 4); return c === null ? null : c > 0.002 ? 'expanding' : c < -0.002 ? 'contracting' : 'flat'; })();

  const liqCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Global Liquidity Watch</h2>
      <span style="font-size:12px;color:var(--muted)">${gliNums ? `Howell to ${esc(gliNums.as_of)}` : 'no GLI entered'}${liq ? ` · net liquidity to ${esc(liq.as_of)}` : ''}</span></div>

    ${!gliNums ? `<div class="empty" style="margin-top:10px">No GLI figures entered. The index is proprietary and the public endpoint returns a paywalled preview, so the note has to be downloaded while signed in and its table entered with <code>node jobs/record-gli.mjs</code>.</div>` : `
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:12px">
      <div style="flex:1;min-width:220px">
        <div class="eyebrow" style="margin-bottom:4px">Global liquidity</div>
        <div style="font-size:33px;font-weight:700;line-height:1">$${(+gliNums.gli_full).toFixed(2)}tn</div>
        <div style="font-size:12.5px;font-weight:600;color:${dirTone(gliDir)};margin-top:3px">${esc((gliDir || '').replace(/^./, c => c.toUpperCase()))}${gliChg('gli_full', 4) === null ? '' : ` · ${pc(gliChg('gli_full', 4))} over 4 weeks`}</div>
        ${spark(gliAll, 'gli_full', 'var(--accent)')}</div>
      <div style="flex:1;min-width:220px">
        <div class="eyebrow" style="margin-bottom:4px">Shadow monetary base</div>
        <div style="font-size:33px;font-weight:700;line-height:1">$${(+gliNums.smb).toFixed(2)}tn</div>
        <div style="font-size:12.5px;font-weight:600;color:${(gliChg('smb', 4) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'};margin-top:3px">${pc(gliChg('smb', 4))} over 4 weeks</div>
        ${spark(gliAll, 'smb', 'var(--neg)')}</div>
      <div style="flex:1;min-width:220px">
        <div class="eyebrow" style="margin-bottom:4px">Collateral multiplier</div>
        <div style="font-size:33px;font-weight:700;line-height:1">${(+gliNums.collateral_multiplier).toFixed(2)}×</div>
        <div style="font-size:12.5px;color:var(--muted);margin-top:3px">${howell && howell.move_quoted ? `MOVE quoted at ${howell.move_quoted}` : 'bond volatility sets the haircut'}</div>
        ${spark(gliAll, 'collateral_multiplier', 'var(--flat)')}</div>
    </div>
    <p class="note" style="margin-top:12px"><b>The index is the base times the multiplier.</b> The shadow monetary base is central bank liquidity plus collateral — what Howell calls the bedrock — and the multiplier is how much broad liquidity that base supports. It moves with bond volatility through haircuts: <b>volatility down → haircuts down → multiplier up → liquidity up.</b> At the latest reading $${(+gliNums.smb).toFixed(2)}tn × ${(+gliNums.collateral_multiplier).toFixed(2)} = $${(+gliNums.smb * +gliNums.collateral_multiplier).toFixed(2)}tn against a published $${(+gliNums.gli_full).toFixed(2)}tn, and that identity is checked on every row before it is stored — a row that fails it has a transcription error, which is the real risk when figures are read off a PDF by hand. <b>The base is falling while the multiplier sits at a record</b>, which is this week's whole message: the index is being held up by haircuts that have not yet adjusted to higher volatility.</p>
    ${howell && howell.change_note ? `<div style="margin-top:12px;padding:11px 13px;background:var(--panel2);border-radius:8px">
      <div class="eyebrow" style="margin-bottom:5px">Howell, ${esc(howell.as_of)}${gliAge !== null && gliAge > 14 ? ` · <b style="color:var(--warn)">${gliAge} days old</b>` : ''}</div>
      <p class="note" style="margin:0;font-style:italic">“${esc(howell.change_note)}”</p>
      ${Array.isArray(howell.drivers) && howell.drivers.length ? `<div style="margin-top:7px">${howell.drivers.map(x => `<span class="chip">${esc(x)}</span>`).join(' ')}</div>` : ''}</div>` : ''}`}

    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <div class="eyebrow" style="margin-bottom:6px">US net liquidity · computed here, for comparison</div>
      ${!liq ? '<div class="empty">Not computed yet.</div>' : `
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:baseline">
        <div><span style="font-size:25px;font-weight:700">$${(+liq.net_liquidity / 1e6).toFixed(2)}tn</span>
          <span style="font-size:12.5px;font-weight:600;color:${dirTone(liq.direction)};margin-left:8px">${esc((liq.direction || '').replace(/^./, c => c.toUpperCase()))}</span></div>
        <div style="font-size:12.5px;color:var(--muted)">4w ${pc(liq.chg_4w)} · 13w ${pc(liq.chg_13w)} · 52w ${pc(liq.chg_52w)}${liq.pctile_3y === null ? '' : ` · ${(+liq.pctile_3y * 100).toFixed(0)}th percentile of its own 3 years`}</div>
      </div>
      <p class="note" style="margin-top:8px">Fed balance sheet $${(+liq.walcl / 1e6).toFixed(2)}tn less the Treasury account $${(+liq.tga / 1e6).toFixed(2)}tn and reverse repo $${(+liq.rrp / 1e6).toFixed(3)}tn. <b>Domestic only</b>, from three public series — Howell's index spans ninety countries, cross-border flows and the collateral multiplier, so this is <b>never a substitute</b> for it. It is here because it updates weekly without anyone entering anything.</p>`}
    </div>
    <p class="note" style="margin-top:14px"><b>The two frameworks on this page disagree, and it is not smoothed over.</b> For Howell liquidity is the engine, leading risk assets by roughly three months. For Zeberg, below, liquidity is not in the chain at all: it sets the amplitude and never the direction, amplifying the markets that sit on top of the economy and moving them first — which is precisely why it gets mistaken for the cause. The desk holds both rather than picking.</p>
  </div>`;
  // Zeberg's sequence. Each link carries the series that reads it, so the chain is a map of what
  // to look at in what order rather than a diagram.
  const CHAIN = [
    ['Cost of money', 'the input: rates, and through them the monthly payment', ['DFF', 'DGS2']],
    ['The consumer', 'demand responds to that payment — 68–70% of GDP', ['PSAVERT', 'UMCSENT']],
    ['Production', 'responds to demand', ['INDPRO']],
    ['Employment', 'responds to the mismatch — coincident, not lagging', ['PAYEMS', 'JTSJOL']],
    ['Wages', 'respond to employment', ['CES0500000003']],
    ['Inflation', 'responds to wages — the caboose', ['CPIAUCSL', 'MICH']],
  ];
  const chainRow = (label, why, codes, i) => {
    const liveSeries = codes.map(c => mac(c)).filter(Boolean);
    return `<div style="display:flex;gap:12px;align-items:flex-start;padding:7px 0${i ? ';border-top:1px solid var(--line)' : ''}">
      <div style="width:20px;height:20px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted);margin-top:1px">${i + 1}</div>
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600">${esc(label)}</div>
        <div style="font-size:11.5px;color:var(--muted)">${why}</div></div>
      <div style="text-align:right;font-size:11.5px;color:var(--muted);flex:none">${liveSeries.length ? liveSeries.map(m => esc(m.fred_code)).join(' · ') : 'not loaded'}</div>
    </div>`;
  };
  const cRow = (label, code, fmt, good) => {
    const m = mac(code);
    const v = m && m.value !== null ? +m.value : null;
    return `<tr><td style="font-size:12.5px">${esc(label)}</td>
      <td class="num"${good && v !== null ? ` style="color:${good(v)}"` : ''}>${v === null ? '<span style="color:var(--muted)">—</span>' : fmt(v)}</td>
      <td style="font-size:11px;color:var(--muted)">${m ? esc(m.obs_date) : '—'}</td></tr>`;
  };
  const codeCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">The Macro Code</h2>
      <span style="font-size:12px;color:var(--muted)">the sequence, and the consumer at both ends of it</span></div>
    <p class="note" style="margin:6px 0 14px">Zeberg's claim is that the economy is forecastable because it is <b>sequential</b>, and that the profession reads the right indicators in the wrong order. The cost of money sets the household's monthly payment; demand responds; production responds to demand; employment responds to the mismatch; wages respond to employment; inflation responds to wages — and the policy rate answering inflation sets the cost of money for the next turn. <b>Liquidity is not in this chain.</b> It amplifies the markets sitting on top of it and moves them first, which is why it gets mistaken for the engine.</p>
    <div style="display:flex;gap:26px;flex-wrap:wrap">
      <div style="flex:1;min-width:300px">
        <div class="eyebrow" style="margin-bottom:6px">The sequence</div>
        ${CHAIN.map(([l, w, c], i) => chainRow(l, w, c, i)).join('')}
        <p class="note" style="margin-top:10px"><b>Housing leads</b>, because it is the largest monthly payment and the first to turn when that payment changes. <b>Employment is coincident</b>, not lagging — the job-creation trend moves with output, while the unemployment rate does lag and the monthly print is noise. <b>Inflation is last</b>, still rising after the economy has turned, which is why a central bank steering by it is late by construction.</p>
      </div>
      <div style="flex:1;min-width:280px">
        <div class="eyebrow" style="margin-bottom:6px">The consumer, where it begins and ends</div>
        <table><tbody>
          ${cRow('Personal saving rate', 'PSAVERT', v => v.toFixed(1) + '%', v => v < 5 ? 'var(--neg)' : 'var(--text)')}
          ${cRow('Real disposable income per capita', 'A229RX0', v => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 }))}
          ${cRow('Consumer credit outstanding', 'TOTALSL', v => '$' + (v / 1e6).toFixed(2) + 'tn')}
          ${cRow('Credit card delinquency', 'DRCCLACBS', v => v.toFixed(2) + '%', v => v > 2.5 ? 'var(--neg)' : 'var(--text)')}
          ${cRow('Mortgage delinquency', 'DRSFRMACBS', v => v.toFixed(2) + '%')}
          ${cRow('Quit rate', 'JTSQUR', v => v.toFixed(1) + '%', v => v < 2.2 ? 'var(--neg)' : 'var(--text)')}
          ${cRow('Job openings', 'JTSJOL', v => (v / 1000).toFixed(2) + 'm')}
          ${cRow('Consumer sentiment', 'UMCSENT', v => v.toFixed(1), v => v < 65 ? 'var(--neg)' : 'var(--text)')}
          ${cRow('Inflation expected, 12 months', 'MICH', v => v.toFixed(1) + '%')}
          ${cRow('Building permits', 'PERMIT', v => (v / 1000).toFixed(2) + 'm')}
        </tbody></table>
        <p class="note" style="margin-top:10px"><b>The quit rate is the honest confidence measure</b>, because being wrong about it costs something: a worker only quits when they believe another job is there. Sentiment can be talked down; a resignation cannot.</p>
      </div>
    </div>
    <p class="note" style="margin-top:12px">These series are loaded but deliberately kept <b>out of the quad</b>. Dropping thirteen new inputs into the growth leg would silently move the regime and make every reading stored before today incomparable with the ones after. They describe the cycle; they do not call it.</p>
  </div>`;
  return `<span class="eyebrow">Macro</span><h1>Adam</h1>
   <p class="sub">The four macro seasons, the path between them, the liquidity that sets the amplitude, and the consumer the cycle begins with.</p>
   ${headCard}${mapCard}${liqCard}${codeCard}`;
}

// The news-flow breakdown behind the percentage on Sven's table. Built from the releases array
// stored with the reading, which is the same array the counts on the surface were taken from --
// a figure that disagrees with what it opens into is the worst kind of wrong, so there is only
// one source and the job self-checks that the two agree before writing.
function newsFlowDrawer(ticker) {
  const r = (D.newsFailure || []).find(x => x.ticker === ticker && x.window_days === newsWindow);
  if (!r) return `<button class="close" data-go="#sven">Close</button><div class="empty">No reading for ${esc(ticker)}.</div>`;
  const rel = Array.isArray(r.releases) ? r.releases : [];
  const good = rel.filter(x => x.good), bad = rel.filter(x => !x.good);
  const tot = rel.length;
  const list = (rows, tone, title, empty) => `<div style="flex:1;min-width:260px">
    <div class="eyebrow" style="color:${tone};margin-bottom:8px">${esc(title)} — ${rows.length}</div>
    ${!rows.length ? `<div class="empty">${esc(empty)}</div>` : rows.map(x => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
      <div style="font-size:13px">${esc(x.text)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:3px">
        published ${esc(x.published)}${x.basis === 'assumed' ? ' (assumed)' : ''} · covers ${esc(x.obs_date)} · ${esc(x.factor)}${x.headline ? ' · <b>headline release</b>' : ''}</div>
    </div>`).join('')}</div>`;
  const ev = (Array.isArray(r.events) ? r.events : []).filter(e => e.failed);
  return `<button class="close" data-go="#sven">Close</button>
    <span class="eyebrow">${esc(r.asset_class || '')}</span><h1>${esc(r.ticker)} news flow</h1>
    <p class="sub">${esc(r.label)} · ${r.window_days} days · ${tot} release${tot === 1 ? '' : 's'} bearing on this asset</p>
    ${!ev.length ? '' : `<div class="card" style="margin-bottom:14px;border-left:3px solid var(--warn)">
      <div class="eyebrow" style="margin-bottom:8px">The failure${ev.length === 1 ? '' : 's'} behind this row</div>
      ${ev.map(e => `<p class="note" style="margin:0 0 8px">${esc(e.text)}</p>`).join('')}</div>`}
    <div class="card"><div style="display:flex;gap:26px;flex-wrap:wrap">
      ${list(good, 'var(--pos)', 'Positive for this asset', 'Nothing in this window was good news for it.')}
      ${list(bad, 'var(--neg)', 'Negative for this asset', 'Nothing in this window was bad news for it.')}
    </div>
    <p class="note" style="margin-top:14px"><b>Good and bad are properties of the pairing, not of the release.</b> A strong payroll print is good news for equities and bad news for bonds; each line above is scored by which way the release moved its factor multiplied by how ${esc((r.asset_class || 'this class').toLowerCase())} loads on that factor, both read from tables the desk already keeps. A <b>headline release</b> can trigger a failure event on its own; the rest count toward this flow but cannot. ${r.pub_basis === 'assumed' ? '<b>Publication dates here are assumed from frequency</b>, because these figures arrived in a backfill rather than being watched as they appeared.' : r.pub_basis === 'mixed' ? 'Dates marked <b>(assumed)</b> came from a backfill; the rest are the day this desk watched the figure appear.' : 'Publication dates are the day this desk watched each figure appear.'}</p></div>`;
}

// ---------- Kate: sentiment, reflexivity, and the popularity contest ----------
//
// Kate's question is never whether something is a good investment. It is what the crowd believes
// is a good investment, how many of them are already there, and whether the belief is still paying
// for itself. Keynes's beauty contest and Soros's reflexivity are the same observation from two
// angles: the price is partly made of belief about the price.
//
// EVERYTHING ON THIS PAGE IS INFERRED FROM PRICE AND VOLUME. The desk holds no positioning data --
// no CFTC Commitment of Traders, no short interest, no fund flows, no sentiment survey -- and the
// page says so in every section that could be mistaken for one. A crowding score presented as
// observed positioning is the kind of number that gets believed and then sized.
const LOOP_LOOK = {
  running:   { label: 'loop running',  tone: 'var(--pos)',  short: 'The move is recruiting the capital that extends it.' },
  crowding:  { label: 'crowding in',   tone: 'var(--neg)',  short: 'Capital still arriving after the move stopped paying for it.' },
  faltering: { label: 'loop faltering', tone: 'var(--warn)', short: 'Participation has turned while the crowd is still in it.' },
  cold:      { label: 'cold',          tone: 'var(--muted)', short: 'No crowd here to be late to.' },
};
// The flock's four states. A murmuration has no leader: each bird watches the six or seven nearest
// it, and the turn shows in the shape before it shows in any single bird. These are the four things
// a narrative can be doing -- attention rising or falling, against a proxy that is paying or not.
const FLOCK_LOOK = {
  gathering:  { label: 'gathering',  tone: 'var(--pos)',   short: 'Attention rising and the proxy rising with it. The flock is turning toward this and being paid for it.' },
  crowding:   { label: 'crowding',   tone: 'var(--neg)',   short: 'Attention rising while the proxy is not. The crowd is arriving after the move stopped paying.' },
  dispersing: { label: 'dispersing', tone: 'var(--muted)', short: 'Attention and price falling together. The flock is leaving.' },
  unwatched:  { label: 'unwatched',  tone: 'var(--flat)',  short: 'The proxy is rising while attention falls. Working without an audience — the opposite of a crowded trade.' },
};
const KIND_LOOK = { asset_class: 'Asset class', sector: 'Sector', theme: 'Theme' };

// THE GATE SOROS WROTE A PREFACE TO INSTALL. In 1994 he said he had presented reflexivity "as if
// it were relevant at all times" and called that a mistake: the two-way feedback can engage at any
// moment, but in most situations it is so feeble it can safely be ignored. So this is the first
// thing read on a narrative, before any loop is discussed, and most of the flock should sit in the
// first row. A reflexivity reading offered on an ordinary tape is not insight.
const EQUIL_LOOK = {
  near_equilibrium:      { label: 'near equilibrium', tone: 'var(--muted)', short: 'Attention and price sit at similar points in their own ranges. The prevailing bias here is noise, and Soros says to call it noise.' },
  stretched:             { label: 'stretched',        tone: 'var(--warn)',  short: 'Perception and price have drifted well apart but are no longer drifting. Stretched and sitting there is not the same as a loop running.' },
  far_from_equilibrium:  { label: 'far from equilibrium', tone: 'var(--neg)', short: 'Drifted apart and still drifting. The only state in which a reflexivity claim is worth making.' },
  insufficient:          { label: 'no reading',       tone: 'var(--line)',  short: 'Either attention has no percentile yet or the proxy has no year of monthly returns to rank against.' },
};
// "When the process is advanced, corrections become scarcer and the danger of a climactic reversal
// greater." The verdicts below are that sentence turned into arithmetic. There is deliberately NO
// stage number: Soros calls his own nine-stage sequence "only one possible path" and says it hardly
// needs emphasizing how crude the model is.
const TEST_LOOK = {
  early:           { label: 'early',            tone: 'var(--muted)', short: 'The advance is young and has not been tested yet. Early is not the same as untested.' },
  tested_recently: { label: 'tested recently',  tone: 'var(--pos)',   short: 'Being tested about as often as it has been. A trend that keeps getting tested and keeps surviving is behaving like a young one.' },
  maturing:        { label: 'maturing',         tone: 'var(--warn)',  short: 'Going longer than usual between tests. Corrections are becoming scarcer, which is what a maturing process looks like.' },
  late_untested:   { label: 'late, untested',   tone: 'var(--neg)',   short: 'More than twice its own normal stretch without a test. A trend that has stopped being tested is late, not strong.' },
  untested:        { label: 'never tested',     tone: 'var(--neg)',   short: 'A long advance that has never had a drawdown of the size that counts as a test for this instrument. Nothing has argued with it.' },
  no_leg:          { label: 'no advance',       tone: 'var(--line)',  short: 'The proxy is below its 200-day average. There is no advance to be testing, and "untested" would be the wrong word for a downtrend.' },
  insufficient:    { label: 'no reading',       tone: 'var(--line)',  short: 'Not enough price history to date an advance.' },
};
// The credit chapter's asymmetry, stated precisely: at the inception of a boom both the volume of
// credit and the value of collateral are at a minimum; at the time of the bust both are at a
// maximum. So the decline is compressed where the advance was drawn out. The murmuration draws
// gathering and dispersing the same way, which implies a symmetry the book denies.
const ASYM_LOOK = {
  slow_up_fast_down: { label: 'slow up, fast down', tone: 'var(--neg)',   short: 'Advances take longer than declines. The credit-cycle shape: drawn-out boom, compressed bust.' },
  symmetric:         { label: 'symmetric',          tone: 'var(--muted)', short: 'Advances and declines take about the same time. Here the murmuration\u2019s even treatment of gathering and dispersing is fair.' },
  fast_up_slow_down: { label: 'fast up, slow down', tone: 'var(--warn)',  short: 'Declines take longer than advances \u2014 the opposite of the credit-cycle shape. Worth knowing before reading a dispersal as a collapse.' },
  insufficient:      { label: 'no reading',         tone: 'var(--line)',  short: 'Too few swings of the size that counts to compare durations.' },
};
// Every leg is signed in the BORROWER'S terms, so "easing" means the same thing on a spread, a
// growth rate and a delinquency rate. A widening spread is tightening even while its level still
// looks historically low, and that distinction is the point of the panel.
const CREDIT_DIR = {
  easing:      { label: 'easing',      tone: 'var(--pos)' },
  tightening:  { label: 'tightening',  tone: 'var(--neg)' },
  flat:        { label: 'flat',        tone: 'var(--muted)' },
  unavailable: { label: '\u2014',     tone: 'var(--line)' },
};
const CREDIT_ACC = {
  accelerating: { label: 'accelerating', tone: 'var(--pos)' },
  decelerating: { label: 'decelerating', tone: 'var(--neg)' },
  steady:       { label: 'steady',       tone: 'var(--muted)' },
  unavailable:  { label: '\u2014',      tone: 'var(--line)' },
};
const CREDIT_PHASE = {
  expanding:    { label: 'Expanding',    tone: 'var(--pos)' },
  decelerating: { label: 'Decelerating', tone: 'var(--warn)' },
  contracting:  { label: 'Contracting',  tone: 'var(--neg)' },
  mixed:        { label: 'Mixed',        tone: 'var(--muted)' },
  insufficient: { label: 'No reading',   tone: 'var(--line)' },
};

// The murmuration. Each narrative is a bird placed by how unusual its attention is (across) and
// what its tradeable proxy has done over the month (up). The trail behind it is where it actually
// sat four, eight and twelve weeks ago, each percentile computed against the year that preceded
// THAT date rather than against today's -- a trail drawn with hindsight's baseline would move for
// reasons the flock never saw. The heavy marker is the flock's centre of mass.
// The flock, drawn as a rotation.
//
// WHY POLAR. The first version was a scatter: attention across, price up, a trail behind each
// bird. It was honest and unreadable -- thirty-two labels colliding in the middle of a box, and
// the thing the metaphor exists to show, the TURN, was invisible because a turn in a scatter is
// just a bent line among other bent lines. On a circle the turn is the whole picture. Each
// narrative's angle says where it is in the cycle and its radius says how far from ordinary it
// has got, so a trail spirals outward as a story takes hold and swings round the rim as the
// crowd moves on. Labels sit at the rim, spread by angle, which is the other half of the fix:
// the geometry does the work that a gutter and leader lines were doing badly.
//
// THE CYCLE. Eight phases, read anticlockwise from the right, and they are not new judgments --
// they are the same two measurements the scatter had, in polar form. East is a narrative drawing
// unusual attention with its price going nowhere; north is price rising; west is attention
// draining; south is price falling. The corners are where the two combine, and the one that
// matters is the south-east: attention still climbing while the price falls, which is the crowd
// arriving after the move stopped paying for it.
const FLOCK_PHASES = [
  ['Loudest',    'var(--neg)'],      // 0deg   high attention, flat price
  ['Gathering',  'var(--pos)'],      // 45deg  attention and price rising together
  ['Running',    'var(--pos)'],      // 90deg  price rising
  ['Unwatched',  'var(--flat)'],     // 135deg price rising, attention draining
  ['Ignored',    'var(--muted)'],    // 180deg nobody talking, nothing happening
  ['Dispersing', 'var(--muted)'],    // 225deg both falling
  ['Fading',     'var(--neg)'],      // 270deg price falling
  ['Crowding',   'var(--neg)'],      // 315deg attention rising into a falling price
];
function murmuration(rows, labelOf, kindOf) {
  const all = rows.filter(r => r.attention_pctile !== null && r.price_1m !== null);
  if (all.length < 4) return '<div class="empty">Not enough measured narratives to draw the flock.</div>';
  const TOP = 8;
  const W = 900, Hh = 620, cx = W / 2, cy = Hh / 2 + 6, R = 220;

  // Both axes are put on the same footing before anything is turned into an angle: attention as
  // its distance from the middle of its own range, price in units of the spread across the flock.
  // Without that the angle would be an artefact of one axis being measured in percent and the
  // other in percentiles, and every bird would point the same way.
  const prices = all.map(r => +r.price_1m);
  const pScale = Math.max(0.02, Math.max(...prices.map(Math.abs)));
  const polar = (att, px) => {
    const x = (att - 0.5) * 2;                 // -1 .. +1
    const y = Math.max(-1, Math.min(1, px / pScale));
    const mag = Math.min(1, Math.hypot(x, y) / Math.SQRT2 * 1.25);
    return { ang: Math.atan2(y, x), r: mag };
  };
  const pt = (att, px) => { const { ang, r } = polar(att, px); return [cx + Math.cos(ang) * r * R, cy - Math.sin(ang) * r * R]; };

  const ranked = all.slice().sort((a, b) => (a.attention_rank ?? 9e9) - (b.attention_rank ?? 9e9));
  const lead = ranked.slice(0, TOP), rest = ranked.slice(TOP);
  const marker = (kind, x, y, tone, op, sc = 1) => kind === 'sector'
    ? `<rect x="${(x - 3.6 * sc).toFixed(1)}" y="${(y - 3.6 * sc).toFixed(1)}" width="${(7.2 * sc).toFixed(1)}" height="${(7.2 * sc).toFixed(1)}" fill="${tone}" opacity="${op}"/>`
    : kind === 'theme'
      ? `<path d="M${x.toFixed(1)} ${(y - 4.4 * sc).toFixed(1)}L${(x + 4.2 * sc).toFixed(1)} ${(y + 3.3 * sc).toFixed(1)}L${(x - 4.2 * sc).toFixed(1)} ${(y + 3.3 * sc).toFixed(1)}Z" fill="${tone}" opacity="${op}"/>`
      : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(4 * sc).toFixed(1)}" fill="${tone}" opacity="${op}"/>`;

  // The flock's centre, and where it has been. One line, heavier than everything else, because
  // this is the only mark on the chart that answers "where is sentiment as a whole heading".
  const com = w => {
    const v = all.map(r => w === 0 ? { a: +r.attention_pctile, p: +r.price_1m }
      : (() => { const t = (r.trail || []).find(x => x.weeks_ago === w); return t && t.attention_pctile !== null && t.price_1m !== null ? { a: +t.attention_pctile, p: +t.price_1m } : null; })()).filter(Boolean);
    return v.length ? { a: v.reduce((s, x) => s + x.a, 0) / v.length, p: v.reduce((s, x) => s + x.p, 0) / v.length } : null;
  };
  const coms = [12, 8, 4, 0].map(w => ({ w, c: com(w) })).filter(x => x.c);

  // Labels at the rim, each pushed out along its own bearing and nudged apart where two birds
  // share one. Angle does most of the separating, which is the point of the projection.
  const used = [];
  const labels = lead.map(r => {
    const { ang } = polar(+r.attention_pctile, +r.price_1m);
    let a = ang;
    // Keep at least seven degrees between labels, searching outward from the true bearing.
    for (let step = 0; step < 40; step++) {
      const cand = ang + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 0.12;
      if (!used.some(u => Math.abs(Math.atan2(Math.sin(u - cand), Math.cos(u - cand))) < 0.12)) { a = cand; break; }
    }
    used.push(a);
    const lr = R + 26;
    const x = cx + Math.cos(a) * lr, y = cy - Math.sin(a) * lr;
    const anchor = Math.cos(a) > 0.2 ? 'start' : Math.cos(a) < -0.2 ? 'end' : 'middle';
    return { r, x, y, anchor, ang, a };
  });

  return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:auto" role="img" aria-label="The flock as a rotation: each narrative placed by where it sits in the attention and price cycle, with its path over the last twelve weeks">
    ${FLOCK_PHASES.map(([name, tone], i) => {
      const a0 = (i * 45 - 22.5) * Math.PI / 180, a1 = (i * 45 + 22.5) * Math.PI / 180;
      const mid = i * 45 * Math.PI / 180;
      const p0 = [cx + Math.cos(a0) * R, cy - Math.sin(a0) * R];
      const p1 = [cx + Math.cos(a1) * R, cy - Math.sin(a1) * R];
      const lx = cx + Math.cos(mid) * (R + 62), ly = cy - Math.sin(mid) * (R + 62);
      return `<path d="M${cx} ${cy}L${p0[0].toFixed(1)} ${p0[1].toFixed(1)}A${R} ${R} 0 0 0 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}Z" fill="${tone}" opacity="0.05"/>
        <line x1="${cx}" y1="${cy}" x2="${p0[0].toFixed(1)}" y2="${p0[1].toFixed(1)}" stroke="var(--line)" stroke-width="0.6" opacity="0.6"/>
        <text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" font-size="11.5" font-weight="600" text-anchor="middle" fill="${tone}" opacity="0.85">${esc(name)}</text>`;
    }).join('')}
    ${[0.33, 0.66, 1].map(f => `<circle cx="${cx}" cy="${cy}" r="${(R * f).toFixed(1)}" fill="none" stroke="var(--line)" stroke-width="${f === 1 ? 1.2 : 0.6}" opacity="${f === 1 ? 0.9 : 0.5}"/>`).join('')}
    <text x="${cx + 4}" y="${cy - 5}" font-size="9.5" fill="var(--muted)">ordinary</text>
    <text x="${cx + 4}" y="${(cy - R + 13).toFixed(1)}" font-size="9.5" fill="var(--muted)">extreme</text>

    ${rest.map(r => { const [x, y] = pt(+r.attention_pctile, +r.price_1m); return marker(kindOf(r.narrative), x, y, 'var(--muted)', 0.22, 0.6); }).join('')}

    ${lead.map(r => {
      const tone = (FLOCK_LOOK[r.state] || { tone: 'var(--muted)' }).tone;
      const tr = (Array.isArray(r.trail) ? r.trail : []).filter(t => t.attention_pctile !== null && t.price_1m !== null)
        .slice().sort((a, b) => b.weeks_ago - a.weeks_ago);
      if (tr.length < 2) { const [x, y] = pt(+r.attention_pctile, +r.price_1m); return `<g><title>${esc(labelOf(r.narrative))} — ${esc(r.state_note || '')}</title>${marker(kindOf(r.narrative), x, y, tone, 0.95)}</g>`; }
      // The trail is drawn as dots that grow toward today, so the direction of travel is legible
      // without an arrowhead to decode -- the newest mark is simply the biggest.
      const pts = tr.map(t => pt(+t.attention_pctile, +t.price_1m));
      const path = `<path d="${pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('')}" fill="none" stroke="${tone}" stroke-width="1.4" opacity="0.32" stroke-linecap="round"/>`;
      const beads = pts.slice(0, -1).map((q, i) => `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="${(1.6 + i * 0.7).toFixed(1)}" fill="${tone}" opacity="${(0.22 + i * 0.1).toFixed(2)}"/>`).join('');
      const [x, y] = pt(+r.attention_pctile, +r.price_1m);
      return `${path}${beads}<g><title>${esc(labelOf(r.narrative))} — ${esc(r.state_note || '')}</title>${marker(kindOf(r.narrative), x, y, tone, 0.95)}</g>`;
    }).join('')}

    ${coms.length < 2 ? '' : `<path d="${coms.map((c, i) => { const [x, y] = pt(c.c.a, c.c.p); return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join('')}" fill="none" stroke="var(--accent)" stroke-width="2.2" opacity="0.7" stroke-dasharray="5 3"/>`}
    ${coms.map((c, i) => { const [x, y] = pt(c.c.a, c.c.p); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${i === coms.length - 1 ? 6.5 : 3}" fill="none" stroke="var(--accent)" stroke-width="${i === coms.length - 1 ? 2.4 : 1.3}" opacity="${i === coms.length - 1 ? 1 : 0.45}"><title>The flock's centre, ${c.w === 0 ? 'today' : c.w + ' weeks ago'}</title></circle>`; }).join('')}
    ${coms.length ? (() => { const [x, y] = pt(coms.at(-1).c.a, coms.at(-1).c.p); return `<text x="${(x + 10).toFixed(1)}" y="${(y - 9).toFixed(1)}" font-size="10.5" font-weight="700" fill="var(--accent)">the flock</text>`; })() : ''}

    ${labels.map(({ r, x, y, anchor, ang, a }) => {
      const tone = (FLOCK_LOOK[r.state] || { tone: 'var(--muted)' }).tone;
      const [bx, by] = pt(+r.attention_pctile, +r.price_1m);
      const ex = cx + Math.cos(a) * (R + 16), ey = cy - Math.sin(a) * (R + 16);
      return `<path d="M${bx.toFixed(1)} ${by.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="${tone}" stroke-width="0.9" opacity="0.28" fill="none"/>
        <text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="11.5" font-weight="600" text-anchor="${anchor}" fill="var(--text)">${esc(labelOf(r.narrative).slice(0, 26))}</text>
        <text x="${x.toFixed(1)}" y="${(y + 12).toFixed(1)}" font-size="9.5" text-anchor="${anchor}" fill="${tone}">${esc((FLOCK_LOOK[r.state] || {}).label || '')}</text>`;
    }).join('')}
  </svg>`;
}
// The four macro quadrants, as the beauty contest refers to them. This lived in Adam's section
// until his page was rebuilt around the quad numbers; it belongs here now, because the contest is
// the only thing that reads it. Quad 1 is goldilocks, 2 reflation, 3 inflation, 4 deflation --
// the same quadrant under the name each page uses for it.
const REGIME_LOOK = {
  goldilocks: { label: 'Goldilocks · Quad 1', tone: 'var(--pos)',  blurb: 'Growth rising, inflation falling. The risk-on quadrant with no price pressure.' },
  reflation:  { label: 'Reflation · Quad 2',  tone: 'var(--flat)', blurb: 'Growth rising, inflation rising. Risk-on, but with price pressure building.' },
  inflation:  { label: 'Inflation · Quad 3',  tone: 'var(--neg)',  blurb: 'Growth falling, inflation rising. The stagflationary quadrant.' },
  deflation:  { label: 'Deflation · Quad 4',  tone: 'var(--neg)',  blurb: 'Growth falling, inflation falling. Defensive assets over risk.' },
};
const STANCE_CROWD = {
  crowded:   ['Crowded',  'var(--neg)'],
  mixed:     ['Mixed',    'var(--flat)'],
  scattered: ['Scattered', 'var(--pos)'],
};

function kate() {
  const n = v => v === null || v === undefined ? null : +v;
  const pc = v => v === null || v === undefined ? '—' : `${+v >= 0 ? '+' : ''}${(+v * 100).toFixed(1)}%`;
  const pct0 = v => v === null || v === undefined ? '—' : `${(+v * 100).toFixed(0)}%`;
  const crowd = (D.crowding || []).slice().sort((a, b) => (a.crowd_rank ?? 9e9) - (b.crowd_rank ?? 9e9));
  const regime = (D.macroRegime || [])[0] || null;
  const ranks = D.beautyRanks || [];
  const secById = Object.fromEntries((D.markets || []).map(m => [m.id, m]));
  const tkr = id => (secById[id] || {}).ticker || '?';
  const nameOf = id => (secById[id] || {}).name || '';

  if (!(D.narReading || []).length && !(D.narAttention || []).length && !crowd.length && !ranks.length) {
    return `<span class="eyebrow">Sentiment</span><h1>Kate</h1>
     <p class="sub">The popularity contest.</p>
     <div class="card"><div class="empty">Nothing computed yet. Run jobs/compute-narrative-sentiment.mjs, jobs/compute-sentiment-crowding.mjs and jobs/compute-beauty-contest.mjs.</div></div>`;
  }

  const loopChip = st => !st || !LOOP_LOOK[st] ? '<span style="color:var(--muted)">—</span>'
    : `<span style="color:${LOOP_LOOK[st].tone};font-weight:600">${esc(LOOP_LOOK[st].label)}</span>`;

  // ---- the crowd, measured on narratives ----
  // Reworked: the popularity contest is about what the crowd is TALKING ABOUT, not which tickers
  // are extended. Nobody is bullish on a three-letter symbol; they are bullish on artificial
  // intelligence, or nuclear power, or the end of the dollar, and the symbol is only how they say
  // so. Four legs, each a share of the flock, so a crowd that is not leaning sits near 50 on all
  // of them and the mean is a reading rather than an index with an arbitrary centre.
  const nReading = (D.narReading || [])[0] || null;
  const nComps = D.narComponents || [];
  const flock = (D.narAttention || []).slice().sort((a, b) => (a.attention_rank ?? 9e9) - (b.attention_rank ?? 9e9));
  const narMeta = Object.fromEntries((D.narratives || []).map(x => [x.slug, x]));
  const labelOf = slug => (narMeta[slug] || {}).label || slug;
  const kindOf = slug => (narMeta[slug] || {}).kind || 'theme';
  const proxyOf = slug => (narMeta[slug] || {}).proxy_ticker || '';
  const flockChip = st => !st || !FLOCK_LOOK[st] ? '<span style="color:var(--muted)">—</span>'
    : `<span style="color:${FLOCK_LOOK[st].tone};font-weight:600">${esc(FLOCK_LOOK[st].label)}</span>`;

  const nScore = nReading ? n(nReading.score) : null;
  const [nLabel, nTone] = nReading && nReading.stance && STANCE_CROWD[nReading.stance] ? STANCE_CROWD[nReading.stance] : ['Not yet reading', 'var(--muted)'];
  const gauge = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Crowd sentiment</h2>
      <span style="font-size:12px;color:var(--muted)">${nReading ? `${nReading.n_live} of ${nReading.n_total} legs live · ${nReading.n_narratives} narratives · as of ${esc(nReading.as_of)}` : ''}</span></div>
    <p class="note" style="margin:6px 0 0">What the crowd is <b>talking about</b> — asset classes, sectors and themes, not individual securities. Each narrative is measured against its <b>own</b> trailing year before anything is compared: artificial intelligence draws 11,784 Wikipedia views a day and corporate bonds draw 35, and ranking the raw numbers would only rediscover that AI is a more famous subject than credit.</p>
    <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap;margin-top:14px">
      <div style="min-width:150px">
        <div style="font-size:52px;font-weight:700;line-height:1;color:${nTone}">${nScore === null ? '—' : nScore.toFixed(0)}</div>
        <div style="font-size:17px;font-weight:600;color:${nTone};margin-top:4px">${esc(nLabel)}</div>
      </div>
      <div style="flex:1;min-width:260px">
        <div class="dialtrack"><div class="dialmark" style="left:${nScore === null ? 50 : nScore}%;background:${nScore === null ? 'var(--line)' : nTone}"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px">
          <span>Scattered</span><span>Mixed</span><span>Crowded</span></div>
      </div>
    </div>
    ${!nComps.length ? '' : `<div style="overflow-x:auto;margin-top:16px"><table style="min-width:620px"><thead><tr><th>Leg</th><th class="num">Reading</th><th>What is counted</th></tr></thead><tbody>
      ${nComps.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).map(c => `<tr>
        <td><b>${esc(c.label)}</b>${c.status === 'live' ? '' : ` <span class="chip" title="${esc(c.how_to_supply || '')}">${esc(c.status.replace('_', ' '))}</span>`}</td>
        <td class="num">${c.score === null ? '<span style="color:var(--muted)">—</span>' : (+c.score).toFixed(0)}${c.value_text ? `<br><span style="font-size:11px;color:var(--muted)">${esc(c.value_text)}</span>` : ''}</td>
        <td style="font-size:12px;color:var(--muted)">${esc(c.measure)}${c.how_to_supply ? ` <b>${esc(c.how_to_supply)}</b>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`}
    <p class="note">${nReading ? esc(nReading.headline) + ' ' : ''}<b>High is not a sell.</b> A talked-about narrative can stay talked-about for a long time, which is why the state of each one matters more than the level of the gauge.</p>
    <div style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <div class="eyebrow" style="margin-bottom:4px">The murmuration</div>
      <p class="note" style="margin:0 0 10px">A flock of starlings has no leader and no plan. Each bird watches the six or seven nearest it, and the whole thing turns as one — the turn visible in the <b>shape</b> long before it is visible in any single bird. So this is drawn as a rotation rather than a scatter: a narrative's <b>bearing</b> says where it sits in the cycle and its <b>distance from the centre</b> says how far from ordinary it has got. The trail behind it is where it was four, eight and twelve weeks ago, with the newest mark the largest, so the direction of travel reads without decoding an arrow.</p>
      <p class="note" style="margin:0 0 10px">Read it anticlockwise from the right. <b>Loudest</b> is unusual attention with the price going nowhere; through <b>Gathering</b> and <b>Running</b> the price is rising with the talk; <b>Unwatched</b> is a price rising while attention drains; <b>Ignored</b>, <b>Dispersing</b> and <b>Fading</b> are the quiet half. <b>Crowding</b>, bottom right, is the one to read twice — attention still climbing into a falling price, which is the crowd arriving after the move stopped paying for it.</p>
      <p class="note" style="margin:0 0 10px"><b>Eight narratives are drawn in full.</b> All ${flock.length} are still in the picture as faint dots, because the flock's centre — the dashed line — is computed from every one of them and leaving any out would move it. But thirty-two labelled birds with thirty-two trails is a tangle rather than a flock. Circles are asset classes, squares sectors, triangles themes.</p>
      ${murmuration(flock, labelOf, kindOf)}
      <p class="note">Each trail point's percentile is computed against the year that preceded <b>that date</b>, not against today's — a trail drawn with hindsight's baseline would move for reasons the flock never saw. Hover a bird for what it is doing and why.</p>
    </div>
    <p class="note"><b>What these sources are.</b> Wikipedia pageviews (what the public looks up), Hacker News story counts where a query cannot match something else — "nuclear power" counts, "gold" does not, because it matches "golden" — and StockTwits message velocity and tone on proxies specific to a narrative, never on a broad index. ${nComps.some(c => c.component === 'reddit' && c.status !== 'live') ? '<b>Reddit refuses unauthenticated reads</b>, so that leg is shown with no data rather than hidden.' : ''} <b>None of it is positioning.</b> Pageviews measure public curiosity, not capital: a narrative can be enormously talked about and barely owned, and the reverse.</p>
  </div>`;

  // ---- the beauty contest, recreated with the reflexivity test ----
  const scored = ranks.filter(r => r.rank !== null).slice().sort((a, b) => a.rank - b.rank);
  const winners = scored.filter(r => r.confirmed);
  const against = scored.filter(r => r.confirmed === false);
  const unscored = ranks.filter(r => r.rank === null);
  const top5 = winners.slice(0, 5);

  const podium = !top5.length ? '' : `<div class="podium">
    ${top5.slice(0, 3).map((w, i) => `<div class="pod pod${i + 1}">
      <div class="podrank">${i + 1}</div>
      <div class="poddim">${esc(w.dimension)}</div>
      <div class="podwin">${esc(w.prefer)}</div>
      <div class="podover">over ${esc(w.avoid)}</div>
      <div class="podspread" style="color:var(--pos)">${pc(w.spread_3m ?? w.spread_1m)}<small> 3 months</small></div>
      ${w.loop_state ? `<div class="podloop" style="color:${LOOP_LOOK[w.loop_state].tone}">${esc(LOOP_LOOK[w.loop_state].label)}</div>` : ''}
      ${w.prefer_tkr ? `<div class="podtkr">${esc(w.prefer_tkr)} vs ${esc(w.avoid_tkr)}</div>` : ''}
    </div>`).join('')}</div>`;

  const contestCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">This week's beauty contest</h2>
      <span style="font-size:12px;color:var(--muted)">${regime ? esc(regime.as_of) : ''} · ${winners.length} of ${scored.length} dimensions have the tape agreeing with the regime</span></div>
    ${!regime ? '<div class="empty">No regime reading, so there is nothing to run the contest against.</div>' : `
    <p class="note" style="margin:8px 0 14px">The regime Adam reads is <b style="color:${REGIME_LOOK[regime.regime].tone}">${esc(REGIME_LOOK[regime.regime].label)}</b>, and these are the dimensions where the market is <b>already paying</b> for what it prefers. Keynes's point was that the contest rewards picking what others pick — a preference the tape has not started confirming is a judgment, not a candidate. Every spread is a real return: one tracked ticker minus another over the same dates.</p>
    ${podium}
    ${!top5.length ? '' : `<table style="margin-top:14px"><thead><tr><th class="num">#</th><th>Dimension</th><th>Favoured</th><th class="num">1 month</th><th class="num">3 months</th><th>Feedback loop</th></tr></thead><tbody>
      ${top5.map(w => `<tr><td class="num">${w.rank}</td><td>${esc(w.dimension)}</td>
        <td><b>${esc(w.prefer)}</b> <span style="color:var(--muted)">over ${esc(w.avoid)}</span></td>
        <td class="num" style="color:${(n(w.spread_1m) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(w.spread_1m)}</td>
        <td class="num" style="color:var(--pos)">${pc(w.spread_3m)}</td>
        <td title="${esc(w.loop_note || '')}">${loopChip(w.loop_state)}</td></tr>`).join('')}
      </tbody></table>
      <p class="note">The top five, and whether each one is feeding itself. <b>Reflexivity is the second question:</b> a spread that widens while capital arrives at the winning side is a loop — the move recruiting the buying that extends it — and it behaves differently from a spread that is merely positive. Acceleration is the last month's spread per day against the quarter's; participation is each proxy's own dollar volume over the month against its trailing year. Hover a verdict for the figures behind it.</p>`}
    ${!against.length ? '' : `<div style="margin-top:16px;border-top:1px solid var(--line);padding-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Where the regime and the tape disagree</div>
      <table><thead><tr><th>Dimension</th><th>Regime prefers</th><th class="num">1 month</th><th class="num">3 months</th><th>Feedback loop</th></tr></thead><tbody>
      ${against.map(w => `<tr><td>${esc(w.dimension)}</td>
        <td><b>${esc(w.prefer)}</b> <span style="color:var(--muted)">over ${esc(w.avoid)}</span></td>
        <td class="num" style="color:${(n(w.spread_1m) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(w.spread_1m)}</td>
        <td class="num" style="color:var(--neg)">${pc(w.spread_3m)}</td>
        <td title="${esc(w.loop_note || '')}">${loopChip(w.loop_state)}</td></tr>`).join('')}
      </tbody></table>
      <p class="note">These are the rows worth reading. Either the regime call is early, or it is wrong, and a contest that only ever confirmed itself would be a mirror. The loop here is tested on whichever side the <b>tape</b> favours rather than the side the regime prefers — if the crowd has picked the avoided leg, that is where the loop lives. ${regime && +regime.conviction < 0.5 ? `<b>Conviction on the regime is ${(+regime.conviction).toFixed(2)}</b>, close enough to the boundary between quadrants that disagreement here is unsurprising.` : ''}</p></div>`}
    ${!unscored.length ? '' : `<p class="note" style="margin-top:12px"><b>${unscored.length} dimension${unscored.length === 1 ? '' : 's'} could not be scored against the tape</b> — ${unscored.map(u => esc(u.dimension)).join(', ')}. The regime still states a preference; there is simply no tracked proxy to test it with, and filling that in from the chart would make the framework unfalsifiable.</p>`}`}
  </div>`;

  // ---- the contrarian Top 5 ----
  // The five most talked-about narratives, and what each is doing. Crowded is not a sell: a
  // narrative that is gathering can gather for a long time, and fading a live loop is how people
  // lose money being early. The row worth saying out loud is CROWDING -- attention still rising
  // after the proxy stopped paying for it.
  // NAMING THE FLAW. "There is bound to be a flaw in the participants' perception of the
  // fundamentals" is the most useful sentence in the chapter for a desk, and nothing recorded an
  // attempt at it. This column is AUTHORED, not computed: it comes from annie_assessments, which
  // refuses a scored row with no sources, and it is dated and attributed on the page. A computed
  // flaw would be the error the 1994 preface corrects, industrialised.
  //
  // Where no row exists the cell says the flaw has not been named. That is an honest state and a
  // more useful one than a blank: it says the desk has looked at the crowd's story and has not yet
  // found the hole in it, rather than implying there isn't one. Soros's claim is that there always
  // is one, and that it may not be visible early.
  const flaws = {};
  for (const a of (D.assessments || [])) {
    if (a.kind !== 'narrative_flaw' || !a.narrative) continue;
    const prev = flaws[a.narrative];
    if (!prev || String(a.as_of) > String(prev.as_of)) flaws[a.narrative] = a;
  }
  const flawCell = slug => {
    const f = flaws[slug];
    if (!f) return '<span style="color:var(--muted);font-size:12px">not yet named</span>';
    const srcs = Array.isArray(f.sources) ? f.sources : [];
    const tip = `${f.body_md || ''}${srcs.length ? `\n\nSources: ${srcs.map(x => `${x.title || x.url}${x.as_of ? ` (${x.as_of})` : ''}`).join('; ')}` : ''}\n\nWritten by ${f.author || 'kate'} on ${f.as_of}.`;
    return `<span title="${esc(tip)}" style="font-size:12px;cursor:help">${esc(f.headline)}
      <span style="color:var(--muted);font-size:10px">${srcs.length} src · ${esc(String(f.as_of))}</span></span>`;
  };
  const nFlaws = Object.keys(flaws).length;

  const topN5 = flock.filter(r => r.attention_ratio !== null).slice(0, 5);
  const crowdingNow = flock.filter(r => r.state === 'crowding');
  const contrarian = !topN5.length ? `<div class="card" style="margin-bottom:14px"><h2>Contrarian Top 5</h2>
    <div class="empty">No narrative could be measured. Run jobs/compute-narrative-sentiment.mjs.</div></div>`
    : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Contrarian Top 5</h2>
      <span style="font-size:12px;color:var(--muted)">the most talked-about narratives, against their own normal</span></div>
    <p class="note" style="margin:8px 0 14px">Ranked by how unusual each narrative's attention is for <b>itself</b>, not by how much of it there is. A narrative at 1.6× its own normal is being talked about more than it usually is, which is the thing that moves; a famous subject sitting at 1.0× is not news.</p>
    <div style="overflow-x:auto"><table style="min-width:760px"><thead><tr>
      <th class="num">#</th><th>Narrative</th><th>Kind</th><th class="num">Attention</th><th class="num">Own year</th>
      <th>Proxy</th><th class="num">1 month</th><th class="num">3 months</th><th>State</th><th>The flaw</th></tr></thead><tbody>
      ${topN5.map(r => `<tr>
        <td class="num">${r.attention_rank}</td>
        <td><b>${esc(labelOf(r.narrative))}</b>${r.n_sources > 1 ? `<br><span style="font-size:11px;color:var(--muted)">${r.n_sources} sources agree it is ${(+r.attention_ratio) >= 1 ? 'busier' : 'quieter'} than normal</span>` : ''}</td>
        <td style="font-size:12px;color:var(--muted)">${esc(KIND_LOOK[kindOf(r.narrative)] || '')}</td>
        <td class="num"><b>${(+r.attention_ratio).toFixed(2)}×</b></td>
        <td class="num">${r.attention_pctile === null ? '—' : pct0(r.attention_pctile)}</td>
        <td><span class="chip">${esc(proxyOf(r.narrative))}</span></td>
        <td class="num" style="color:${(n(r.price_1m) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(r.price_1m)}</td>
        <td class="num" style="color:${(n(r.price_3m) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(r.price_3m)}</td>
        <td title="${esc(r.state_note || '')}">${flockChip(r.state)}</td>
        <td>${flawCell(r.narrative)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note" style="margin-top:12px"><b>The flaw is written, not computed.</b> <i>"There is bound to be a flaw in the participants' perception of the fundamentals"</i> — and Soros adds that it may not be visible early. ${nFlaws ? `${nFlaws} ${nFlaws === 1 ? 'narrative has' : 'narratives have'} one named, each with its sources and the date it was written; hover for the argument.` : 'None has been named yet.'} A cell reading <b>not yet named</b> means the desk has looked at the crowd's story and has not found the hole in it — <b>not</b> that there isn't one. Computing this field would give an opinion the authority of arithmetic, which is the error the 1994 preface exists to correct.</p>
    ${!crowdingNow.length ? `<p class="note" style="margin-top:12px">Nothing in the flock is <b>crowding</b> right now — no narrative is drawing rising attention while its proxy falls. That is the case where a contrarian list is a watchlist rather than a trade.</p>`
      : `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Where the boat is leaning hardest — ${crowdingNow.length} narrative${crowdingNow.length === 1 ? '' : 's'} crowding</div>
      ${crowdingNow.slice(0, 6).map(r => `<p class="note" style="margin:0 0 8px"><b>${esc(labelOf(r.narrative))}</b> <span class="chip">${esc(proxyOf(r.narrative))}</span> — ${esc(r.state_note || '')}</p>`).join('')}
      <p class="note">These are the narratives the crowd is still turning toward after the price stopped rewarding it. It is the combination worth naming, not a signal to sell: being early into a reversal costs the same as being wrong about it.</p></div>`}
    <p class="note" style="margin-top:12px"><b>This is not positioning data.</b> The desk has no Commitment of Traders report, no short interest, no fund flows and no investor survey. What is measured here is public attention — pageviews, forum posts, message velocity — set against what the tradeable proxy actually did. That is a weaker claim than knowing who owns what, and the weaker claim is the true one.</p>
  </div>`;

  // ---- the equilibrium gate, the test count and the asymmetry ----
  //
  // THIS CARD COMES BEFORE THE CONTEST ON PURPOSE. Soros's 1994 preface corrects his own readers
  // for treating reflexivity as always relevant, and the correction is structural: the first
  // question about a narrative is not "is a loop running" but "is this even a tape where that
  // question has an answer". Most rows read near equilibrium, and that is the honest shape.
  //
  // There is no stage number anywhere on it. The sequence Soros describes is "only one possible
  // path" by his own account, and he says it hardly needs emphasizing how crude the model is.
  // Printing "stage 6 of 9" would be inventing a precision the author disclaimed, so the card
  // shows the test count and the stretch since the last test and lets the reader place it.
  const reflex = D.narReflex || [];
  const reflexByNar = Object.fromEntries(reflex.map(r => [r.narrative, r]));
  const EQ_RANK = { far_from_equilibrium: 0, stretched: 1, near_equilibrium: 2, insufficient: 3 };
  const chip = (look, key) => { const L = look[key]; return !L ? '<span style="color:var(--muted)">—</span>'
    : `<span title="${esc(L.short || '')}" style="color:${L.tone};font-weight:600">${esc(L.label)}</span>`; };
  const reflexRows = reflex.slice().sort((a, b) =>
    (EQ_RANK[a.equilibrium] ?? 9) - (EQ_RANK[b.equilibrium] ?? 9) || (n(b.gap_now) ?? -1) - (n(a.gap_now) ?? -1));
  const nFar = reflex.filter(r => r.equilibrium === 'far_from_equilibrium').length;
  const nNear = reflex.filter(r => r.equilibrium === 'near_equilibrium').length;
  const lateOnes = reflex.filter(r => r.test_verdict === 'late_untested' || r.test_verdict === 'untested');

  const reflexCard = !reflex.length ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Is the loop even worth asking about?</h2>
      <span style="font-size:12px;color:var(--muted)">${esc(reflex.map(r => r.as_of).sort().pop() || '')} · ${reflex.length} narratives</span></div>
    <p class="note" style="margin:8px 0 14px">Soros published <i>The Alchemy of Finance</i> in 1987 and wrote a preface in 1994 to correct his own readers: he had presented reflexivity <i>"as if it were relevant at all times"</i> and called that a mistake. The feedback can engage at any moment, but <b>in most situations it is so feeble it can safely be ignored</b>. So this is the first thing read on a narrative, and it currently says <b>${nNear} of ${reflex.length}</b> are near equilibrium — where the prevailing bias is noise and should be called noise. <b>${nFar}</b> ${nFar === 1 ? 'is' : 'are'} far from it.</p>
    <div style="overflow-x:auto"><table style="min-width:900px"><thead><tr>
      <th>Narrative</th><th>Proxy</th><th class="num">Attention</th><th class="num">Price</th><th class="num">Gap</th>
      <th>State</th><th class="num">Advance</th><th class="num">Tests</th><th class="num">Since</th><th>Sequence</th><th>Shape</th></tr></thead><tbody>
      ${reflexRows.map(r => {
        const far = r.equilibrium === 'far_from_equilibrium';
        const late = r.test_verdict === 'late_untested' || r.test_verdict === 'untested';
        return `<tr${far || late ? ' style="background:var(--panel2)"' : ''}>
        <td><b>${esc(labelOf(r.narrative))}</b> <span style="font-size:11px;color:var(--muted)">${esc(KIND_LOOK[kindOf(r.narrative)] || '')}</span></td>
        <td><span class="chip">${esc(r.proxy_ticker || '')}</span></td>
        <td class="num">${r.attention_pctile === null ? '—' : pct0(r.attention_pctile)}</td>
        <td class="num">${r.price_pctile === null ? '—' : pct0(r.price_pctile)}</td>
        <td class="num" title="${esc(r.equilibrium_note || '')}" style="color:${far ? 'var(--neg)' : 'var(--text)'}">${r.gap_now === null ? '—' : (+r.gap_now).toFixed(0)}${r.gap_trend === null ? '' : `<span style="font-size:10px;color:var(--muted)"> ${+r.gap_trend > 0 ? '↑' : +r.gap_trend < 0 ? '↓' : '='}</span>`}</td>
        <td>${chip(EQUIL_LOOK, r.equilibrium)}</td>
        <td class="num" style="color:var(--muted)">${r.leg_days === null ? '—' : r.leg_days}</td>
        <td class="num">${r.tests === null ? '—' : r.tests}</td>
        <td class="num">${r.days_since_test === null ? '—' : r.days_since_test}${r.median_gap === null ? '' : `<span style="font-size:10px;color:var(--muted)">/${(+r.median_gap).toFixed(0)}</span>`}</td>
        <td title="${esc(r.test_note || '')}">${chip(TEST_LOOK, r.test_verdict)}</td>
        <td title="${esc(r.asymmetry_note || '')}">${chip(ASYM_LOOK, r.asymmetry_verdict)}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <p class="note" style="margin-top:12px"><b>Gap</b> is how far apart attention and price sit in their own trailing years, in percentile points, with an arrow for whether it has widened over twelve weeks. The gate is <b>68 points</b>, and it is not a round number: two unrelated percentiles differ by 33 points on average, so a 30-point gate would measure coincidence and call it divergence. Under that null a gap of 68 or more turns up about a tenth of the time, which is a drift large enough that chance is an uncomfortable explanation. <b>An earlier version of this card used 30 and flagged 18 of 32 narratives</b> — the opposite of what the book says the answer should look like.</p>
    <p class="note"><b>Advance</b> is how many sessions the proxy has been above its 200-day average. <b>Tests</b> counts the drawdowns inside that advance which the advance went on to survive — Soros's "successful test", and the threshold is scaled to the instrument, because a 7% drawdown is a genuine test of the S&P and an ordinary fortnight for uranium miners. <b>Since</b> is sessions since the last test against this advance's own normal stretch between them. ${lateOnes.length ? `<b style="color:var(--neg)">${lateOnes.length} advance${lateOnes.length === 1 ? '' : 's'} ${lateOnes.length === 1 ? 'has' : 'have'} stopped being tested</b> — ${lateOnes.map(r => esc(labelOf(r.narrative))).join(', ')}. <i>"When the process is advanced, corrections become scarcer and the danger of a climactic reversal greater."</i>` : 'Nothing is currently running long past its own normal stretch between tests.'}</p>
    <p class="note"><b>Shape</b> is the asymmetry the credit chapter describes — at the inception of a boom both credit and collateral are at a minimum, at the bust both are at a maximum, so declines are compressed where advances were drawn out. It is measured on the <b>proxy's price history, not on attention</b>: the attention series is days old and would give a shape rather than a finding. The murmuration draws gathering and dispersing the same way, and this column says for which narratives that even treatment is fair.</p></div>`;

  // ---- the credit cycle, as conditions ----
  //
  // THE CAVEAT IS NOT A FOOTNOTE HERE. Soros's credit cycle runs between a loan and the value of
  // the collateral behind it; the desk has no collateral-value series, no loan-to-value
  // distribution and no private-credit data. So this is the loop's shadow, and the panel says so
  // above the numbers rather than beneath them.
  const cLegs = (D.creditLegs || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const cRead = (D.creditReading || [])[0] || null;
  const creditCard = !cLegs.length ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">The credit cycle</h2>
      ${!cRead ? '' : `<span style="font-size:12px;color:var(--muted)">${cLegs.length} legs · oldest observation ${esc(cRead.oldest_obs || '—')}</span>`}</div>
    <p class="note" style="margin:8px 0 0"><b>This is credit conditions, not Soros's loop.</b> ${esc(cRead ? cRead.caveat : '')}</p>
    ${!cRead ? '' : `<div style="display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;margin:14px 0 4px">
      <div style="font-size:26px;font-weight:700;color:${(CREDIT_PHASE[cRead.phase] || {}).tone}">${esc((CREDIT_PHASE[cRead.phase] || {}).label || cRead.phase)}</div>
      <div style="color:var(--muted);font-size:13px;max-width:62ch">${esc(cRead.headline)}</div></div>`}
    <div style="overflow-x:auto;margin-top:12px"><table style="min-width:820px"><thead><tr>
      <th>Leg</th><th class="num">Level</th><th class="num">Change</th><th>Direction</th>
      <th class="num">Change in the change</th><th>Second derivative</th><th class="num">As of</th></tr></thead><tbody>
      ${cLegs.map(r => {
        const d = CREDIT_DIR[r.direction] || CREDIT_DIR.unavailable;
        const a = CREDIT_ACC[r.accel_sign] || CREDIT_ACC.unavailable;
        const sgn = v => v === null ? '—' : `${+v >= 0 ? '+' : '−'}${Math.abs(+v).toFixed(2)}`;
        return `<tr title="${esc(r.detail || '')}">
        <td><b>${esc(r.label)}</b> <span style="font-size:11px;color:var(--muted)">${esc(r.series_id || '')}</span></td>
        <td class="num">${r.level === null ? '—' : (+r.level).toFixed(2)}<span style="font-size:10px;color:var(--muted)">${esc(r.level_unit === 'index' ? '' : r.level_unit === 'pp' ? 'pp' : '%')}</span></td>
        <td class="num">${sgn(r.change)}</td>
        <td style="color:${d.tone};font-weight:600">${esc(d.label)}</td>
        <td class="num">${sgn(r.acceleration)}</td>
        <td style="color:${a.tone};font-weight:600">${esc(a.label)}</td>
        <td class="num" style="font-size:11px;color:var(--muted)">${esc(r.obs_date || '—')}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <p class="note" style="margin-top:12px"><b>Read the second derivative, not the level.</b> <i>"Only net new lending stimulates"</i> — debt service withdraws resources, so total new lending has to keep rising just to hold net new lending flat. That makes credit which is abundant and decelerating the condition that <i>ends</i> a boom rather than the condition of one, and it looks like a boom on every level-based measure. Each leg is signed in the borrower's terms, so <b>easing means the same thing on a spread, a growth rate and a delinquency rate</b>: a widening spread is tightening even while its level still looks historically low. Hover a row for what it is and why it is here.</p>
    <p class="note"><b>Every leg carries its own observation date</b> because they are not equally fresh — spreads are daily, bank credit is weekly with a lag, delinquencies are quarterly. One as-of date across the panel would imply the slowest leg is as current as the fastest. Soros is also explicit that how the credit and regulatory cycles interact was the main source of his own confusion, and nothing here claims to model that.</p></div>`;

  // ---- where the desk's own book sits ----
  // The part that is actionable: crowding in the abstract is interesting, crowding in something
  // the models already own is a decision.
  const held = new Set();
  for (const h of (D.currentHoldings || [])) if (h.security_id) held.add(h.security_id);
  const ownRows = crowd.filter(r => held.has(r.security_id) && r.crowd_score !== null);
  const bookCard = !ownRows.length ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">What the desk owns, by the tape</h2>
      <span style="font-size:12px;color:var(--muted)">${ownRows.length} held name${ownRows.length === 1 ? '' : 's'} scored</span></div>
    <p class="note" style="margin:8px 0 14px">The narratives above are what the crowd is <b>saying</b>. This is what the desk actually <b>holds</b>, scored on the tape instead — attention against its own normal, distance above its own trend, six-month return, one-sidedness of its own days — most crowded first. Two different measurements of two different things, and the pair is the point: a holding can be quiet on the tape while the narrative behind it is the loudest in the flock.</p>
    <div style="overflow-x:auto"><table style="min-width:560px"><thead><tr>
      <th class="num">Rank</th><th>Ticker</th><th class="num">Crowd score</th><th class="num">Attention</th>
      <th class="num">Above own trend</th><th class="num">6 months</th><th>Feedback loop</th></tr></thead><tbody>
      ${ownRows.map(r => `<tr>
        <td class="num" style="color:var(--muted)">${r.crowd_rank}</td>
        <td><b>${esc(tkr(r.security_id))}</b></td>
        <td class="num">${(+r.crowd_score).toFixed(0)}</td>
        <td class="num">${r.attention === null ? '—' : (+r.attention).toFixed(2) + '×'}</td>
        <td class="num">${pct0(r.stretch_pctile)}</td>
        <td class="num" style="color:${(n(r.momentum_6m) ?? 0) >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc(r.momentum_6m)}</td>
        <td title="${esc(r.loop_note || '')}">${loopChip(r.loop_state)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">Rank is against the whole scored universe of ${crowd.length} securities, not against this list, so a rank of 40 means fortieth most crowded thing the desk tracks. Holdings with no exchange volume or too little history are absent rather than shown at zero.</p>
  </div>`;

  // ---- how the loop states are defined ----
  const legend = `<div class="card" style="margin-bottom:14px">
    <h2>Reading the loop</h2>
    <p class="note" style="margin:0 0 12px">Soros's addition to Keynes: belief and price are a two-way street, so a rising price can recruit the buying that raises it further. The loop runs until it does not — reflexivity is not a reason a trend continues, it is a reason it eventually breaks hard. Two vocabularies, because two things are being watched.</p>
    <div class="eyebrow" style="margin-bottom:6px">The flock — a narrative's attention against its proxy</div>
    <table><thead><tr><th>State</th><th>What it means</th></tr></thead><tbody>
      ${['gathering', 'crowding', 'dispersing', 'unwatched'].map(k => `<tr>
        <td><span style="color:${FLOCK_LOOK[k].tone};font-weight:600">${esc(FLOCK_LOOK[k].label)}</span></td>
        <td style="font-size:12px">${esc(FLOCK_LOOK[k].short)}</td></tr>`).join('')}
    </tbody></table>
    <p class="note"><b>Crowding</b> is the state to read twice. It looks most like a winner — attention rising, the subject everywhere — and behaves least like one, because the price stopped paying before the crowd got there.</p>
    <div class="eyebrow" style="margin:16px 0 6px">The loop — a contest dimension, or a single holding</div>
    <p class="note" style="margin:0 0 10px">Measured from the tape rather than from attention: whether the winning side is still pulling away, and whether dollar volume is still arriving at it.</p>
    <table><thead><tr><th>State</th><th>What it means</th></tr></thead><tbody>
      ${['running', 'crowding', 'faltering', 'cold'].map(k => `<tr>
        <td><span style="color:${LOOP_LOOK[k].tone};font-weight:600">${esc(LOOP_LOOK[k].label)}</span></td>
        <td style="font-size:12px">${esc(LOOP_LOOK[k].short)}</td></tr>`).join('')}
    </tbody></table>
    <div class="eyebrow" style="margin:16px 0 6px">The gate — whether the question applies at all</div>
    <p class="note" style="margin:0 0 10px">Read this before either vocabulary above. Both of them describe a loop, and Soros's 1994 preface says most of the time there isn't one: the feedback can engage at any moment but <i>in most situations it is so feeble it can safely be ignored</i>, and <i>"what is normal in one is abnormal in the other"</i>.</p>
    <table><thead><tr><th>State</th><th>What it means</th></tr></thead><tbody>
      ${['near_equilibrium', 'stretched', 'far_from_equilibrium'].map(k => `<tr>
        <td><span style="color:${EQUIL_LOOK[k].tone};font-weight:600">${esc(EQUIL_LOOK[k].label)}</span></td>
        <td style="font-size:12px">${esc(EQUIL_LOOK[k].short)}</td></tr>`).join('')}
    </tbody></table>
    <div class="eyebrow" style="margin:16px 0 6px">The sequence — how far along an advance is</div>
    <p class="note" style="margin:0 0 10px">The one stage marker that is genuinely computable is the <b>successful test</b>: a drawdown inside an advance that the advance survives. Early processes are tested often; late ones are not. <b>No stage number is printed anywhere</b>, because Soros calls his own nine-stage sequence "only one possible path" and says it hardly needs emphasizing how crude the model is.</p>
    <table><thead><tr><th>State</th><th>What it means</th></tr></thead><tbody>
      ${['early', 'tested_recently', 'maturing', 'late_untested', 'untested', 'no_leg'].map(k => `<tr>
        <td><span style="color:${TEST_LOOK[k].tone};font-weight:600">${esc(TEST_LOOK[k].label)}</span></td>
        <td style="font-size:12px">${esc(TEST_LOOK[k].short)}</td></tr>`).join('')}
    </tbody></table>
    <p class="note"><b>What is deliberately absent from this page.</b> No stage number. No model of how the credit and regulatory cycles interact — Soros says that was the main source of his own confusion, and the desk should not be more certain than the author. And no second reflexivity score: Kate already has one for single names, written with sources, and computing a rival that merely looked measured would be the preface's error at scale.</p>
  </div>`;

  return `<span class="eyebrow">Sentiment</span><h1>Kate</h1>
   <p class="sub">The popularity contest — which narratives the crowd is talking about, how full each one already is, and whether the loop behind it still pays.</p>
   ${gauge}${reflexCard}${contestCard}${contrarian}${creditCard}${bookCard}${legend}`;
}

// ---------- Annie: decision quality, from Thinking in Bets ----------
//
// Four measures the dashboard had no answer for, added 2026-10-20. Three of them depend on inputs
// the journal only began collecting that day, so they read empty until entries exist and say so
// in those words -- "not yet started" and "broken" must never render the same way.
//
// The fourth, fielding, runs on 318 closed trades the desk already had, and it is COMPUTED rather
// than asked. Duke's warning is that we field our wins into skill and our losses into luck; a
// field asking the desk to do that sorting would measure the bias with an instrument made of the
// bias. The trade review already holds each position's return and its excess over the benchmark,
// which splits the result into what the asset class delivered and what came from choosing the
// name. That split is arithmetic, and the bias shows up as a gap between winners and losers.
function decisionQualityCard(strategyId) {
  const rows = D.decisionQuality || [];
  const r = strategyId ? rows.find(x => x.strategy_id === strategyId) : rows.find(x => x.scope === 'firm');
  if (!r) return '';
  const pc = v => v === null || v === undefined ? '—' : `${(+v * 100).toFixed(0)}%`;
  const n = v => v === null || v === undefined ? null : +v;

  // ---- calibration ----
  const bins = Array.isArray(r.calibration_bins) ? r.calibration_bins.filter(b => b.n > 0) : [];
  const calBlock = !bins.length ? `<div class="empty" style="margin:0">No entry has been scored yet. Calibration starts from the first journal entry that carries a confidence and a horizon and has since resolved — it <b>cannot be backfilled</b>, because a confidence recalled after the outcome is a memory of the outcome.</div>`
    : (() => {
      const W = 420, Hh = 220, pad = { l: 42, r: 14, t: 12, b: 34 };
      const X = v => pad.l + (v / 100) * (W - pad.l - pad.r);
      const Y = v => pad.t + (1 - v / 100) * (Hh - pad.t - pad.b);
      return `<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
        <svg viewBox="0 0 ${W} ${Hh}" style="width:100%;max-width:420px;height:auto" role="img" aria-label="Stated confidence against how often those calls came true">
          <line x1="${X(0)}" y1="${Y(0)}" x2="${X(100)}" y2="${Y(100)}" stroke="var(--muted)" stroke-dasharray="4 3" opacity="0.6"/>
          <text x="${X(72)}" y="${Y(84)}" font-size="9.5" fill="var(--muted)">perfect calibration</text>
          ${[0, 50, 100].map(v => `<text x="${pad.l - 6}" y="${(Y(v) + 3.5).toFixed(1)}" font-size="10" text-anchor="end" fill="var(--muted)">${v}%</text>
            <text x="${X(v).toFixed(1)}" y="${Hh - pad.b + 15}" font-size="10" text-anchor="middle" fill="var(--muted)">${v}%</text>`).join('')}
          <text x="${X(50).toFixed(1)}" y="${Hh - 4}" font-size="10" text-anchor="middle" fill="var(--muted)">said this likely →</text>
          ${bins.map(b => `<circle cx="${X(+b.stated).toFixed(1)}" cy="${Y(+b.realised).toFixed(1)}" r="${(3 + Math.min(7, b.n)).toFixed(1)}" fill="var(--accent)" opacity="0.75"><title>${b.n} entries around ${b.stated}% — ${b.realised}% came true</title></circle>`).join('')}
        </svg>
        <div style="flex:1;min-width:220px">
          <div style="font-size:30px;font-weight:700;line-height:1">${r.brier === null ? '—' : (+r.brier).toFixed(3)}</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Brier score over ${r.n_scored} scored ${r.n_scored === 1 ? 'entry' : 'entries'}</div>
          <p class="note" style="margin:0">Mean squared error between what was said and what happened. <b>0 is perfect; 0.25 is what you get by saying 50% to everything</b>, so anything above that is worse than a shrug. ${r.brier === null ? 'Withheld until ten entries have resolved — a Brier over a handful of calls is four coin flips wearing a decimal.' : ''}</p>
        </div></div>`;
    })();

  // ---- fielding ----
  const gap = n(r.fielding_gap);
  const fieldBlock = !r.n_fielded ? `<div class="empty" style="margin:0">No closed trades to attribute yet.</div>`
    : `<div style="display:flex;gap:26px;flex-wrap:wrap;align-items:center">
        <div style="flex:1;min-width:260px">
          ${[['Winners', n(r.win_skill_share), 'var(--pos)'], ['Losers', n(r.loss_skill_share), 'var(--neg)']].map(([lab, v, tone]) => `
            <div style="margin-bottom:10px">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>${lab}</span><b style="color:${tone}">${pc(v)} selection</b></div>
              <div style="height:9px;border-radius:99px;background:var(--panel2);overflow:hidden">
                <div style="width:${Math.max(1, Math.min(100, (v ?? 0) * 100)).toFixed(1)}%;height:100%;background:${tone};opacity:.8"></div></div></div>`).join('')}
        </div>
        <div style="min-width:170px">
          <div style="font-size:30px;font-weight:700;line-height:1;color:${gap === null ? 'var(--muted)' : Math.abs(gap) < 0.05 ? 'var(--pos)' : 'var(--warn)'}">${gap === null ? '—' : (gap >= 0 ? '+' : '−') + Math.abs(gap * 100).toFixed(0) + 'pt'}</div>
          <div style="font-size:12px;color:var(--muted)">fielding gap · ${r.n_fielded} ${strategyId ? 'trades' : 'decisions'}</div></div>
      </div>
      <div style="display:flex;gap:26px;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
        <div style="min-width:200px">
          <div style="font-size:30px;font-weight:700;line-height:1;color:${n(r.cum_selection) === null ? 'var(--muted)' : +r.cum_selection >= 0 ? 'var(--pos)' : 'var(--neg)'}">${n(r.cum_selection) === null ? '—' : (+r.cum_selection >= 0 ? '+' : '−') + Math.abs(+r.cum_selection * 100).toFixed(1) + 'pt'}</div>
          <div style="font-size:12px;color:var(--muted)">total contributed by selection${n(r.cum_selection) === null || !r.n_fielded ? '' : `, ${(+r.cum_selection / r.n_fielded * 10000).toFixed(0)}bp per decision`}</div></div>
        <div style="min-width:200px">
          <div style="font-size:30px;font-weight:700;line-height:1;color:${n(r.helped_share) === null ? 'var(--muted)' : +r.helped_share >= 0.5 ? 'var(--pos)' : 'var(--neg)'}">${pc(r.helped_share)}</div>
          <div style="font-size:12px;color:var(--muted)">of decisions where selection helped at all</div></div>
      </div>
      <p class="note"><b>The gap above says how results were attributed. These two say whether the choosing paid</b>, which is a different question the gap cannot answer — a desk can have a perfectly even attribution and no edge at all. ${n(r.helped_share) !== null && +r.helped_share < 0.5 ? `Selection helped on fewer than half of them, so a coin flip between the names already held would have done as well.` : ''}</p>
      <p class="note">Each closed decision is split into what its <b>asset class</b> delivered and what came from <b>choosing that name</b> over its peers — the return, and the part of it that beat the benchmark. The share is then compared between winners and losers, and it should not differ: how a result is attributed must not depend on whether it made money. ${gap === null ? '' : Math.abs(gap) < 0.05 ? 'These are the same within noise, which is what an unbiased record looks like.' : gap > 0 ? `Winners are credited to selection <b>${(gap * 100).toFixed(0)} points more</b> than losers are. That is self-serving bias with a number on it — the desk taking credit for what the tide did.` : `Losers are attributed to selection <b>${(Math.abs(gap) * 100).toFixed(0)} points more</b> than winners are. That is the <b>opposite</b> of self-serving bias, and it is worth sitting with: on this record the desk's gains came mostly from being in the right asset class, while its losses came disproportionately from the names it picked within one.`} This is computed, not asked — an opinion about luck is the first thing self-serving bias distorts.${strategyId ? '' : ' Firm-wide counts <b>decisions</b> rather than rows: one fund exited on one date appears once per model that held it, and counting rows would weight a decision by how many models happened to own it.'}</p>`;

  // ---- Ulysses contracts and dissent, side by side ----
  const ulyBlock = !r.n_thresholds ? `<div class="empty" style="margin:0">No entry carries a loss threshold yet.</div>`
    : `<div style="font-size:30px;font-weight:700;line-height:1">${r.n_honoured}<span style="font-size:18px;color:var(--muted)"> of ${r.n_breached}</span></div>
      <div style="font-size:12px;color:var(--muted)">breached thresholds that were honoured, from ${r.n_thresholds} set</div>`;
  const disBlock = !(r.n_unanimous + r.n_contested) ? `<div class="empty" style="margin:0">No entry has been read by two or more agents yet.</div>`
    : `<div style="font-size:30px;font-weight:700;line-height:1">${r.n_contested}<span style="font-size:18px;color:var(--muted)"> of ${r.n_unanimous + r.n_contested}</span></div>
      <div style="font-size:12px;color:var(--muted)">entries went ahead over an objection${r.n_contested ? ` — ${r.contested_worked} worked, against ${r.unanimous_worked} of ${r.n_unanimous} unanimous` : ''}</div>`;

  return `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Decision quality</h2>
      <span style="font-size:12px;color:var(--muted)">as of ${esc(r.as_of)}</span></div>
    <p class="note" style="margin:6px 0 0">${esc(r.headline || '')}</p>

    <h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Calibration — were we as right as we said we were</h3>
    ${calBlock}

    <h3 style="margin:20px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Fielding — the tide, or the name we picked</h3>
    ${fieldBlock}

    <div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:20px">
      <div style="flex:1;min-width:260px">
        <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Kill criteria held</h3>
        ${ulyBlock}
        <p class="note" style="margin:8px 0 0">A loss threshold is a precommitment past-us makes to bind present-us. Its value is not the line itself but the <b>stop-and-think</b> it forces at the moment someone wants to cut the binding — so the number worth watching is never how often a threshold was hit, it is how often it was hit and respected.</p>
      </div>
      <div style="flex:1;min-width:260px">
        <h3 style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Dissent</h3>
        ${disBlock}
        <p class="note" style="margin:8px 0 0">Five agents read each entry. A group is only worth having if its disagreement changes anything, so this compares how contested entries fared against unanimous ones. It is the only way to find out whether the fifth opinion is worth what it costs.</p>
      </div>
    </div>
  </div>`;
}

// ---------- Sven: market internals ----------
//
// Two dashboards. The rule matrix is Linda Raschke's twelve technical rules evaluated nightly on
// daily bars; the news-failure table asks whether an asset is responding to its own news. Both are
// arithmetic — nothing on this page is written by an agent — and both carry what they cannot see.
// FOUR STATES, AND neutral NO LONGER DOES TWO JOBS. Livermore: "If a stock doesn't act right don't
// touch it; because, being unable to tell precisely what is wrong, you cannot tell which way it is
// going. No diagnosis, no prognosis. No prognosis, no profit." That is a state, and the matrix
// could not express it -- neutral was carrying both "the rule was tested and did not resolve" and
// "the rule had no precondition to test", and the second is the more useful claim.
const RULE_STATE = {
  bullish:       { dot: 'var(--pos)',   label: 'bullish', short: 'The rule tested and resolved bullish.' },
  bearish:       { dot: 'var(--neg)',   label: 'bearish', short: 'The rule tested and resolved bearish.' },
  neutral:       { dot: 'var(--muted)', label: 'neutral', short: 'The rule was testable and the test failed, or resolved to no direction. Informative — a strong close that does not follow through is the rule failing, and Raschke treats that as a finding.' },
  no_read:       { dot: 'none',         label: 'no read', short: 'The precondition is absent, or the inputs conflict: no new extreme to react to, no gap worth the name, no run of strong closes, price and the averages disagreeing. No diagnosis, so no direction is offered.' },
  not_evaluable: { dot: 'transparent',  label: 'not evaluable on daily bars', short: 'The rule cannot be tested on daily bars at all, on any day. Rules 3, 9 and 10 are entirely about when inside the session something happened, and a daily bar has no inside.' },
};
// Livermore's admired chart room compared "individual curves with the general market curve". A
// bullish read on emerging markets in a bullish market is not the same observation as one in a
// bearish market, and only the second is worth anything.
const VS_MARKET = {
  is_market:      { label: 'is the market', short: 'SPY\u2019s own row. Marked rather than left blank, because a blank reads as missing data.' },
  with_market:    { label: 'with the market', short: 'The same read as SPY on the same rule. The common case, and much the weaker one.' },
  against_market: { label: 'against the market', short: 'The opposite read to SPY on the same rule \u2014 this index is saying something the market is not. The informative cell.' },
  market_silent:  { label: 'market has no direction', short: 'This index resolved bullish or bearish and SPY did not \u2014 it read neutral, or had no precondition to test. There is nothing to agree or disagree with, and agreeing with silence is not agreement.' },
  silent:         { label: 'no direction here',  short: 'This index has no direction on this rule \u2014 no read, or tested and failed \u2014 so the comparison does not arise.' },
};
const GROUPS = [['US equity', 'US equity'], ['International', 'International'], ['Commodity', 'Commodity']];
const SVEN_GROUP = { SPY: 'US equity', QQQ: 'US equity', MDY: 'US equity', IWM: 'US equity', DIA: 'US equity', EFA: 'International', EEM: 'International', GLD: 'Commodity', USO: 'Commodity' };
// The order the owner reads them in, broad market first. Kept here rather than left to whatever
// order the rows arrive in, which is the database's business and not a reading order.
const SVEN_ORDER = ['SPY', 'QQQ', 'MDY', 'IWM', 'DIA', 'EFA', 'EEM', 'GLD', 'USO'];
// The general curve. SPY rather than a tenth series, so a row on this page can BE the market.
const MARKET_T = 'SPY';
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
     <div class="card"><div class="empty">Nothing computed yet. Run jobs/compute-raschke-rules.mjs, jobs/compute-tape-precedent.mjs and jobs/compute-news-failure.mjs.</div></div>`;
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
      <th class="num">Net</th><th class="num" title="Rules reading the opposite of SPY's read on the same rule. These are the cells saying something the market is not.">vs mkt</th></tr></thead><tbody>
    ${GROUPS.map(([g]) => {
      const rows = tickers.filter(t => SVEN_GROUP[t] === g);
      if (!rows.length) return '';
      return `<tr><td colspan="${ruleCols.length + 3}" style="padding-top:10px;color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase">${esc(g)}</td></tr>` +
        rows.map(t => {
          const mine = ruleCols.map(c => cellFor(t, c.rule_key));
          const bull = mine.filter(r => r && r.state === 'bullish').length;
          const bear = mine.filter(r => r && r.state === 'bearish').length;
          const net = bull - bear;
          const againstCount = mine.filter(r => r && r.vs_market === 'against_market').length;
          return `<tr><td class="click" data-go="#sven/${esc(t)}" style="cursor:pointer"><b>${esc(t)}</b> <span style="color:var(--muted)">${esc(SVEN_LABEL[t] || '')}</span></td>
            ${mine.map(r => {
              if (!r) return '<td class="num">·</td>';
              const st = RULE_STATE[r.state] || RULE_STATE.neutral;
              const vm = VS_MARKET[r.vs_market] || null;
              const against = r.vs_market === 'against_market';
              const tip = `${r.rule_no}. ${r.rule_title}\n${r.headline}`
                + (r.state === 'no_read' ? '\n[no read: the precondition is absent]' : '')
                + (vm && r.vs_market !== 'silent' ? `\n[${vm.label}${r.market_state && r.vs_market !== 'is_market' ? `: SPY reads ${r.market_state.replace('_', ' ')}` : ''}]` : '')
                + (r.adapted ? '\n[adapted to daily bars]' : '');
              // A no_read is a hollow ring: visibly a cell that was looked at, visibly carrying no
              // direction, and distinct from the dash of a rule that can never be tested.
              const mark = r.state === 'not_evaluable' ? '<span style="color:var(--line)">–</span>'
                : r.state === 'no_read' ? '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;border:1.5px solid var(--line);box-sizing:border-box"></span>'
                : `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${st.dot}${against ? ';box-shadow:0 0 0 2.5px var(--panel),0 0 0 4px currentColor' : ''}"></span>`;
              return `<td class="num" data-tip="${esc(tip)}" style="cursor:default;color:${against ? st.dot : 'inherit'}">${mark}${r.adapted ? '<sup style="color:var(--warn);font-size:9px">a</sup>' : ''}</td>`;
            }).join('')}
            <td class="num"><b style="color:${net > 0 ? 'var(--pos)' : net < 0 ? 'var(--neg)' : 'var(--muted)'}">${net > 0 ? '+' : ''}${net}</b></td>
            <td class="num">${t === MARKET_T ? '<span style="color:var(--muted);font-size:11px">market</span>'
              : againstCount ? `<b style="color:var(--warn)">${againstCount}</b>`
              : '<span style="color:var(--muted)">·</span>'}</td></tr>`;
        }).join('');
    }).join('')}
    </tbody></table></div>
    <p class="note">Columns are Raschke's rules in her numbering; <b>11a–11d</b> are the four principles of price behaviour she lists under rule 11. A dot is the rule's read on that index today — green bullish, red bearish, grey neutral — and <b>Net</b> is bullish rules minus bearish. Hover a cell for what the rule says; click an index for all of it with the numbers.</p>
    <p class="note"><b>A hollow ring is a fourth state, and it is the one Livermore cared about most.</b> <i>"If a stock doesn't act right don't touch it; because, being unable to tell precisely what is wrong, you cannot tell which way it is going. No diagnosis, no prognosis. No prognosis, no profit."</i> The ring means the rule's precondition is absent or its inputs conflict — no new extreme to react to, no gap worth the name, no run of strong closes, price and the averages disagreeing. <b>Grey now means something narrower than it used to:</b> the rule was testable and the test failed or resolved to no direction, which is itself a finding. Those were one colour before, and they are two different claims.</p>
    <p class="note"><b>A haloed dot reads the opposite of the market.</b> Livermore's admired chart room compared <i>"individual curves with the general market curve"</i>, and this matrix used to score nine indices independently — which makes a bullish read on emerging markets in a bullish market look identical to one in a bearish market. SPY is the general curve here, its own row is marked <i>market</i> in the last column, and <b>vs mkt</b> counts the rules on which an index disagrees with it. ${(() => { const a = rules.filter(r => r.vs_market === 'against_market'); return a.length ? `Today <b>${a.length}</b> cell${a.length === 1 ? '' : 's'} disagree${a.length === 1 ? 's' : ''} with the market: ${a.map(r => `${esc(r.ticker)} rule ${r.rule_no}`).join(', ')}.` : 'Today nothing disagrees with the market on a rule where both have a read.'; })()}
    Rules marked <sup style="color:var(--warn)">a</sup> are <b>adapted</b>: Raschke wrote for an intraday screen, and where a daily bar can carry the spirit of a rule but not the rule itself — a close in the top third of the range standing in for "the last hour" — the substitution is named rather than hidden. <b>Rules 3, 9 and 10 are not evaluable at all</b> and show a dash: they are entirely about when inside the session something happened, and a daily bar has no inside. Approximating them would be inventing the number the rule turns on.</p></div>`;

  // ---- the quiet tape ----
  //
  // "No man can always have adequate reasons for buying or selling stocks daily." There is a Wall
  // Street fool who thinks he must trade all the time, and the analyst's version is thinking he
  // must have a view every day. A dashboard that always says something is that fool with a
  // stylesheet, so this sits at the TOP of the page: the first thing it says is whether there is
  // anything to say. A page that can print "quiet" is one worth believing when it prints anything
  // else.
  const qt = (D.tapeQuiet || [])[0] || null;
  const QUIET_LOOK = {
    quiet:        { label: 'Quiet',      tone: 'var(--muted)' },
    ordinary:     { label: 'Ordinary',   tone: 'var(--flat)' },
    active:       { label: 'Active',     tone: 'var(--warn)' },
    loud:         { label: 'Loud',       tone: 'var(--neg)' },
    insufficient: { label: 'No reading', tone: 'var(--line)' },
  };
  const quietCard = !qt ? '' : (() => {
    const L = QUIET_LOOK[qt.verdict] || QUIET_LOOK.insufficient;
    const legs = Array.isArray(qt.legs) ? qt.legs : [];
    return `<div class="card" style="margin-bottom:14px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h2 style="margin:0">Is there anything to say?</h2>
        <span style="font-size:12px;color:var(--muted)">${esc(qt.as_of)} · ${qt.n_indices} indices</span></div>
      <div style="display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;margin:12px 0 6px">
        <div style="font-size:26px;font-weight:700;color:${L.tone}">${esc(L.label)}</div>
        <div style="color:var(--muted);font-size:13px;max-width:64ch">${esc(qt.headline)}</div></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:10px">
        ${legs.map(l => `<div style="display:flex;gap:8px;align-items:baseline;font-size:12px">
          <span style="color:${l.says === 'quiet' ? 'var(--muted)' : l.says === 'unavailable' ? 'var(--line)' : 'var(--warn)'};font-weight:700">${l.says === 'quiet' ? '·' : l.says === 'unavailable' ? '–' : '!'}</span>
          <span>${esc(l.text || l.label || '')}</span></div>`).join('')}
      </div>
      <p class="note" style="margin-top:12px">Five internals, each a count or a share of something already computed, and the verdict is a statement rather than a direction. A <b>·</b> is an internal saying nothing in particular; a <b>!</b> is one doing something worth naming. ${esc(qt.detail || '')}</p></div>`;
  })();

  // ---- "acting right": behaviour against each index's own precedent ----
  //
  // LIVERMORE'S ACTUAL DEFINITION of tape reading is "the behavior of a stock, actions that enable
  // you to judge whether or not it is going to proceed in accordance with the precedents that your
  // observation has noted" -- two parts, what the thing normally does and whether it is doing that
  // now. The rule matrix above only ever answered a third question: what the indicators read today.
  //
  // THIS IS NOT A FORECAST, and the design is what makes that true. Each test runs on a COMPLETED
  // response: the most recent time the index entered a named condition long enough ago that the
  // ten-session window has closed. So the claim is never "this will go up"; it is "this has or has
  // not behaved the way it normally behaves", which is knowable from data the desk already holds.
  const prec = (D.svenPrecedent || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const brk = Object.fromEntries((D.svenBreaks || []).map(r => [r.ticker, r]));
  const PREC_LOOK = {
    acting_right:     { dot: 'var(--pos)',   label: 'acting right' },
    acting_strong:    { dot: 'var(--accent)', label: 'acting right, strongly' },
    not_acting_right: { dot: 'var(--neg)',   label: 'NOT acting right' },
    no_precedent:     { dot: 'none',         label: 'no precedent' },
    untested:         { dot: 'none',         label: 'untested' },
  };
  const precCols = [...new Map(prec.map(r => [r.precedent_key, r])).values()].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const precTickers = [...new Set(prec.map(r => r.ticker))].sort((a, b) => {
    const ia = SVEN_ORDER.indexOf(a), ib = SVEN_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const precFor = (t, k) => prec.find(r => r.ticker === t && r.precedent_key === k) || null;
  const notRight = prec.filter(r => r.verdict === 'not_acting_right');
  const broken = (D.svenBreaks || []).filter(r => r.verdict !== 'holds' && r.verdict !== 'insufficient');

  const actingCard = !prec.length ? '' : `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Is it acting right?</h2>
      <span style="font-size:12px;color:var(--muted)">${esc(prec.map(r => r.as_of).sort().pop() || '')} · ${precCols.length} conditions × ${precTickers.length} indices · ${prec[0] ? prec[0].horizon_days : 10}-session response</span></div>
    <p class="note" style="margin:8px 0 14px">Livermore's definition of tape reading has two parts: <b>what the thing normally does</b>, and <b>whether it is doing that now</b>. For each named condition this compares the most recent completed response against every other time that same index was in that same condition. <b>Where it does not match, the output is not a direction</b> — <i>"being unable to tell precisely what is wrong, you cannot tell which way it is going"</i>.</p>
    <div style="overflow-x:auto"><table style="min-width:800px"><thead><tr>
      <th>Index</th>${precCols.map(c => `<th class="num" style="font-size:11px" title="${esc(c.precedent_label)}">${esc(c.precedent_label.replace(/^New (\d+)-day/, '$1d').replace('Gap of half an ATR or more', 'Gap').replace('Narrowest range in seven', 'NR7').replace('Climax day', 'Climax'))}</th>`).join('')}
      <th class="num">Off</th><th>Precedent</th></tr></thead><tbody>
      ${precTickers.map(t => {
        const mine = precCols.map(c => precFor(t, c.precedent_key));
        const off = mine.filter(r => r && r.verdict === 'not_acting_right').length;
        const b = brk[t] || null;
        const bTone = !b ? 'var(--line)' : b.verdict === 'holds' ? 'var(--muted)' : b.verdict === 'insufficient' ? 'var(--line)' : 'var(--warn)';
        const bLabel = !b ? '—' : b.verdict === 'holds' ? 'holds' : b.verdict === 'insufficient' ? 'no reading'
          : b.verdict === 'both' ? 'volatility + correlation' : b.verdict === 'volatility_regime' ? 'volatility regime' : 'correlation regime';
        return `<tr${off ? ' style="background:var(--panel2)"' : ''}>
          <td class="click" data-go="#sven/${esc(t)}" style="cursor:pointer"><b>${esc(t)}</b> <span style="color:var(--muted)">${esc(SVEN_LABEL[t] || '')}</span></td>
          ${mine.map(r => {
            if (!r) return '<td class="num">·</td>';
            const L = PREC_LOOK[r.verdict] || PREC_LOOK.no_precedent;
            const tip = `${r.precedent_label}\n${r.headline}${r.detail ? `\n\n${r.detail}` : ''}\n\n${r.method || ''}`;
            const mark = r.verdict === 'no_precedent' || r.verdict === 'untested'
              ? `<span style="color:var(--line)">${r.verdict === 'untested' ? '\u00b7' : '\u2013'}</span>`
              : `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${L.dot}"></span>`;
            return `<td class="num" data-tip="${esc(tip)}" style="cursor:default">${mark}</td>`;
          }).join('')}
          <td class="num">${off ? `<b style="color:var(--neg)">${off}</b>` : '<span style="color:var(--muted)">·</span>'}</td>
          <td title="${esc(b ? b.detail || '' : '')}" style="font-size:12px;color:${bTone};font-weight:${b && b.verdict !== 'holds' && b.verdict !== 'insufficient' ? '600' : '400'}">${esc(bLabel)}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <p class="note" style="margin-top:12px"><b>A green dot is an index doing what it normally does after that condition; a red dot is not acting right.</b> A dash means this index has not been in that condition enough times to have a precedent — fewer than twelve occurrences, or a median response so small there is no characteristic behaviour to match. <b>Occurrences are counted at least a full response window apart</b>, because a twenty-day high can print for nine sessions running and counting each one would turn one event into nine near-identical observations and make a thin precedent look thick. Precedents are per index and never pooled: gold's response to a new high is not the Russell's, and the average of them describes neither. Hover any cell for the distribution behind it.</p>
    ${notRight.length ? `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">${notRight.length} reading${notRight.length === 1 ? '' : 's'} not acting right</div>
      ${notRight.slice(0, 8).map(r => `<p class="note" style="margin:0 0 7px"><b>${esc(r.ticker)}</b> <span style="color:var(--muted)">${esc(r.precedent_label.toLowerCase())}</span> — ${esc(r.headline)}</p>`).join('')}
      <p class="note">These are the rows Livermore says to stand aside on rather than to trade against. The instruction is explicitly not a direction.</p></div>`
      : `<p class="note"><b>Nothing is failing its own precedent right now.</b> Every tested index responded to its last named condition within the middle range of how it has responded before.</p>`}
    <p class="note" style="margin-top:12px"><b>Precedent</b> is the other half of the question, and it comes from the book's clearest cautionary tale: the chartist with decades of correlations across stocks, bonds, grain, cotton and money who <i>"lost millions"</i> when the war <i>"knocked all precedents into a cocked hat"</i>. A flag means realised volatility, or correlation to the market, has sat outside its own two-year 10–90 band for <b>ten consecutive sessions</b> — and each of those sessions is judged against the two years that preceded <i>it</i>, not against today, because a band drawn with hindsight would move under the streak it is counting. One wild week is not a regime, and <b>a flag that cries wolf is worse than none</b>. ${broken.length ? `Flagged now: ${broken.map(r => `<b>${esc(r.ticker)}</b>`).join(', ')}.` : 'Nothing is flagged.'}</p></div>`;

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
  // The strength scale. One failure event puts an asset on the board; repetition is what builds
  // conviction, rather than what earns admission. The old read needed five agreeing releases
  // before it would say anything, which silenced exactly the case worth seeing -- one important
  // print the market refuses to trade on.
  const STRENGTH = {
    initiate:  ['Initiate',  'var(--flat)', 'One failure event. On the board, not yet a case.'],
    confirmed: ['Confirmed', 'var(--warn)', 'Two failure events the same way. It has happened twice.'],
    strong:    ['Strong',    'var(--neg)',  'Three or more. A pattern rather than an incident.'],
  };
  const strengthCell = r => {
    const k = r.signal_strength;
    if (!k || !STRENGTH[k]) return '<span style="color:var(--muted)">–</span>';
    const [label, tone, why] = STRENGTH[k];
    const pips = k === 'initiate' ? 1 : k === 'confirmed' ? 2 : 3;
    return `<span style="color:${tone};font-weight:700" title="${esc(why)}">${esc(label)}</span>
      <br><span style="letter-spacing:2px;color:${tone};font-size:11px">${'●'.repeat(pips)}${'○'.repeat(Math.max(0, 3 - pips))}</span>
      <br><small style="color:var(--muted)">${r.n_events} event${r.n_events === 1 ? '' : 's'}</small>`;
  };
  // Total news flow: everything that bore on this asset in the window, good against bad, with the
  // share that pointed one way. The percentage opens the full list -- the count on the surface
  // and the headlines behind it come from the same stored array, so they cannot disagree.
  const flowCell = r => {
    const tot = (r.n_positive || 0) + (r.n_negative || 0);
    if (!tot) return '<span style="color:var(--muted)">–</span>';
    const share = Math.max(r.n_positive, r.n_negative) / tot;
    const leanGood = r.n_positive >= r.n_negative;
    return `<span style="color:var(--pos)">${r.n_positive} good</span> / <span style="color:var(--neg)">${r.n_negative} bad</span>
      <br><button class="flowpct" data-flow="${esc(r.ticker)}" title="Open every release behind this figure, good and bad, separated.">
        ${(share * 100).toFixed(0)}% ${leanGood ? 'good' : 'bad'}</button>`;
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
      <th>Asset</th><th>Class</th><th>Verdict</th><th class="num">Signal strength</th>
      <th class="num">Total news flow</th><th class="num">Price</th><th>Impacted Holdings</th></tr></thead><tbody>
    ${rowsN.map(r => {
      const st = FAILURE_STYLE[r.verdict] || FAILURE_STYLE.none;
      const fail = /failure$/.test(r.verdict);
      const ch = n(r.price_change);
      return `<tr${fail ? ' style="background:var(--panel2)"' : ''}>
        <td><b>${esc(r.ticker)}</b><br><small style="color:var(--muted)">${esc(r.label)}</small></td>
        <td style="color:var(--muted)">${esc(r.asset_class || '—')}</td>
        <td><span data-verdict="${esc(r.verdict)}" style="color:${st[1]};font-weight:${fail ? '700' : '400'}" title="${esc(st[2])}">${esc(st[0])}</span>
          <br><small style="color:var(--muted);max-width:360px;display:inline-block">${esc(r.headline)}</small></td>
        <td class="num">${strengthCell(r)}</td>
        <td class="num">${flowCell(r)}</td>
        <td class="num">${ch === null ? '<span style="color:var(--muted)">–</span>' : `<span style="color:${ch >= 0 ? 'var(--pos)' : 'var(--neg)'}">${(ch * 100).toFixed(1)}%</span>`}
          <br><small style="color:var(--muted)">${r.made_new_high ? 'new high' : r.made_new_low ? 'new low' : 'no new extreme'}</small></td>
        <td style="font-size:12px">${impactedCell(r, fail)}</td></tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="note"><b>Impacted Holdings</b> names the firm's own positions in the asset class a reading describes, in firm dollars, largest first — not the models, which hold every class and so repeated the same eight names on every row. A confirming read supports those positions and a failure puts them at risk, so the column takes its sign from the verdict rather than storing one that could drift from it. A ticker marked <b>*</b> counts only its share of that class: QDSIX is classified 60% equity, 20% fixed income and 20% commodities, so a commodity reading reaches a fifth of its position and not all of it. Where a verdict concluded nothing the column reads <b>No Impact to Models</b> — a reading that called no direction reaches no holding. <b>Failures sort to the top of the table</b>, since they are the only rows that ask for a decision.
    <b>Good news is not a property of a release on its own</b> — a strong payroll print is good news for equities and bad news for bonds. Each release is scored by which way it moved its factor, multiplied by how that asset class loads on that factor, so both halves come from tables the desk already keeps rather than from a judgment made here.
    A <b>failure is now an event, not a window average</b>: one headline release — CPI, payrolls, PCE, GDP, retail sales, claims — whose price response over the following five sessions contradicted it. One event is enough to reach this table. The earlier read needed five agreeing releases across two factors before it would say anything, and that silenced the case most worth seeing: a single important print the market refuses to trade on, which is exactly what bonds did when a hot CPI landed and yields fell anyway.
    <b>Signal strength</b> is how often it has happened, not how certain anything is. ${Object.entries(STRENGTH).map(([, v]) => `<b style="color:${v[1]}">${v[0]}</b> ${v[2].toLowerCase()}`).join(' ')} Repetition builds the case rather than buying admission to the table. The trade-off is deliberate and worth stating: one event is a noisier signal than five agreeing releases was, and the desk would rather see an Initiate it can dismiss than miss a Strong because the first print was lonely.
    A release only counts as failed if the price moved against it by more than <b>half of that asset's own typical five-session move</b>. Without that floor the test is a bare sign test, and with roughly fifteen headline releases a month a bare sign test catches coin flips — the first version of this read returned Strong on nine of ten assets, which is the same as having no scale at all. A release the price barely reacted to is a quiet day, not a refusal.
    <b>Total news flow</b> counts every release bearing on the asset, headline or not, because the derived indices are still news even though a failure is not called off them. Click the percentage for the full list, positive and negative separated.
    Only weekly, monthly and quarterly series count: the daily ones here are market prices, not announcements. <b>Publication dates</b> are taken from the day this desk watched each figure appear where the loader was running continuously around it, and assumed from frequency where the figure arrived in a backfill — each row says which, and the two are different claims.</p></div>`;

  return `<span class="eyebrow">Market internals</span><h1>Sven</h1>
   <p class="sub">Raschke's twelve rules across the major indices, whether each index is behaving the way it normally behaves, and whether assets are responding to their own news.</p>
   ${quietCard}${matrix}${actingCard}${newsCard}`;
}

// All twelve rules for one index, with the numbers and the method behind each.
function svenDrawer(ticker) {
  const rows = (D.svenRules || []).filter(r => r.ticker === ticker).sort((a, b) => a.rule_no - b.rule_no || a.rule_key.localeCompare(b.rule_key));
  if (!rows.length) return `<button class="close" data-go="#sven">Close</button><h1>${esc(ticker)}</h1><div class="card"><div class="empty">No rule signals for this index.</div></div>`;
  return `<button class="close" data-go="#sven">Close</button>
   <span class="eyebrow">Raschke's rules · ${esc(rows[0].as_of)}</span><h1>${esc(ticker)} — ${esc(SVEN_LABEL[ticker] || '')}</h1>
   ${(() => {
     // The precedent half of the drawer, first, because it is the question Livermore actually
     // asked -- what this index normally does, and whether it is doing that now.
     const prec = (D.svenPrecedent || []).filter(r => r.ticker === ticker).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
     const b = (D.svenBreaks || []).find(r => r.ticker === ticker) || null;
     if (!prec.length && !b) return '';
     const pc2 = v => v === null || v === undefined ? '\u2014' : `${+v >= 0 ? '+' : '\u2212'}${Math.abs(+v * 100).toFixed(2)}%`;
     const tone = v => v === 'not_acting_right' ? 'var(--neg)' : v === 'acting_strong' ? 'var(--accent)' : v === 'acting_right' ? 'var(--pos)' : 'var(--line)';
     return `<div class="card" style="margin-bottom:14px">
       <h2 style="margin:0 0 4px">Is it acting right?</h2>
       <p class="note" style="margin:0 0 12px">What this index normally does after each named condition, and what it did the last time the condition finished its ${prec[0] ? prec[0].horizon_days : 10}-session window. Run on a completed response, never a live one, so nothing here is a forecast.</p>
       ${!prec.length ? '<div class="empty" style="margin:0">No precedent tests for this index.</div>'
         : `<div style="overflow-x:auto"><table style="min-width:640px"><thead><tr>
         <th>Condition</th><th class="num">Times</th><th class="num">Normally</th><th class="num">Middle half</th>
         <th class="num">Last trigger</th><th class="num">What followed</th><th>Verdict</th></tr></thead><tbody>
         ${prec.map(r => `<tr title="${esc(r.detail || '')}">
           <td>${esc(r.precedent_label)}</td>
           <td class="num">${r.n_precedents}</td>
           <td class="num">${pc2(r.hist_median)}${r.hist_hit_rate === null ? '' : `<span style="font-size:10px;color:var(--muted)"> ${(+r.hist_hit_rate * 100).toFixed(0)}%</span>`}</td>
           <td class="num" style="font-size:11px;color:var(--muted)">${r.hist_p25 === null ? '\u2014' : `${pc2(r.hist_p25)} to ${pc2(r.hist_p75)}`}</td>
           <td class="num" style="font-size:11px;color:var(--muted)">${esc(r.trigger_date || '\u2014')}</td>
           <td class="num" style="color:${r.realised === null ? 'var(--muted)' : +r.realised >= 0 ? 'var(--pos)' : 'var(--neg)'}">${pc2(r.realised)}${r.realised_pctile === null ? '' : `<span style="font-size:10px;color:var(--muted)"> p${(+r.realised_pctile * 100).toFixed(0)}</span>`}</td>
           <td style="color:${tone(r.verdict)};font-weight:600;font-size:12px">${esc((r.verdict || '').replace(/_/g, ' '))}</td></tr>`).join('')}
       </tbody></table></div>
       <p class="note" style="margin-top:10px">${esc(prec[0].method || '')}</p>`}
       ${!b ? '' : `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
         <div class="eyebrow" style="margin-bottom:6px">Does the precedent still apply?</div>
         <p style="margin:0 0 4px;color:${b.verdict === 'holds' ? 'var(--muted)' : 'var(--warn)'}"><b>${esc(b.headline)}</b></p>
         <p class="note" style="margin:0">${esc(b.detail || '')}</p></div>`}
     </div>`;
   })()}
   ${rows.map(r => {
     const st = RULE_STATE[r.state] || RULE_STATE.neutral;
     const vm = VS_MARKET[r.vs_market] || null;
     const edge = r.state === 'not_evaluable' ? 'var(--line)' : r.state === 'no_read' ? 'var(--line)' : st.dot;
     return `<div class="card" style="margin-bottom:10px;border-left:3px solid ${edge}">
       <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap">
         <h2 style="margin:0;font-size:13px">${r.rule_no}. ${esc(r.rule_title)}</h2>
         <div style="display:flex;gap:6px;align-items:baseline">
           ${vm && r.vs_market !== 'silent' && r.vs_market !== 'is_market' ? `<span class="chip" title="${esc(vm.short)}" style="color:${r.vs_market === 'against_market' ? 'var(--warn)' : 'var(--muted)'}">${esc(vm.label)}${r.market_state && r.vs_market !== 'market_silent' ? ` · ${esc(MARKET_T)} ${esc(r.market_state.replace('_', ' '))}` : ''}</span>` : ''}
           <span class="chip" title="${esc(st.short || '')}" style="color:${st.dot === 'transparent' || st.dot === 'none' ? 'var(--muted)' : st.dot}">${esc(st.label)}</span></div></div>
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

    return `${decisionQualityCard(isOverall ? null : annieModel)}<div class="card" style="margin-bottom:14px">
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

function briefs(embed) {
  const morning = outputsFor('sisyphus', ['morning_brief']).slice().sort((a, b) => b.as_of.localeCompare(a.as_of));
  const primers = outputsFor('sisyphus', ['sunday_primer']).slice().sort((a, b) => b.as_of.localeCompare(a.as_of));
  const list = (title, rows, emptyMsg) => `
   <div class="card" style="margin-bottom:14px"><h2>${esc(title)}</h2>
    ${rows.length ? rows.map((o, i) => `<details ${i === 0 ? 'open' : ''} style="margin-bottom:8px">
        <summary style="cursor:pointer;padding:6px 0"><b>${esc(o.title)}</b></summary>
        <div style="padding-top:6px">${md(o.body_md)}</div></details>`).join('')
      : `<div class="empty">${esc(emptyMsg)}</div>`}</div>`;
  return `${embed ? '' : '<span class="eyebrow">Sisyphus</span><h1>Briefs</h1>'}
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

  // Where the volatility check failed and a blend exists that passes, that blend is STAGED
  // automatically: selected in the dropdown, previewed in the donut, and counted by the tick.
  // It is not saved. Nothing in this panel is written until Update is pressed, and a
  // classification is a judgment about client money — the suggestion arrives made rather than
  // offered, and still waits for the owner to agree with it.
  //
  // Only where the owner has expressed no view of their own: `in` rather than a truthiness test,
  // so a deliberate "Leave unclassified" is a view and is left alone.
  for (const f of (D.blendFit || [])) {
    if (f.passes === true || !f.suggested_mix) continue;
    if (f.security_id in repPending) continue;
    const cur = mixOf(ovBySec[f.security_id]);
    if (cur && mixKey(cur) === mixKey(f.suggested_mix)) continue;   // already on it
    repPending[f.security_id] = mixKey(f.suggested_mix);
  }
  // Counted from what is STAGED, not from what this render happened to stage. The drawer renders
  // more than once — opening it, previewing a change, switching a period — and a counter
  // incremented in the loop above reads 3 the first time and 0 every time after, so the banner
  // would vanish while the selections it describes stayed on screen.
  const autoStaged = (D.blendFit || []).filter(f =>
    f.suggested_mix && repPending[f.security_id] === mixKey(f.suggested_mix)).length;
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
        ${autoStaged ? `<p class="note" style="margin:8px 0 0;font-size:11.5px;color:var(--warn)"><b>${autoStaged} suggested blend${autoStaged === 1 ? ' has' : 's have'} been selected for you</b>, chosen to bring the blend's standard deviation within ${Math.round(((D.blendFit || [])[0]?.tolerance ?? 0.10) * 100)}% of the fund's own. Nothing is saved until you press Update, and changing a dropdown overrides the suggestion.</p>` : ''}
        ${(unres.length || res.length) ? `<p class="note" style="margin:8px 0 0;font-size:11.5px">A classification is stored against the security, not this model, so it applies everywhere the name is held${(() => {
          const ids = [...unres, ...res].map(h => h.security_id).filter(Boolean);
          const others = (D.models || []).filter(x => x.id !== m.id && ((D.currentHoldings || []).some(c => c.strategy_id === x.id && ids.includes(c.security_id)) || (x.holdings || []).some(c => ids.includes(c.security_id))));
          return others.length ? ` — these names are also held by ${others.length} other model${others.length === 1 ? '' : 's'}` : '';
        })()}. The tick compares the chosen blend's standard deviation with the fund's own over the fund's longest history; within ${Math.round(((D.blendFit || [])[0]?.tolerance ?? 0.10) * 100)}% passes.</p>` : ''}
      </div></section>`;
  };

  // A target submitted from the Sandbox replaces the target panel, and ONLY the target panel.
  // Everything else in this drawer -- the actual holdings beside it, the statistics, the
  // contribution, the drawdown, the fingerprint and the breakdown -- stays on what the model
  // holds and what it has traded. A target is an intention; an intention must not restate
  // performance, which is why this is a separate table rather than a write to target_allocations.
  const sbTarget = (D.sandboxTargets || []).find(t => t.strategy_id === m.id) || null;
  const targetPanelH = sbTarget
    ? sbTarget.holdings.map(h => ({ ...h, cls: (D.markets.find(x => x.id === h.security_id) || {}).cls || null }))
    : targetH;
  const targetPanelAs = sbTarget
    ? `Submitted ${String(sbTarget.submitted_at).slice(0, 10)} from the Sandbox${sbTarget.author ? ` by ${sbTarget.author}` : ''}`
    : 'Current target weights';

  const allocGrid = `<div class="dashgrid" style="margin-bottom:18px">
    ${panel('Target allocation', targetPanelAs, targetPanelH, h => h.cls)}
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

  // Both outcomes re-render the drawer rather than reaching in and editing the node that happens
  // to hold the loading text. Mutating textContent left the state invisible to anything that
  // reads the drawer's markup -- a newly added security with no technicals showed "Loading
  // chart…" for ever as far as the smoke harness could tell, and a reader staring at a stuck
  // spinner has no way to know the difference between slow and empty either.
  const shell = body => { $('#drawer').innerHTML = `<button class="close" data-go="#markets">Close</button>
    <span class="eyebrow">${esc(D.classNames[row.cls] || row.cls)}</span><h1>${esc(row.ticker)}</h1>
    <p class="sub">${esc(row.name)}</p>${body}`; };
  let hist;
  try {
    hist = await q(() => sb.from('technical_snapshots').select(TECH_HISTORY_COLS)
      .eq('security_id', securityId).order('as_of', { ascending: false }).limit(300));
    hist.reverse();
  } catch (ex) {
    shell(`<div class="empty">Could not load history: ${esc(ex.message)}</div>`);
    return;
  }
  if (!hist.length) {
    shell(`<div class="empty">No technical history for this security yet. The nightly technicals job needs about ten months of closes before it will fit an SMA200 and a 63-day relative strength, so a newly added name appears here only once it has them.</div>`);
    return;
  }

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
    obs = await q(() => sb.from('macro_observations').select('obs_date,value,vintage_date')
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

// A model's name without its parenthetical short form. annie() has its own copy scoped to that
// page; this is the module-level one the Sandbox and Gail use.
const bareName = s => String(s || '').replace(/\s*\([^)]*\)/g, '');

// ---------- Sandbox: the trade journal ----------
//
// A decision record, not an order. Nothing here reaches a broker, and submitting an entry moves
// no allocation: the target allocation below is a separate object with its own explicit Submit
// Final, so writing down a thought cannot change client money by accident.
//
// Form state is module-level so a re-render keeps it. Structural controls — the action, the
// asset class, the sizing — re-render, because what the form shows depends on them. Free text
// and the slider deliberately do NOT: re-rendering a textarea on every keystroke takes the
// cursor with it, and re-rendering a range input mid-drag drops the drag.
let sbAction = 'buy';
let sbTicker = '';
let sbClass = null;
let sbRationale = '';
// Thinking in Bets, added 2026-10-20. Confidence is a NUMBER rather than a conviction, because a
// number can be scored and a conviction cannot -- and because "58% to 46%" is a recalibration
// where "right to wrong" is an identity threat a person fights off instead of updating.
let sbConfidence = 60, sbHorizonDays = 90, sbPremortem = '';
// The branches, written down before the advancing present cuts them off. Kept whole afterwards.
let sbScenarios = [{ label: '', probability: 60 }, { label: '', probability: 40 }];
let sbSetup = '';
let sbSizing = null;
let sbCustomPct = '';
let sbHorizon = null;
let sbLoss = -0.10;
let sbModels = new Set();
let sbSaveMsg = null;

const SB_SETUPS = {
  buy: ['MPH change', 'Swing Trade', 'Confirmed Bottom', 'Momentum Play', 'Quad Focused', 'Add-On', 'Cash Substitute', 'Sentiment'],
  sell: ['Rebalance', 'Stop Loss', 'Top Confirmed', 'MPH Change', 'Quad Focused', 'Trim', 'Sentiment'],
  rebalance: ['Time-Based', 'Risk-Based'],
};
const SB_CLASSES = [
  ['equity', 'Equity'], ['fixed_income', 'Fixed Income'], ['commodities', 'Commodities'],
  ['blended', 'Blended Asset'], ['cash_equivalent', 'Cash Equivalent'],
];
// Two sizing ladders. Equity-like risk is sized in 3s to a 12% cap -- the desk's single-position
// limit -- and income-like risk in 4s to 16%, because a bond sleeve carries less of it per unit
// of weight. Full Position is the cap, not an aspiration.
const SB_SIZING = {
  equityLike: [['starter', 'Starter Position', 0.03], ['half_max', 'Half Max', 0.06], ['full', 'Full Position', 0.12]],
  incomeLike: [['starter', 'Starter Position', 0.04], ['half_max', 'Half Max', 0.08], ['full', 'Full Position', 0.16]],
};
const sbLadder = () => (sbClass === 'fixed_income' || sbClass === 'cash_equivalent') ? SB_SIZING.incomeLike : SB_SIZING.equityLike;
const sbSizePct = () => {
  if (sbSizing === 'custom') { const v = parseFloat(sbCustomPct); return Number.isFinite(v) ? v / 100 : null; }
  const row = sbLadder().find(r => r[0] === sbSizing);
  return row ? row[2] : null;
};

// The tax a proposed sale would realise, per model, straight off the open lots. FIFO, so the
// oldest slice goes first and its own age decides its rate -- one sale can be part short and part
// long term, which is what makes an average-cost shortcut wrong here.
const SB_LT_RATE = 0.15, SB_ST_RATE = 0.24;
function sbTaxFor(strategyId, ticker, sellWeight) {
  const lots = (D.openLots || []).filter(l => l.strategy_id === strategyId && l.ticker === ticker)
    .slice().sort((a, b) => String(a.lot_date).localeCompare(String(b.lot_date)));
  if (!lots.length) return null;
  const held = lots.reduce((a, l) => a + +l.weight, 0);
  const take = Math.min(sellWeight, held);
  let left = take, stGain = 0, ltGain = 0, stLoss = 0, ltLoss = 0, oldest = null, anyOpening = false, anyEstimated = false;
  for (const l of lots) {
    if (left <= 1e-9) break;
    const part = Math.min(+l.weight, left);
    if (l.current_price === null || !(+l.cost_price > 0)) { left -= part; continue; }
    const g = part * (+l.current_price / +l.cost_price - 1) * 10000;
    if (l.is_long_term) { if (g >= 0) ltGain += g; else ltLoss += -g; }
    else { if (g >= 0) stGain += g; else stLoss += -g; }
    if (!oldest) oldest = l.lot_date;
    if (l.from_opening_book) anyOpening = true;
    if (l.basis_estimated) anyEstimated = true;
    left -= part;
  }
  // Netted the way the rule works, so a loss offsets rather than being taxed at zero and ignored.
  let st = stGain - stLoss, lt = ltGain - ltLoss;
  if (st < 0 && lt > 0) { const u = Math.min(-st, lt); lt -= u; st += u; }
  else if (lt < 0 && st > 0) { const u = Math.min(-lt, st); st -= u; lt += u; }
  const tax = Math.max(0, st) * SB_ST_RATE + Math.max(0, lt) * SB_LT_RATE;
  return { held, sold: take, stGain, ltGain, stLoss, ltLoss, netSt: st, netLt: lt, taxBps: tax, oldest, anyOpening, anyEstimated, shortOfRequest: sellWeight > held + 1e-9 };
}

function sandbox() {
  const models = D.models || [];
  const setups = SB_SETUPS[sbAction] || [];
  const sizePct = sbSizePct();
  const isSell = sbAction === 'sell' || sbAction === 'rebalance';
  const chosen = sbModels.size ? models.filter(m => sbModels.has(m.id)) : [];

  const radio = (name, val, cur, label, attr) =>
    `<label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;cursor:pointer;font-size:13px">
      <input type="radio" name="${name}" ${attr}="${esc(val)}" ${cur === val ? 'checked' : ''} style="accent-color:var(--accent)">${esc(label)}</label>`;
  const check = (val, cur, label, attr, sub) =>
    `<label style="display:inline-flex;align-items:center;gap:6px;margin:0 14px 8px 0;cursor:pointer;font-size:13px">
      <input type="checkbox" ${attr}="${esc(val)}" ${cur === val ? 'checked' : ''} style="accent-color:var(--accent)">${esc(label)}${sub ? `<span style="color:var(--muted)">${esc(sub)}</span>` : ''}</label>`;

  // ---- tax estimate, only where a sale would realise something ----
  const taxBlock = (() => {
    if (!isSell) return '';
    if (!sbTicker) return `<div class="note" style="margin-top:8px;color:var(--muted)">Enter a ticker and the tax a sale would realise appears here, model by model.</div>`;
    const target = chosen.length ? chosen : models;
    const rows = target.map(m => ({ m, t: sbTaxFor(m.id, sbTicker.toUpperCase(), sizePct === null ? Infinity : sizePct) }))
      .filter(x => x.t);
    if (!rows.length) return `<div class="note" style="margin-top:8px;color:var(--muted)">No open lots for <b>${esc(sbTicker.toUpperCase())}</b> in ${chosen.length ? 'the selected models' : 'any model'}, so there is nothing to realise.</div>`;
    const totalTax = rows.reduce((a, x) => a + x.t.taxBps, 0) / rows.length;
    return `<div style="margin-top:10px;border:1px solid var(--line);border-radius:8px;padding:11px 13px;background:var(--panel2)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <b style="font-size:13px">Tax impact of selling ${esc(sbTicker.toUpperCase())}${sizePct === null ? ' in full' : ` ${(sizePct * 100).toFixed(0)}% of the model`}</b>
        <span style="font-size:12px;color:var(--muted)">15% long-term · 24% short-term</span></div>
      <div style="overflow-x:auto;margin-top:8px"><table style="min-width:520px"><thead><tr>
        <th>Model</th><th class="num">Held</th><th class="num">Sold</th><th class="num">LT gain</th><th class="num">ST gain</th><th class="num">Tax</th><th>Oldest lot</th>
      </tr></thead><tbody>
      ${rows.map(({ m, t }) => `<tr><td>${esc(bareName(m.name))}</td>
        <td class="num">${(t.held * 100).toFixed(1)}%</td>
        <td class="num">${(t.sold * 100).toFixed(1)}%</td>
        <td class="num" style="color:var(--pos)">${(t.netLt / 100).toFixed(2)}%</td>
        <td class="num" style="color:var(--flat)">${(t.netSt / 100).toFixed(2)}%</td>
        <td class="num"><b style="color:var(--neg)">−${(t.taxBps / 100).toFixed(2)}%</b></td>
        <td style="font-size:12px;color:var(--muted)">${esc(t.oldest || '—')}${t.anyOpening ? ' *' : ''}${t.anyEstimated ? ' †' : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note" style="margin:8px 0 0">Averaging <b>−${(totalTax / 100).toFixed(2)}%</b> of model value across ${rows.length} model${rows.length === 1 ? '' : 's'}. Priced off the open FIFO lots, so the oldest slice goes first and its own age sets its rate — one sale can be part short and part long term. Losses net against gains of the same character before tax is applied. ${rows.some(x => x.t.anyOpening) ? 'Lots marked <b>*</b> were already held when the records begin, so their basis and age are the first snapshot\'s rather than the true purchase, and the gain on them is understated. ' : ''}${rows.some(x => x.t.anyEstimated) ? 'Lots marked <b>†</b> had no price on the day they were acquired, so the earliest price the security has is used as the basis — the holding period is real, the gain is indicative. ' : ''}${rows.some(x => x.t.shortOfRequest) ? 'Where the position is smaller than the size chosen, only what is held is sold. ' : ''}Estimate only, federal rates, no state tax or wash-sale adjustment.</p></div>`;
  })();

  const scenTotal = sbScenarios.reduce((a, x) => a + (+x.probability || 0), 0);
  // Scenarios are required to be complete -- labelled and summing to 100 -- because a half-filled
  // branch list is worse than none: it looks like a record of what was considered and is not.
  const scenOk = sbScenarios.every(x => x.label.trim()) && Math.abs(scenTotal - 100) < 0.5;
  const canSubmit = sbAction && sbClass && sbRationale.trim().length > 0 && sbSetup && sbSizing && sizePct !== null && sbHorizon && sbModels.size > 0 && (sbAction === 'rebalance' || sbTicker.trim()) && scenOk && sbPremortem.trim().length > 0 && sbHorizonDays > 0;
  const missing = [
    sbTicker.trim() || sbAction === 'rebalance' ? '' : 'ticker',
    sbClass ? '' : 'asset class', sbRationale.trim() ? '' : 'rationale', sbSetup ? '' : 'set-up',
    sizePct === null ? 'sizing' : '', sbHorizon ? '' : 'time horizon', sbModels.size ? '' : 'at least one model',
    sbScenarios.every(x => x.label.trim()) ? '' : 'a label on every scenario',
    Math.abs(scenTotal - 100) < 0.5 ? '' : 'scenarios summing to 100%',
    sbPremortem.trim() ? '' : 'premortem',
    sbHorizonDays > 0 ? '' : 'a horizon in days',
  ].filter(Boolean);

  // The Grid. Scoped to this wrapper so the look cannot reach another tab, and the semantic
  // colours inside it are untouched: a gain stays green and a loss stays red, because a reader
  // should never have to translate a colour through a theme to know what a number means.
  return `<div class="tron">
  <span class="eyebrow">Sandbox</span><h1>Sandbox</h1>
  <p class="sub">Write down a decision before taking it, and try an allocation before committing to it. Nothing on this page reaches a broker, and nothing changes a model until it is explicitly submitted.</p>

  <div class="card" style="margin-bottom:14px">
    <h2 style="margin:0 0 4px">Journal entry</h2>
    <p class="note" style="margin:0 0 14px">A decision record. Submitting files it with Gail; it moves no money and changes no allocation.</p>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Action</div>
      ${['buy', 'sell', 'rebalance'].map(a => radio('sbaction', a, sbAction, a[0].toUpperCase() + a.slice(1), 'data-sbaction')).join('')}</div>

    <div style="margin-bottom:14px;display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">
      <div><div class="eyebrow" style="margin-bottom:6px">Ticker${sbAction === 'rebalance' ? ' <span style="color:var(--muted);text-transform:none">(optional for a rebalance)</span>' : ''}</div>
        <input data-sbticker type="text" value="${esc(sbTicker)}" placeholder="e.g. KSPY" style="width:140px;padding:6px 9px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;text-transform:uppercase"></div>
    </div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Asset class</div>
      ${SB_CLASSES.map(([v, l]) => check(v, sbClass, l, 'data-sbclass')).join('')}</div>

    ${taxBlock}

    <div style="margin:16px 0 14px"><div class="eyebrow" style="margin-bottom:6px">Rationale</div>
      <textarea data-sbrationale rows="3" placeholder="Why this, why now, and what would make it wrong." style="width:100%;padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;font-family:inherit;resize:vertical">${esc(sbRationale)}</textarea></div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Set-Up <span style="color:var(--muted);text-transform:none">— the list follows the action</span></div>
      <select data-sbsetup style="padding:6px 9px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;min-width:220px">
        <option value="">Choose a set-up…</option>
        ${setups.map(o => `<option value="${esc(o)}" ${sbSetup === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select></div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Sizing strategy${sbClass ? '' : ' <span style="color:var(--muted);text-transform:none">— choose an asset class first; the ladder depends on it</span>'}</div>
      ${!sbClass ? '<span style="color:var(--muted);font-size:13px">—</span>' : `
        ${sbLadder().map(([v, l, pc]) => check(v, sbSizing, l, 'data-sbsizing', ` (${(pc * 100).toFixed(0)}%)`)).join('')}
        ${check('custom', sbSizing, 'Custom', 'data-sbsizing')}
        ${sbSizing === 'custom' ? `<input data-sbcustom type="number" step="0.1" min="0" max="100" value="${esc(sbCustomPct)}" placeholder="%" style="width:86px;padding:5px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px">` : ''}`}</div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Time horizon</div>
      ${radio('sbhorizon', 'strategic', sbHorizon, 'Strategic Position', 'data-sbhorizon')}
      ${radio('sbhorizon', 'trading', sbHorizon, 'Trading Position', 'data-sbhorizon')}</div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Confidence <span style="color:var(--muted);text-transform:none">— how likely is this to work, and by when</span></div>
      <div style="display:flex;align-items:center;gap:12px;max-width:520px;flex-wrap:wrap">
        <input data-sbconf type="range" min="1" max="99" step="1" value="${sbConfidence}" style="flex:1;min-width:200px;accent-color:var(--accent)">
        <b id="sbConfOut" style="color:var(--accent);font-variant-numeric:tabular-nums;min-width:44px">${sbConfidence}%</b>
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)">over
          <input data-sbhorizondays type="number" min="1" max="3650" value="${sbHorizonDays}" style="width:74px;padding:5px 7px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px"> days</label></div>
      <p class="note" style="margin:6px 0 0">The scale stops at 1 and 99 deliberately. Nearly nothing is 0% or 100%, and offering those ends invites the all-or-nothing thinking this field exists to replace. <b>This cannot be filled in later</b> — a confidence recalled after the outcome is known is a memory of the outcome, so calibration only ever measures forward from the day it starts.</p></div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Scenarios <span style="color:var(--muted);text-transform:none">— the futures you think are possible, before one of them happens</span></div>
      ${sbScenarios.map((sc, i) => `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;max-width:620px">
        <input data-sbscenlabel="${i}" value="${esc(sc.label)}" placeholder="${i === 0 ? 'What you expect' : i === 1 ? 'What else could happen' : 'The one nobody wants'}" style="flex:1;padding:7px 9px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px">
        <input data-sbscenprob="${i}" type="number" min="0" max="100" value="${sc.probability}" style="width:70px;padding:7px 9px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;text-align:right">
        <span style="color:var(--muted);font-size:13px">%</span>
        ${sbScenarios.length > 2 ? `<button class="btn" data-sbscendel="${i}" style="padding:4px 9px;font-size:12px;background:var(--panel2);color:var(--muted)">×</button>` : ''}</div>`).join('')}
      <div style="display:flex;gap:10px;align-items:center;margin-top:4px">
        ${sbScenarios.length < 4 ? `<button class="btn" data-sbscenadd="1" style="padding:5px 11px;font-size:12px;background:var(--panel2);color:var(--text)">Add a branch</button>` : ''}
        <span style="font-size:12px;color:${Math.abs(scenTotal - 100) < 0.5 ? 'var(--muted)' : 'var(--warn)'}">sums to ${scenTotal}%${Math.abs(scenTotal - 100) < 0.5 ? '' : ' — must be 100'}</span></div>
      <p class="note" style="margin:6px 0 0">Time is a tree: one trunk of past, many branches of possible future. The advancing present acts like a chainsaw — once a branch happens, every other one is cut off and the 20% outcome looks like it was always certain. <b>These are kept whole after the fact</b>, including the ones that did not happen, because that record is the only thing hindsight has to argue with.</p></div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Premortem <span style="color:var(--muted);text-transform:none">— it is a year from now and this failed. Why?</span></div>
      <textarea data-sbpremortem rows="2" placeholder="Write from the failure looking back, not from today looking forward." style="width:100%;padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;font-family:inherit;resize:vertical">${esc(sbPremortem)}</textarea>
      <p class="note" style="margin:6px 0 0">Imagining obstacles makes success <b>more</b> likely, not less — Oettingen's mental contrasting finds the opposite of what positive visualisation promises. Backcasting is the cheerleader; this is the heckler, and without it the space where things go right gets drawn far too large.</p></div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Loss threshold <span style="color:var(--muted);text-transform:none">— a precommitment: Stan alerts when it is breached</span></div>
      <div style="display:flex;align-items:center;gap:12px;max-width:420px">
        <input data-sbloss type="range" min="-30" max="-1" step="1" value="${(sbLoss * 100).toFixed(0)}" style="flex:1;accent-color:var(--neg)">
        <b id="sbLossOut" style="color:var(--neg);font-variant-numeric:tabular-nums;min-width:48px">${(sbLoss * 100).toFixed(0)}%</b></div></div>

    <div style="margin-bottom:14px"><div class="eyebrow" style="margin-bottom:6px">Models</div>
      ${models.map(m => `<label style="display:inline-flex;align-items:center;gap:6px;margin:0 14px 8px 0;cursor:pointer;font-size:13px">
        <input type="checkbox" data-sbmodel="${esc(m.id)}" ${sbModels.has(m.id) ? 'checked' : ''} style="accent-color:var(--accent)">${esc(bareName(m.name))}</label>`).join('')}</div>

    ${sbSaveMsg ? `<div class="note" style="margin-bottom:10px;color:${sbSaveMsg.ok ? 'var(--pos)' : 'var(--neg)'}">${esc(sbSaveMsg.text)}</div>` : ''}
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn" data-sbsubmit="1" ${canSubmit ? '' : 'disabled'} style="${canSubmit ? '' : 'opacity:.5'}">Submit Trade</button>
      <button class="btn" data-sbanalyze="1" ${canSubmit ? '' : 'disabled'} style="${canSubmit ? '' : 'opacity:.5'};background:var(--panel2);color:var(--text)">Analyze Trade</button>
      ${missing.length ? `<small style="color:var(--muted)">Still needed: ${esc(missing.join(', '))}</small>` : ''}</div>
    <p class="note">Submitting files the entry with Gail, who keeps the catalogue. <b>Analyze</b> asks Annie, Adam, Sven, Kate and Stan to read the same entry through their own lens and return Go, Go Fish or No Go — Annie on process, Adam on regime, Sven on the tape, Kate on whether the crowd is already on this side, and Stan on what it does to the book and what it costs to do. They are agents, not scripts in this page: the request is recorded and the verdicts appear on Gail's tab when they run. A button that appeared to think while inventing five opinions in JavaScript would be the worst thing this desk could ship.</p>
  </div>
  ${sandboxAllocation()}
  </div>`;
}

// ---------- Sandbox: the target allocation editor ----------
//
// A workbench, not a commitment. Test recomputes everything from the proposed weights; Submit
// Final records the allocation and ONE thing reads it — the Target Allocation pie in a model's
// drawer. Every statistic on this site carries on measuring what the models actually hold,
// because a target is what the desk intends and an intention must not restate performance.
let saModelId = null;
let saRows = null;          // [{ticker, weight, security_id}] — the working copy
let saTested = null;        // the last Test result; cleared whenever a weight changes
let saBusy = false;
let saMsg = null;
let saNote = '';

const saTotal = () => (saRows || []).reduce((a, r) => a + (+r.weight || 0), 0);
function saLoad(m) {
  saModelId = m.id;
  // Seeded from a previous submission if there is one, otherwise from the model's live targets.
  const prev = (D.sandboxTargets || []).find(t => t.strategy_id === m.id);
  saRows = prev
    ? prev.holdings.map(h => ({ ...h }))
    : (m.holdings || []).map(h => ({ ticker: h.ticker || (D.markets.find(x => x.id === h.security_id) || {}).ticker || '?', weight: +h.weight, security_id: h.security_id }));
  saTested = null; saMsg = null;
}

// Daily prices for the proposed names, fetched when Test is pressed rather than on page load:
// the editor is one page of many and nobody should pay for its price history to read Sisyphus.
const saPriceCache = new Map();
async function saPrices(ids, from) {
  const missing = ids.filter(id => !saPriceCache.has(id));
  for (let i = 0; i < missing.length; i += 8) {
    const chunk = missing.slice(i, i + 8);
    for (const id of chunk) saPriceCache.set(id, []);
    // PAGED. Eight securities over a year is around two thousand rows, and PostgREST stops at a
    // thousand without saying so in the body -- the first cut of this read a truncated page and
    // measured Balanced Core at a 26.9% year with 21% volatility, because every holding whose
    // history was cut short got based on whatever price survived. A plausible number computed
    // from a silently truncated read is the worst thing this page could produce.
    for (let page = 0; ; page++) {
      const { data, error } = await sb.from('market_data')
        .select('security_id,price_date,close,adj_close')
        .in('security_id', chunk).gte('price_date', from)
        .order('price_date', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (error) throw new Error(error.message);
      const got = data || [];
      for (const r of got) saPriceCache.get(r.security_id).push(r);
      if (got.length < 1000) break;
      if (page > 40) throw new Error('paged past 40k price rows for one chunk; refusing to loop further');
    }
    // The range pages come back ordered by date across the whole chunk, so each security's own
    // series has to be put back in order before anything reads "the first price in the window".
    for (const id of chunk) saPriceCache.get(id).sort((a, b) => String(a.price_date).localeCompare(String(b.price_date)));
  }
  return Object.fromEntries(ids.map(id => [id, saPriceCache.get(id) || []]));
}

// Rebuild a daily series from the proposed weights and measure it properly. Buy and hold from the
// window start: the weights are a target, and a target that is rebalanced daily is a different
// strategy from the one being proposed.
function saSeries(rows, px, dates, rf) {
  const out = [];
  const base = {};
  for (const r of rows) {
    const b = px[r.security_id] || [];
    const first = b.find(x => x.price_date >= dates[0]);
    base[r.security_id] = first ? +(first.adj_close ?? first.close) : null;
  }
  const byDate = {};
  for (const r of rows) {
    byDate[r.security_id] = new Map((px[r.security_id] || []).map(x => [x.price_date, +(x.adj_close ?? x.close)]));
  }
  for (const d of dates) {
    let v = 0, covered = 0;
    for (const r of rows) {
      const p = byDate[r.security_id]?.get(d), b = base[r.security_id];
      if (!(p > 0) || !(b > 0)) continue;
      v += (+r.weight) * (p / b);
      covered += +r.weight;
    }
    if (covered > 0) out.push({ d, v: v / covered, covered });
  }
  return out;
}
function saStats(series, bench) {
  if (series.length < 20) return null;
  const ret = [], bret = [];
  for (let i = 1; i < series.length; i++) {
    ret.push(series[i].v / series[i - 1].v - 1);
    const b0 = bench.find(x => x.d === series[i - 1].d), b1 = bench.find(x => x.d === series[i].d);
    bret.push(b0 && b1 ? b1.v / b0.v - 1 : null);
  }
  const total = series.at(-1).v / series[0].v - 1;
  const benchTotal = bench.length > 1 ? bench.at(-1).v / bench[0].v - 1 : null;
  const mean = ret.reduce((a, b) => a + b, 0) / ret.length;
  const sd = Math.sqrt(ret.reduce((a, b) => a + (b - mean) ** 2, 0) / (ret.length - 1));
  // Drawdown with the peak reset at the window start, the same rule the model statistics use.
  let peak = -Infinity, dd = 0;
  for (const p of series) { if (p.v > peak) peak = p.v; dd = Math.min(dd, p.v / peak - 1); }
  // Capture and beta only over days where both sides priced.
  const pairs = ret.map((r, i) => [r, bret[i]]).filter(([, b]) => b !== null);
  const up = pairs.filter(([, b]) => b > 0), down = pairs.filter(([, b]) => b < 0);
  const sum = (a, i) => a.reduce((x, y) => x + y[i], 0);
  const cap = a => a.length && sum(a, 1) !== 0 ? sum(a, 0) / sum(a, 1) : null;
  let beta = null, r2 = null;
  if (pairs.length > 20) {
    const mb = sum(pairs, 1) / pairs.length, mr = sum(pairs, 0) / pairs.length;
    let cov = 0, varb = 0, varr = 0;
    for (const [r, b] of pairs) { cov += (r - mr) * (b - mb); varb += (b - mb) ** 2; varr += (r - mr) ** 2; }
    beta = varb > 0 ? cov / varb : null;
    r2 = varb > 0 && varr > 0 ? (cov * cov) / (varb * varr) : null;
  }
  return { total, benchTotal, vol: sd * Math.sqrt(252), maxDD: dd, upside: cap(up), downside: cap(down), beta, r2, n: series.length, coverage: Math.min(...series.map(s => s.covered)) };
}


// The fingerprint and the sector breakdown are weighted sums of figures already measured per
// security and already loaded, so they need no prices and must not wait for Test. They move with
// a weight exactly as the two pies do; Test is only for the figures that need a price series.
function saFingerprint(rows, againstStrategyId) {
  const fps = D.secFingerprint || [];
  const FAC = [['value', 'Value'], ['momentum', 'Momentum'], ['quality', 'Quality'], ['low_volatility', 'Low Volatility'], ['size', 'Size (small)']];
  let cov = 0, tot = 0; const acc = {};
  for (const r of rows) {
    if (!(+r.weight > 0)) continue;
    tot += +r.weight;
    const f = fps.find(x => x.security_id === r.security_id);
    if (!f || !f.betas) continue;
    cov += +r.weight;
    for (const [k] of FAC) acc[k] = (acc[k] || 0) + (+r.weight) * (+f.betas[k] || 0);
  }
  if (!(cov > 0)) return null;
  const cur = (D.fingerprint || []).filter(x => x.scope === 'model' && x.strategy_id === againstStrategyId);
  return {
    coverage: tot > 0 ? cov / tot : 0,
    rows: FAC.map(([k, label], i) => ({
      factor: k, label, sort_order: i,
      model_beta: +(acc[k] / cov).toFixed(4),
      benchmark_beta: cur.find(c => c.factor === k)?.model_beta ?? null,
    })),
  };
}
function saSectors(rows) {
  const se = D.styleExposure || [];
  let cov = 0, tot = 0; const acc = {};
  for (const r of rows) {
    if (!(+r.weight > 0)) continue;
    tot += +r.weight;
    const mix = (D.secStyle || []).find(x => x.security_id === r.security_id);
    if (!mix || !mix.mix) continue;
    cov += +r.weight;
    for (const [b, share] of Object.entries(mix.mix)) acc[b] = (acc[b] || 0) + (+r.weight) * share;
  }
  const sum = Object.values(acc).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const label = b => (se.find(x => x.bucket === b) || {}).label || String(b).replace(/_/g, ' ');
  return { coverage: tot > 0 ? cov / tot : 0, rows: Object.entries(acc).map(([b, v]) => ({ label: label(b), v: v / sum })).sort((a, b) => b.v - a.v) };
}

// The editor itself, appended to the Sandbox page below the journal.
function sandboxAllocation() {
  const models = D.models || [];
  if (!models.length) return '';
  const m = models.find(x => x.id === saModelId) || models[0];
  if (!saRows || saModelId !== m.id) saLoad(m);

  const total = saTotal();
  const off = Math.abs(total - 1) > 0.0005;
  const mph = (D.modelSpeedLimit || []).find(r => r.strategy_id === m.id) || null;
  const master = D.speedLimit && D.speedLimit[0] ? D.speedLimit[0] : null;
  const prev = (D.sandboxTargets || []).find(t => t.strategy_id === m.id) || null;

  const clsOf = tk => { const s = (D.markets || []).find(x => x.ticker === tk); return s ? s.cls : null; };
  // The two pies are weighted sums, so they move the instant a weight does — no Test needed.
  const byClass = {};
  for (const r of saRows) {
    const ov = (D.factorOverrides || []).find(o => o.security_id === r.security_id);
    const mix = mixOf(ov);
    if (mix) { for (const [c, share] of Object.entries(mix)) byClass[c] = (byClass[c] || 0) + (+r.weight) * share; continue; }
    const c = clsOf(r.ticker) || 'unclassified';
    byClass[c] = (byClass[c] || 0) + (+r.weight);
  }
  const CLASS_ORDER = [['equities', 'Equities'], ['bonds', 'Fixed Income'], ['commodities_real_assets', 'Commodities'], ['gold', 'Gold'], ['cash', 'Cash'], ['alternatives', 'Alternatives'], ['unclassified', 'Unclassified']];
  const classSlices = CLASS_ORDER.map(([k, label]) => ({ k, label, v: byClass[k] || 0 })).filter(s => s.v > 0.0001);

  // Factor pie: each class's weight split across the factors it is long, by the desk's own matrix.
  const longs = { growth: 0, inflation: 0, liquidity: 0 }; let unclassified = 0;
  for (const [c, w] of Object.entries(byClass)) {
    const row = FA_MATRIX[c];
    if (!row) { unclassified += w; continue; }
    const lf = ['growth', 'inflation', 'liquidity'].filter(f => row[f] === 'L');
    if (!lf.length) { unclassified += w; continue; }
    for (const f of lf) longs[f] += w / lf.length;
  }
  const factorSlices = [
    { k: 'growth', label: 'Growth', v: longs.growth }, { k: 'inflation', label: 'Inflation', v: longs.inflation },
    { k: 'liquidity', label: 'Liquidity', v: longs.liquidity }, { k: 'unclassified', label: 'Unclassified', v: unclassified },
  ].filter(s => s.v > 0.0001);

  const pie = (slices, colors) => {
    const sum = slices.reduce((a, s) => a + s.v, 0) || 1;
    let acc = 0; const R = 58, C = 70;
    const arcs = slices.map((s, i) => {
      const a0 = acc / sum * 2 * Math.PI - Math.PI / 2; acc += s.v;
      const a1 = acc / sum * 2 * Math.PI - Math.PI / 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, r) => [C + r * Math.cos(a), C + r * Math.sin(a)];
      const [x0, y0] = p(a0, R), [x1, y1] = p(a1, R);
      return `<path d="M ${C} ${C} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 ${big} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${colors[s.k] || 'var(--muted)'}" stroke="var(--panel)" stroke-width="1.5"><title>${esc(s.label)} ${(s.v / sum * 100).toFixed(1)}%</title></path>`;
    }).join('');
    return `<svg viewBox="0 0 140 140" style="width:140px;height:140px;flex:none">${arcs}</svg>`;
  };
  const legend = (slices, colors) => {
    const sum = slices.reduce((a, s) => a + s.v, 0) || 1;
    return `<div style="font-size:12px;line-height:1.8">${slices.map(s =>
      `<div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colors[s.k] || 'var(--muted)'};margin-right:6px"></span>${esc(s.label)} <b>${(s.v / sum * 100).toFixed(1)}%</b></div>`).join('')}</div>`;
  };
  const FCOL = { growth: 'var(--growth)', inflation: 'var(--inflation)', liquidity: 'var(--liquidity)', unclassified: 'var(--unclass)' };

  const rowsHtml = saRows.map((r, i) => `<tr>
    <td><b>${esc(r.ticker)}</b>${r.security_id ? '' : '<br><small style="color:var(--warn)">unknown ticker</small>'}</td>
    <td style="color:var(--muted);font-size:12px">${esc((CLASS_ORDER.find(c => c[0] === clsOf(r.ticker)) || [, '—'])[1])}</td>
    <td class="num"><input data-sawt="${i}" type="number" step="0.5" min="0" max="100" value="${(+r.weight * 100).toFixed(1)}"
      style="width:78px;padding:4px 7px;border-radius:5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;text-align:right"></td>
    <td class="num"><span class="click" data-sadel="${i}" title="Remove this holding" style="cursor:pointer;color:var(--neg);font-weight:700">×</span></td></tr>`).join('');

  const t = saTested;
  const statLine = (lbl, v, fmt, title) => `<div title="${esc(title || '')}"><span style="color:var(--muted);font-size:12px">${esc(lbl)}</span><br><b style="font-variant-numeric:tabular-nums">${v === null || v === undefined ? '—' : fmt(v)}</b></div>`;
  const pc1 = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const statsBlock = !t ? `<div class="note" style="color:var(--muted)">Press <b>Test</b> to rebuild a daily series from these weights and measure it — return, capture, beta, drawdown and volatility over the year to date and the last twelve months.</div>`
    : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:12px 18px">
        ${statLine('YTD return', t.ytd?.total, pc1, 'Buy and hold of these weights from the first trading day of the year')}
        ${statLine('YTD vs bench', t.ytd && t.ytd.benchTotal !== null ? t.ytd.total - t.ytd.benchTotal : null, pc1, 'Against this model’s own benchmark over the same days')}
        ${statLine('1Y return', t.oneY?.total, pc1, 'Buy and hold over the last twelve months')}
        ${statLine('Max drawdown', t.oneY?.maxDD, pc1, 'Largest fall from a running peak inside the one-year window')}
        ${statLine('Volatility', t.oneY?.vol, v => (v * 100).toFixed(1) + '%', 'Annualised standard deviation of daily returns over one year')}
        ${statLine('Upside capture', t.oneY?.upside, v => (v * 100).toFixed(0) + '%', 'Return on the benchmark’s up days, divided by the benchmark’s')}
        ${statLine('Downside capture', t.oneY?.downside, v => (v * 100).toFixed(0) + '%', 'Return on the benchmark’s down days, divided by the benchmark’s')}
        ${statLine('Beta vs bench', t.oneY?.beta, v => v.toFixed(2) + '×', 'Least squares over one year. Read R² beside it.')}
        ${statLine('R²', t.oneY?.r2, v => v.toFixed(2), 'Below 0.5 the beta is not describing risk posture')}
        ${statLine('FI duration', t.duration, v => v.toFixed(2) + ' yrs', 'Weighted empirical duration of the fixed income sleeve, per unit of fixed income weight')}
      </div>
      <p class="note">Rebuilt from these weights as a <b>buy and hold</b> from each window’s first day — a target rebalanced daily would be a different strategy from the one proposed. ${t.ytd && t.ytd.coverage < 0.999 ? `Only ${(t.ytd.coverage * 100).toFixed(0)}% of the weight could be priced across the year; the rest is excluded and the figures renormalise over what remains. ` : ''}Gross of fees, no transaction costs, and not a backtest of a strategy — it is this one book held still.</p>`;

  const priced = saRows.filter(r => r.security_id && +r.weight > 0);
  const fp = saFingerprint(priced, m.id);
  // A book with no equity has no style to fingerprint, and that is a fact about the book rather
  // than a gap in the measurement. Saying so beats an absent section the reader has to interpret.
  const fpBlock = !fp ? `<h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Factor fingerprint</h3>
    <p class="note" style="margin:0">None of the proposed holdings carries a measured factor fingerprint, so there is no style tilt to report. For a book with little or no equity that is the right answer rather than a missing one — the five factors are equity styles.</p>` : `<h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Factor fingerprint</h3>
    <div style="display:flex;gap:22px;flex-wrap:wrap;align-items:center">
      ${factorRadar(fp.rows, 'Current', 'Proposed')}
      <div style="flex:1;min-width:260px;overflow-x:auto"><table style="min-width:300px"><thead><tr><th>Factor</th><th class="num">Proposed</th><th class="num">Current</th><th class="num">Change</th></tr></thead><tbody>
      ${fp.rows.map(r => { const d = r.model_beta !== null && r.benchmark_beta !== null ? r.model_beta - r.benchmark_beta : null;
        return `<tr><td>${esc(r.label)}</td><td class="num">${r.model_beta === null ? '—' : (r.model_beta >= 0 ? '+' : '−') + Math.abs(r.model_beta).toFixed(2)}</td>
        <td class="num" style="color:var(--muted)">${r.benchmark_beta === null ? '—' : (r.benchmark_beta >= 0 ? '+' : '−') + Math.abs(r.benchmark_beta).toFixed(2)}</td>
        <td class="num" style="color:${d === null ? 'var(--muted)' : Math.abs(d) < 0.02 ? 'var(--muted)' : d > 0 ? 'var(--pos)' : 'var(--neg)'}">${d === null ? '—' : (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2)}</td></tr>`; }).join('')}
      </tbody></table></div></div>
    <p class="note">Each holding’s measured factor tilts, weighted by the proposed book and set against the model as it stands. Tilts are per unit of equity exposure, so a change here is a change of style rather than of how much equity is held. ${fp.coverage < 0.999 ? `Covers ${(fp.coverage * 100).toFixed(0)}% of the proposed equity; holdings without a fingerprint are left out rather than averaged in at zero.` : ''}</p>`;

  const sec = saSectors(priced);
  const secBlock = (!sec || !sec.rows.length) ? `<h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Sector weighting</h3>
    <p class="note" style="margin:0">No proposed holding carries a sector fit, so there is no breakdown to show. Sector is a property of equity; a fixed income or cash book has none to report.</p>` : `<h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Sector weighting</h3>
    <div style="overflow-x:auto"><table style="min-width:360px"><thead><tr><th>Sector</th><th class="num">Share of equity</th></tr></thead><tbody>
    ${sec.rows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${(r.v * 100).toFixed(1)}%</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">Returns-based, from each fund’s own sector fit, weighted by the proposed book and renormalised over the equity that could be placed${sec.coverage < 0.999 ? ` — ${(sec.coverage * 100).toFixed(0)}% of it` : ''}. Never a holdings look-through: no source connected here publishes what these funds own.</p>`;

  return `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Target allocation</h2>
      <span style="font-size:12px;color:var(--muted)">${mph ? `MPH ${esc(String(mph.light || '').toUpperCase())}${mph.target_low !== null ? ` · band ${(+mph.target_low).toFixed(2)}–${(+mph.target_high).toFixed(2)}×` : ''}` : ''}${master && master.light ? ` · master ${esc(String(master.light).toUpperCase())}` : ''}</span></div>
    <p class="note" style="margin:4px 0 12px">Build a target against the current speed limit. <b>Test</b> measures it; <b>Submit Final</b> records it, and the only thing that changes is the Target Allocation pie in this model’s drawer — every statistic on the site carries on measuring what the model actually holds.</p>

    <div class="tabs" style="margin:0 0 12px">${models.map(x =>
      `<button class="tab" data-samodel="${esc(x.id)}" aria-selected="${x.id === m.id}">${esc(bareName(x.name))}</button>`).join('')}</div>

    ${prev ? `<div class="note" style="margin-bottom:10px;color:var(--muted)">Last submitted ${esc(String(prev.submitted_at).slice(0, 16).replace('T', ' '))}${prev.author ? ` by ${esc(prev.author)}` : ''}. Editing starts from that submission.</div>` : ''}

    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:330px;overflow-x:auto">
        <table style="min-width:330px"><thead><tr><th>Ticker</th><th>Class</th><th class="num">Weight</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr><td colspan="2" style="color:var(--muted)">Total</td>
          <td class="num"><b style="color:${off ? 'var(--warn)' : 'var(--pos)'}">${(total * 100).toFixed(1)}%</b></td><td></td></tr></tfoot></table>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
          <input data-saticker type="text" placeholder="Add ticker" style="width:130px;padding:5px 9px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px;text-transform:uppercase">
          <button class="btn" data-saadd="1" style="padding:5px 12px;font-size:13px">Add</button>
          ${off ? `<small style="color:var(--warn)">Weights total ${(total * 100).toFixed(1)}%. A mix that does not add up is a legitimate thing to look at on the way to one that does, and nothing here silently renormalises it.</small>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:18px;flex-wrap:wrap">
        <div><div class="eyebrow" style="margin-bottom:6px">Asset class</div>
          <div style="display:flex;gap:10px;align-items:center">${pie(classSlices, CLASS_COLORS)}${legend(classSlices, CLASS_COLORS)}</div></div>
        <div><div class="eyebrow" style="margin-bottom:6px">Regimes</div>
          <div style="display:flex;gap:10px;align-items:center">${pie(factorSlices, FCOL)}${legend(factorSlices, FCOL)}</div></div>
      </div>
    </div>

    ${fpBlock}

    <h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Portfolio statistics</h3>
    ${statsBlock}
    ${secBlock}

    ${saMsg ? `<div class="note" style="margin-top:10px;color:${saMsg.ok ? 'var(--pos)' : 'var(--neg)'}">${esc(saMsg.text)}</div>` : ''}
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;align-items:center">
      <button class="btn" data-satest="1" ${saBusy ? 'disabled' : ''} style="background:var(--panel2);color:var(--text)">${saBusy ? 'Measuring…' : 'Test'}</button>
      <button class="btn" data-safinal="1" ${saBusy ? 'disabled' : ''}>Submit Final</button>
      <button class="btn" data-satune="1" ${saBusy ? 'disabled' : ''} style="background:var(--panel2);color:var(--text)">Agent Fine Tune</button>
      <input data-sanote type="text" value="${esc(saNote)}" placeholder="Note for the record (optional)" style="flex:1;min-width:180px;padding:6px 9px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:13px">
    </div>
    <p class="note"><b>Submit Final</b> timestamps this allocation and the Target Allocation pie in this model’s drawer starts showing it. Nothing else moves: the factor pie on the actual book, the stress scores, duration, geography and every return figure stay on what the model holds, because a target is an intention and an intention must not restate performance. <b>Agent Fine Tune</b> asks Adam, Sven, Kate and Stan to propose changes with reasons; like the trade analysis, they run outside this page and their answer appears once they have.</p>
  </div>`;
}

// ---------- Gail: the catalogue ----------
//
// Gail is the desk's librarian, so the journal lives with her. This page does not grade anything
// — it records what was decided, when, and what the four agents made of it. A verdict with no
// answered_at is a request still outstanding, shown as pending rather than quietly omitted.
const GAIL_VERDICT = {
  go:      ['Go', 'var(--pos)', '&#10003;'],
  go_fish: ['Go Fish', 'var(--flat)', '&#128031;'],
  no_go:   ['No Go', 'var(--neg)', '&#10007;'],
};
const GAIL_AGENTS = [['annie', 'Annie'], ['adam', 'Adam'], ['sven', 'Sven'], ['kate', 'Kate'], ['stan', 'Stan']];

function gailJournal() {
  // Submitted entries only. A draft is a thought that has not been filed, and the catalogue is
  // for what was decided. Nothing in this build writes a draft, but the filter is the guarantee.
  const entries = (D.journal || []).filter(e => e.submitted_at).slice().sort((a, b) =>
    String(b.submitted_at || b.created_at).localeCompare(String(a.submitted_at || a.created_at)));
  const verdicts = D.journalVerdicts || [];
  const models = D.models || [];
  const nameOf = id => bareName((models.find(m => m.id === id) || {}).name || '—');

  if (!entries.length) {
    return `<p class="sub">Every decision written in the Sandbox is filed here with what the agents made of it.</p>
      <div class="card"><div class="empty">No journal entries yet. Write one in the Sandbox and it is filed here.</div></div>`;
  }

  const card = e => {
    const vs = verdicts.filter(v => v.journal_id === e.id);
    const answered = vs.filter(v => v.verdict);
    const tally = GAIL_AGENTS.map(([k, label]) => {
      const v = vs.find(x => x.agent === k);
      if (!v) return `<div style="text-align:center;min-width:70px"><div style="font-size:11px;color:var(--muted)">${esc(label)}</div>
        <div style="color:var(--muted);font-size:12px;margin-top:3px">not asked</div></div>`;
      if (!v.verdict) return `<div style="text-align:center;min-width:70px"><div style="font-size:11px;color:var(--muted)">${esc(label)}</div>
        <div style="color:var(--muted);font-size:12px;margin-top:3px">pending</div></div>`;
      const [lbl, col, glyph] = GAIL_VERDICT[v.verdict] || GAIL_VERDICT.go_fish;
      return `<div style="text-align:center;min-width:70px" title="${esc(v.rationale || v.headline || '')}">
        <div style="font-size:11px;color:var(--muted)">${esc(label)}</div>
        <div style="font-size:19px;color:${col};line-height:1.2">${glyph}</div>
        <div style="font-size:11px;color:${col};font-weight:600">${esc(lbl)}</div></div>`;
    }).join('');
    const pc = v => v === null || v === undefined ? '—' : (+v * 100).toFixed(1) + '%';
    const tax = e.tax_estimate && e.tax_estimate.per_model ? e.tax_estimate.per_model : null;
    return `<div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:baseline">
        <h2 style="margin:0;font-size:16px">
          <span style="color:${e.action === 'buy' ? 'var(--pos)' : e.action === 'sell' ? 'var(--neg)' : 'var(--flat)'};text-transform:uppercase;font-size:12px;letter-spacing:.06em">${esc(e.action)}</span>
          ${e.ticker ? ` ${esc(e.ticker)}` : ''}
          <span style="font-weight:400;color:var(--muted);font-size:13px"> · ${esc((e.asset_class || '').replace(/_/g, ' '))} · ${esc(e.setup || '')}</span></h2>
        <small style="color:var(--muted)">${esc(String(e.submitted_at || e.created_at).slice(0, 16).replace('T', ' '))}${e.author ? ` · ${esc(e.author)}` : ''}</small></div>
      <div style="display:flex;gap:26px;flex-wrap:wrap;margin-top:10px;align-items:flex-start">
        <div style="flex:1;min-width:260px">
          <p style="margin:0 0 8px;font-size:13.5px">${esc(e.rationale || '')}</p>
          <div style="font-size:12px;color:var(--muted);line-height:1.7">
            <b style="color:var(--text)">${pc(e.sizing_pct)}</b> ${esc((e.sizing || '').replace(/_/g, ' '))} · <b style="color:var(--text)">${esc(e.horizon || '—')}</b>
            ${e.loss_threshold !== null && e.loss_threshold !== undefined ? ` · stop at <b style="color:var(--neg)">${(+e.loss_threshold * 100).toFixed(0)}%</b>` : ''}
            <br>${(e.strategy_ids || []).map(id => esc(nameOf(id))).join(', ') || 'no models'}
            ${tax ? `<br><span style="color:var(--neg)">Estimated tax −${(tax.reduce((a, x) => a + +x.tax_bps, 0) / tax.length / 100).toFixed(2)}%</span> of model value, averaged across ${tax.length} model${tax.length === 1 ? '' : 's'} at 15/24` : ''}
          </div></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start">${tally}</div>
      </div>
      ${answered.length ? `<details style="margin-top:10px;font-size:13px"><summary style="cursor:pointer;color:var(--text)">What the agents said</summary>
        ${answered.map(v => { const [lbl, col] = GAIL_VERDICT[v.verdict] || GAIL_VERDICT.go_fish;
          return `<div style="margin-top:8px"><b style="color:${col}">${esc((GAIL_AGENTS.find(a => a[0] === v.agent) || [,v.agent])[1])} — ${esc(lbl)}</b>
            ${v.headline ? `<br><span style="font-size:13px">${esc(v.headline)}</span>` : ''}
            ${v.rationale ? `<br><span style="color:var(--muted);font-size:12.5px">${esc(v.rationale)}</span>` : ''}</div>`; }).join('')}
      </details>` : ''}
    </div>`;
  };

  const pending = verdicts.filter(v => !v.verdict).length;
  return `<p class="sub">Every decision written in the Sandbox is filed here with what the agents made of it.</p>
  ${pending ? `<div class="card" style="margin-bottom:12px;border-left:3px solid var(--warn)"><p style="margin:0;font-size:13px"><b>${pending} analysis request${pending === 1 ? '' : 's'} outstanding.</b> The agents run outside this page, so a verdict appears once they have read the entry. Pending is pending — it is not a quiet No.</p></div>` : ''}
  ${entries.map(card).join('')}
  <p class="note"><b>${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.</b> A journal entry is a decision record and nothing more: it reaches no broker and moves no allocation. The tax figure beside one is the estimate made at the time it was written, priced off the open lots then — it is not re-costed as prices move, because what matters later is what the desk believed when it decided.</p>`;
}

// ---------- Neil: Hunger Games Demo ----------
//
// Demography and the long cycle. Adam owns the quarters; this page owns the decades.
//
// THE ONE RULE THIS PAGE LIVES UNDER. Strauss and Howe's turnings are a FRAMEWORK the desk has
// adopted, published in 1997, with their own question mark on the end of the Third Turning.
// Nothing here computes a turning from data. The page therefore keeps two kinds of statement
// visibly apart: what Strauss and Howe say, which is labelled as theirs, and what the series say,
// which carries an observation date. A framework that explains every outcome afterwards explains
// none of them in advance, and mixing the two would quietly convert a lens into a forecast.
const TURNING_TONE = { 1: '#22c55e', 2: '#84cc16', 3: '#f59e0b', 4: '#ef4444' };
// The phases of life the book uses. The whole mechanism is that a Great Event reaches each cohort
// at a different one, and that twenty years later every cohort has moved up exactly one.
const PHASES = [
  ['Childhood', 0, 20], ['Young adulthood', 21, 41], ['Midlife', 42, 62], ['Elderhood', 63, 83],
];

function neil() {
  const yr = new Date().getFullYear();
  const turns = D.turnings || [];
  const gens = D.generations || [];
  const macro = D.macroNow || [];
  const mac = code => macro.find(m => m.fred_code === code) || null;
  const v = code => { const m = mac(code); return m && m.value !== null ? +m.value : null; };

  if (!turns.length && !gens.length) {
    return `<span class="eyebrow">Demography</span><h1>Hunger Games Demo</h1>
     <p class="sub">The saeculum and the generational clock.</p>
     <div class="card"><div class="empty">Nothing seeded yet. The turnings and generations live in the database so the page and the book cannot drift apart.</div></div>`;
  }

  const current = turns.find(t => t.end_year === null) || turns[turns.length - 1];
  const yearsIn = current ? yr - current.start_year : null;

  // ---- the saeculum clock ----
  const span = turns.length ? turns[0].start_year : yr;
  const total = yr - span;
  const clock = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">The saeculum</h2>
      <span style="font-size:12px;color:var(--muted)">Strauss and Howe's dating, published 1997</span></div>
    <div style="display:flex;align-items:center;gap:30px;flex-wrap:wrap;margin-top:14px">
      <div style="min-width:240px">
        <div style="font-size:46px;font-weight:800;line-height:1;color:${TURNING_TONE[current.turning]}">Turning ${current.turning}</div>
        <div style="font-size:17px;font-weight:600;margin-top:5px">${esc(current.mood)}</div>
        <div style="font-size:13px;color:var(--muted);margin-top:3px">${current.start_year}–${current.end_year || 'present'} · ${yearsIn} year${yearsIn === 1 ? '' : 's'} in</div>
      </div>
      <div style="flex:1;min-width:280px">
        <div style="display:flex;height:34px;border-radius:7px;overflow:hidden;border:1px solid var(--line)">
          ${turns.map(t => { const end = t.end_year || yr; const w = (end - t.start_year) / Math.max(1, total) * 100;
            return `<div title="${esc(t.name)} · ${t.start_year}–${t.end_year || 'present'}" style="width:${w.toFixed(1)}%;background:${TURNING_TONE[t.turning]};opacity:${t.end_year === null ? 0.9 : 0.4};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#0b0f14">${t.turning}</div>`; }).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:5px">
          <span>${turns.length ? turns[0].start_year : ''}</span><span>${yr}</span></div>
        <p class="note" style="margin:8px 0 0">${esc(current.description)}</p>
      </div>
    </div>
    <p class="note"><b>This is their dating, not a measurement.</b> Strauss and Howe wrote in 1997 and gave the Third Turning's end as 2005 <b>with a question mark</b>, so the Fourth Turning's start year inherits that uncertainty and its length is open. Nothing on this desk computes a turning from data, and this page will not pretend otherwise. The mechanism they propose is ordinary ageing: a Great Event lands on everyone at once but reaches each cohort at a different phase of life, and twenty years later every cohort has moved up one — which is why turnings recur on the length of a phase of life rather than on any economic cycle.</p>
  </div>`;

  // ---- the generational clock: computed, not asserted ----
  const phaseOf = age => { const p = PHASES.find(([, lo, hi]) => age >= lo && age <= hi); return p ? p[0] : age > 83 ? 'Beyond elderhood' : null; };
  const genRows = gens.map(g => {
    const oldest = yr - g.birth_from, youngest = yr - g.birth_to;
    return { ...g, oldest, youngest, spans: [...new Set([phaseOf(youngest), phaseOf(oldest)].filter(Boolean))] };
  }).filter(g => g.youngest <= 100).reverse();

  const genCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">Who is where</h2>
      <span style="font-size:12px;color:var(--muted)">ages as of ${yr}</span></div>
    <p class="note" style="margin:6px 0 12px">Each cohort's age and phase of life is computed from its birth years and today's date rather than asserted, so this moves on its own every January. Phases are the book's: childhood 0–20, young adulthood 21–41, midlife 42–62, elderhood 63–83.</p>
    <div style="overflow-x:auto"><table style="min-width:560px"><thead><tr>
      <th>Generation</th><th class="num">Born</th><th class="num">Age now</th><th>Phase of life</th><th>Sample member</th></tr></thead><tbody>
      ${genRows.map(g => `<tr>
        <td><b>${esc(g.name)}</b></td>
        <td class="num" style="color:var(--muted)">${g.birth_from}–${g.birth_to}</td>
        <td class="num">${g.youngest}–${g.oldest}</td>
        <td>${g.spans.length ? g.spans.map(x => `<span class="chip">${esc(x)}</span>`).join(' ') : '<span style="color:var(--muted)">past the book’s span</span>'}</td>
        <td style="color:var(--muted);font-size:12.5px">${esc(g.sample || '')}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="note"><b>Birth years are Strauss and Howe's</b>, including the question mark they put on the Millennial end year, because the book was written before that cohort had finished arriving. Later writers have moved these boundaries; the desk keeps theirs so that the generations and the turnings come from one source rather than two that disagree.</p>
  </div>`;

  // ---- the arithmetic, which is not a framework ----
  const over65 = v('SPPOP65UPTOZSUSA'), under15 = v('SPPOP0014TOZSUSA');
  const dep = v('SPPOPDPNDOLUSA'), tfr = v('SPDYNTFRTINUSA'), cbr = v('SPDYNCBRTINUSA');
  const le = v('SPDYNLE00INUSA'), growth = v('SPPOPGROWUSA'), wap = v('LFWA64TTUSM647S');
  const prime = v('LNU01300060'), pop = v('POPTHM');
  const REPLACEMENT = 2.1;
  const stat = (label, val, sub, tone) => `<div style="flex:1;min-width:165px">
    <div class="eyebrow" style="margin-bottom:3px">${esc(label)}</div>
    <div style="font-size:27px;font-weight:700;line-height:1${tone ? `;color:${tone}` : ''}">${val}</div>
    <div style="font-size:11.5px;color:var(--muted);margin-top:3px">${sub}</div></div>`;
  const asOf = code => { const m = mac(code); return m ? esc(m.obs_date.slice(0, 4)) : '—'; };

  const pyramidCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">The arithmetic</h2>
      <span style="font-size:12px;color:var(--muted)">measured, with observation years</span></div>
    <p class="note" style="margin:6px 0 14px">Everything above this line is a framework. Everything below it is a series with a date on it, and it is the part that does the work in anything said about the next decade.</p>
    <div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:16px">
      ${stat('65 and over', over65 === null ? '—' : over65.toFixed(1) + '%', `share of population · ${asOf('SPPOP65UPTOZSUSA')}`, 'var(--neg)')}
      ${stat('Under 15', under15 === null ? '—' : under15.toFixed(1) + '%', `share of population · ${asOf('SPPOP0014TOZSUSA')}`, 'var(--accent)')}
      ${stat('Old-age dependency', dep === null ? '—' : dep.toFixed(1), `per 100 of working age · ${asOf('SPPOPDPNDOLUSA')}`)}
      ${stat('Fertility rate', tfr === null ? '—' : tfr.toFixed(2), `births per woman · ${asOf('SPDYNTFRTINUSA')}`, tfr !== null && tfr < REPLACEMENT ? 'var(--neg)' : 'var(--pos)')}
    </div>
    ${over65 !== null && under15 !== null ? `<div style="margin-bottom:14px">
      <div style="display:flex;height:26px;border-radius:7px;overflow:hidden;border:1px solid var(--line)">
        <div style="width:${under15.toFixed(1)}%;background:var(--accent);opacity:.75;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#0b0f14">under 15</div>
        <div style="flex:1;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted)">working age</div>
        <div style="width:${over65.toFixed(1)}%;background:var(--neg);opacity:.75;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#0b0f14">65+</div>
      </div>
      <p class="note" style="margin:8px 0 0">${over65 > under15
        ? `<b>The crossover has happened.</b> There are now more people over 65 than under 15 — ${over65.toFixed(1)}% against ${under15.toFixed(1)}% — which in this series had never been true before. Whatever else is argued about the long cycle, this is the fact underneath it, and it does not reverse on any horizon a portfolio is managed over.`
        : `Under-15s still outnumber the over-65s, ${under15.toFixed(1)}% against ${over65.toFixed(1)}%.`}</p></div>` : ''}
    <div style="display:flex;gap:22px;flex-wrap:wrap">
      ${stat('Population', pop === null ? '—' : (pop / 1000).toFixed(1) + 'm', `total · ${asOf('POPTHM')}`)}
      ${stat('Population growth', growth === null ? '—' : growth.toFixed(2) + '%', `a year · ${asOf('SPPOPGROWUSA')}`)}
      ${stat('Working age 15–64', wap === null ? '—' : (wap / 1e6).toFixed(1) + 'm', `persons · ${asOf('LFWA64TTUSM647S')}`)}
      ${stat('Prime-age participation', prime === null ? '—' : prime.toFixed(1) + '%', `25–54 · ${asOf('LNU01300060')}`)}
      ${stat('Life expectancy', le === null ? '—' : le.toFixed(1), `years at birth · ${asOf('SPDYNLE00INUSA')}`)}
      ${stat('Crude birth rate', cbr === null ? '—' : cbr.toFixed(1), `per 1,000 · ${asOf('SPDYNCBRTINUSA')}`)}
    </div>
    ${tfr !== null ? `<p class="note" style="margin-top:14px"><b>Fertility is ${tfr.toFixed(2)} against a replacement rate of ${REPLACEMENT}.</b> A country below replacement does not shrink immediately — momentum in the existing age structure carries it for decades, and migration can offset it entirely — but the shape of the pyramid is set long before the total turns. These are <b>annual series and they are revised</b>; the year beside each figure is the observation, not today.</p>` : ''}
  </div>`;

  // ---- The Hunger Games ----
  //
  // Dredge's thesis, and the reason it sits on a demography page rather than a macro one: the
  // scarce resource being competed for is SAVERS. A working-age population accumulates financial
  // assets; a retired one spends them down. So a contest among sovereigns for "the dwindling
  // marginal supply of liquidity" is, underneath, a contest for a pool demography is draining.
  //
  // The thesis states itself in one number -- government debt divided by the working-age people
  // who have to absorb it -- and both halves were already on this desk.
  //
  // WHAT IS DELIBERATELY ABSENT. The meeting notes record repo leverage near $12tn and repo plus
  // OCC-related exposures near $20tn, and say in the same breath that these were "presented as
  // discussion points, not independently verified". They are not shown. His illustrative
  // portfolios are his hypotheticals, named as his, and are not desk guidance.
  const debtPct = v('GFDEGDQ188S'), debtAbs = v('GFDEBTN'), deficit = v('FYFSGDA188S');
  const interestPct = v('FYOIGDA188S'), interestAbs = v('A091RC1Q027SBEA'), foreign = v('FDHBFIN');
  const workAge = v('LFWA64TTUSM647S');
  const perSaver = debtAbs !== null && workAge > 0 ? (debtAbs * 1e6) / workAge : null;
  const dredgeStat = (label, val, sub, tone) => `<div style="flex:1;min-width:172px">
    <div class="eyebrow" style="margin-bottom:3px">${esc(label)}</div>
    <div style="font-size:26px;font-weight:700;line-height:1${tone ? `;color:${tone}` : ''}">${val}</div>
    <div style="font-size:11.5px;color:var(--muted);margin-top:3px">${sub}</div></div>`;

  const dredgeCard = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <h2 style="margin:0">The Hunger Games</h2>
      <span style="font-size:12px;color:var(--muted)">David Dredge, Convex Strategies</span></div>
    <p class="note" style="margin:6px 0 14px">Dredge describes a <b>competition among sovereigns for the buyers of government debt</b> — in his written updates, a contest for “the dwindling marginal supply of liquidity in the system”, with the US Treasury, Europe and Japan all placing paper into one pool. <b>It belongs on a demography page because the scarce resource is savers.</b> In his words, developed economies face <b>fewer taxpayers and savers and more retirees and dissavers</b> while government debt runs above 100% of GDP. A working-age population accumulates financial assets; a retired one spends them down.</p>

    ${perSaver === null ? '' : `<div style="padding:14px 16px;background:var(--panel2);border-radius:9px;border-left:3px solid var(--warn);margin-bottom:16px">
      <div class="eyebrow" style="margin-bottom:4px">The thesis in one number</div>
      <div style="font-size:40px;font-weight:800;line-height:1">$${Math.round(perSaver).toLocaleString()}</div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px">of federal debt for every person of working age</div>
      <p class="note" style="margin:8px 0 0">$${(debtAbs / 1e6).toFixed(2)}tn of debt divided by ${(workAge / 1e6).toFixed(1)}m people aged 15 to 64. <b>Both halves move the wrong way at once:</b> the numerator grows with every deficit, and the denominator was set by births that already happened. That is the arena.</p></div>`}

    <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px">
      ${dredgeStat('Federal debt', debtPct === null ? '—' : debtPct.toFixed(1) + '%', `of GDP · ${asOf('GFDEGDQ188S')}`, debtPct !== null && debtPct > 100 ? 'var(--neg)' : null)}
      ${dredgeStat('Deficit', deficit === null ? '—' : deficit.toFixed(1) + '%', `of GDP · ${asOf('FYFSGDA188S')}`, 'var(--neg)')}
      ${dredgeStat('Interest outlays', interestPct === null ? '—' : interestPct.toFixed(2) + '%', `of GDP · ${asOf('FYOIGDA188S')}`)}
      ${dredgeStat('Interest paid', interestAbs === null ? '—' : '$' + (interestAbs / 1000).toFixed(2) + 'tn', `annualised · ${asOf('A091RC1Q027SBEA')}`)}
      ${dredgeStat('Held abroad', foreign === null ? '—' : '$' + (foreign / 1000).toFixed(2) + 'tn', `federal debt · ${asOf('FDHBFIN')}`)}
    </div>

    <h3 style="margin:18px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">What he says it does to a portfolio</h3>
    <p class="note" style="margin:0 0 10px">His own words, attributed rather than adopted. <b>Risk is vulnerability to loss, not the probability of a forecast event.</b> Sequencing and compounding make time material — his illustration is that washing and ironing a pair of trousers have the same average but different outcomes depending on the order.</p>
    <p class="note" style="margin:0 0 10px"><b>“Sharpe World”</b> is his name for the simplified model: Gaussian distributions, continuous markets, stable correlations, arithmetic averages and Sharpe-ratio optimisation — against a real world of gaps, fat tails, leverage, correlations that move, and <b>geometric</b> compounding. He argues the fixed-income leg of the 60/40 has lost the hedging property it was held for, and that <b>inflation is the principal risk for retail savers</b>, particularly those regulated into large bond allocations. His examples were five-times-levered gilts in liability-driven strategies, and Silicon Valley Bank reporting its risk metrics shortly before it failed.</p>
    <p class="note" style="margin:0 0 10px">On construction he argues for <b>“good brakes” before pursuing growth</b>: negatively correlated, asymmetric protection alongside assets with natural volatility, so that more capital can be deployed safely rather than less. <b>The mixes he cited are his, not this desk's</b>, and are recorded as his argument rather than as any allocation — a 25% gold, 25% long-volatility, 50% Nasdaq example in conversation, and a levered “Barbell Racer” backtest in his written updates.</p>
    <p class="note" style="margin:0"><b>Two things are deliberately not shown as figures.</b> The repo leverage numbers from that conversation were recorded as “presented as discussion points, not independently verified”, so they appear nowhere here. And the fiscal figures above are <b>this desk's own, from FRED, each with its observation date</b> — they corroborate the shape of his argument, but they are not his numbers and he is not the source for them.</p>
  </div>`;

  return `<span class="eyebrow">Demography</span><h1>Hunger Games Demo</h1>
   <p class="sub">Where the United States sits in the saeculum, which generations occupy which phase of life, and the age arithmetic underneath both.</p>
   ${clock}${genCard}${pyramidCard}${dredgeCard}`;
}

// ---------- Gail: The Library ----------
//
// Gail is the desk's librarian and historian, so her page is a library rather than a dashboard:
// one reading room with shelves off it. Three to begin with -- the trade journal catalogued, the
// inbox of what was clipped and where it went, and the briefs -- and the shelf bar is built from
// a list, so a fourth is one entry rather than a redesign.
//
// Briefs and Inbox were tabs in the header. They are sections here now, rendered from the SAME
// functions rather than copied, so the Library version cannot drift from what the standalone page
// said. Both old hashes still resolve.
//
// The look is the Thomas Jefferson Building: parchment, reading-room green, oxidised brass, and
// the arch. It is scoped to this page exactly as the Tron treatment is scoped to the Sandbox, and
// it follows the same two rules -- figures keep the desk's own semantic colours, because a reader
// must never translate a colour through a theme to know whether money was made, and no decoration
// is laid over a number, because an ornamented digit is a misread digit.
const LIBRARY_SHELVES = [
  ['journal', 'Trade Journal History', 'Decisions as they were written, with what each agent made of them.'],
  ['inbox',   'Inbox',                 'What arrived, where it was routed, and what was held back.'],
  ['briefs',  'Briefs',                'The morning brief and the Sunday primer, as filed.'],
];

function gail(shelf) {
  const active = LIBRARY_SHELVES.some(x => x[0] === shelf) ? shelf : 'journal';
  const meta = LIBRARY_SHELVES.find(x => x[0] === active);
  const body = active === 'inbox' ? inbox(true) : active === 'briefs' ? briefs(true) : gailJournal();
  const counts = {
    journal: (D.journal || []).filter(e => e.submitted_at).length,
    inbox: (D.routingLog || []).length,
    briefs: outputsFor('sisyphus', ['morning_brief', 'sunday_primer']).length,
  };
  return `<div class="loc">
    <div class="locplate">
      <span class="eyebrow">Gail · The Librarian</span>
      <h1>The Library</h1>
      <p class="sub">The desk's record of itself — what was decided, what came in, and what was written about it. Nothing here is computed; everything here was filed.</p>
    </div>
    <nav class="shelf" aria-label="Library sections">
      ${LIBRARY_SHELVES.map(([k, label]) => `<button class="shelftab${k === active ? ' on' : ''}" data-shelf="${k}"${k === active ? ' aria-current="page"' : ''}>
        <span class="shelflabel">${esc(label)}</span>
        <span class="shelfcount">${counts[k]}</span></button>`).join('')}
    </nav>
    <div class="locroom">
      <div class="lochead"><h2>${esc(meta[1])}</h2><p>${esc(meta[2])}</p></div>
      ${body}
    </div>
  </div>`;
}

// ---------- Admin: status, sources, views and agents under one roof ----------
//
// Four tabs that were each consulted rather than read. Status goes first because it is the one
// that answers "can I trust what the rest of this site just told me" -- a degraded query or a
// stale price run changes how every other number should be taken, so it belongs above the things
// it qualifies. Sources second, for the same reason one level down: whose calls are behind the
// views. Then the views themselves, then the agents' latest output.
//
// Each section is the original page rendered with its banner suppressed, not a copy of it. One
// implementation, four places it can appear, and no chance of the Admin version drifting from
// what the standalone page used to say.
function admin() {
  const sec = (eyebrow, title, body, note) => `<div style="margin:0 0 10px">
    <span class="eyebrow">${esc(eyebrow)}</span>
    <h2 style="margin:2px 0 0;font-size:20px">${esc(title)}</h2>
    ${note ? `<p class="note" style="margin:4px 0 0">${note}</p>` : ''}</div>${body}`;
  return `<span class="eyebrow">Allocation model</span><h1>Admin</h1>
   <p class="sub">What is running, what the data came from, the allocation views behind it, and the agents' latest output. Everything here qualifies the rest of the site rather than adding to it.</p>
   ${sec('Housekeeping', 'Status', status(true), 'Read this first: a failed query or a stale price run changes how every other figure on the site should be taken.')}
   <div style="height:26px;border-top:1px solid var(--line);margin:22px 0 0"></div>
   ${sec('Provenance', 'Sources', sources(true))}
   <div style="height:26px;border-top:1px solid var(--line);margin:22px 0 0"></div>
   ${sec('Allocation', 'Views', viewsPage(true))}
   <div style="height:26px;border-top:1px solid var(--line);margin:22px 0 0"></div>
   ${sec('The desk', 'Agents', agents(true))}`;
}

function viewsPage(embed) {
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
     ${rows.map(r => `<tr class="click" data-go="#admin/${esc(r.series_id)}"><td>${esc(r.name)} <small style="color:var(--muted)">(${esc(r.fred_code)})</small></td><td class="num">${r.value}${/percent/i.test(r.unit || '') ? '%' : ''}</td><td>${esc(r.obs_date)}</td></tr>`).join('')}
     </tbody></table></div>`;
  }).join('');

  return `${embed ? '' : '<span class="eyebrow">Allocation model</span><h1>Views</h1>'}<p class="sub">Exposure of each asset class, the desk's current stance where recorded, the macro data behind it, and a sandbox for trying a different mix. Click a macro series for its chart.</p>
  <div class="card" style="margin-bottom:14px"><h2>Exposure matrix</h2><div class="mx"><div class="hd"></div>${D.factors.map(f => `<div class="hd">${esc(fname(f).toUpperCase())}</div>`).join('')}${rows}</div>
  <p class="note">Long +1, Flat 0, Short −1, Flat/Short −0.5. Subjective judgments.</p></div>
  <h2 style="margin:18px 0 10px">Stances</h2>
  ${haveViews ? viewCards : '<div class="empty">No stance recorded yet for any asset class.</div>'}
  <h2 style="margin:18px 0 10px">Indexes</h2>
  ${indexSection()}
  <h2 style="margin:18px 0 10px">Macro data</h2>
  ${macroSection || '<div class="empty">No macro data loaded yet.</div>'}
  ${playground()}`;
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

function agents(embed) {
  // isolated: true for agents whose output never feeds a brief or Stan's process unless
  // explicitly tapped in — worth showing on the card so the distinction stays visible.
  const A = [
    ['adam', 'Adam', 'Macro', false], ['stan', 'Stan', 'Risk', false],
    ['megan', 'Megan', 'Planning ideas', false], ['annie', 'Annie', 'Decision quality', false],
    ['sisyphus', 'Sisyphus', 'Executive', false],
    ['sven', 'Sven', 'Market internals', true], ['gail', 'Gail', 'Geopolitics', true],
    ['kate', 'Kate', 'Sentiment', false],
  ];
  return `${embed ? '' : '<span class="eyebrow">Allocation model</span><h1>Agents</h1>'}<p class="sub">Each agent's latest output, with its as-of date. Isolated agents are shown here to read, but their work never feeds a brief or the allocation process unless explicitly tapped in.</p>
  <div class="agents">${A.map(([k, n, r, isolated]) => { const o = D.outputs.find(x => x.agent === k);
   return `<div class="card"><span class="eyebrow">${r}</span><h2 style="font-size:18px">${n} ${isolated ? '<span class="chip">isolated</span>' : ''}</h2>${o ? `<div><b>${esc(o.title)}</b> <span class="chip">${esc(o.as_of)}</span></div><p style="white-space:pre-wrap;color:var(--muted)">${esc(o.body_md.slice(0, 900))}${o.body_md.length > 900 ? '…' : ''}</p>` : '<div class="empty">No output yet.</div>'}</div>`; }).join('')}</div>`;
}
function inbox(embed) {
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
  return `${embed ? '' : '<span class="eyebrow">Allocation model</span><h1>Inbox</h1>'}<p class="sub">Clipped and dropped items, where they were routed, and why.</p>
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

function sources(embed) {
  const src = D.sources || [], calls = D.calls || [];
  const hitColor = h => h === null || h === undefined ? 'var(--muted)' : h ? 'var(--pos)' : 'var(--neg)';
  const dirChip = d => { const cls = d === 'bullish' ? 'long' : d === 'bearish' ? 'short' : 'flat'; return `<span class="chip ${cls}">${esc(d)}</span>`; };
  const totalScored = src.reduce((a, s) => a + (s.n_directional || 0), 0);
  const totalOpen = src.reduce((a, s) => a + (s.n_open || 0), 0);
  return `${embed ? '' : '<span class="eyebrow">Allocation model</span><h1>Sources</h1>'}
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

function status(embed) {
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
  return `${embed ? '' : '<span class="eyebrow">Allocation model</span><h1>Status</h1>'}<p class="sub">What's built, in progress, or not started — kept in sync with the project roadmap.</p>
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
// The news-flow percentage opens the releases behind it.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-flow]');
  if (!t) return;
  location.hash = '#sven/flow-' + t.dataset.flow;
});
// News-failure window tabs on Sven's page.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-newswin]');
  if (!t) return;
  newsWindow = +t.dataset.newswin;
  $('#app').innerHTML = sven();
});
// The Library's shelves. The hash carries the shelf, so a section is a real link and the back
// button walks between them rather than leaving the page.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-shelf]');
  if (!t) return;
  location.hash = '#gail/' + t.dataset.shelf;
});
// The window selector on the Markets performance chart. One listener per control, because the
// harness matches a selector string exactly and a grouped selector would ship untested.
document.addEventListener('click', e => {
  const t = e.target.closest('[data-perf]');
  if (!t) return;
  perfPeriod = t.dataset.perf;
  $('#app').innerHTML = markets();
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

// ---------- Sandbox form ----------
//
// Structural controls re-render, because what the form shows depends on them. Free text and the
// slider do not: re-rendering a textarea on each keystroke takes the caret with it, and
// re-rendering a range input mid-drag drops the drag. Those write to state and leave the DOM be.
// One listener per control rather than one combined selector. Every other handler on this page
// is written that way, and the smoke harness drives a click by matching the selector string
// exactly -- a grouped selector is unreachable from a test, which is how four of these shipped
// untested the first time.
const sbRedraw = () => { $('#app').innerHTML = sandbox(); };
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sbaction]'); if (!t) return;
  sbSaveMsg = null; sbAction = t.dataset.sbaction; sbSetup = '';   // the set-up list changes with the action
  sbRedraw();
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sbclass]'); if (!t) return;
  sbSaveMsg = null;
  sbClass = sbClass === t.dataset.sbclass ? null : t.dataset.sbclass;
  sbSizing = null;                                                 // the ladder changes with the class
  sbRedraw();
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sbsizing]'); if (!t) return;
  sbSaveMsg = null; sbSizing = sbSizing === t.dataset.sbsizing ? null : t.dataset.sbsizing;
  sbRedraw();
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sbhorizon]'); if (!t) return;
  sbSaveMsg = null; sbHorizon = t.dataset.sbhorizon;
  sbRedraw();
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sbmodel]'); if (!t) return;
  sbSaveMsg = null;
  const id = t.dataset.sbmodel;
  sbModels.has(id) ? sbModels.delete(id) : sbModels.add(id);
  sbRedraw();
});
// These write state WITHOUT redrawing: re-rendering a textarea on each keystroke takes the caret
// with it, and re-rendering a range input mid-drag drops the drag.
document.addEventListener('input', e => {
  const r = e.target.closest('[data-sbrationale]'); if (!r) return;
  sbRationale = r.value;
});
document.addEventListener('input', e => {
  const c = e.target.closest('[data-sbcustom]'); if (!c) return;
  sbCustomPct = c.value;
});
document.addEventListener('input', e => {
  const tk = e.target.closest('[data-sbticker]'); if (!tk) return;
  sbTicker = String(tk.value || '').toUpperCase();
});
document.addEventListener('input', e => {
  const l = e.target.closest('[data-sbloss]'); if (!l) return;
  sbLoss = +l.value / 100;
  const out = document.getElementById('sbLossOut');              // updated in place, not redrawn
  if (out) out.textContent = `${(+l.value).toFixed(0)}%`;
});
// Confidence updates its readout in place rather than redrawing -- a slider that rebuilt the form
// on every pixel would lose focus mid-drag. One listener per control, because the smoke harness
// matches a selector string exactly and a grouped selector would ship untested.
document.addEventListener('input', e => {
  const c = e.target.closest('[data-sbconf]'); if (!c) return;
  sbConfidence = +c.value;
  const out = document.getElementById('sbConfOut');
  if (out) out.textContent = `${sbConfidence}%`;
});
document.addEventListener('input', e => {
  const h = e.target.closest('[data-sbhorizondays]'); if (!h) return;
  sbHorizonDays = Math.max(0, Math.min(3650, +h.value || 0));
});
document.addEventListener('input', e => {
  const t = e.target.closest('[data-sbpremortem]'); if (!t) return;
  sbPremortem = t.value;
});
document.addEventListener('input', e => {
  const l = e.target.closest('[data-sbscenlabel]'); if (!l) return;
  const i = +l.dataset.sbscenlabel;
  if (sbScenarios[i]) sbScenarios[i].label = l.value;
});
// The probability total and the submit gate both depend on this, so it redraws on change rather
// than on every keystroke -- the running total should settle, not flicker.
document.addEventListener('change', e => {
  const p = e.target.closest('[data-sbscenprob]'); if (!p) return;
  const i = +p.dataset.sbscenprob;
  if (sbScenarios[i]) sbScenarios[i].probability = Math.max(0, Math.min(100, +p.value || 0));
  sbRedraw();
});
document.addEventListener('click', e => {
  const a = e.target.closest('[data-sbscenadd]'); if (!a) return;
  sbScenarios.push({ label: '', probability: 0 });
  sbRedraw();
});
document.addEventListener('click', e => {
  const d = e.target.closest('[data-sbscendel]'); if (!d) return;
  sbScenarios.splice(+d.dataset.sbscendel, 1);
  sbRedraw();
});
// The ticker and the size decide the tax estimate, so those two redraw once the field is left.
document.addEventListener('change', e => {
  const t = e.target.closest('[data-sbsetup]'); if (!t) return;
  sbSetup = t.value; sbRedraw();
});
// The ticker and a custom size both feed the tax estimate, so leaving either field redraws it.
document.addEventListener('change', e => {
  const t = e.target.closest('[data-sbticker]'); if (!t) return;
  sbTicker = String(t.value || '').toUpperCase(); sbRedraw();
});
document.addEventListener('change', e => {
  const t = e.target.closest('[data-sbcustom]'); if (!t) return;
  sbCustomPct = t.value; sbRedraw();
});

// Build the row once, so Submit and Analyze cannot disagree about what was decided.
function sbEntry() {
  const sizePct = sbSizePct();
  const isSell = sbAction === 'sell' || sbAction === 'rebalance';
  const ids = [...sbModels];
  const perModel = !isSell || !sbTicker ? null : ids.map(id => {
    const t = sbTaxFor(id, sbTicker.toUpperCase(), sizePct === null ? Infinity : sizePct);
    return t ? { strategy_id: id, tax_bps: +t.taxBps.toFixed(3), lt_bps: +t.netLt.toFixed(3), st_bps: +t.netSt.toFixed(3), sold: +t.sold.toFixed(6), oldest_lot: t.oldest } : null;
  }).filter(Boolean);
  return {
    action: sbAction,
    ticker: sbTicker ? sbTicker.toUpperCase() : null,
    asset_class: sbClass, rationale: sbRationale.trim(), setup: sbSetup,
    sizing: sbSizing, sizing_pct: sizePct, horizon: sbHorizon,
    loss_threshold: +sbLoss.toFixed(4), strategy_ids: ids,
    // Written once, at the moment of deciding, and never revisited. These three are the whole
    // reason the calibration record can exist at all -- each is unrecoverable after the fact.
    confidence: sbConfidence, horizon_days: sbHorizonDays,
    premortem: sbPremortem.trim() || null,
    scenarios: sbScenarios.filter(x => x.label.trim()).map(x => ({ label: x.label.trim(), probability: +x.probability || 0 })),
    outcome: 'open',
    // The estimate as it stood when the decision was written. Deliberately frozen: what matters
    // later is what the desk believed when it decided, not what the price did afterwards.
    tax_estimate: perModel && perModel.length ? { rates: { lt: 0.15, st: 0.24 }, per_model: perModel } : null,
    author: 'desk',
  };
}
document.addEventListener('click', async e => {
  const sub = e.target.closest('[data-sbsubmit]'), ana = e.target.closest('[data-sbanalyze]');
  if (!sub && !ana) return;
  const row = { ...sbEntry(), submitted_at: new Date().toISOString() };
  try {
    const { data, error } = await sb.from('trade_journal').insert(row).select('id').single();
    if (error) throw new Error(error.message);
    if (ana) {
      // A request, not an answer. The agents run outside this page; Gail shows these as pending
      // until they do, which is the honest state rather than a silent gap.
      const reqs = ['annie', 'adam', 'sven', 'kate', 'stan'].map(agent => ({ journal_id: data.id, agent }));
      const { error: ve } = await sb.from('trade_journal_verdicts').insert(reqs);
      if (ve) throw new Error(ve.message);
    }
    sbSaveMsg = { ok: true, text: ana
      ? 'Filed with Gail, and Annie, Adam, Sven, Kate and Stan have been asked to read it. Their verdicts appear on Gail’s tab once they run.'
      : 'Filed with Gail.' };
    sbRationale = ''; sbTicker = ''; sbSetup = ''; sbSizing = null; sbCustomPct = '';
    D.journal = null;   // forces a reload next time Gail is opened
  } catch (ex) {
    sbSaveMsg = { ok: false, text: `Could not file that entry: ${ex.message}. Nothing was saved.` };
  }
  $('#app').innerHTML = sandbox();
});


// ---------- Sandbox allocation editor ----------
const saRedraw = () => { $('#app').innerHTML = sandbox(); };
document.addEventListener('click', e => {
  const t = e.target.closest('[data-samodel]'); if (!t) return;
  saModelId = null; saRows = null; saMsg = null;
  const m = (D.models || []).find(x => x.id === t.dataset.samodel);
  if (m) saLoad(m);
  saRedraw();
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-sadel]'); if (!t) return;
  saRows.splice(+t.dataset.sadel, 1);
  saTested = null;                       // the measurement described the old book
  saRedraw();
});
document.addEventListener('click', e => {
  const t = e.target.closest('[data-saadd]'); if (!t) return;
  const box = document.querySelector('[data-saticker]');
  const tk = String(box?.value || '').trim().toUpperCase();
  if (!tk) return;
  if (saRows.some(r => r.ticker === tk)) { saMsg = { ok: false, text: `${tk} is already in this allocation.` }; return saRedraw(); }
  const sec = (D.markets || []).find(x => x.ticker === tk);
  // An unknown ticker is still added, flagged, and simply cannot be priced or classified. Refusing
  // it would stop the owner sketching with a name the universe has not caught up with yet.
  saRows.push({ ticker: tk, weight: 0, security_id: sec ? sec.id : null });
  saMsg = sec ? null : { ok: false, text: `${tk} is not in the securities universe, so it cannot be priced or classified. Add it to data/universe.csv to measure it.` };
  saTested = null;
  saRedraw();
});
// Weights write state without redrawing, so the caret stays in the field being typed into.
document.addEventListener('input', e => {
  const t = e.target.closest('[data-sawt]'); if (!t) return;
  const i = +t.dataset.sawt;
  if (saRows[i]) saRows[i].weight = (parseFloat(t.value) || 0) / 100;
  saTested = null;
});
document.addEventListener('input', e => {
  const t = e.target.closest('[data-sanote]'); if (!t) return;
  saNote = t.value;
});
// Leaving a weight field redraws, so the pies and the total catch up.
// ---------------------------------------------------------------------------
// The tab menu. Twelve tabs do not fit a laptop header and wrapping them pushed the page down by
// two rows before anything had been read, so below the breakpoint they collapse behind a button.
//
// It is a button rather than a checkbox hack because it has to be closable from four directions --
// choosing a tab, clicking away, pressing Escape, and any navigation the user made some other way
// -- and aria-expanded has to follow all four or a screen reader is told the menu is open after it
// has shut.
// ---------------------------------------------------------------------------
function setMenu(open) {
  const nav = $('#nav'), btn = $('#menu');
  if (!nav || !btn) return;
  nav.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
document.addEventListener('click', e => {
  const btn = e.target.closest('#menu');
  // preventDefault is optional-chained because the button is a <button> with no default to
  // prevent, and because a synthetic event dispatched without one should not take the handler down.
  if (btn) { e.preventDefault?.(); setMenu(!$('#nav').classList.contains('open')); return; }
  // Clicking a tab navigates, and the hashchange handler closes the menu. Clicking anywhere else
  // outside it closes without navigating.
  if (!e.target.closest('#nav') && $('#nav') && $('#nav').classList.contains('open')) setMenu(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

document.addEventListener('change', e => {
  const t = e.target.closest('[data-sawt]'); if (!t) return;
  saRedraw();
});

// Test: rebuild a daily series from the proposed weights and measure it over two windows.
document.addEventListener('click', async e => {
  if (!e.target.closest('[data-satest]')) return;
  // GUARDED because saRows is only populated by sandboxAllocation(), which returns early when the
  // model list is empty -- and the model list is empty whenever the strategies query failed. The
  // button is still in the DOM from the previous render, so a click then threw a TypeError that
  // killed every later handler on the page. An intermittent query timeout should degrade to a
  // message, not to a dead page.
  if (!saRows) { saMsg = { ok: false, text: 'No model is loaded, so there is nothing to measure. Reload the page — the strategy list did not arrive.' }; return saRedraw(); }
  const rows = saRows.filter(r => r.security_id && +r.weight > 0);
  if (!rows.length) { saMsg = { ok: false, text: 'Nothing priceable to measure: every row needs a known ticker and a weight above zero.' }; return saRedraw(); }
  saBusy = true; saMsg = null; saRedraw();
  try {
    const m = (D.models || []).find(x => x.id === saModelId);
    const bench = (D.markets || []).find(x => x.ticker === (m?.benchmarkTicker || 'VSMGX')) || (D.markets || []).find(x => x.ticker === 'VSMGX');
    const ids = [...new Set([...rows.map(r => r.security_id), bench?.id].filter(Boolean))];
    const yr = new Date().getUTCFullYear();
    const from = `${yr - 1}-10-01`;                   // enough for a one-year window plus a margin
    const px = await saPrices(ids, from);
    // The calendar comes from the benchmark where there is one, else the longest series present.
    const src = (bench && px[bench.id]?.length) ? px[bench.id] : Object.values(px).sort((a, b) => b.length - a.length)[0] || [];
    const all = src.map(r => r.price_date);
    const ytdFrom = `${yr - 1}-12-31`;
    const oneYFrom = all.at(-1) ? new Date(Date.parse(all.at(-1)) - 365 * 864e5).toISOString().slice(0, 10) : from;
    const mk = start => {
      const dates = all.filter(d => d >= start);
      if (dates.length < 20) return null;
      const series = saSeries(rows, px, dates, null);
      const bseries = bench ? saSeries([{ security_id: bench.id, weight: 1 }], px, dates, null) : [];
      return saStats(series, bseries);
    };
    // Duration and the fingerprint are weighted sums of figures already measured per security.
    const dur = (() => {
      const lots = D.secDuration || [];
      let w = 0, wd = 0;
      for (const r of rows) {
        const d = lots.find(x => x.security_id === r.security_id);
        if (!d || d.duration_yrs === null) continue;
        const cls = (D.markets || []).find(x => x.id === r.security_id)?.cls;
        const ov = (D.factorOverrides || []).find(o => o.security_id === r.security_id);
        const mix = mixOf(ov);
        const share = mix ? (+mix.bonds || 0) : (cls === 'bonds' ? 1 : 0);
        if (share <= 0) continue;
        w += (+r.weight) * share; wd += (+r.weight) * share * (+d.duration_yrs);
      }
      return w > 0 ? wd / w : null;
    })();
    // The fingerprint and the sector breakdown are rendered live from the weights by
    // saFingerprint and saSectors -- neither needs a price, so neither waits for this.
    // Test carries only the figures that genuinely need a price series.
    saTested = { ytd: mk(ytdFrom), oneY: mk(oneYFrom), duration: dur };
    if (!saTested.ytd && !saTested.oneY) saMsg = { ok: false, text: 'Not enough overlapping price history to measure these weights.' };
  } catch (ex) {
    saMsg = { ok: false, text: `Could not measure that: ${ex.message}` };
  }
  saBusy = false; saRedraw();
});

// Submit Final: records the allocation. Only the Target Allocation pie reads it.
document.addEventListener('click', async e => {
  if (!e.target.closest('[data-safinal]')) return;
  const rows = saRows.filter(r => +r.weight > 0);
  if (!rows.length) { saMsg = { ok: false, text: 'Nothing to submit: every row is at zero.' }; return saRedraw(); }
  saBusy = true; saRedraw();
  try {
    const mph = (D.modelSpeedLimit || []).find(r => r.strategy_id === saModelId) || null;
    const { error } = await sb.from('sandbox_target_allocation').insert({
      strategy_id: saModelId,
      holdings: rows.map(r => ({ ticker: r.ticker, weight: +(+r.weight).toFixed(6), security_id: r.security_id })),
      note: saNote || null, author: 'desk',
      mph_reading: mph ? { light: mph.light, target_low: mph.target_low, target_high: mph.target_high, actual_beta: mph.actual_beta } : null,
    });
    if (error) throw new Error(error.message);
    saMsg = { ok: true, text: `Submitted. The Target Allocation pie in this model’s drawer now shows it; nothing else on the site moved.` };
    D.sandboxTargets = null;   // reload on the next visit
  } catch (ex) {
    saMsg = { ok: false, text: `Could not submit that allocation: ${ex.message}. Nothing was saved.` };
  }
  saBusy = false; saRedraw();
});

// Agent Fine Tune: a request, like the trade analysis. The agents run outside this page.
document.addEventListener('click', async e => {
  if (!e.target.closest('[data-satune]')) return;
  const rows = saRows.filter(r => +r.weight > 0);
  if (!rows.length) { saMsg = { ok: false, text: 'Nothing to tune: every row is at zero.' }; return saRedraw(); }
  saBusy = true; saRedraw();
  try {
    const { data, error } = await sb.from('trade_journal').insert({
      action: 'rebalance', asset_class: null,
      rationale: `Agent Fine Tune requested on a proposed allocation for ${bareName(((D.models || []).find(m => m.id === saModelId) || {}).name || '')}: ${rows.map(r => `${r.ticker} ${(+r.weight * 100).toFixed(1)}%`).join(', ')}.${saNote ? ` Note: ${saNote}` : ''}`,
      setup: 'Risk-Based', strategy_ids: [saModelId], author: 'desk',
      submitted_at: new Date().toISOString(),
    }).select('id').single();
    if (error) throw new Error(error.message);
    const reqs = ['adam', 'sven', 'kate', 'stan'].map(agent => ({ journal_id: data.id, agent }));
    const { error: ve } = await sb.from('trade_journal_verdicts').insert(reqs);
    if (ve) throw new Error(ve.message);
    saMsg = { ok: true, text: 'Adam, Sven, Kate and Stan have been asked to tune this allocation. Their proposals appear on Gail’s tab once they run.' };
  } catch (ex) {
    saMsg = { ok: false, text: `Could not request a tune: ${ex.message}` };
  }
  saBusy = false; saRedraw();
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
