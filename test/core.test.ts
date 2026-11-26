import { describe, expect, it } from "vitest";
import { pickCandidates } from "../src/core/candidates.ts";
import { buildLinkRequest, checkLinkAnswer, pairKey, tagsByUse } from "../src/core/linking.ts";
import { costOf } from "../src/core/models.ts";
import { cosine, rank } from "../src/core/search.ts";
import type { Note } from "../src/core/types.ts";

const note = (id: string, tags: string[] = []): Note => ({ id, text: `지어낸 노트 ${id}`, tags });

describe("검색", () => {
  it("코사인 유사도로 순서를 매긴다", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(() => cosine([1], [1, 0])).toThrow();
    const hits = rank([1, 0], [["a", [0, 1]], ["b", [1, 0]], ["c", [1, 1]]], 2);
    expect(hits.map((h) => h.id)).toEqual(["b", "c"]);
  });
});

describe("후보 고르기", () => {
  const target = note("t", ["요리"]);
  const others = [note("near"), note("tagged", ["요리"]), note("r1"), note("r2")];
  const vectors = new Map([
    ["t", [1, 0]],
    ["near", [1, 0]],
    ["tagged", [0, 1]],
    ["r1", [0, 1]],
    ["r2", [0, 1]],
  ]);

  it("유사도, 태그, 무작위 순서로 겹치지 않게 고른다", () => {
    const picked = pickCandidates(target, [target, ...others], vectors, () => 0, { similar: 1, random: 1 });
    expect(picked.map((c) => [c.note.id, c.source])).toEqual([
      ["near", "similar"],
      ["tagged", "tag"],
      ["r1", "random"],
    ]);
  });

  it("노트가 모자라면 있는 만큼만 고른다", () => {
    expect(pickCandidates(target, [], vectors, () => 0)).toEqual([]);
    expect(pickCandidates(target, others, vectors, () => 0.99)).toHaveLength(4);
  });
});

describe("태그·연결 검사", () => {
  const aliases = new Map([1, 2, 3, 4, 5, 6].map((n) => [`c${n}`, `id${n}`]));
  const link = (to: string, why = "이유") => ({ to, why });

  it("태그를 다듬고 3개까지만 받는다", () => {
    const out = checkLinkAnswer("new", { tags: ["#요리", "요리", " ", "장보기", "기록", "넷째"], links: [] }, aliases, new Set());
    expect(out.tags).toEqual(["요리", "장보기", "기록"]);
  });

  it("없는 노트, 이유 없음, 중복, 끊은 연결, 자기 자신을 버린다", () => {
    const out = checkLinkAnswer(
      "id6",
      { tags: [], links: [link("c9"), link("c1", " "), link("c2"), link("c2"), link("c3"), link("c4"), link("c6")] },
      aliases,
      new Set([pairKey("id6", "id3")]),
      new Set([pairKey("id4", "id6")]),
    );
    expect(out.links).toEqual([{ from: "id6", to: "id2", why: "이유" }]);
    expect(out.rejected.map((r) => r.reason)).toEqual([
      "unknown-note", "no-reason", "duplicate", "duplicate", "removed", "self",
    ]);
  });

  it("연결은 4개까지만 받는다", () => {
    const out = checkLinkAnswer("new", { tags: [], links: [1, 2, 3, 4, 5].map((n) => link(`c${n}`)) }, aliases, new Set());
    expect(out.links).toHaveLength(4);
    expect(out.rejected).toEqual([{ to: "id5", reason: "over-limit" }]);
  });

  it("형식이 다른 답은 실패로 본다", () => {
    expect(() => checkLinkAnswer("new", { tags: [] }, aliases, new Set())).toThrow();
    expect(() => checkLinkAnswer("new", null, aliases, new Set())).toThrow();
  });

  it("요청에는 노트 ID 대신 후보 번호를 쓴다", () => {
    const request = buildLinkRequest(note("20260101000000"), [note("20251231000000", ["요리"])], ["요리"]);
    expect(request.input).not.toContain('"20251231000000"');
    expect(JSON.parse(request.input).후보[0]).toMatchObject({ no: "c1", tags: ["요리"] });
    expect(request.aliases.get("c1")).toBe("20251231000000");
  });

  it("많이 쓴 태그가 앞에 온다", () => {
    expect(tagsByUse([note("a", ["나", "가"]), note("b", ["나"])])).toEqual(["나", "가"]);
  });
});

describe("비용", () => {
  it("가격표로 계산하고 모르는 모델은 null이다", () => {
    expect(costOf("gpt-6-luna", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6);
    expect(costOf("unknown", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});
