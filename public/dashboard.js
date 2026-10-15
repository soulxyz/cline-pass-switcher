(() => {
  'use strict';
  const el = (s) => document.querySelector(s);
  const text = (id, value) => { el(id).textContent = value; };
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = (n) => n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  const compact = (n) => n == null ? '—' : n < 10000 ? number(n) : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
  const speed = (n) => n == null ? '—' : Number(n).toFixed(1);
  const duration = (n) => n == null ? '—' : n < 1000 ? `${number(n)} ms` : `${(n / 1000).toFixed(2)} s`;
  const money = n => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < .01 ? 6 : 4 }).format(n);
  const time = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const shortModel = (value) => String(value || '').replace(/^cline-pass\//, '');
  const failed = (r) => !!r.error || r.status >= 400;
  const dateKey = (ts) => new Date(ts).toISOString().slice(0, 10);
  const A = globalThis.CPSAnalytics;
  const storedSize = Number(localStorage.getItem('cps_page_size'));
  const state = { range: 'today', filters: { provider: '', model: '' }, trend: 'tokens', summary: 'requests', groupPage: 1, overviewPage: 1, pageSize: [25,50,100,200].includes(storedSize) ? storedSize : 50, pricing: {}, pricingLoaded: false, version: '', analytics: { days: {}, hours: {} }, recent: [], history: [], historyVersion: '', historyLoaded: false, active: [], latestMeasured: null, liveNow: 0, now: Date.now(), page: 1, sort: 'time', descending: true, view: 'overview', renderedHour: null };
  let polling = false;
  let historyLoading = null;
  let details = new Map();

  async function read(path) {
    const headers = AUTH_KEY ? { 'X-Admin-Key': AUTH_KEY } : {};
    const response = await fetch(path, { headers, signal: AbortSignal.timeout(12000) });
    if (response.status === 401) { showLogin(); throw new Error('请输入有效代理密钥后继续。'); }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `读取失败（HTTP ${response.status}）`);
    return data;
  }

  function showError(error) {
    el('#dataError').hidden = false;
    text('#dataErrorText', `同步失败：${error.message} 已保留上次数据，可稍后重试。`);
    text('#connectionLabel', '连接暂时中断');
    document.body.dataset.offline = 'true';
  }

  window.refreshTelemetry = async function refreshTelemetry() {
    if (polling || el('#loginOverlay').style.display === 'flex') return;
    polling = true;
    try {
      const data = await read(`/api/telemetry?version=${encodeURIComponent(state.version)}`);
      const changed = state.version !== String(data.version);
      state.version = String(data.version);
      state.now = data.now;
      applyLive(data);
      if (data.analytics) state.analytics = data.analytics;
      if (data.recent) state.recent = data.recent;
      if (data.priceCatalog) {
        state.priceStatus = data.priceCatalog;
        renderPriceStatus();
        if (state.summary === 'pricing' && state.pricingLoaded && state.pricingFetchedAt !== data.priceCatalog.fetchedAt) void loadPricing(snapshotPricing());
      }
      el('#dataError').hidden = true;
      delete document.body.dataset.offline;
      text('#connectionLabel', '代理已连接');
      text('#syncLabel', `已同步 ${new Date(data.now).toLocaleTimeString('zh-CN', { hour12: false })}`);
      if (changed || state.renderedHour !== Math.floor(data.now / 3600000) || el('#metrics').getAttribute('aria-busy') === 'true') {
        state.renderedHour = Math.floor(data.now / 3600000);
        renderUsageFilters();
        renderOverview();
        renderRecent();
      }
      if (['overview', 'requests'].includes(state.view) && (!state.historyLoaded || (state.historyVersion !== state.version && (state.view === 'overview' || el('#autoRefresh').checked)))) await loadRequests();
    } catch (error) { showError(error); }
    finally { polling = false; }
  };

  function applyLive(data) {
    if (data.now < state.liveNow) return;
    state.liveNow = data.now;
    state.active = data.active || [];
    if (Object.hasOwn(data, 'latestMeasured')) state.latestMeasured = data.latestMeasured;
    renderLive();
  }
  let livePolling = false;
  async function refreshLive() {
    if (livePolling || document.hidden || state.view !== 'overview' || !Number(el('#refreshInterval').value) || el('#loginOverlay').style.display === 'flex') return;
    livePolling = true;
    try { applyLive(await read('/api/live')); }
    catch {
      text('#currentSpeedState', '连接暂时中断');
      text('#currentSpeed', '—');
      text('#currentSpeedNote', '当前数据未更新；最近实测与区间均速保留。');
    } finally { livePolling = false; }
  }

  function rangeBuckets() {
    return A.range(state.analytics, state.range, state.now, state.filters);
  }

  function renderUsageFilters() {
    const providers = new Set(), models = new Set();
    for (const bucket of Object.values(state.analytics.days)) for (const segment of Object.values(bucket.segments || {})) {
      providers.add(segment.provider || '未识别上游'); models.add(segment.model);
    }
    for (const [id, values, label, current] of [['#providerFilter', providers, '全部上游', state.filters.provider], ['#modelFilter', models, '全部模型', state.filters.model]]) {
      if (current) values.add(current);
      el(id).innerHTML = `<option value="">${label}</option>${[...values].filter(Boolean).sort().map(v => `<option value="${escape(v)}">${escape(id === '#modelFilter' ? shortModel(v) : v)}</option>`).join('')}`;
      el(id).value = current;
    }
  }

  function renderOverview() {
    const buckets = rangeBuckets();
    const totals = A.sum(buckets);
    text('#metricCost', totals.costRequests ? money(totals.costUsd) : '—');
    text('#metricCostNote', totals.costRequests ? `${number(totals.reportedCostRequests)} 次上报 · ${number(totals.estimatedCostRequests)} 次估算 / ${number(totals.requests)} 次请求` : '等待完整用量与可用报价');
    text('#metricRequests', number(totals.requests));
    text('#metricRequestsNote', `${number(totals.requests - totals.errors)} 成功 · ${number(totals.errors)} 失败`);
    text('#metricTokens', totals.usageRequests ? compact(totals.totalTokens) : '—');
    el('#metricTokens').title = totals.usageRequests ? `${number(totals.totalTokens)} Token` : '上游未上报用量';
    text('#metricTokensNote', totals.requests ? `${number(totals.usageRequests)} / ${number(totals.requests)} 次请求已上报用量` : '等待首条请求的真实用量');
    text('#metricSpeed', totals.generationMs ? speed(totals.generatedTokens / (totals.generationMs / 1000)) : '—');
    text('#metricSpeedNote', totals.speedCount ? `${number(totals.speedCount)} 次流式请求 · 按生成时长加权` : '等待可计时的流式请求');
    text('#metricSuccess', totals.requests ? `${((totals.requests - totals.errors) / totals.requests * 100).toFixed(1)}%` : '—');
    text('#metricSuccessNote', totals.requests ? `平均耗时 ${duration(buckets.reduce((s, b) => s + (b.durationMs || 0), 0) / totals.requests)}` : '尚无请求');
    text('#inputTotal', totals.usageRequests ? number(totals.inputTokens) : '—');
    text('#outputTotal', totals.usageRequests ? number(totals.outputTokens) : '—');
    text('#ttftAverage', totals.ttftCount ? duration(totals.ttftSum / totals.ttftCount) : '—');
    text('#cacheReadTotal', totals.cacheReadRequests ? compact(totals.cachedTokens) : '—');
    el('#cacheReadTotal').title = totals.cacheReadRequests ? `${number(totals.cachedTokens)} Token` : '上游未上报';
    text('#cacheReadNote', `${number(totals.cacheReadRequests)} / ${number(totals.requests)} 次请求已上报`);
    text('#cacheWriteTotal', totals.cacheWriteRequests ? compact(totals.cacheWriteTokens) : '—');
    el('#cacheWriteTotal').title = totals.cacheWriteRequests ? `${number(totals.cacheWriteTokens)} Token` : '上游未上报';
    text('#cacheWriteNote', `${number(totals.cacheWriteRequests)} 次请求已上报写入用量`);
    text('#cacheHitRate', totals.cacheInputTokens > 0 ? `${(totals.cacheReadTokensForRate / totals.cacheInputTokens * 100).toFixed(1)}%` : '—');
    text('#metricCacheRate', totals.cacheInputTokens > 0 ? `${(totals.cacheReadTokensForRate / totals.cacheInputTokens * 100).toFixed(1)}%` : '—');
    text('#metricCacheNote', `${number(totals.cacheReadRequests)} / ${number(totals.requests)} 次请求已上报缓存`);
    text('#cacheHitNote', totals.cacheRateRequests ? `未命中 ${number(totals.cacheInputTokens - totals.cacheReadTokensForRate)} 输入 Token · ${number(totals.cacheRateRequests)} 次请求` : '仅计算有缓存明细的请求');
    text('#reasoningTotal', totals.reasoningRequests ? compact(totals.reasoningTokens) : '—');
    el('#reasoningTotal').title = totals.reasoningRequests ? `${number(totals.reasoningTokens)} Token` : '上游未上报';
    text('#reasoningNote', `${number(totals.reasoningRequests)} 次请求已上报 · 输出的子集`);
    text('#rangeLabel', state.range === 'today' ? '当天 · UTC' : Number(state.range) === 1 ? '最近 24 小时' : `最近 ${state.range} 天`);
    const original = A.range(state.analytics, state.range, state.now);
    const originalTotal = A.sum(original).requests;
    const groupedTotal = A.sum(original.flatMap(b => Object.values(b.segments || {}))).requests;
    const incomplete = groupedTotal < originalTotal;
    el('#coverageNote').hidden = !incomplete || !['overview', 'requests'].includes(state.view);
    text('#coverageNote', `旧数据的模型／上游分组可追溯 ${number(groupedTotal)} / ${number(originalTotal)} 次请求。筛选与分组仅统计可追溯记录，未筛选总览保留完整原始聚合。`);
    if (state.version) el('#metrics').setAttribute('aria-busy', 'false');
    renderTrend(buckets, totals);
    renderHeatmap();
    renderSummary();
  }

  function renderTrend(buckets, totals) {
    const node = el('#trendChart');
    const settings = {
      tokens: { label: 'Token 用量', known: totals.usageRequests, fields: ['inputTokens', 'outputTokens'], labels: ['输入', '输出'], unit: 'Token' },
      requests: { label: '请求次数', known: totals.requests, fields: ['requests'], labels: ['请求'], unit: '次' },
      cost: { label: '参考成本', known: totals.costRequests, fields: ['costUsd'], labels: ['上报与估算'], unit: 'USD' },
      cache: { label: '缓存用量', known: totals.cacheReadRequests + totals.cacheWriteRequests, fields: ['cachedTokens', 'cacheWriteTokens'], labels: ['读取', '写入'], unit: 'Token' },
    }[state.trend];
    const hourly = state.range === 'today' || Number(state.range) === 1;
    text('#trendTitle', `使用趋势 · ${settings.label}`);
    text('#trendSubtitle', `${hourly ? '按小时' : '按天'}聚合 · UTC · ${settings.unit}${state.trend === 'cost' ? ' · 仅计有成本数据的请求' : ''}`);
    el('#trendLegend').innerHTML = settings.labels.map((label, i) => `<span><i class="legend-dot ${i ? 'output' : 'input'}"></i>${label}</span>`).join('');
    if (!settings.known) {
      node.innerHTML = `<div class="chart-empty"><strong>此范围尚无${settings.label}数据</strong><span>${state.trend === 'cost' ? '上游上报成本或配置模型定价后，新请求将记录参考成本。' : '可调整筛选，或通过代理发起请求后查看。'}</span></div>`;
      return;
    }
    const max = Math.max(0, ...buckets.flatMap(b => settings.fields.map(field => b[field] || 0)));
    const top = state.trend === 'cost' ? max * 1.15 || .01 : Math.max(4, Math.ceil(max / 4) * 4);
    const display = value => state.trend === 'cost' ? money(value) : compact(value);
    const label = b => hourly ? `${new Date(b.ts).getUTCHours().toString().padStart(2, '0')}:00` : b.key.slice(5).replace('-', '/');
    node.innerHTML = `<div class="bar-chart" role="group" aria-label="${hourly ? '每小时' : '每天'}${settings.label}，聚焦柱状图查看精确值">
      <div class="chart-scale">${[1, .75, .5, .25, 0].map(ratio => `<span>${display(top * ratio)}</span>`).join('')}</div>
      <div class="bars">${buckets.map((b, i) => {
        const hasData = state.trend === 'cost' ? b.costRequests : state.trend === 'cache' ? b.cacheReadRequests || b.cacheWriteRequests : state.trend === 'tokens' ? b.usageRequests : true;
        const title = `${b.key.replace('T', ' ')} UTC · ${!hasData ? '未上报' : settings.fields.map((field, index) => `${settings.labels[index]} ${state.trend === 'cost' ? money(b[field] || 0) : number(b[field] || 0)}`).join(' · ')} · ${number(b.requests || 0)} 次请求`;
        return `<button class="bar-slot" data-bar="${i}" title="${escape(title)}" aria-label="${escape(title)}">${settings.fields.map((field, index) => `<span class="bar ${index ? 'output' : 'input'}" style="height:${(b[field] || 0) / top * 100}%"></span>`).join('')}</button>`;
      }).join('')}</div><div class="chart-ticks">${[...new Set([0, Math.floor((buckets.length - 1) / 3), Math.floor((buckets.length - 1) * 2 / 3), buckets.length - 1])].map(i => `<span>${label(buckets[i])}</span>`).join('')}</div></div><div class="chart-readout" hidden></div>`;
    node.querySelectorAll('[data-bar]').forEach(button => {
      const show = () => { const output = node.querySelector('.chart-readout'); output.textContent = button.title; output.hidden = false; };
      button.addEventListener('pointerenter', show);
      button.addEventListener('focus', show);
      button.addEventListener('pointerleave', () => { node.querySelector('.chart-readout').hidden = true; });
      button.addEventListener('blur', () => { node.querySelector('.chart-readout').hidden = true; });
      button.addEventListener('click', () => filterDay(dateKey(buckets[Number(button.dataset.bar)].ts)));
    });
  }

  function renderHeatmap() {
    const metric = el('#heatMetric').value;
    const metricLabel = { requests: '次请求', totalTokens: 'Token', errors: '次错误', cachedTokens: '缓存读取 Token', cacheWriteTokens: '缓存写入 Token' }[metric];
    const today = Date.parse(`${dateKey(state.now)}T00:00:00Z`);
    const weeks = innerWidth <= 700 ? 13 : innerWidth <= 1200 ? 26 : 53;
    el('#heatmap').style.setProperty('--heat-weeks', weeks);
    text('#heatmapSubtitle', `${weeks === 53 ? '近一年' : `最近 ${weeks} 周`} · 点击日期追踪当日请求 · UTC`);
    const end = today + (6 - new Date(today).getUTCDay()) * 86400000;
    const start = end - (weeks * 7 - 1) * 86400000;
    const days = Array.from({ length: weeks * 7 }, (_, i) => {
      const ts = start + i * 86400000;
      const key = dateKey(ts);
      const bucket = A.select(state.analytics.days[key] || {}, state.filters);
      return { ts, key, value: bucket[metric] || 0, bucket };
    });
    const max = Math.max(1, ...days.map(d => d.value));
    let lastMonth = '';
    const months = days.filter((_, i) => i % 7 === 0).map(d => {
      const month = `${new Date(d.ts).getUTCMonth() + 1} 月`;
      const output = month === lastMonth ? '' : month;
      lastMonth = month;
      return `<span>${output}</span>`;
    }).join('');
    el('#heatmap').innerHTML = `<div class="heat-months" aria-hidden="true"><span></span>${months}</div><div class="heat-body"><div class="heat-days" aria-hidden="true"><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span></div><div class="heat-grid" role="group" aria-label="${weeks} 周调用热力图，日期以 UTC 计">${days.map(d => {
      const level = !d.value ? 0 : Math.max(1, Math.ceil(Math.sqrt(d.value / max) * 4));
      const missing = metric === 'cachedTokens' ? !d.bucket.cacheReadRequests : metric === 'cacheWriteTokens' ? !d.bucket.cacheWriteRequests : metric === 'totalTokens' ? !d.bucket.usageRequests : false;
      const label = missing ? `${d.key} · ${metricLabel}未上报` : `${d.key} · ${number(d.value)} ${metricLabel}`;
      return `<button class="heat-cell${d.ts > today ? ' future' : ''}" data-day="${d.key}" data-level="${level}" title="${escape(label)}" aria-label="${escape(label)}" ${d.ts > today ? 'disabled' : ''}></button>`;
    }).join('')}</div></div>`;
    const total = days.reduce((sum, d) => sum + d.value, 0);
    const active = days.filter(d => d.bucket.requests > 0).length;
    const cacheRequests = metric === 'cachedTokens' ? days.reduce((sum, d) => sum + (d.bucket.cacheReadRequests || 0), 0) : metric === 'cacheWriteTokens' ? days.reduce((sum, d) => sum + (d.bucket.cacheWriteRequests || 0), 0) : null;
    text('#heatmapSummary', cacheRequests === 0 ? `此范围尚无${metricLabel}上报` : `${number(total)} ${metricLabel} · ${active} 个活跃日`);
    el('#heatmap').querySelectorAll('[data-day]').forEach(button => {
      const detail = () => {
        const b = A.select(state.analytics.days[button.dataset.day] || {}, state.filters);
        text('#heatDetail', `${button.dataset.day} UTC · ${number(b.requests || 0)} 次请求 · ${b.usageRequests ? number(b.totalTokens) + ' Token' : 'Token 未上报'} · 缓存读取 ${b.cacheReadRequests ? number(b.cachedTokens) : '—'} / 写入 ${b.cacheWriteRequests ? number(b.cacheWriteTokens) : '—'} Token · ${number(b.errors || 0)} 次错误`);
      };
      button.addEventListener('pointerenter', detail);
      button.addEventListener('focus', detail);
      button.addEventListener('click', () => { detail(); filterDay(button.dataset.day); });
    });
  }

  function renderLive() {
    const active = state.active.filter(request => A.matches(request, state.filters));
    const liveRate = request => request.liveTps ?? request.tps;
    const measured = active.filter(request => request.stream && typeof liveRate(request) === 'number' && Number.isFinite(liveRate(request)));
    const latest = [state.latestMeasured, ...state.history, ...state.recent].filter(request => request && typeof request.tps === 'number' && Number.isFinite(request.tps) && !failed(request) && A.matches(request, state.filters)).sort((a,b) => b.ts - a.ts)[0];
    const paused = !Number(el('#refreshInterval').value);
    text('#currentSpeed', measured.length ? speed(measured.reduce((total, request) => total + liveRate(request), 0)) : '—');
    text('#currentSpeedState', paused ? '已暂停 · 手动快照' : measured.length ? `${measured.length} 路实测` : active.length ? '等待上游用量' : '当前空闲');
    const newestUsage = Math.max(0, ...measured.map(request => request.usageUpdatedAt || 0));
    text('#currentSpeedNote', paused ? '自动刷新已暂停，点击刷新获取当前快照。' : measured.length ? `${measured.length} / ${active.length} 路已上报 · 各请求累计均速合计${newestUsage ? ` · 用量 ${Math.max(0, Math.floor((state.liveNow - newestUsage) / 1000))} 秒前上报` : ''}` : active.length ? '生成中；上游返回输出 Token 后补全，右侧保留最近实测。' : '每秒更新 · 发起流式请求后自动展示。');
    text('#lastMeasuredSpeed', latest ? speed(latest.tps) : '—');
    text('#lastMeasuredNote', latest ? `${shortModel(latest.model)} · ${latest.provider || '未知上游'} · ${time(latest.ts)}` : '尚无可测量的流式请求');
    text('#activeCount', `${active.length} 进行中`);
    text('#navActive', state.active.length);
    el('#navActive').hidden = !state.active.length;
    if (active.length && !state.hadActive) el('#liveDrawer').open = true;
    state.hadActive = active.length > 0;
    el('#liveRequests').innerHTML = active.length ? active.map(r => `<div class="live-item"><div class="live-item-head"><span class="live-model">${escape(shortModel(r.model))}</span><span class="live-speed">${liveRate(r) != null ? speed(liveRate(r)) + ' tok/s' : r.stream ? '等待用量' : '请求中'}</span></div><p>${escape(r.provider || r.account || '连接上游')} · 已用时 ${duration(r.ms)}${r.ttftMs != null ? ` · 首字 ${duration(r.ttftMs)}` : ''}</p><p>${r.outputTokens != null ? `输出 ${number(r.outputTokens)} Token · ` : ''}${r.stream ? '流式' : '非流式'} · ${escape(r.id.slice(0, 8))}</p></div>`).join('') : `<div class="chart-empty"><strong>当前筛选下暂无进行中请求</strong><span>${latest ? `最近完成 ${escape(shortModel(latest.model))} · ${speed(latest.tps)} tok/s` : '请求开始后，在这里查看实时进度。'}</span></div>`;
  }

  function renderSummary() {
    document.querySelectorAll('[data-summary]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.summary === state.summary)));
    el('#overviewLogs').hidden = state.summary !== 'requests';
    el('#overviewGroups').hidden = !['provider', 'model'].includes(state.summary);
    el('#overviewPricing').hidden = state.summary !== 'pricing';
    if (['provider', 'model'].includes(state.summary)) renderGroups();
    if (state.summary === 'pricing' && !state.pricingLoaded) loadPricing();
  }

  function renderGroups() {
    const by = state.summary === 'model' ? 'model' : 'provider';
    const order = el('#groupSort').value;
    const rows = A.groups(rangeBuckets(), by).sort((a, b) => {
      if (order === 'costUsd' && !!a.costRequests !== !!b.costRequests) return a.costRequests ? -1 : 1;
      return (b[order] || 0) - (a[order] || 0) || a.key.localeCompare(b.key);
    });
    const pages = Math.max(1, Math.ceil(rows.length / 25));
    state.groupPage = Math.max(1, Math.min(pages, state.groupPage));
    text('#groupName', by === 'model' ? '模型' : '供应商 / 实际上游');
    text('#groupDescription', `按${by === 'model' ? '请求模型' : '实际命中上游'}汇总 · 点击查看对应请求`);
    el('#groupBody').innerHTML = rows.slice((state.groupPage - 1) * 25, state.groupPage * 25).map(r => `<tr><td class="group-key" title="${escape(r.key)}">${escape(by === 'model' ? shortModel(r.key) : r.key)}</td><td class="numeric">${number(r.requests)}</td><td class="numeric">${r.usageRequests ? compact(r.totalTokens) : '—'}</td><td class="numeric cache-number">${r.cacheReadRequests ? compact(r.cachedTokens) : '—'}</td><td class="numeric">${r.cacheInputTokens ? `${(r.cacheReadTokensForRate / r.cacheInputTokens * 100).toFixed(1)}%` : '—'}</td><td class="numeric cost-value" title="${r.costRequests} / ${r.requests} 次有成本数据，含 ${r.estimatedCostRequests} 次估算">${r.costRequests ? money(r.costUsd) : '—'}</td><td class="numeric">${r.generationMs ? speed(r.generatedTokens / (r.generationMs / 1000)) : '—'}</td><td class="numeric">${r.ttftCount ? duration(r.ttftSum / r.ttftCount) : '—'}</td><td class="numeric">${((r.requests - r.errors) / r.requests * 100).toFixed(1)}%</td><td><button class="detail-button" data-group-key="${escape(r.key)}" data-group-by="${by}">查看请求 ↗</button></td></tr>`).join('') || '<tr><td colspan="10" class="empty">此范围暂无可分组记录。新请求会自动记录模型与实际上游。</td></tr>';
    text('#groupCount', `${number(rows.length)} 个${by === 'model' ? '模型' : '上游'} · 分组依据已记录的维度`);
    text('#groupPage', `${state.groupPage} / ${pages}`);
    el('#prevGroup').disabled = state.groupPage === 1;
    el('#nextGroup').disabled = state.groupPage === pages;
  }

  let pricingLoading = false;
  function snapshotPricing() {
    return Object.fromEntries([...document.querySelectorAll('[data-price-model]')].map(row => [row.dataset.priceModel, {
      mode: row.querySelector('[data-price-source]').value,
      values: Object.fromEntries([...row.querySelectorAll('[data-price-field]')].map(input => [input.dataset.priceField, input.value])),
      manual: row.dataset.manualDraft ? JSON.parse(row.dataset.manualDraft) : null,
    }]));
  }
  function renderPriceStatus() {
    const s = state.priceStatus || {};
    const updated = s.fetchedAt ? new Date(s.fetchedAt).toLocaleString('zh-CN') : '尚未同步';
    text('#priceCatalogStatus', `models.dev · ${number(s.count || 0)} 条报价 · 拉取时间 ${updated}${s.stale && s.fetchedAt ? ' · 缓存已超过 24 小时' : ''}${s.syncing ? ' · 正在后台同步…' : ''}${s.error ? ` · ${s.error}${s.count ? '（继续使用缓存）' : ''}` : ''}`);
  }
  function applyPriceRow(row, mode, manualValues) {
    const model = row.dataset.priceModel;
    const info = state.priceCatalog?.[model] || {};
    let price = null;
    if (mode === 'manual') price = manualValues || state.pricing[model] || {};
    else price = mode === 'auto' ? info.resolved : info.candidates?.find(candidate => candidate.key === mode)?.price;
    for (const input of row.querySelectorAll('[data-price-field]')) {
      const value = price?.[input.dataset.priceField];
      input.value = value ?? '';
      input.readOnly = mode !== 'manual';
      input.placeholder = mode === 'manual' ? input.dataset.priceField.startsWith('cache') ? '同输入单价' : '未设置' : '未提供';
    }
    const reason = mode === 'manual' ? '手动覆盖 · 保存后生效' : mode === 'auto' ? ({ upstream: '按实际渠道匹配', 'official-reference': '官方参考价 · 非实际渠道报价', 'single-reference': '单一来源参考价', selected: '已指定目录来源' }[info.resolved?.match] || '未能唯一匹配，请选择报价来源') : '选定供应商报价 · 保存后生效';
    textPriceHint(row, `${reason}${price?.tiers?.length ? ` · 含 ${price.tiers.length} 个上下文档位` : ''}`);
    row.dataset.mode = mode;
  }
  function textPriceHint(row, value) { row.querySelector('.price-source-note').textContent = value; }
  async function loadPricing(draft = null) {
    if (pricingLoading) return;
    pricingLoading = true;
    try {
      const data = await read('/api/pricing');
      if (draft && document.querySelector('[data-price-model]')) draft = snapshotPricing();
      state.pricing = data.pricing || {};
      state.priceSelections = data.selections || {};
      state.priceCatalog = data.catalog || {};
      state.priceStatus = data.status || {};
      state.pricingFetchedAt = state.priceStatus.fetchedAt;
      renderPriceStatus();
      const models = [...new Set([...(data.models || []), ...Object.keys(state.pricing)])];
      el('#pricingBody').innerHTML = models.map(model => {
        const candidates = state.priceCatalog[model]?.candidates || [];
        const mode = draft?.[model]?.mode || (state.pricing[model] ? 'manual' : state.priceSelections[model] || 'auto');
        const unavailable = !['auto', 'manual'].includes(mode) && !candidates.some(candidate => candidate.key === mode);
        return `<tr data-price-model="${escape(model)}"><td class="mono">${escape(model)}</td><td class="price-source"><select data-price-source aria-label="${escape(model)} 价格来源"><option value="auto">自动匹配 models.dev</option><option value="manual">手动覆盖</option>${unavailable ? `<option value="${escape(mode)}">上次来源（当前未匹配）</option>` : ''}${candidates.map(candidate => `<option value="${escape(candidate.key)}">${escape(`${candidate.providerName} / ${candidate.model} · ${candidate.price.input} / ${candidate.price.output}`)}</option>`).join('')}</select><small class="price-source-note"></small></td>${['input', 'output', 'cacheRead', 'cacheWrite'].map(field => `<td><input type="number" min="0" step="any" inputmode="decimal" data-price-field="${field}" aria-label="${escape(model)} ${field} 单价（USD / 百万 Token）"></td>`).join('')}</tr>`;
      }).join('') || '<tr><td colspan="6" class="empty">暂无订阅模型，请先在模型路由中添加或拉取模型。</td></tr>';
      for (const row of document.querySelectorAll('[data-price-model]')) {
        const model = row.dataset.priceModel;
        const saved = draft?.[model];
        const mode = saved?.mode || (state.pricing[model] ? 'manual' : state.priceSelections[model] || 'auto');
        row.querySelector('[data-price-source]').value = mode;
        if (saved?.manual) row.dataset.manualDraft = JSON.stringify(saved.manual);
        applyPriceRow(row, mode, mode === 'manual' ? saved?.values || state.pricing[model] : null);
      }
      state.pricingLoaded = true;
      text('#pricingMessage', '来源选择和手动单价需保存；自动目录价拉取后用于新请求。历史记录保留原价格，未匹配不会猜最低价。');
    } catch (error) { text('#pricingMessage', `读取失败：${error.message}。点击「定价」可重试。`); }
    finally { pricingLoading = false; }
  }

  el('#pricingBody').addEventListener('change', event => {
    const select = event.target.closest('[data-price-source]');
    if (!select) return;
    const row = select.closest('[data-price-model]');
    const current = Object.fromEntries([...row.querySelectorAll('[data-price-field]')].map(input => [input.dataset.priceField, input.value]));
    if (row.dataset.mode === 'manual') row.dataset.manualDraft = JSON.stringify(current);
    const manual = row.dataset.manualDraft ? JSON.parse(row.dataset.manualDraft) : current;
    applyPriceRow(row, select.value, select.value === 'manual' ? manual : null);
  });
  el('#syncModelPrices').addEventListener('click', async () => {
    const button = el('#syncModelPrices');
    const draft = snapshotPricing();
    button.disabled = true; button.textContent = '正在拉取…';
    try {
      const data = await api('/api/pricing/sync', {});
      await loadPricing(draft);
      text('#pricingMessage', data.ok ? `已拉取 ${number(data.status.count)} 条报价，手动编辑已保留。来源切换与手动单价请保存后生效。` : `${data.status.error}；${data.status.count ? '继续使用上次缓存' : '尚无可用缓存'}。手动定价仍可使用。`);
    } catch (error) { text('#pricingMessage', `拉取失败：${error.message}。已有配置保持可用。`); }
    finally { button.disabled = false; button.textContent = '拉取 models.dev'; }
  });

  el('#savePricing').addEventListener('click', async () => {
    if (!state.pricingLoaded) return status('请先成功读取定价配置。');
    const button = el('#savePricing');
    button.disabled = true; button.textContent = '正在保存…';
    try {
      const pricing = {}, selections = {};
      for (const row of document.querySelectorAll('[data-price-model]')) {
        const mode = row.querySelector('[data-price-source]').value;
        if (mode !== 'manual') { if (mode !== 'auto') selections[row.dataset.priceModel] = mode; continue; }
        const values = Object.fromEntries([...row.querySelectorAll('[data-price-field]')].map(input => [input.dataset.priceField, input.value.trim()]));
        if (!values.input && !values.output) {
          if (values.cacheRead || values.cacheWrite) throw new Error(`${row.dataset.priceModel} 还需填写输入、输出单价`);
          continue;
        }
        if (!values.input || !values.output) throw new Error(`${row.dataset.priceModel} 的输入与输出单价均需填写`);
        const rule = { input: Number(values.input), output: Number(values.output), cacheRead: Number(values.cacheRead || values.input), cacheWrite: Number(values.cacheWrite || values.input) };
        if (Object.values(rule).some(value => !Number.isFinite(value) || value < 0)) throw new Error('单价必须是非负数字');
        pricing[row.dataset.priceModel] = rule;
      }
      const data = await api('/api/pricing', { pricing, selections });
      state.pricing = data.pricing;
      state.priceSelections = data.selections || {};
      text('#pricingMessage', `已保存 ${Object.keys(pricing).length} 个手动覆盖、${Object.keys(selections).length} 个指定来源；其他模型自动匹配 models.dev。仅影响新请求。`);
      status('参考定价已保存');
    } catch (error) { text('#pricingMessage', `保存失败：${error.message}`); }
    finally { button.disabled = false; button.textContent = '保存定价'; }
  });

  function requestRows(rows) {
    return rows.map(r => {
      const key = r.id || `legacy-${r.ts}-${r.model}`;
      details.set(key, r);
      const isError = failed(r);
      const freshInput = r.inputTokens != null && r.cachedTokens != null && r.cachedTokens <= r.inputTokens ? r.inputTokens - r.cachedTokens : null;
      const costLabel = r.costSource === 'estimated' ? `估算 · ${r.costPricing?.source === 'models.dev' ? 'models.dev' : '手动定价'}` : '上游上报';
      return `<tr><td class="log-time">${escape(time(r.ts))}<div class="subline">${r.stream ? '流式' : '非流式'}</div></td><td>${escape(r.account || '—')}</td><td>${escape(r.provider || '—')}</td><td><span class="model-name" title="${escape(r.model)}">${escape(shortModel(r.model))}</span></td><td class="numeric" title="完整输入 ${number(r.inputTokens)} Token">${number(freshInput)}</td><td class="numeric">${number(r.outputTokens)}</td><td class="numeric cache-number">${number(r.cachedTokens)}</td><td class="numeric">${number(r.cacheWriteTokens)}</td><td class="numeric cost-value" title="${r.costUsd == null ? '成本未上报，且无可用的完整定价估算' : costLabel}">${r.costSource === 'estimated' && r.costUsd != null ? '≈ ' : ''}${money(r.costUsd)}</td><td class="numeric"><span class="speed-number">${speed(r.tps)}</span>${r.tps != null ? '<small> tok/s</small>' : ''}</td><td class="numeric">${duration(r.ttftMs)}</td><td><span class="badge ${isError ? 'red' : 'green'}">${isError ? '×' : '✓'} ${r.status || (isError ? '失败' : '成功')}</span></td><td><button class="detail-button" data-detail="${escape(key)}" aria-label="查看 ${escape(shortModel(r.model))} 请求详情">↗</button></td></tr>`;
    }).join('');
  }

  function renderRecent() {
    details = new Map();
    const rows = filteredRequests(true);
    const page = paginate(rows, state.overviewPage);
    state.overviewPage = page.page;
    el('#recentBody').innerHTML = rows.length ? requestRows(page.rows) : '<tr><td colspan="13" class="empty">此范围暂无匹配请求。可调整筛选，或通过代理发起请求。</td></tr>';
    text('#overviewLogCount', `${number(rows.length)} 条匹配 · 每页 ${state.pageSize} 条`);
    text('#overviewPageInfo', rows.length ? `第 ${page.start + 1}—${page.end} 条 · 共 ${number(rows.length)} 条` : '0 条匹配记录');
    text('#overviewPageNumber', `${page.page} / ${page.pages}`);
    for (const id of ['#overviewFirst', '#overviewPrev']) el(id).disabled = page.page === 1;
    for (const id of ['#overviewNext', '#overviewLast']) el(id).disabled = page.page === page.pages;
    renderLive();
    if (state.historyLoaded) renderRequests();
  }

  function paginate(rows, requestedPage) {
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    const page = Math.max(1, Math.min(pages, requestedPage));
    const start = (page - 1) * state.pageSize;
    const end = Math.min(rows.length, start + state.pageSize);
    return { page, pages, start, end, rows: rows.slice(start, end) };
  }

  async function loadRequests(force = false) {
    if (historyLoading) return historyLoading;
    if (!force && state.historyLoaded && state.historyVersion === state.version) return;
    const version = state.version;
    historyLoading = (async () => {
      const data = await read('/api/history');
      state.history = data.history || [];
      state.historyVersion = version;
      state.historyLoaded = true;
      renderRecent();
    })();
    try { await historyLoading; } finally { historyLoading = null; }
  }

  function filteredRequests(overview = false) {
    const search = el(overview ? '#overviewSearch' : '#requestSearch').value.toLowerCase().trim();
    const status = el(overview ? '#overviewStatus' : '#requestStatus').value;
    const date = overview ? '' : el('#requestDate').value;
    const buckets = rangeBuckets();
    const start = buckets[0]?.ts ?? 0;
    const rows = state.historyLoaded ? state.history : state.recent;
    return rows.filter(r => A.matches(r, state.filters) && (!search || [r.model, r.provider, r.canonical, r.account, r.id].some(v => String(v || '').toLowerCase().includes(search))) && (status === 'all' || (status === 'error') === failed(r)) && (date ? dateKey(r.ts) === date : r.ts >= start && r.ts <= state.now)).sort((a, b) => {
      if (overview) return b.ts - a.ts;
      if (state.sort === 'speed') {
        if (a.tps == null) return b.tps == null ? b.ts - a.ts : 1;
        if (b.tps == null) return -1;
      }
      const delta = state.sort === 'speed' ? a.tps - b.tps : a.ts - b.ts;
      return state.descending ? -delta : delta;
    });
  }

  function renderRequests() {
    const rows = filteredRequests();
    const page = paginate(rows, state.page);
    state.page = page.page;
    el('#histBody').innerHTML = rows.length ? requestRows(page.rows) : '<tr><td colspan="13" class="empty">没有匹配的记录。可清除筛选，或通过代理发起新请求。</td></tr>';
    text('#requestCount', `${number(rows.length)} 条匹配 · 共 ${number(state.history.length)} 条保留记录`);
    text('#pageNumber', `${state.page} / ${page.pages}`);
    el('#prevPage').disabled = state.page === 1;
    el('#requestFirst').disabled = state.page === 1;
    el('#nextPage').disabled = state.page === page.pages;
    el('#requestLast').disabled = state.page === page.pages;
    for (const [id, sort] of [['#sortTime', 'time'], ['#sortSpeed', 'speed']]) {
      const active = state.sort === sort;
      text(id, `${sort === 'time' ? '时间' : '生成速度'} ${active ? state.descending ? '↓' : '↑' : '↕'}`);
      const th = el(id).closest('th');
      if (active) th.setAttribute('aria-sort', state.descending ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    }
  }

  function showDetail(key) {
    const r = details.get(key);
    if (!r) return;
    text('#detailTitle', shortModel(r.model));
    const item = (label, value, wide = false) => `<div${wide ? ' class="wide"' : ''}><dt>${label}</dt><dd>${escape(value)}</dd></div>`;
    el('#requestDetail').innerHTML = `<dl class="detail-grid">${[
      item('请求 ID', r.id || '旧记录未分配 ID', true), item('时间', new Date(r.ts).toLocaleString('zh-CN')), item('状态', failed(r) ? `失败 · ${r.status || '旧记录'}` : `成功 · ${r.status || 200}`),
      item('参考成本（USD）', money(r.costUsd)), item('成本来源', r.costSource === 'estimated' ? r.costPricing?.source === 'models.dev' ? '按请求发生时的 models.dev 目录价估算' : '按请求发生时的手动定价估算' : r.costSource === 'reported' ? '上游 usage.cost 上报' : '未上报／无完整可估算用量'),
      ...(r.costPricing ? [item('计价单价（USD / 百万 Token）', `输入 ${r.costPricing.input} / 输出 ${r.costPricing.output} / 缓存读 ${r.costPricing.cacheRead} / 缓存写 ${r.costPricing.cacheWrite} / 推理 ${r.costPricing.reasoning ?? r.costPricing.output}`, true)] : []),
      ...(r.costPricing?.source === 'models.dev' ? [item('报价供应商 / 模型', `${r.costPricing.provider} / ${r.costPricing.model}`, true), item('报价拉取时间', r.costPricing.fetchedAt ? new Date(r.costPricing.fetchedAt).toLocaleString('zh-CN') : '—'), item('目录记录更新时间', r.costPricing.updated || '—'), item('匹配方式', ({upstream:'实际渠道',selected:'用户指定来源','official-reference':'官方基准参考（非实际渠道报价）','single-reference':'单一来源参考'})[r.costPricing.match] || '—'), item('上下文价格档位', r.costPricing.aboveInputTokens != null ? `输入超过 ${number(r.costPricing.aboveInputTokens)} Token` : '基础档位')] : []),
      item('实际上游', r.provider || '—'), item('账号', r.account || '—'), item('实际模型', r.canonical || '—', true),
      item('输入 Token（含缓存）', number(r.inputTokens)), item('输出 Token', number(r.outputTokens)), item('总 Token', number(r.totalTokens)), item('缓存读取 Token', number(r.cachedTokens)), item('缓存写入 Token', number(r.cacheWriteTokens)), item('未命中输入 Token', r.cachedTokens != null && r.inputTokens != null && r.cachedTokens <= r.inputTokens ? number(r.inputTokens - r.cachedTokens) : '—'), item('输入命中占比', r.inputTokens > 0 && r.cachedTokens != null && r.cachedTokens <= r.inputTokens ? `${(r.cachedTokens / r.inputTokens * 100).toFixed(1)}%` : '—'), item('推理 Token（输出的子集）', number(r.reasoningTokens)), item('响应方式', r.stream ? '流式 SSE' : '非流式 JSON'),
      item('实际生成速度', r.tps == null ? '—（无用量或片段计时不足）' : `${speed(r.tps)} tok/s`), item('端到端吞吐', r.endToEndTps == null ? '—' : `${speed(r.endToEndTps)} tok/s`), item('首字延迟 TTFT', duration(r.ttftMs)), item('生成时长', duration(r.generationMs)), item('总耗时', duration(r.ms)),
    ].join('')}</dl>${r.error ? `<p class="error-detail">${escape(r.error)}</p>` : ''}<h3>上游尝试路径</h3><ol class="trace-list">${(r.trace || r.attempts || []).map((attempt, i) => typeof attempt === 'string' ? `<li>${i + 1}. ${escape(attempt)}</li>` : `<li>${i + 1}. ${escape(attempt.upstream || '自动选择')} <span class="badge ${attempt.status === 200 ? 'green' : 'red'}">HTTP ${number(attempt.status)}</span> · ${duration(attempt.ms)}${attempt.note ? `<p>${escape(attempt.note)}</p>` : ''}</li>`).join('') || '<li class="dim">此记录未提供逐次尝试信息。</li>'}</ol><p class="dim" style="font-size:var(--caption)">「—」表示上游未上报或旧记录不含此字段。Token 来自上游实际用量，速度基于流式片段到达代理的计时。</p>`;
    el('#requestDialog').showModal();
  }

  function filterDay(day) {
    el('#requestDate').value = day;
    state.page = 1;
    if (location.hash === '#requests') renderRequests();
    else location.hash = 'requests';
  }

  const viewInfo = {
    overview: ['用量统计', '用量统计', '追踪请求用量、缓存表现、实际生成速度与参考成本。'],
    requests: ['请求追踪', '请求追踪', '检查每次调用的用量、实际渠道、缓存与首字延迟。'],
    routing: ['模型路由', '让请求走向合适的上游。', '配置渠道优先级、故障转移与排除规则，随时验证实际命中。'],
    settings: ['账号与设置', '管理你的代理工作空间。', '账号池、客户端接入地址与访问密钥，在这里统一配置。'],
  };
  let managementLoaded = false;
  async function loadManagement() {
    if (managementLoaded) return;
    try {
      await loadAll();
      managementLoaded = true;
    } catch (error) { showError(error); }
  }
  function navigate(moveFocus = true) {
    const requested = location.hash.slice(1);
    state.view = Object.hasOwn(viewInfo, requested) ? requested : 'overview';
    const [label, heading, description] = viewInfo[state.view];
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== state.view; });
    document.querySelectorAll('[data-view]').forEach(link => {
      if (link.dataset.view === state.view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    text('#breadcrumb', label); text('#pageTitle', heading); text('#pageDescription', description);
    document.title = `${label} · Cline Pass`;
    el('#exportButton').hidden = state.view === 'routing' || state.view === 'settings';
    el('#usageFilters').hidden = !['overview', 'requests'].includes(state.view);
    if (!['overview', 'requests'].includes(state.view)) el('#coverageNote').hidden = true;
    else renderOverview();
    if (state.view === 'requests') loadRequests().catch(showError);
    if (state.view === 'routing' || state.view === 'settings') loadManagement();
    if (moveFocus) { el('#main').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
  }

  function csvCell(value) {
    let cell = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replace(/"/g, '""')}"`;
  }
  el('#exportButton').addEventListener('click', async () => {
    const button = el('#exportButton');
    const original = button.innerHTML;
    button.disabled = true; button.textContent = '正在导出…';
    try {
      await loadRequests(true);
      const rows = filteredRequests(state.view === 'overview');
      const columns = ['id', 'ts', 'model', 'account', 'provider', 'canonical', 'status', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd', 'costSource', 'pricingSource', 'pricingProvider', 'pricingModel', 'pricingFetchedAt', 'tps', 'endToEndTps', 'ttftMs', 'generationMs', 'ms', 'stream', 'error'];
      const pricingFields = { pricingSource:'source', pricingProvider:'provider', pricingModel:'model', pricingFetchedAt:'fetchedAt' };
      const csv = '\uFEFF' + [columns.map(csvCell).join(','), ...rows.map(r => columns.map(c => csvCell(c === 'ts' ? new Date(r.ts).toISOString() : pricingFields[c] ? r.costPricing?.[pricingFields[c]] : r[c])).join(','))].join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `cline-pass-requests-${dateKey(state.now)}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(`已导出 ${number(rows.length)} 条请求记录`);
    } catch (error) { showError(error); }
    finally { button.innerHTML = original; button.disabled = false; }
  });
  el('#refreshButton').addEventListener('click', async () => {
    const button = el('#refreshButton'); button.disabled = true;
    try {
      if (state.view === 'routing' || state.view === 'settings') { managementLoaded = false; await loadManagement(); }
      await window.refreshTelemetry();
      if (['overview', 'requests'].includes(state.view)) await loadRequests(true);
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
  });
  function applyUsageFilters() {
    state.filters.provider = el('#providerFilter').value;
    state.filters.model = el('#modelFilter').value;
    state.range = el('#usageRange').value;
    state.page = 1; state.overviewPage = 1; state.groupPage = 1;
    renderOverview(); renderRecent();
  }
  for (const id of ['#providerFilter', '#modelFilter', '#usageRange']) el(id).addEventListener('change', applyUsageFilters);
  el('#resetUsageFilters').addEventListener('click', () => { el('#providerFilter').value = ''; el('#modelFilter').value = ''; el('#usageRange').value = 'today'; applyUsageFilters(); });
  document.querySelectorAll('[data-trend]').forEach(button => button.addEventListener('click', () => {
    state.trend = button.dataset.trend;
    document.querySelectorAll('[data-trend]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    renderTrend(rangeBuckets(), A.sum(rangeBuckets()));
  }));
  document.querySelectorAll('[data-summary]').forEach(button => button.addEventListener('click', () => { state.summary = button.dataset.summary; state.groupPage = 1; renderSummary(); }));
  el('#groupSort').addEventListener('change', () => { state.groupPage = 1; renderGroups(); });
  el('#prevGroup').addEventListener('click', () => { state.groupPage--; renderGroups(); });
  el('#nextGroup').addEventListener('click', () => { state.groupPage++; renderGroups(); });
  for (const id of ['#overviewSearch', '#overviewStatus']) el(id).addEventListener('input', () => { state.overviewPage = 1; renderRecent(); });
  el('#heatMetric').addEventListener('change', renderHeatmap);
  for (const id of ['#requestSearch', '#requestStatus', '#requestDate']) el(id).addEventListener('input', () => { state.page = 1; renderRequests(); });
  el('#clearFilters').addEventListener('click', () => { el('#requestSearch').value = ''; el('#requestDate').value = ''; el('#requestStatus').value = 'all'; state.page = 1; renderRequests(); });
  function turnLogPage(overview, target) {
    const key = overview ? 'overviewPage' : 'page';
    state[key] = target;
    if (overview) renderRecent(); else renderRequests();
    el(overview ? '#recentBody' : '#histBody').closest('.table-wrap').scrollTop = 0;
  }
  el('#prevPage').addEventListener('click', () => turnLogPage(false, state.page - 1));
  el('#nextPage').addEventListener('click', () => turnLogPage(false, state.page + 1));
  el('#requestFirst').addEventListener('click', () => turnLogPage(false, 1));
  el('#requestLast').addEventListener('click', () => turnLogPage(false, Math.max(1, Math.ceil(filteredRequests().length / state.pageSize))));
  el('#overviewFirst').addEventListener('click', () => turnLogPage(true, 1));
  el('#overviewPrev').addEventListener('click', () => turnLogPage(true, state.overviewPage - 1));
  el('#overviewNext').addEventListener('click', () => turnLogPage(true, state.overviewPage + 1));
  el('#overviewLast').addEventListener('click', () => turnLogPage(true, Math.max(1, Math.ceil(filteredRequests(true).length / state.pageSize))));
  document.querySelectorAll('[data-page-size]').forEach(select => {
    select.value = String(state.pageSize);
    select.addEventListener('change', () => {
      const size = Number(select.value);
      if (![25,50,100,200].includes(size)) return;
      state.pageSize = size; state.overviewPage = 1; state.page = 1;
      localStorage.setItem('cps_page_size', String(size));
      document.querySelectorAll('[data-page-size]').forEach(control => { control.value = String(size); });
      renderRecent();
      el('#recentBody').closest('.table-wrap').scrollTop = 0;
      el('#histBody').closest('.table-wrap').scrollTop = 0;
    });
  });
  for (const [id, sort] of [['#sortTime', 'time'], ['#sortSpeed', 'speed']]) el(id).addEventListener('click', () => { state.descending = state.sort === sort ? !state.descending : true; state.sort = sort; state.page = 1; renderRequests(); });
  el('#autoRefresh').addEventListener('change', () => { if (el('#autoRefresh').checked) loadRequests(true).catch(showError); });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-detail]'); if (button) showDetail(button.dataset.detail);
    const group = event.target.closest('[data-group-key]');
    if (group) {
      el(group.dataset.groupBy === 'model' ? '#modelFilter' : '#providerFilter').value = group.dataset.groupKey;
      applyUsageFilters();
      el('#requestSearch').value = ''; el('#requestStatus').value = 'all'; el('#requestDate').value = '';
      location.hash = 'requests';
    }
  });
  function updateThemeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    text('#themeButton', dark ? '浅色' : '深色');
    el('#themeButton').setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题');
  }
  updateThemeButton();
  el('#themeButton').addEventListener('click', () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('cps_theme', document.documentElement.dataset.theme);
    updateThemeButton();
  });
  el('#sourceButton').addEventListener('click', () => {
    el('#sourceDetail').innerHTML = `<dl class="detail-grid"><div class="wide"><dt>数据来源</dt><dd>经本代理处理的真实请求与上游 usage；不读取其他应用的会话日志。</dd></div><div><dt>详细日志</dt><dd>最近 2,000 条</dd></div><div><dt>聚合留存</dt><dd>按日 366 天 / 按小时 32 天</dd></div><div><dt>当前同步</dt><dd>${escape(time(state.now))}</dd></div><div><dt>统计时区</dt><dd>UTC；日志显示本地时间</dd></div><div class="wide"><dt>参考成本</dt><dd>优先使用上游 usage.cost（USD），其次手动定价，再匹配 models.dev 供应商报价。估算保存请求发生时的单价与来源；报价不等于订阅扣费，无法完整估算时显示 —。</dd></div><div class="wide"><dt>缓存口径</dt><dd>读取和写入已计入完整输入，推理已计入输出。命中占比按同批已上报缓存明细的输入 Token 加权。</dd></div><div class="wide"><dt>统计完整性</dt><dd>未筛选总览沿用历史聚合；旧版本丢弃的请求无法补回模型／上游维度。分组覆盖不足时页面会标明。</dd></div></dl>`;
    el('#sourceDialog').showModal();
  });
  el('#requestDialog').addEventListener('click', event => { if (event.target === el('#requestDialog') && (event.offsetX < 0 || event.offsetX > event.target.clientWidth || event.offsetY < 0 || event.offsetY > event.target.clientHeight)) event.target.close(); });
  window.addEventListener('hashchange', () => navigate());
  window.addEventListener('unhandledrejection', event => { event.preventDefault(); status(event.reason?.message || '操作失败，请重试。'); });

  // Pause polls in background tabs, resume immediately when visible. No overlapping fetches.
  let pollTimer;
  function setRefreshInterval() {
    clearInterval(pollTimer);
    const seconds = Number(el('#refreshInterval').value);
    if (seconds) pollTimer = setInterval(() => { if (!document.hidden) window.refreshTelemetry(); }, seconds * 1000);
    localStorage.setItem('cps_refresh', String(seconds));
    renderLive();
  }
  const savedInterval = localStorage.getItem('cps_refresh');
  if (savedInterval != null && ['0', '2', '5', '10', '30'].includes(savedInterval)) el('#refreshInterval').value = savedInterval;
  setRefreshInterval();
  el('#refreshInterval').addEventListener('change', setRefreshInterval);
  setInterval(refreshLive, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) window.refreshTelemetry(); });
  for (const query of ['(max-width: 700px)', '(max-width: 1200px)']) matchMedia(query).addEventListener('change', renderHeatmap);
  (async () => {
    navigate(false);
    try {
      const meta = await read('/api/meta');
      el('#noKeyBanner').style.display = meta.configured ? 'none' : 'block';
      if (meta.authRequired && !AUTH_KEY) { showLogin(); return; }
      await window.refreshTelemetry();
    } catch (error) { showError(error); }
  })();
})();
