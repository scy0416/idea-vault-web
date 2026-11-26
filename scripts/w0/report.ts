// 직접 평가할 보고서와, 적은 판정을 세는 함수.
import { costOf } from "../../src/core/models.ts";
import type { Result } from "./pipeline.ts";

const KINDS = {
  L: "연결",
  T: "태그",
  N: "비슷한 노트",
  S: "질문 검색",
} as const;
type Kind = keyof typeof KINDS;

const oneLine = (text: string) => text.replace(/\s+/g, " ");

export function totalCost(result: Result): number | null {
  const link = costOf(result.models.link, result.usage.link);
  const embedding = costOf(result.models.embedding, result.usage.embedding);
  return link === null || embedding === null ? null : link + embedding;
}

export function renderReport(result: Result): string {
  const texts = new Map(result.notes.map((n) => [n.id, oneLine(n.text)]));
  const text = (id: string) => texts.get(id) ?? id;
  const verdict = (kind: Kind, n: number) => `- 판정 ${kind}${n} (O/X): `;
  const cost = totalCost(result);
  const { link, embedding } = result.usage;

  const out: string[] = [
    "# W0 품질 시험",
    "",
    "각 `판정` 줄 끝에 납득하면 `O`, 아니면 `X`를 적는다. 모르겠으면 비워 둔다.",
    "다 적은 뒤 `npm run w0:score -- <이 파일>`로 센다.",
    "",
    "| 항목 | 값 |",
    "|---|---|",
    `| 태그·연결 모델 | ${result.models.link} |`,
    `| 임베딩 모델 | ${result.models.embedding} |`,
    `| 난수 씨앗 | ${result.seed} |`,
    `| 노트 | ${result.notes.length}개 (처리 안 됨 ${result.failed.length}개) |`,
    `| 연결 | ${result.links.length}개 (검사에서 버림 ${result.rejected.length}개) |`,
    `| 토큰 | 태그·연결 입력 ${link.inputTokens} / 출력 ${link.outputTokens}, 임베딩 ${embedding.inputTokens} |`,
    `| 비용(추정) | ${cost === null ? "가격표에 없는 모델" : `$${cost.toFixed(4)}`} |`,
    "",
    `## ${KINDS.L}`,
    "",
  ];

  result.links.forEach((l, i) => {
    out.push(
      `### L${i + 1}`,
      "",
      `- 새 노트: ${text(l.from)}`,
      `- 이은 노트: ${text(l.to)}`,
      `- 이유: ${oneLine(l.why)}`,
      `- 후보로 뽑힌 방법: ${{ similar: "유사도", tag: "태그", random: "무작위" }[l.source]}`,
      verdict("L", i + 1),
      "",
    );
  });
  if (!result.links.length) out.push("연결이 없다.", "");

  out.push(`## ${KINDS.T}`, "");
  result.notes.forEach((n, i) => {
    out.push(
      `### T${i + 1}`,
      "",
      `- 노트: ${oneLine(n.text)}`,
      `- 태그: ${n.tags.join(", ") || "(없음)"}`,
      verdict("T", i + 1),
      "",
    );
  });

  out.push(`## ${KINDS.N}`, "", "가까운 순서다. 목록이 대체로 그럴듯하면 `O`.", "");
  result.neighbors.forEach((item, i) => {
    out.push(`### N${i + 1}`, "", `노트: ${text(item.id)}`, "");
    item.hits.forEach((h, n) => out.push(`${n + 1}. (${h.score.toFixed(3)}) ${text(h.id)}`));
    out.push("", verdict("N", i + 1), "");
  });

  if (result.questions.length) {
    out.push(`## ${KINDS.S}`, "", "필요한 노트가 위쪽에 나왔으면 `O`.", "");
    result.questions.forEach((item, i) => {
      out.push(`### S${i + 1}`, "", `질문: ${oneLine(item.question)}`, "");
      item.hits.forEach((h, n) => out.push(`${n + 1}. (${h.score.toFixed(3)}) ${text(h.id)}`));
      out.push("", verdict("S", i + 1), "");
    });
  }

  if (result.failed.length) {
    out.push("## 처리 안 됨", "");
    for (const f of result.failed) out.push(`- ${text(f.id)} — ${oneLine(f.error)}`);
    out.push("");
  }
  return out.join("\n");
}

export interface Score {
  label: string;
  good: number;
  bad: number;
  blank: number;
  unreadable: string[];
}

export function scoreReport(report: string): Score[] {
  const scores = new Map<Kind, Score>();
  // 노트 문장이 판정 줄처럼 보여도 줄 처음이 아니므로 세지 않는다.
  for (const m of report.matchAll(/^- 판정 ([LTNS])(\d+) \(O\/X\):(.*)$/gm)) {
    const kind = m[1] as Kind;
    const value = m[3]!.trim().toUpperCase();
    let score = scores.get(kind);
    if (!score) {
      score = { label: KINDS[kind], good: 0, bad: 0, blank: 0, unreadable: [] };
      scores.set(kind, score);
    }
    if (value === "O") score.good++;
    else if (value === "X") score.bad++;
    else if (!value) score.blank++;
    else score.unreadable.push(kind + m[2]);
  }
  return [...scores.values()];
}
