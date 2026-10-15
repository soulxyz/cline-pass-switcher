import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const DAY = 86400e3;
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const providerId = value => {
  const id = String(value || '').toLowerCase().replace(/\s+/g, '-');
  return ({ 'z-ai': 'zai', zhipuai: 'zai', 'z.ai': 'zai', 'open-router': 'openrouter', 'vercel-ai-gateway': 'vercel' })[id] || id;
};
const modelId = value => String(value || '').toLowerCase().replace(/^cline-pass\//, '').replace(/^(z-ai|zai)\//, 'zhipuai/');
const tail = value => modelId(value).split('/').at(-1);

function rates(cost) {
  if (!cost || !valid(cost.input) || !valid(cost.output)) return null;
  const result = { input: cost.input, output: cost.output };
  for (const [source, target] of [['cache_read', 'cacheRead'], ['cache_write', 'cacheWrite'], ['reasoning', 'reasoning']]) if (valid(cost[source])) result[target] = cost[source];
  return result;
}

export function parseModelsDev(data) {
  const result = [];
  for (const [pid, provider] of Object.entries(data || {})) {
    if (!provider || typeof provider.models !== 'object' || !provider.models) continue;
    for (const [id, model] of Object.entries(provider.models)) {
      if (!model || model.status === 'deprecated') continue;
      const price = rates(model.cost);
      if (!price) continue;
      const tiers = (Array.isArray(model.cost.tiers) ? model.cost.tiers : []).flatMap(band => {
        const bandRates = rates(band);
        return bandRates && band.tier?.type === 'context' && valid(band.tier.size) ? [{ ...bandRates, aboveInputTokens: band.tier.size }] : [];
      });
      const legacy = rates(model.cost.context_over_200k);
      if (!tiers.length && legacy) tiers.push({ ...legacy, aboveInputTokens: 200000 });
      result.push({
        key: JSON.stringify([pid, id]), provider: pid, providerName: provider.name || pid,
        model: id, canonical: model.canonical_model_id || '', name: model.name || id,
        updated: model.last_updated || null, price: { ...price, tiers: tiers.sort((a, b) => a.aboveInputTokens - b.aboveInputTokens) },
      });
    }
  }
  if (!result.length) throw new Error('models.dev 未返回有效的模型价格，已保留原缓存');
  return result;
}

async function downloadCatalog() {
  try {
    const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    // Windows PowerShell uses the OS network/proxy stack when Node's direct
    // connection is unavailable. Fixed public URL; no keys/prompts leave the app.
    const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; (Invoke-WebRequest -UseBasicParsing -Uri '${MODELS_DEV_URL}' -TimeoutSec 20).Content`;
    const modernShell = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
    const shell = fs.existsSync(modernShell) ? modernShell : 'powershell.exe';
    const { stdout } = await promisify(execFile)(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 25000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  }
}

export function createModelsDevStore(cachePath, { fetcher = downloadCatalog, now = Date.now } = {}) {
  let cache = { fetchedAt: 0, entries: [] }, pending = null, lastAttempt = 0, error = null;
  try {
    const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (saved.version === 1 && Array.isArray(saved.entries) && saved.entries.every(e => e && typeof e.key === 'string' && typeof e.model === 'string' && typeof e.provider === 'string' && rates(e.price))) cache = saved;
  } catch { /* A missing price cache does not prevent serving requests. */ }
  let index = new Map();
  function reindex() {
    index = new Map();
    for (const entry of cache.entries) for (const id of new Set([modelId(entry.model), modelId(entry.canonical), tail(entry.model), tail(entry.canonical)].filter(Boolean))) {
      const items = index.get(id) || []; items.push(entry); index.set(id, items);
    }
  }
  reindex();
  function candidates(model, canonical) {
    const exactCanonical = canonical && (index.get(modelId(canonical)) || []);
    const matches = exactCanonical?.length ? exactCanonical : index.get(modelId(model)) || index.get(tail(model)) || [];
    return matches.slice().sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  }
  function lookup(entry, selected) {
    const available = candidates(entry.model, entry.canonical);
    const canonicalIds = new Set(available.map(option => modelId(option.canonical)).filter(Boolean));
    const canonical = modelId(entry.canonical) || (canonicalIds.size === 1 ? [...canonicalIds][0] : null);
    const compact = options => {
      const exact = options.filter(option => tail(option.model) === tail(entry.model));
      return exact.length ? exact : options;
    };
    let chosen = null, match = null;
    if (selected) { chosen = available.find(option => option.key === selected); match = 'selected'; }
    else {
      const direct = compact(available.filter(option => providerId(option.provider) === providerId(entry.provider) && entry.provider));
      if (direct.length === 1) { chosen = direct[0]; match = 'upstream'; }
      else if (!direct.length && canonical?.includes('/')) {
        const official = compact(available.filter(option => providerId(option.provider) === providerId(canonical.split('/')[0])));
        if (official.length === 1) { chosen = official[0]; match = 'official-reference'; }
      }
      if (!chosen && !direct.length && available.length === 1) { chosen = available[0]; match = 'single-reference'; }
    }
    return chosen ? { ...chosen.price, source: 'models.dev', sourceKey: chosen.key, provider: chosen.provider, model: chosen.model, match, fetchedAt: cache.fetchedAt, updated: chosen.updated } : null;
  }
  async function refresh(force = false) {
    if (pending) return pending;
    if (!force && ((cache.entries.length && now() - cache.fetchedAt < DAY) || (lastAttempt && now() - lastAttempt < 5 * 60e3))) return status();
    lastAttempt = now();
    pending = (async () => {
      try {
        const entries = parseModelsDev(await fetcher());
        const next = { version: 1, fetchedAt: now(), entries };
        const tempPath = `${cachePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(next));
        fs.renameSync(tempPath, cachePath);
        cache = next; error = null; reindex();
      } catch (failure) { error = `价格库同步失败：${String(failure.message).slice(0, 240)}`; }
      finally { pending = null; }
      return status();
    })();
    return pending;
  }
  function status() {
    return { source: MODELS_DEV_URL, fetchedAt: cache.fetchedAt, count: cache.entries.length, stale: !cache.fetchedAt || now() - cache.fetchedAt >= DAY, syncing: !!pending, error };
  }
  return { refresh, status, candidates, lookup };
}
