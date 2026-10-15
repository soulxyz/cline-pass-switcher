const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function normalizePricing(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('定价配置必须是模型与价格的映射');
  const result = {};
  for (const [model, price] of Object.entries(value)) {
    if (!model.trim() || model.length > 200 || !price || !valid(price.input) || !valid(price.output)) throw new Error('每个模型需填写非负的输入、输出单价');
    if (['__proto__', 'constructor', 'prototype'].includes(model)) throw new Error('无效模型 ID');
    const cacheRead = price.cacheRead ?? price.input;
    const cacheWrite = price.cacheWrite ?? price.input;
    if (!valid(cacheRead) || !valid(cacheWrite)) throw new Error('缓存单价必须是非负数字');
    result[model] = { input: price.input, output: price.output, cacheRead, cacheWrite };
  }
  return result;
}

export function priceEntry(entry, pricing = {}, catalogPrice = null) {
  if (valid(entry.costUsd) && entry.costSource === 'reported') return { costUsd: entry.costUsd, costSource: 'reported' };
  const manual = pricing?.[entry.model] || pricing?.[entry.canonical];
  let price = manual || catalogPrice;
  if (!price || !valid(entry.inputTokens) || !valid(entry.outputTokens)) return { costUsd: null, costSource: null };
  if (!manual && price.tiers) {
    const band = price.tiers.filter(tier => entry.inputTokens > tier.aboveInputTokens).at(-1);
    if (band) price = { ...band, source: price.source, sourceKey: price.sourceKey, provider: price.provider, model: price.model, match: price.match, fetchedAt: price.fetchedAt, updated: price.updated };
  }
  if (!manual && ((entry.cachedTokens > 0 && price.cacheRead == null) || (entry.cacheWriteTokens > 0 && price.cacheWrite == null))) return { costUsd: null, costSource: null };
  const { input, output, cacheRead = input, cacheWrite = input } = price;
  if (![input, output, cacheRead, cacheWrite].every(valid)) return { costUsd: null, costSource: null };
  if ((entry.cachedTokens ?? 0) + (entry.cacheWriteTokens ?? 0) > entry.inputTokens) return { costUsd: null, costSource: null };
  if ((cacheRead !== input && entry.cachedTokens == null) || (cacheWrite !== input && entry.cacheWriteTokens == null)) return { costUsd: null, costSource: null };
  const reasoning = price.reasoning ?? output;
  if (!valid(reasoning) || (reasoning !== output && !valid(entry.reasoningTokens)) || (entry.reasoningTokens != null && entry.reasoningTokens > entry.outputTokens)) return { costUsd: null, costSource: null };
  const total = entry.inputTokens * input + entry.outputTokens * output
    + (entry.reasoningTokens ?? 0) * (reasoning - output)
    + (entry.cachedTokens ?? 0) * (cacheRead - input) + (entry.cacheWriteTokens ?? 0) * (cacheWrite - input);
  return Number.isFinite(total) && total >= 0 ? {
    costUsd: total / 1e6, costSource: 'estimated',
    costPricing: { input, output, cacheRead, cacheWrite, reasoning, source: manual ? 'manual' : price.source, provider: price.provider, model: price.model, match: price.match, fetchedAt: price.fetchedAt, updated: price.updated, aboveInputTokens: price.aboveInputTokens },
  } : { costUsd: null, costSource: null };
}
