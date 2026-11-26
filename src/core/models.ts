// 기본 모델과 가격표는 이 파일에만 둔다.
// 100만 토큰당 달러. 2026-11-26에 공식 가격표에서 확인.

export const DEFAULT_MODELS = {
  link: "gpt-6-luna",
  ask: "gpt-6-luna",
  embedding: "text-embedding-3-small",
} as const;

export const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6.1-terra": { input: 1, output: 5 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** 가격표에 없는 모델이면 null. 캐시 할인은 계산하지 않는다. */
export function costOf(model: string, usage: Usage): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}
