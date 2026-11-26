import { describe, expect, it } from "vitest";
import {
  createNote,
  FormatError,
  idFromPath,
  notePath,
  parseNote,
  parseVault,
  serializeNote,
  serializeVault,
  type StoredNote,
} from "../src/core/note-file.ts";
import { localTimestamp, uniqueNoteId } from "../src/core/note-id.ts";

const ID = "20261126153012";
const PATH = `notes/${ID}.md`;

// 설계 3절의 예시
const EXAMPLE = `---
id: "20261126153012"
created: 2026-11-26T15:30:12+09:00
tags: [패션, 중고거래]
tagsByUser: false
processed: sha256:abc123
links:
  - to: "20261120091100"
    why: 안 입는 옷을 찾아내는 기능이 교환할 옷을 고르는 데 쓰인다
    by: ai
    at: 2026-11-26T15:30:20+09:00
---
안 입는 옷을 동네 사람과 바꿔 입는 플랫폼
`;

const note = (over: Partial<StoredNote> = {}): StoredNote => ({
  id: ID,
  created: "2026-11-26T15:30:12+09:00",
  text: "지어낸 노트",
  tags: [],
  tagsByUser: false,
  links: [],
  ...over,
});
const roundTrip = (value: StoredNote) => parseNote(PATH, serializeNote(value));
const file = (head: string, body = "본문\n") => `---\n${head}\n---\n${body}`;
const HEAD = `id: "${ID}"\ncreated: 2026-11-26T15:30:12+09:00`;

describe("ID와 시각", () => {
  it("겹치는 ID는 1초씩 밀고 해를 넘어간다", () => {
    const used = new Set(["20261231235959", "20270101000000"]);
    expect(uniqueNoteId("20261231235959", used)).toBe("20270101000001");
    expect(used.has("20270101000001")).toBe(true);
  });

  it("같은 순간에 만든 노트도 ID가 다르고 created는 실제 시각이다", () => {
    const now = new Date(2026, 10, 26, 15, 30, 12);
    const used = new Set<string>();
    const [a, b] = [createNote(" 첫째 \r\n", used, now), createNote("둘째", used, now)];
    expect([a.id, b.id]).toEqual([ID, "20261126153013"]);
    expect(b.created).toBe(a.created);
    expect(a.text).toBe("첫째");
  });

  it("현지 시각에 시차를 붙인다", () => {
    const now = new Date(2026, 10, 26, 15, 30, 12);
    const text = localTimestamp(now);
    expect(text).toMatch(/^2026-11-26T15:30:12[+-]\d\d:\d\d$/);
    expect(Date.parse(text)).toBe(now.getTime());
  });
});

describe("노트 파일", () => {
  it("경로에서 ID를 읽는다", () => {
    expect(notePath(ID)).toBe(PATH);
    expect(idFromPath(PATH)).toBe(ID);
    expect(idFromPath("notes/메모.md")).toBeNull();
    expect(idFromPath(`other/${ID}.md`)).toBeNull();
  });

  it("설계의 예시를 읽고 그대로 다시 쓴다", () => {
    const parsed = parseNote(PATH, EXAMPLE);
    expect(parsed).toMatchObject({
      id: ID,
      tags: ["패션", "중고거래"],
      processed: "sha256:abc123",
      text: "안 입는 옷을 동네 사람과 바꿔 입는 플랫폼",
      links: [{ to: "20261120091100", by: "ai" }],
    });
    expect(serializeNote(parsed)).toBe(EXAMPLE);
  });

  it("태그와 연결이 없는 노트를 쓴다", () => {
    expect(serializeNote(note())).toBe(`---\n${HEAD}\ntags: []\ntagsByUser: false\nlinks: []\n---\n지어낸 노트\n`);
    expect(roundTrip(note())).toEqual(note());
  });

  it("YAML로 헷갈리는 글자를 그대로 보존한다", () => {
    const value = note({
      tags: ["2026", "true", "a, b", "[x]", "# 샵", "null"],
      tagsByUser: true,
      links: [
        {
          to: "20261120091100",
          why: '콜론: 샵 # 따옴표 " \' 그리고\n두 번째 줄 ' + "긴 문장 ".repeat(30).trim(),
          by: "user",
          at: "2026-11-26T15:30:20+09:00",
          removed: true,
        },
      ],
    });
    expect(roundTrip(value)).toEqual(value);
  });

  it.each([
    "---\n구분선으로 시작\n---\n끝",
    "\n앞뒤 빈 줄\n\n",
    "여러 줄\n\n  들여 쓴 줄",
    "",
  ])("본문 %j 을 바꾸지 않는다", (text) => {
    expect(roundTrip(note({ text })).text).toBe(text);
  });

  it("앱이 모르는 항목을 남긴다", () => {
    const content = file(
      `${HEAD}\ntitle: 직접 적음\nlinks:\n  - to: "20261120091100"\n    why: 이유\n    by: user\n    at: 2026-11-26T15:30:20+09:00\n    memo: 남길 것`,
    );
    const again = serializeNote(parseNote(PATH, content));
    expect(again).toContain("title: 직접 적음");
    expect(again).toContain("memo: 남길 것");
  });

  it("손으로 고친 파일의 BOM, CRLF, 빠진 항목, 따옴표 없는 ID를 받아들인다", () => {
    const content = `\uFEFF---\r\nid: ${ID}\r\ncreated: 2026-11-26T15:30:12+09:00\r\ntags:\r\n---\r\n첫 줄\r\n둘째 줄`;
    expect(parseNote(PATH, content)).toEqual(note({ text: "첫 줄\n둘째 줄" }));
  });

  const link = (fields: string) => `${HEAD}\nlinks:\n  - ${fields}`;
  const good = 'to: "20261120091100"\n    why: 이유\n    by: ai\n    at: 2026-11-26T15:30:20+09:00';

  it.each([
    ["머리말 없음", "본문뿐"],
    ["닫히지 않은 머리말", `---\n${HEAD}\n본문`],
    ["깨진 YAML", file("id: [")],
    ["항목이 아닌 머리말", file("그냥 글")],
    ["다른 ID", file(HEAD.replace(ID, "20260101000000"))],
    ["시각 아님", file(`id: "${ID}"\ncreated: 어제`)],
    ["목록 아닌 태그", file(`${HEAD}\ntags: 하나`)],
    ["참/거짓 아닌 값", file(`${HEAD}\ntagsByUser: 네`)],
    ["잘못된 대상", file(link(good.replace("20261120091100", "abc")))],
    ["이유 없음", file(link(good.replace("why: 이유\n    ", "")))],
    ["알 수 없는 by", file(link(good.replace("by: ai", "by: bot")))],
    ["빈 연결", file(`${HEAD}\nlinks:\n  - `)],
  ])("%s: 경로를 알리며 실패한다", (_, content) => {
    expect(() => parseNote(PATH, content)).toThrow(FormatError);
    expect(() => parseNote(PATH, content)).toThrow(PATH);
  });

  it("위의 정상 연결은 읽힌다", () => {
    expect(parseNote(PATH, file(link(good))).links).toHaveLength(1);
  });
});

describe("vault.json", () => {
  it("쓰고 읽는다", () => {
    expect(serializeVault()).toBe('{\n  "version": 1\n}\n');
    expect(parseVault(serializeVault())).toEqual({ version: 1 });
  });

  it.each(["아님", "{}", '{"version":"1"}', '{"version":0}', "null"])("%s 는 거절한다", (content) => {
    expect(() => parseVault(content)).toThrow(FormatError);
  });

  it("더 새로운 형식은 업데이트를 안내한다", () => {
    expect(() => parseVault('{"version":2}')).toThrow("업데이트");
  });
});
