
let DATA = null;
let AUTH_KEY = localStorage.getItem('cps_key') || '';
const $ = (s) => document.querySelector(s);
const fmt = (ts) => new Date(ts).toLocaleTimeString();

async function api(path, body) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (AUTH_KEY) headers['X-Admin-Key'] = AUTH_KEY;
  const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const value = await res.json();
  if (!res.ok) throw new Error(value.error?.message || value.error || `HTTP ${res.status}`);
  return value;
}

function showLogin() { $('#loginOverlay').style.display = 'flex'; setTimeout(() => $('#loginKey').focus(), 50); }
async function tryLogin() {
  const k = $('#loginKey').value.trim();
  if (!k) return;
  const res = await fetch('/api/config', { headers: { 'X-Admin-Key': k } });
  if (res.ok) {
    AUTH_KEY = k; localStorage.setItem('cps_key', k);
    $('#loginOverlay').style.display = 'none'; $('#loginErr').textContent = '';
    loadAll().catch((e) => status(e.message));
    window.refreshTelemetry?.();
  } else {
    $('#loginErr').textContent = '密钥错误，请重试';
  }
}

const ST_TAG = { ok: '✔可用', limited: '⏳限流', bad: '✘不可钉', auth: '密钥错误' };
const ST_RANK = { ok: 0, limited: 1, unknown: 2, auth: 3, bad: 4 };
const ST_CLS = { ok: 'ok', limited: 'limited', bad: 'bad', auth: 'auth' };

// 排序后的上游 slug 列表（按校验状态：可用优先），供面板与测试台共用
function sortedUpstreams(meta) {
  const stMap = (meta && meta.upstreamStatus) || {};
  return [...((meta && meta.upstreams) || [])].sort((a, b) => (ST_RANK[stMap[a]?.status] ?? 2) - (ST_RANK[stMap[b]?.status] ?? 2));
}

// 测试台仍用单选下拉（选中即作为唯一优先上游测试）
function upstreamOptions(meta, selected) {
  let html = '<option value="">自动（不指定上游）</option>';
  for (const u of sortedUpstreams(meta)) {
    const stMap = (meta && meta.upstreamStatus) || {};
    const detail = (meta && meta.upstreamDetail) || {};
    const d = detail[u];
    const st = stMap[u]?.status;
    const tag = st && ST_TAG[st] ? ' · ' + ST_TAG[st] : '';
    const label = d ? `${u}（${d.name}${d.endpoints > 1 ? ' ×' + d.endpoints : ''}${tag}）` : `${u}${tag}`;
    html += `<option value="${u}" ${u === selected ? 'selected' : ''}>${label}</option>`;
  }
  return html;
}

// 主表每行的上游优先级/排除面板：<details> 内逐行「优先 / 排除」药丸切换
// 状态存在 data-* 属性上，切换时原地更新（updateRowUi），不重建 DOM
function upstreamPanel(id, meta, cfg) {
  const ups = sortedUpstreams(meta);
  const stMap = (meta && meta.upstreamStatus) || {};
  const detail = (meta && meta.upstreamDetail) || {};
  const selected = cfg.upstreams || [];
  const excSet = new Set(cfg.exclude || []);
  const rows = ups.map((u) => {
    const d = detail[u];
    const st = stMap[u]?.status;
    const no = selected.indexOf(u);
    const isSel = no >= 0;
    const isEx = excSet.has(u);
    const stTxt = st && ST_TAG[st] ? ST_TAG[st] : '';
    const stCls = ST_CLS[st] || 'unknown';
    return `<div class="uprow${isEx ? ' excluded' : ''}" data-m="${id}" data-u="${u}" data-stat="${stTxt}" data-statcls="${stCls}">
      <span class="upno" title="优先级顺序（尝试顺序）">${no >= 0 ? no + 1 : ''}</span>
      <span class="upinfo"><span class="upslug mono">${u}</span><span class="upname" title="${d ? d.name : ''}">${d ? d.name : ''}${d && d.endpoints > 1 ? ' ×' + d.endpoints : ''}</span></span>
      <span class="upstat ${isEx ? 'excl' : stCls}">${isEx ? '已排除' : stTxt}</span>
      <button class="pill${isSel ? ' prio-on' : ''}" title="优先：加入尝试序列（异常自动顺切下一个）；再点一次取消" onclick="toggleUp('${id}','sel','${u}',${isSel ? 'false' : 'true'})">优先</button>
      <button class="pill${isEx ? ' excl-on' : ''}" title="排除：该上游永不被使用；再点一次取消" onclick="toggleUp('${id}','excl','${u}',${isEx ? 'false' : 'true'})">排除</button>
      <button class="ghost mini arrow-btn" style="${isSel ? '' : 'display:none'}" onclick="moveUp('${id}','${u}')" title="上移提高优先级">↑</button>
      <button class="ghost mini arrow-btn" style="${isSel ? '' : 'display:none'}" onclick="moveDown('${id}','${u}')" title="下移降低优先级">↓</button>
    </div>`;
  }).join('');
  return `<details class="ups-wrap">
    <summary><span class="ups-sum">${summaryChips(cfg)}</span></summary>
    <div class="ups-panel">${rows || '<div class="empty">尚未探测到上游，先点「探测」</div>'}
      <div class="ups-tools">
        <button class="ghost mini" onclick="bulkUp('${id}','all')" title="全部按可用状态排序加入优先序列">全选优先</button>
        <button class="ghost mini" onclick="bulkUp('${id}','clear')" title="清空优先与排除（回到自动）">清空</button>
        <span class="dim" style=" align-self:center;">点「优先」按序尝试（异常自动顺切）；点「排除」永不使用</span>
      </div>
    </div>
  </details>`;
}

// 收起状态下的汇总徽章：①fireworks ②sail-research ✕2
function summaryChips(cfg) {
  const ups = cfg.upstreams || [];
  const exc = cfg.exclude || [];
  if (!ups.length && !exc.length) return '<span class="sum-auto">自动 · 网关智能选择</span>';
  let html = '';
  for (let i = 0; i < Math.min(ups.length, 4); i++) html += `<span class="sum-chip">${i + 1}&nbsp;${ups[i]}</span>`;
  if (ups.length > 4) html += `<span class="sum-chip sum-more">+${ups.length - 4}</span>`;
  if (exc.length) html += `<span class="sum-chip sum-ex">✕ ${exc.length}</span>`;
  return html;
}

function render() {
  $('#proxyBase').textContent = '代理地址：' + DATA.proxyBase + '（点击复制）';
  const rows = DATA.subscription.map((s) => {
    const m = s.meta;
    const ups = (m?.upstreams?.length ?? null);
    const last = m?.lastProvider ? `<span class="badge">${m.lastProvider}</span>` : '<span class="dim">未探测</span>';
    const canon = m?.canonicalSlug ? `<span class="mono dim">${m.canonicalSlug}</span>` : '<span class="dim">—</span>';
    const tier0 = m?.tier0?.length ? `<div class="dim" style="">tier-0: ${m.tier0.join(', ')}</div>` : '';
    const pipe = m?.pinnable ? `<span class="badge green">可精确钉住·${m.pipeline === 'planner' ? 'Vercel' : 'OpenRouter'}</span>` : '<span class="badge orange">请先探测</span>';
    const mode = s.config.pinMode || 'strict';
    const sort = s.config.sort || '';
    return `<tr${LAST_ADDED.includes(s.id) ? ' class="row-new"' : ''} data-id="${s.id}">
      <td class="mono">${s.id}<div style="margin-top:4px">${pipe}</div>${tier0}</td>
      <td>${canon}</td>
      <td>${ups === null ? '<span class="dim">—</span>' : ups}</td>
      <td>${last}${m?.lastMs ? `<div class="dim" style="">${m.lastMs} ms</div>` : ''}</td>
      <td>
        ${upstreamPanel(s.id, m, s.config)}
      </td>
      <td>
        <div><select onchange="saveCfg('${s.id}','pinMode',this.value)" title="严格：逐个只钉勾选的上游；优先：当前上游排 order 首位，其余勾选项作为网关侧回退">
          <option value="strict" ${mode === 'strict' ? 'selected' : ''}>严格钉住</option>
          <option value="preferred" ${mode === 'preferred' ? 'selected' : ''}>优先+回退</option>
        </select></div>
        <select onchange="saveCfg('${s.id}','sort',this.value)" style="margin-top:4px" title="按指标排序上游（不选上游时也可单独使用）">
          <option value="" ${!sort ? 'selected' : ''}>网关智能选</option>
          <option value="cost" ${sort === 'cost' ? 'selected' : ''}>最低成本</option>
          <option value="ttft" ${sort === 'ttft' ? 'selected' : ''}>最快首字</option>
          <option value="tps" ${sort === 'tps' ? 'selected' : ''}>最高吞吐</option>
        </select>
      </td>
      <td><div class="row-actions">
        <button class="ghost" onclick="probe('${s.id}', this)">探测</button>
        <button class="ghost" onclick="test('${s.id}', this)">测试</button>
        <button class="ghost" onclick="validate('${s.id}', this)" title="把每个上游渠道各钉一次最小请求，标出可用/限流/不可钉">校验</button>
      </div></td>
    </tr>`;
  }).join('');
  $('#subBody').innerHTML = rows;

  $('#testModel').innerHTML = DATA.subscription.map((s) => `<option value="${s.id}">${s.id}</option>`).join('');
  onTestModelChange();

  $('#catSummary').textContent = `展开（共 ${DATA.catalogCount} 个目录模型）`;
  const of = DATA.officialFetch;
  $('#officialInfo').textContent = of ? `上次拉取 ${new Date(of.ts).toLocaleString()}（${(of.sources || []).join('+')}，新增 ${of.added.length}）` : '尚未拉取过官方清单';
  renderCatalog();

  loadHistory().catch((e) => status(e.message));
}

function renderCatalog() {
  const f = ($('#catFilter').value || '').toLowerCase();
  const list = DATA.catalog.filter((id) => !f || id.toLowerCase().includes(f)).slice(0, 400);
  $('#catBody').innerHTML = list.map((id) => {
    const m = DATA.subscription.find((s) => s.id === id)?.meta;
    const pinnable = id.includes(':free');
    return `<tr><td class="mono">${id}</td><td>${pinnable ? '<span class="badge green">:free 可精确钉住</span>' : '<span class="badge orange">规划器管理</span>'}</td>
    <td>${m?.lastProvider ? '<span class="badge">' + m.lastProvider + '</span>' : ''}</td>
    <td><button class="ghost" onclick="probe('${id}', this)">探测</button></td></tr>`;
  }).join('') || '<tr><td class="empty">无匹配</td></tr>';
}

async function loadAll() {
  const [models, accs, sec, meta] = await Promise.all([api('/api/models'), api('/api/accounts'), api('/api/security'), api('/api/meta')]);
  DATA = models;
  ACCS = accs;
  render();
  renderAccounts();
  renderSecurity(sec);
  $('#noKeyBanner').style.display = meta.configured ? 'none' : 'block';
}

function renderSecurity(sec) {
  $('#secProxyKey').value = sec.proxyKey || '';
  $('#secPublicBase').value = sec.publicBaseUrl || '';
  const badge = $('#secBadge');
  badge.textContent = sec.authRequired ? '鉴权已开启' : '鉴权已关闭';
  badge.className = sec.authRequired ? 'badge green' : 'badge orange';
  const ec = $('#exposeCatalog');
  if (ec) ec.checked = !!sec.exposeCatalog;
}

async function saveExposeCatalog(v) {
  const r = await api('/api/security', { exposeCatalog: v });
  if (r.ok) secMsg(v ? '已开启：/v1/models 将包含全部目录模型' : '已关闭：/v1/models 仅返回订阅模型');
  else secMsg(r.error?.message || '保存失败', true);
}

async function saveSecurity() {
  const payload = {
    proxyKey: $('#secProxyKey').value.trim(),
    publicBaseUrl: $('#secPublicBase').value.trim(),
  };
  const r = await api('/api/security', payload);
  if (r.ok) {
    // 控制台鉴权与代理密钥同源：改完立即换新密钥，避免会话失效
    AUTH_KEY = r.proxyKey || ''; localStorage.setItem('cps_key', AUTH_KEY);
    renderSecurity(r);
    DATA.proxyBase = r.proxyBase;
    $('#proxyBase').textContent = '代理地址：' + r.proxyBase + '（点击复制）';
    secMsg('已保存' + (r.authRequired ? '，鉴权开启' : '，鉴权已关闭（任何客户端都可访问代理）'));
  } else secMsg(r.error?.message || '保存失败', true);
}

function secMsg(msg, isErr) {
  const el = $('#secMsg');
  el.textContent = msg;
  el.style.color = isErr ? 'var(--red)' : 'var(--green)';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 8000);
}

async function probe(id, btn) {
  btn.disabled = true; btn.textContent = '探测中…'; status('正在探测 ' + id);
  try {
    const r = await api('/api/probe', { model: id });
    status(r.ok ? `${id} 探测完成：上游 ${r.upstreams?.length ?? 0} 个，命中 ${r.lastProvider}` : `探测失败：${r.error}`);
    await loadAll();
  } catch (e) { status(`探测失败：${e.message}`); }
  finally { btn.disabled = false; btn.textContent = '探测'; }
}

async function probeAll() {
  const btn = $('#probeAllBtn'); btn.disabled = true;
  try {
    let failures = 0;
    for (const s of DATA.subscription) {
      btn.textContent = `探测中 ${s.id}`;
      try { await api('/api/probe', { model: s.id }); } catch { failures++; }
    }
    await loadAll();
    status(`探测完成${failures ? `，${failures} 个模型暂未成功` : ''}`);
  } catch (e) { status(e.message); }
  finally { btn.disabled = false; btn.textContent = '批量探测'; }
}

async function test(id, btn) {
  btn.disabled = true; btn.textContent = '测试中…';
  // 读取该行面板的当前状态（药丸按钮的选中态）
  const tr = btn.closest('tr');
  const sel = [...tr.querySelectorAll('.uprow')].filter((r) => r.querySelector('.pill.prio-on')).map((r) => r.dataset.u);
  const excl = [...tr.querySelectorAll('.uprow')].filter((r) => r.querySelector('.pill.excl-on')).map((r) => r.dataset.u);
  const body = { model: id };
  if (sel.length || excl.length || tr.querySelector('.uprow')) { body.upstreams = sel; body.exclude = excl; }
  try { showTest(await api('/api/test', body), id, sel); }
  catch (e) { status(`测试失败：${e.message}`); }
  finally { btn.disabled = false; btn.textContent = '测试'; }
}

let LAST_ADDED = [];
async function fetchOfficial(btn) {
  btn.disabled = true; btn.textContent = '拉取中…';
  const el = $('#fetchResult');
  try {
    const r = await api('/api/fetch-official-models', {});
    LAST_ADDED = r.added || [];
    el.style.display = 'block';
    el.innerHTML = `<div class="kvs">
      <div>拉取时间 <b>${new Date().toLocaleTimeString()}</b></div>
      <div>来源 <b>${r.sources.join(' + ') || '无可用来源'}</b></div>
      <div>官方清单 <b>${r.found} 个</b></div>
      <div>新增 <b class="${r.added.length ? 'match' : 'dim'}">${r.added.length} 个</b></div>
      <div>合并后 <b>${r.knownModels.length} 个</b></div>
    </div>${r.added.length ? '✔ 检测到新模型，已加入下方列表并高亮显示：' + r.added.join('、') : '✔ 清单已是最新：官方渠道 ' + r.found + ' 个模型均已覆盖，现有 ' + r.knownModels.length + ' 个订阅模型保持不变。'}`;
    await loadAll();
    setTimeout(() => { LAST_ADDED = []; }, 6000);
  } catch (e) {
    el.style.display = 'block';
    el.innerHTML = '<span class="mismatch">拉取失败，请稍后重试</span>';
  }
  btn.disabled = false; btn.textContent = '拉取官方模型';
}

async function validate(id, btn) {
  btn.disabled = true; btn.textContent = '校验中…';
  status(`正在校验 ${id} 的全部上游渠道（约需 1 分钟）…`);
  try {
    const r = await api('/api/validate-upstreams', { model: id });
    status(`校验完成：✔可用 ${r.summary.ok} · ⏳限流 ${r.summary.limited} · ✘不可钉 ${r.summary.bad} · 🔑key错 ${r.summary.auth} · 未判定 ${r.summary.unknown}（下拉框已标注并排序）`);
  } catch (e) {
    status('校验失败');
  }
  btn.disabled = false; btn.textContent = '校验';
  await loadAll();
}

async function runTest() {
  const btn = $('#testBtn'); btn.disabled = true; btn.textContent = '发送中…';
  const model = $('#testModel').value, up = $('#testUpstream').value || null;
  try { showTest(await api('/api/test', { model, upstreams: up ? [up] : [] }), model, up ? [up] : []); }
  catch (e) { status(`测试失败：${e.message}`); }
  finally { btn.disabled = false; btn.textContent = '发送测试'; }
}

function onTestModelChange() {
  const m = DATA.subscription.find((s) => s.id === $('#testModel').value);
  $('#testUpstream').innerHTML = upstreamOptions(m?.meta, null);
}

// 逐次尝试明细：fireworks(✗429 781ms) → sail-research(✔ 2458ms)
function traceHtml(trace) {
  if (!trace?.length) return '';
  const parts = trace.map((t) => `<span class="tr ${t.status === 200 ? 'ok' : 'bad'}">${t.upstream || 'auto'}(${t.status === 200 ? '✔' : '✗' + t.status} ${t.ms}ms${t.note && t.status !== 200 && t.note !== 'ok' ? ' · ' + escapeHtml(String(t.note).slice(0, 60)) : ''})</span>`);
  return `<div class="trace">尝试序列：${parts.join(' → ')}</div>`;
}

function showTest(r, model, target) {
  const el = $('#testResult'); el.style.display = 'block';
  const targets = Array.isArray(target) ? target : target ? [target] : [];
  if (!r.ok) {
    el.innerHTML = `<span class="mismatch">请求失败：${escapeHtml(r.error || '')}</span>${traceHtml(r.trace)}`;
    return;
  }
  const hit = !targets.length || r.actual === targets[0];
  const hitExcluded = Array.isArray(r.exclude) && r.exclude.length && r.exclude.includes(r.actual);
  el.innerHTML = `<div class="kvs">
      <div>模型 <b class="mono">${model}</b></div>
      <div>目标上游 <b>${targets.length ? targets.join(' → ') : '自动'}</b></div>
      <div>实际上游 <b class="${hit && !hitExcluded ? 'match' : 'mismatch'}">${r.actual || '未知'}</b></div>
      <div>耗时 <b>${r.ms} ms</b></div>
    </div>${traceHtml(r.trace)}
    ${hitExcluded ? `<div class="mismatch">⚠ 排除未生效：命中了被排除的上游 ${r.actual}（该渠道可能不在本地已知清单内，或网关未遵守白名单；先点「探测」刷新渠道列表再试）</div>` : hit ? '✔ 上游匹配，选择已生效。' : (r.actual ? '✘ 未命中首个目标上游：渠道可能限流或不可钉（点「校验」检查全部渠道）；严格模式失败会直接报错，可改用「优先+回退」。' : '该模型响应未携带上游信息，无法回读实际上游。')}
    <div class="dim" style="margin-top:6px">回复：${escapeHtml(r.content || '(空)')}　·　背后模型：${r.canonicalSlug || '—'}　·　管道：${r.pipeline === 'direct' ? '直连(OpenRouter)' : r.pipeline === 'planner' ? '规划器(Vercel)' : '未知'}</div>`;
}

// —— perModel 配置保存：POST 完整字段（upstreams + exclude 一起），UI 由调用方乐观更新 ——
async function saveModelCfg(id, patch) {
  const s = DATA.subscription.find((x) => x.id === id);
  if (!s) return;
  const cfg = s.config;
  const full = {
    upstreams: patch.upstreams !== undefined ? patch.upstreams : (cfg.upstreams || []),
    exclude: patch.exclude !== undefined ? patch.exclude : (cfg.exclude || []),
    pinMode: patch.pinMode !== undefined ? patch.pinMode : (cfg.pinMode || 'strict'),
    sort: patch.sort !== undefined ? patch.sort : (cfg.sort || null),
  };
  try {
    const r = await api('/api/config', { perModel: { [id]: full } });
    if (r.ok) {
      cfg.upstreams = full.upstreams; cfg.exclude = full.exclude; cfg.pinMode = full.pinMode; cfg.sort = full.sort;
      status(`${id} 配置已保存`);
    } else {
      status(`${id} 保存失败：${r.error?.message || '未知错误'}`);
      await loadAll();
    }
  } catch {
    await loadAll();
  }
}

// 下拉框保存入口（模式/排序）
async function saveCfg(id, field, value) {
  const patch = {};
  if (field === 'pinMode') patch.pinMode = value || 'strict';
  else if (field === 'sort') patch.sort = value || null;
  await saveModelCfg(id, patch);
}

// 面板行内更新：只改 class / 文本 / onclick，绝不重建 DOM —— 面板保持展开、滚动位置不变
function updateRowUi(id) {
  const s = DATA.subscription.find((x) => x.id === id);
  if (!s) return;
  const cfg = s.config;
  const selected = cfg.upstreams || [];
  const excSet = new Set(cfg.exclude || []);
  const tr = document.querySelector(`#subBody tr[data-id="${id}"]`);
  if (!tr) return render();
  tr.querySelectorAll('.uprow').forEach((row) => {
    const u = row.dataset.u;
    const no = selected.indexOf(u);
    const isEx = excSet.has(u);
    const pills = row.querySelectorAll('.pill');
    if (pills[0]) {
      pills[0].classList.toggle('prio-on', no >= 0);
      pills[0].setAttribute('onclick', `toggleUp('${id}','sel','${u}',${no >= 0 ? 'false' : 'true'})`);
    }
    if (pills[1]) {
      pills[1].classList.toggle('excl-on', isEx);
      pills[1].setAttribute('onclick', `toggleUp('${id}','excl','${u}',${isEx ? 'false' : 'true'})`);
    }
    row.classList.toggle('excluded', isEx);
    row.querySelector('.upno').textContent = no >= 0 ? String(no + 1) : '';
    row.querySelectorAll('.arrow-btn').forEach((b) => { b.style.display = no >= 0 ? '' : 'none'; });
    const stat = row.querySelector('.upstat');
    if (isEx) { stat.textContent = '已排除'; stat.className = 'upstat excl'; }
    else { stat.textContent = row.dataset.stat || ''; stat.className = 'upstat ' + (row.dataset.statcls || 'unknown'); }
  });
  const sum = tr.querySelector('.ups-sum');
  if (sum) sum.innerHTML = summaryChips(cfg);
  const selects = tr.cells[5].querySelectorAll('select');
  if (selects[0]) selects[0].value = cfg.pinMode || 'strict';
  if (selects[1]) selects[1].value = cfg.sort || '';
}

// 面板药丸切换：kind='sel' 优先 | 'excl' 排除（互斥）。乐观更新 + 保存（失败自动回滚）
function toggleUp(id, kind, u, on) {
  const s = DATA.subscription.find((x) => x.id === id);
  if (!s) return;
  const cfg = s.config;
  let ups = [...(cfg.upstreams || [])];
  let exc = [...(cfg.exclude || [])];
  if (kind === 'sel') {
    if (on) { if (!ups.includes(u)) ups.push(u); exc = exc.filter((x) => x !== u); }
    else ups = ups.filter((x) => x !== u);
  } else {
    if (on) { if (!exc.includes(u)) exc.push(u); ups = ups.filter((x) => x !== u); }
    else exc = exc.filter((x) => x !== u);
  }
  cfg.upstreams = ups; cfg.exclude = exc;
  updateRowUi(id);
  saveModelCfg(id, { upstreams: ups, exclude: exc });
}

// 调整优先顺序（乐观更新 + 保存）
function moveUpDown(id, u, dir) {
  const s = DATA.subscription.find((x) => x.id === id);
  if (!s) return;
  const ups = [...(s.config.upstreams || [])];
  const i = ups.indexOf(u);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ups.length) return;
  [ups[i], ups[j]] = [ups[j], ups[i]];
  s.config.upstreams = ups;
  updateRowUi(id);
  saveModelCfg(id, { upstreams: ups });
}
const moveUp = (id, u) => moveUpDown(id, u, -1);
const moveDown = (id, u) => moveUpDown(id, u, 1);

// 批量：'all'=按可用状态排序全部加入优先；'clear'=清空优先与排除（回到自动）
function bulkUp(id, action) {
  const s = DATA.subscription.find((x) => x.id === id);
  if (!s) return;
  if (action === 'all') {
    const ups = sortedUpstreams(s.meta).filter((u) => !(s.config.exclude || []).includes(u));
    s.config.upstreams = ups;
    updateRowUi(id);
    saveModelCfg(id, { upstreams: ups });
  } else {
    s.config.upstreams = []; s.config.exclude = [];
    updateRowUi(id);
    saveModelCfg(id, { upstreams: [], exclude: [] });
  }
}

async function loadHistory() {
  if (window.refreshTelemetry) await window.refreshTelemetry();
}

let ACCS = null;
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function renderAccounts() {
  if (!ACCS) return;
  $('#accMode').value = ACCS.mode;
  const show = $('#accShowKeys').checked;
  const rows = ACCS.accounts.map((a, i) => {
    const st = (ACCS.stats || {})[a.name] || {};
    const checked = ACCS.mode === 'single' && i === ACCS.active;
    return `<tr>
      <td><input type="radio" name="accActive" data-i="${i}" ${checked ? 'checked' : ''} ${ACCS.mode !== 'single' ? 'disabled title="轮询模式下按顺序轮流使用"' : 'title="单账号模式下使用此账号"'}></td>
      <td><input class="accName" data-i="${i}" value="${escapeHtml(a.name)}" style="width:110px; background:var(--card2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 8px; "></td>
      <td><input class="accKey" data-i="${i}" type="${show ? 'text' : 'password'}" value="${escapeHtml(a.key)}" style="width:100%; min-width:280px; background:var(--card2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 8px; font-family:Consolas, monospace; "></td>
      <td><input type="checkbox" class="accEnabled" data-i="${i}" ${a.enabled !== false ? 'checked' : ''}></td>
      <td>${st.requests ?? 0}${st.lastError ? '<div class="mismatch" style="">最近有错误</div>' : ''}</td>
      <td class="dim" style="">${st.lastUsed ? fmt(st.lastUsed) : '—'}</td>
      <td><div class="row-actions">
        <button class="ghost" onclick="testAccount(${i}, this)">测试</button>
        <button class="ghost" onclick="delAccount(${i})">删除</button>
      </div></td>
    </tr>`;
  }).join('');
  $('#accBody').innerHTML = rows || '<tr><td colspan="7" class="empty">暂无账号，点击「＋ 添加账号」</td></tr>';
}

// 把 DOM 里当前编辑值收回 ACCS（避免重渲染丢输入）
function collectAccounts() {
  const mode = $('#accMode').value;
  const accs = ACCS.accounts.map((a, i) => ({
    name: document.querySelector(`.accName[data-i="${i}"]`)?.value?.trim() || a.name,
    key: document.querySelector(`.accKey[data-i="${i}"]`)?.value?.trim() || '',
    enabled: document.querySelector(`.accEnabled[data-i="${i}"]`)?.checked !== false,
  }));
  const checked = document.querySelector('input[name="accActive"]:checked');
  const active = checked ? parseInt(checked.dataset.i) : Math.min(ACCS.active ?? 0, Math.max(0, accs.length - 1));
  return { accounts: accs, mode, active };
}

async function saveAccounts() {
  const payload = collectAccounts();
  if (!payload.accounts.filter((a) => a.key).length) { accMsg('至少需要一个 key 非空的账号', true); return; }
  const r = await api('/api/accounts', payload);
  if (r.ok) { accMsg(`已保存：${r.accounts} 个账号 · ${r.mode === 'roundrobin' ? '轮询' : '单账号'}模式`); await loadAll(); }
  else accMsg(r.error?.message || '保存失败', true);
}

function addAccountRow() {
  const cur = collectAccounts();
  cur.accounts.push({ name: `账号${cur.accounts.length + 1}`, key: '', enabled: true });
  ACCS.accounts = cur.accounts; ACCS.mode = cur.mode; ACCS.active = cur.active;
  renderAccounts();
  const last = document.querySelectorAll('.accKey');
  if (last.length) last[last.length - 1].focus();
}

function delAccount(i) {
  const cur = collectAccounts();
  cur.accounts.splice(i, 1);
  ACCS.accounts = cur.accounts; ACCS.mode = cur.mode; ACCS.active = Math.min(cur.active, Math.max(0, cur.accounts.length - 1));
  renderAccounts();
}

async function testAccount(i, btn) {
  collectAccounts();
  const acc = ACCS.accounts[i];
  if (!acc.key) { accMsg('请先填写该账号的 key', true); return; }
  btn.disabled = true; btn.textContent = '测试中…'; accMsg(`正在测试 ${acc.name} …`);
  try {
    const r = await api('/api/accounts/test', { key: acc.key });
    accMsg(r.ok ? `✔ ${acc.name} 可用（${r.ms} ms）${r.note ? ' · ' + r.note : ''}` : `✘ ${acc.name} 不可用：${r.error}`, !r.ok);
  } catch (e) { accMsg(e.message, true); }
  finally { btn.disabled = false; btn.textContent = '测试'; }
}

function toggleKeyVis() {
  const show = $('#accShowKeys').checked;
  document.querySelectorAll('.accKey').forEach((el) => { el.type = show ? 'text' : 'password'; });
}

function accMsg(msg, isErr) {
  const el = $('#accMsg');
  el.textContent = msg;
  el.style.color = isErr ? 'var(--red)' : 'var(--green)';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 8000);
}

let statusTimer;
function status(msg) { $('#status').textContent = msg; clearTimeout(statusTimer); statusTimer = setTimeout(() => $('#status').textContent = '', 6000); }

$('#proxyBase').onclick = async () => {
  if (!DATA?.proxyBase) return status('代理地址尚未加载，请稍后重试。');
  try { await navigator.clipboard.writeText(DATA.proxyBase); status('已复制代理地址'); }
  catch { status('浏览器未允许复制，请手动复制上方地址。'); }
};
$('#testModel').addEventListener('change', onTestModelChange);
$('#catFilter').addEventListener('input', renderCatalog);
$('#loginKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
