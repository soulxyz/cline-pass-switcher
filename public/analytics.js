// Pure aggregation helpers shared by all dashboard views. No network or DOM work.
(() => {
  const fields = ['requests', 'errors', 'inputTokens', 'outputTokens', 'totalTokens', 'usageRequests', 'durationMs', 'ttftSum', 'ttftCount', 'generationMs', 'generatedTokens', 'speedCount', 'cachedTokens', 'cacheWriteTokens', 'cacheReadRequests', 'cacheWriteRequests', 'cacheInputTokens', 'cacheReadTokensForRate', 'cacheRateRequests', 'reasoningTokens', 'reasoningRequests', 'costUsd', 'costRequests', 'reportedCostRequests', 'estimatedCostRequests'];
  const pad = value => String(value).padStart(2, '0');
  const dateKey = ts => {
    const date = new Date(ts);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const startOfDay = ts => { const date = new Date(ts); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const addDays = (ts, days) => { const date = new Date(ts); date.setDate(date.getDate() + days); return date.getTime(); };
  const hourStart = ts => { const date = new Date(ts); return date.getTime() - date.getMinutes() * 60000 - date.getSeconds() * 1000 - date.getMilliseconds(); };
  const hourKey = ts => new Date(hourStart(ts)).toISOString();
  function isoTimestamp(ts) {
    const date = new Date(ts), offset = -date.getTimezoneOffset();
    return `${dateKey(ts)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  }
  const matches = (record, filters) => (!filters.provider || (record.provider || '未识别上游') === filters.provider) && (!filters.model || record.model === filters.model);
  function sum(rows) {
    const result = Object.fromEntries(fields.map(key => [key, 0]));
    for (const row of rows) for (const field of fields) result[field] += row[field] || 0;
    return result;
  }
  function select(bucket = {}, filters = {}) {
    if (!filters.provider && !filters.model) return bucket;
    const segments = Object.fromEntries(Object.entries(bucket.segments || {}).filter(([, segment]) => matches(segment, filters)));
    return { ...sum(Object.values(segments)), segments };
  }
  function range(analytics, selected, now, filters = {}) {
    let times;
    const hourly = selected === 'today' || Number(selected) === 1;
    if (hourly) {
      const end = hourStart(now);
      const start = selected === 'today' ? startOfDay(now) : end - 23 * 3600000;
      times = Array.from({ length: Math.round((end - start) / 3600000) + 1 }, (_, i) => start + i * 3600000);
    } else {
      const days = [7, 30].includes(Number(selected)) ? Number(selected) : 7;
      const end = startOfDay(now);
      times = Array.from({ length: days }, (_, i) => addDays(end, -(days - 1 - i)));
    }
    return times.map(ts => {
      const key = hourly ? hourKey(ts) : dateKey(ts);
      const bucket = analytics[hourly ? 'hours' : 'days']?.[key] || {};
      return { ts, key, ...select(bucket, filters) };
    });
  }
  function groups(buckets, by) {
    const grouped = new Map();
    for (const bucket of buckets) for (const segment of Object.values(bucket.segments || {})) {
      const key = by === 'provider' ? segment.provider || '未识别上游' : segment.model || '未知模型';
      const group = grouped.get(key) || { key, rows: [] };
      group.rows.push(segment);
      grouped.set(key, group);
    }
    return [...grouped.values()].map(({ key, rows }) => ({ key, ...sum(rows) }));
  }
  globalThis.CPSAnalytics = { fields, sum, select, range, groups, matches, dateKey, startOfDay, addDays, hourKey, isoTimestamp };
})();
