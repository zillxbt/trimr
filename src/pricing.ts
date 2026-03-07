// Anthropic pricing per 1M tokens — updated March 2026
export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM: number;
  cacheReadPerM: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': {
    inputPerM: 15.0,
    outputPerM: 75.0,
    cacheWritePerM: 18.75,
    cacheReadPerM: 1.5,
  },
  'claude-sonnet-4-6': {
    inputPerM: 3.0,
    outputPerM: 15.0,
    cacheWritePerM: 3.75,
    cacheReadPerM: 0.30,
  },
  'claude-haiku-4-5': {
    inputPerM: 0.80,
    outputPerM: 4.0,
    cacheWritePerM: 1.0,
    cacheReadPerM: 0.08,
  },
};

export function getPricing(model: string): ModelPricing {
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.includes(key) || key.includes(model)) return pricing;
  }
  if (model.includes('opus'))   return PRICING['claude-opus-4-6'];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (model.includes('haiku'))  return PRICING['claude-haiku-4-5'];
  // Default to Sonnet pricing
  return PRICING['claude-sonnet-4-6'];
}

export type CostType = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

export function calculateCost(tokens: number, model: string, type: CostType): number {
  const p = getPricing(model);
  switch (type) {
    case 'input':      return (tokens / 1_000_000) * p.inputPerM;
    case 'output':     return (tokens / 1_000_000) * p.outputPerM;
    case 'cacheRead':  return (tokens / 1_000_000) * p.cacheReadPerM;
    case 'cacheWrite': return (tokens / 1_000_000) * p.cacheWritePerM;
  }
}

/** Rough token estimator: ~4 chars per token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
