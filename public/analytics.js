// Pure aggregation helpers shared by all dashboard views. No network or DOM work.
(() => {
  const fields = ['requests', 'errors', 'inputTokens', 'outputTokens', 'totalTokens', 'usageRequests', 'durationMs', 'ttftSum', 'ttftCount', 'generationMs', 'generatedTokens', 'speedCount', 'cachedTokens', 'cacheWriteTokens', 'cacheReadRequests', 'cacheWriteRequests', 'cacheInputTokens', 'cacheReadTokensForRate', 'cacheRateRequests', 'reasoningTokens', 'reasoningRequests', 'costUsd', 'costRequests', 'reportedCostRequests', 'estimatedCostRequests'];
  const dateKey = ts => new Date(ts).toISOString().slice(0, 10);
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
      const end = Math.floor(now / 3600000) * 3600000;
      const start = selected === 'today' ? Date.parse(`${dateKey(now)}T00:00:00Z`) : end - 23 * 3600000;
      times = Array.from({ length: Math.round((end - start) / 3600000) + 1 }, (_, i) => start + i * 3600000);
    } else {
      const days = [7, 30].includes(Number(selected)) ? Number(selected) : 7;
      const end = Date.parse(`${dateKey(now)}T00:00:00Z`);
      times = Array.from({ length: days }, (_, i) => end - (days - 1 - i) * 86400000);
    }
    return times.map(ts => {
      const key = new Date(ts).toISOString().slice(0, hourly ? 13 : 10);
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
  globalThis.CPSAnalytics = { fields, sum, select, range, groups, matches, dateKey };
})();
