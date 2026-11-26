// 노트를 적은 순서대로 하나씩 처리해, 앱의 저장 흐름을 흉내 낸다.
import { pickCandidates, type CandidateSource } from "../../src/core/candidates.ts";
import {
  buildLinkRequest,
  checkLinkAnswer,
  LINK_INSTRUCTIONS,
  LINK_SCHEMA,
  pairKey,
  tagsByUse,
  type Checked,
} from "../../src/core/linking.ts";
import type { Usage } from "../../src/core/models.ts";
import { AnswerError, ApiError, type OpenAI } from "../../src/core/openai.ts";
import { rank, type Hit, type Vector } from "../../src/core/search.ts";
import type { Link, Note } from "../../src/core/types.ts";

export const NEIGHBORS = 5;
export const QUESTION_HITS = 15;

export interface Result {
  models: { link: string; embedding: string };
  seed: number;
  notes: Note[];
  links: (Link & { source: CandidateSource })[];
  rejected: (Checked["rejected"][number] & { from: string })[];
  failed: { id: string; error: string }[];
  neighbors: { id: string; hits: Hit[] }[];
  questions: { question: string; hits: Hit[] }[];
  usage: { link: Usage; embedding: Usage };
}

/** 같은 시험을 되풀이할 수 있도록 씨앗이 있는 난수 (mulberry32) */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function runTrial(options: {
  api: OpenAI;
  notes: Note[];
  questions?: string[];
  models: Result["models"];
  seed: number;
  log?: (message: string) => void;
}): Promise<Result> {
  const { api, models, seed, questions = [], log = () => {} } = options;
  const notes = options.notes.map((n) => ({ ...n, tags: [...n.tags] }));
  const result: Result = {
    models,
    seed,
    notes,
    links: [],
    rejected: [],
    failed: [],
    neighbors: [],
    questions: [],
    usage: {
      link: { inputTokens: 0, outputTokens: 0 },
      embedding: { inputTokens: 0, outputTokens: 0 },
    },
  };
  const addLinkUsage = (u: Usage) => {
    result.usage.link.inputTokens += u.inputTokens;
    result.usage.link.outputTokens += u.outputTokens;
  };

  log(`임베딩 ${notes.length + questions.length}개를 만듭니다.`);
  const embedded = await api.embed(models.embedding, [...notes.map((n) => n.text), ...questions]);
  result.usage.embedding = embedded.usage;
  const vectors = new Map<string, Vector>(notes.map((n, i) => [n.id, embedded.vectors[i]!]));

  const random = seededRandom(seed);
  const pairs = new Set<string>();
  for (const [index, note] of notes.entries()) {
    log(`태그·연결 ${index + 1}/${notes.length}`);
    const candidates = pickCandidates(note, notes.slice(0, index), vectors, random);
    const request = buildLinkRequest(
      note,
      candidates.map((c) => c.note),
      tagsByUse(notes.slice(0, index)),
    );
    try {
      const answer = await api.json({
        model: models.link,
        instructions: LINK_INSTRUCTIONS,
        input: request.input,
        schemaName: "tags_and_links",
        schema: LINK_SCHEMA,
      });
      addLinkUsage(answer.usage);
      const checked = checkLinkAnswer(note.id, answer.data, request.aliases, pairs);
      note.tags = checked.tags;
      for (const link of checked.links) {
        pairs.add(pairKey(link.from, link.to));
        const source = candidates.find((c) => c.note.id === link.to)!.source;
        result.links.push({ ...link, source });
      }
      result.rejected.push(...checked.rejected.map((r) => ({ ...r, from: note.id })));
    } catch (error) {
      // 키, 모델 이름, 한도 문제는 다음 노트에서도 같으므로 멈춘다.
      if (error instanceof ApiError) throw error;
      if (error instanceof AnswerError) addLinkUsage(error.usage);
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ id: note.id, error: message });
      log(`  처리 안 됨: ${message}`);
    }
  }

  const all = [...vectors];
  result.neighbors = notes.map((n) => ({
    id: n.id,
    hits: rank(vectors.get(n.id)!, all.filter(([id]) => id !== n.id), NEIGHBORS),
  }));
  result.questions = questions.map((question, i) => ({
    question,
    hits: rank(embedded.vectors[notes.length + i]!, all, QUESTION_HITS),
  }));
  return result;
}
