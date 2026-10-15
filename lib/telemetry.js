import { StringDecoder } from 'node:string_decoder';

const count = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeUsage(usage) {
  const cachedTokens = count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.cache_read_input_tokens);
  const cacheWriteTokens = count(usage?.prompt_tokens_details?.cache_write_tokens ?? usage?.input_tokens_details?.cache_write_tokens ?? usage?.cache_creation_input_tokens);
  let inputTokens = count(usage?.prompt_tokens ?? usage?.input_tokens);
  // Native Anthropic input_tokens excludes cache reads/writes. OpenAI-compatible
  // prompt_tokens and Responses input_tokens_details already include them.
  const separateCacheInput = usage?.prompt_tokens == null && usage?.input_tokens_details == null && (usage?.cache_read_input_tokens != null || usage?.cache_creation_input_tokens != null);
  if (separateCacheInput && inputTokens !== null) inputTokens += (cachedTokens ?? 0) + (cacheWriteTokens ?? 0);
  const outputTokens = count(usage?.completion_tokens ?? usage?.output_tokens);
  return {
    inputTokens, outputTokens,
    totalTokens: count(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cachedTokens, cacheWriteTokens,
    costUsd: count(usage?.cost_currency && usage.cost_currency !== 'USD' ? null : usage?.cost),
    costSource: count(usage?.cost_currency && usage.cost_currency !== 'USD' ? null : usage?.cost) !== null ? 'reported' : null,
    reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens),
  };
}

// Cache ratios only pair a reported cache-read count with that same request's
// complete input count. Missing cache fields must never dilute the denominator.
export function accumulateCacheUsage(bucket, entry) {
  for (const key of ['cachedTokens', 'cacheWriteTokens', 'cacheReadRequests', 'cacheWriteRequests', 'cacheInputTokens', 'cacheReadTokensForRate', 'cacheRateRequests', 'reasoningTokens', 'reasoningRequests']) bucket[key] ??= 0;
  if (entry.cachedTokens != null) { bucket.cachedTokens += entry.cachedTokens; bucket.cacheReadRequests++; }
  if (entry.cacheWriteTokens != null) { bucket.cacheWriteTokens += entry.cacheWriteTokens; bucket.cacheWriteRequests++; }
  if (entry.reasoningTokens != null) { bucket.reasoningTokens += entry.reasoningTokens; bucket.reasoningRequests++; }
  if (entry.cachedTokens != null && entry.inputTokens != null && entry.cachedTokens <= entry.inputTokens) {
    bucket.cacheInputTokens += entry.inputTokens;
    bucket.cacheReadTokensForRate += entry.cachedTokens;
    bucket.cacheRateRequests++;
  }
}

// Observe SSE without buffering response content or changing the bytes sent to clients.
// Token counts come exclusively from upstream usage; chunks/characters are never tokens.
export class StreamObserver {
  constructor(startedAt) {
    this.startedAt = startedAt;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.usage = normalizeUsage(null);
    this.rawUsage = {};
    this.firstTokenAt = null;
    this.lastTokenAt = null;
    this.liveTps = null;
    this.usageUpdatedAt = null;
    this.provider = null;
    this.canonical = null;
    this.error = null;
    this.done = false;
    this.finished = false;
  }
  push(chunk, now = Date.now()) {
    this.pending += this.decoder.write(chunk);
    this.drain(now);
  }
  drain(now) {
    let newline;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      this.line(line, now);
    }
    // A malformed event must not grow memory without bound.
    if (this.pending.length > 2 * 1024 * 1024) this.pending = '';
  }
  line(line, now) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { this.done = true; return; }
    let value;
    try { value = JSON.parse(data); } catch { return; }
    const d = value.data?.choices || value.data?.usage ? value.data : value;
    if (d.usage) {
      const previous = this.rawUsage;
      this.rawUsage = { ...previous, ...d.usage };
      for (const field of ['prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details', 'output_tokens_details']) {
        if (d.usage[field]) this.rawUsage[field] = { ...previous[field], ...d.usage[field] };
      }
      this.usage = normalizeUsage(this.rawUsage);
    }
    if (d.error) this.error = typeof d.error === 'string' ? d.error : d.error.message || '上游流式错误';
    const choice = d.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content || delta?.reasoning_content || delta?.reasoning || delta?.tool_calls?.length) {
      this.firstTokenAt ??= now;
      this.lastTokenAt = now;
    }
    if (d.usage && count(d.usage.completion_tokens ?? d.usage.output_tokens) !== null) {
      const elapsed = this.firstTokenAt !== null && this.lastTokenAt > this.firstTokenAt ? this.lastTokenAt - this.firstTokenAt : null;
      this.liveTps = elapsed ? this.usage.outputTokens / (elapsed / 1000) : null;
      this.usageUpdatedAt = now;
    }
    if (choice?.finish_reason) this.finished = true;
    const route = d.provider_metadata?.gateway?.routing || delta?.provider_metadata?.gateway?.routing || choice?.message?.provider_metadata?.gateway?.routing;
    if (route?.finalProvider) this.provider = route.finalProvider;
    else if (typeof d.provider === 'string') this.provider = d.provider.toLowerCase().replace(/\s+/g, '-');
    if (route?.canonicalSlug) this.canonical = route.canonicalSlug;
    else if (typeof d.model === 'string') this.canonical = d.model;
  }
  end(now = Date.now()) {
    this.pending += this.decoder.end();
    this.drain(now);
    if (this.pending) this.line(this.pending, now);
    this.pending = '';
  }
  metrics(now = Date.now()) {
    const ms = Math.max(0, now - this.startedAt);
    const generationMs = this.firstTokenAt !== null && this.lastTokenAt > this.firstTokenAt ? this.lastTokenAt - this.firstTokenAt : null;
    return {
      ...this.usage, ms,
      liveTps: this.liveTps, usageUpdatedAt: this.usageUpdatedAt,
      ttftMs: this.firstTokenAt !== null ? this.firstTokenAt - this.startedAt : null,
      generationMs,
      tps: generationMs && this.usage.outputTokens !== null ? this.usage.outputTokens / (generationMs / 1000) : null,
      endToEndTps: ms > 0 && this.usage.outputTokens !== null ? this.usage.outputTokens / (ms / 1000) : null,
    };
  }
}

export function accumulateCostUsage(bucket, entry) {
  for (const field of ['costUsd', 'costRequests', 'reportedCostRequests', 'estimatedCostRequests']) bucket[field] ??= 0;
  if (typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) && entry.costUsd >= 0) {
    bucket.costUsd += entry.costUsd;
    bucket.costRequests++;
    bucket[entry.costSource === 'estimated' ? 'estimatedCostRequests' : 'reportedCostRequests']++;
  }
}

function accumulateBucket(bucket, entry) {
  for (const key of ['requests', 'errors', 'inputTokens', 'outputTokens', 'totalTokens', 'usageRequests', 'durationMs', 'ttftSum', 'ttftCount', 'generationMs', 'generatedTokens', 'speedCount']) bucket[key] ??= 0;
  accumulateCacheUsage(bucket, entry);
  accumulateCostUsage(bucket, entry);
  bucket.requests++;
  bucket.errors += entry.error || entry.status >= 400 ? 1 : 0;
  bucket.inputTokens += entry.inputTokens ?? 0;
  bucket.outputTokens += entry.outputTokens ?? 0;
  bucket.totalTokens += entry.totalTokens ?? 0;
  bucket.usageRequests += entry.totalTokens != null ? 1 : 0;
  bucket.durationMs += entry.ms || 0;
  if (entry.ttftMs != null) { bucket.ttftSum += entry.ttftMs; bucket.ttftCount++; }
  if (entry.tps != null && !entry.error && !(entry.status >= 400)) {
    bucket.generatedTokens += entry.outputTokens;
    bucket.generationMs += entry.generationMs;
    bucket.speedCount++;
  }
}

export function addDimension(bucket, entry) {
  const model = entry.model || '';
  const provider = entry.provider || '';
  const account = entry.account || '';
  const key = JSON.stringify([model, provider, account]);
  bucket.segments ??= {};
  const segment = (bucket.segments[key] ||= { model, provider, account });
  accumulateBucket(segment, entry);
}

const zoneFormatters = new Map();
function zonedKeys(ts, timeZone) {
  if (!timeZone) {
    const iso = new Date(ts).toISOString();
    return { day: iso.slice(0, 10), hour: iso.slice(0, 13) };
  }
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', minute: '2-digit', second: '2-digit' });
    zoneFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ts).map(part => [part.type, part.value]));
  // Absolute hour starts distinguish repeated hours when daylight saving ends.
  const hourStart = ts - Number(parts.minute) * 60000 - Number(parts.second) * 1000 - new Date(ts).getUTCMilliseconds();
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: new Date(hourStart).toISOString() };
}

export function addAggregate(analytics, entry, timeZone) {
  const { day, hour } = zonedKeys(entry.ts, timeZone);
  for (const [group, key] of [['days', day], ['hours', hour]]) {
    const bucket = (analytics[group][key] ||= {});
    accumulateBucket(bucket, entry);
    addDimension(bucket, entry);
  }
  const oldestDay = zonedKeys(entry.ts - 366 * 86400e3, timeZone).day;
  const oldestHour = zonedKeys(entry.ts - 32 * 86400e3, timeZone).hour;
  for (const key of Object.keys(analytics.days)) if (key < oldestDay) delete analytics.days[key];
  for (const key of Object.keys(analytics.hours)) if (key < oldestHour) delete analytics.hours[key];
}
