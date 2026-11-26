export type Vector = ArrayLike<number>;

export function cosine(a: Vector, b: Vector): number {
  if (a.length !== b.length) throw new Error("벡터 길이가 다릅니다.");
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export interface Hit {
  id: string;
  score: number;
}

/** 유사도가 높은 순서로 limit개 */
export function rank(query: Vector, items: Iterable<[string, Vector]>, limit: number): Hit[] {
  const hits: Hit[] = [];
  for (const [id, vector] of items) hits.push({ id, score: cosine(query, vector) });
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, limit);
}
