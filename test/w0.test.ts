import { describe, expect, it } from "vitest";
import { parseExport, parseLines } from "../scripts/w0/input.ts";
import { runTrial } from "../scripts/w0/pipeline.ts";
import { renderReport, scoreReport } from "../scripts/w0/report.ts";
import { AnswerError, ApiError, type OpenAI } from "../src/core/openai.ts";

const usage = { inputTokens: 100, outputTokens: 10 };
const models = { link: "gpt-6-luna", embedding: "text-embedding-3-small" };

/** 첫 후보와 잇는 가짜 모델. fail에 든 문장은 실패한다. */
function fakeApi(fail: Record<string, Error> = {}) {
  const inputs: any[] = [];
  const api: OpenAI = {
    async embed(_, texts) {
      return { vectors: texts.map((_, i) => [1, i]), usage: { inputTokens: texts.length, outputTokens: 0 } };
    },
    async json({ input }) {
      const data = JSON.parse(input);
      inputs.push(data);
      const error = fail[data.새_노트.text];
      if (error) throw error;
      const links = data.후보.length ? [{ to: "c1", why: "둘 다 장보기에 닿는다" }] : [];
      return { data: { tags: ["장보기"], links }, usage };
    },
  };
  return { api, inputs };
}

const notes = () => parseLines("장볼 것 나눠 적기\n남은 반찬 알려주기\n제철 채소 달력", new Date(2026, 0, 1));

describe("입력", () => {
  it("한 줄이 노트 하나이며 ID는 1초씩 밀린다", () => {
    const out = parseLines("﻿- 첫째\r\n\r\n2. 둘째\n", new Date(2026, 0, 1, 23, 59, 59));
    expect(out).toEqual([
      { id: "20260101235959", text: "첫째", tags: [] },
      { id: "20260102000000", text: "둘째", tags: [] },
    ]);
  });

  it("시제품 JSON은 예시를 빼고 오래된 것부터 읽는다", () => {
    const out = parseExport(
      JSON.stringify({
        notes: [
          { zid: "20260102000000", created: 2, text: "나중", tags: ["옛"] },
          { zid: "20260101000000", created: 1, text: "먼저" },
          { zid: "20260101000000", created: 1, text: "겹침" },
          { zid: "20260103000000", created: 3, text: "예시", example: true },
        ],
        links: [],
      }),
    );
    expect(out.map((n) => [n.id, n.text, n.tags])).toEqual([
      ["20260101000000", "먼저", []],
      ["20260101000001", "겹침", []],
      ["20260102000000", "나중", []],
    ]);
    expect(() => parseExport("{}")).toThrow();
  });
});

describe("시험 실행", () => {
  it("앞서 적은 노트만 후보로 주고, 붙은 태그를 다음 요청에 넘긴다", async () => {
    const { api, inputs } = fakeApi();
    const source = notes();
    const result = await runTrial({ api, notes: source, models, seed: 1, questions: ["장보기?"] });

    expect(inputs.map((i) => i.후보.length)).toEqual([0, 1, 2]);
    expect(inputs[1].기존_태그).toEqual(["장보기"]);
    expect(result.links).toHaveLength(2);
    expect(result.notes[0]!.tags).toEqual(["장보기"]);
    expect(source[0]!.tags).toEqual([]);
    expect(result.neighbors[0]!.hits).toHaveLength(2);
    expect(result.questions[0]!.hits).toHaveLength(3);
    expect(result.usage.link).toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it("답 하나가 실패해도 나머지를 처리한다", async () => {
    const { api } = fakeApi({ "남은 반찬 알려주기": new AnswerError("거절", usage) });
    const result = await runTrial({ api, notes: notes(), models, seed: 1 });
    expect(result.failed).toEqual([{ id: result.notes[1]!.id, error: "거절" }]);
    expect(result.links).toHaveLength(1);
    expect(result.usage.link.inputTokens).toBe(300);
  });

  it("키나 한도 오류는 바로 멈춘다", async () => {
    const { api, inputs } = fakeApi({ "장볼 것 나눠 적기": new ApiError(401, "키") });
    await expect(runTrial({ api, notes: notes(), models, seed: 1 })).rejects.toThrow("키");
    expect(inputs).toHaveLength(1);
  });
});

describe("보고서", () => {
  it("적은 판정을 종류별로 센다", async () => {
    const result = await runTrial({ api: fakeApi().api, notes: notes(), models, seed: 1 });
    const report = renderReport(result);
    expect(report).toContain("- 이유: 둘 다 장보기에 닿는다");
    expect(scoreReport(report)[0]).toMatchObject({ label: "연결", good: 0, bad: 0, blank: 2 });

    const judged = report
      .replace("판정 L1 (O/X): ", "판정 L1 (O/X): o")
      .replace("판정 L2 (O/X): ", "판정 L2 (O/X): X")
      .replace("판정 T1 (O/X): ", "판정 T1 (O/X): 글쎄")
      .replaceAll("\n", "\r\n");
    const [links, tags] = scoreReport(judged);
    expect(links).toMatchObject({ good: 1, bad: 1, blank: 0 });
    expect(tags).toMatchObject({ blank: 2, unreadable: ["T1"] });
  });
});
