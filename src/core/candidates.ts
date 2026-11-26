import { rank, type Vector } from "./search.ts";
import type { Note } from "./types.ts";

export const SIMILAR_CANDIDATES = 30;
export const RANDOM_CANDIDATES = 3;

export type CandidateSource = "similar" | "tag" | "random";

export interface Candidate {
  note: Note;
  source: CandidateSource;
}

/**
 * 연결 후보: 유사도 상위 + 태그가 겹치는 노트 + 무작위.
 * 아직 태그가 없는 새 노트는 태그로 고르는 후보가 없다.
 */
export function pickCandidates(
  target: Note,
  others: Note[],
  vectors: Map<string, Vector>,
  random: () => number,
  limits: { similar: number; random: number } = {
    similar: SIMILAR_CANDIDATES,
    random: RANDOM_CANDIDATES,
  },
): Candidate[] {
  const pool = new Map(others.filter((n) => n.id !== target.id).map((n) => [n.id, n]));
  const targetVector = vectorOf(vectors, target.id);
  const picked: Candidate[] = [];
  const take = (id: string, source: CandidateSource) => {
    const note = pool.get(id);
    if (!note) return;
    picked.push({ note, source });
    pool.delete(id);
  };

  const ranked = rank(
    targetVector,
    [...pool.keys()].map((id): [string, Vector] => [id, vectorOf(vectors, id)]),
    limits.similar,
  );
  for (const hit of ranked) take(hit.id, "similar");

  const tags = new Set(target.tags);
  for (const note of [...pool.values()]) {
    if (note.tags.some((t) => tags.has(t))) take(note.id, "tag");
  }

  for (let i = 0; i < limits.random && pool.size; i++) {
    const ids = [...pool.keys()];
    take(ids[Math.floor(random() * ids.length)]!, "random");
  }
  return picked;
}

function vectorOf(vectors: Map<string, Vector>, id: string): Vector {
  const vector = vectors.get(id);
  if (!vector) throw new Error(`노트 ${id}의 벡터가 없습니다.`);
  return vector;
}
