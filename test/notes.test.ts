import { IDBFactory } from "fake-indexeddb";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteList } from "../src/app/NoteList.tsx";
import {
  addTag,
  editText,
  filterNotes,
  isSaveKey,
  removeTag,
  shortTime,
  splitInput,
  tagCounts,
  type Filter,
} from "../src/app/notes.ts";
import type { StoredNote } from "../src/core/note-file.ts";
import { openStore } from "../src/storage/store.ts";

const note = (id: string, text: string, tags: string[] = []): StoredNote => ({
  id,
  created: "2026-11-26T15:30:12+09:00",
  text,
  tags,
  tagsByUser: false,
  links: [],
});

describe("입력", () => {
  it("한 줄이 노트 하나이며 목록 기호와 빈 줄을 뺀다", () => {
    expect(splitInput("- 첫째\r\n\n  * 둘째  \r3. 셋째\n#태그처럼 시작\n- \n3.5배")).toEqual([
      "첫째",
      "둘째",
      "셋째",
      "#태그처럼 시작",
      "3.5배",
    ]);
    expect(splitInput(" \n ")).toEqual([]);
  });

  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };

  it("PC의 Enter만 저장한다", () => {
    expect(isSaveKey(enter, true)).toBe(true);
    expect(isSaveKey(enter, false)).toBe(false);
  });

  it.each([{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { key: "a" }])(
    "%j 이면 저장하지 않는다",
    (over) => {
      expect(isSaveKey({ ...enter, ...over }, true)).toBe(false);
    },
  );
});

describe("거르기", () => {
  const notes = [
    note("20260103000000", "장볼 것 나눠 적기", ["장보기"]),
    note("20260102000000", "Garden 물주기 알림", ["식물", "알림"]),
    note("20260101000000", "남은 반찬 알려주기", ["장보기", "식물"]),
  ];
  const ids = (filter: Partial<Filter>) =>
    filterNotes(notes, { tag: null, query: "", ...filter }).map((n) => n.id.slice(7, 8));

  it("낱말이 본문, 태그, 번호에 모두 있으면 맞는다", () => {
    expect(ids({})).toEqual(["3", "2", "1"]);
    expect(ids({ query: " garden " })).toEqual(["2"]);
    expect(ids({ query: "장보기 반찬" })).toEqual(["1"]);
    expect(ids({ query: "#식물" })).toEqual(["2", "1"]);
    expect(ids({ query: "20260103" })).toEqual(["3"]);
    expect(ids({ query: "없는말" })).toEqual([]);
    expect(ids({ query: "#" })).toEqual(["3", "2", "1"]);
  });

  it("풀어 쓴 한글도 찾는다", () => {
    expect(ids({ query: "반찬".normalize("NFD") })).toEqual(["1"]);
  });

  it("태그와 검색어를 함께 적용한다", () => {
    expect(ids({ tag: "식물" })).toEqual(["2", "1"]);
    expect(ids({ tag: "식물", query: "반찬" })).toEqual(["1"]);
  });

  it("태그를 많이 쓴 순서로 세며 한 노트의 중복은 한 번이다", () => {
    expect(tagCounts([...notes, note("20260104000000", "x", ["알림", "알림"])])).toEqual([
      ["식물", 2],
      ["알림", 2],
      ["장보기", 2],
    ]);
  });
});

describe("수정", () => {
  const base = note("20260101000000", "원래 글", ["가"]);

  it("직접 고친 태그를 표시한다", () => {
    expect(addTag(base, " #나 ")).toMatchObject({ tags: ["가", "나"], tagsByUser: true });
    expect(removeTag(base, "가")).toMatchObject({ tags: [], tagsByUser: true });
  });

  it("바뀐 것이 없으면 받은 노트를 그대로 돌려준다", () => {
    for (const same of [addTag(base, "가"), addTag(base, " # "), removeTag(base, "없음")]) expect(same).toBe(base);
    for (const text of ["원래 글", " 원래 글\n", "", "  \n "]) expect(editText(base, text)).toBe(base);
  });

  it("본문은 앞뒤만 다듬고 여러 줄을 남긴다", () => {
    expect(editText(base, "\n첫 줄\r\n\n  둘째 \n").text).toBe("첫 줄\n\n  둘째");
  });

  it("적은 곳의 시각을 보여준다", () => {
    expect(shortTime(base.created)).toBe("2026-11-26 15:30");
  });

  it("잇따른 수정이 서로를 덮어쓰지 않고, 같은 내용은 올릴 대상이 아니다", async () => {
    const store = await openStore(new IDBFactory());
    const [made] = await store.addNotes(["글"]);
    await Promise.all([
      store.updateNote(made!.id, (n) => addTag(n, "가")),
      store.updateNote(made!.id, (n) => addTag(n, "나")),
      store.updateNote(made!.id, (n) => editText(n, "고친 글")),
    ]);
    const entry = await store.getEntry(made!.id);
    expect(entry!.note).toMatchObject({ text: "고친 글", tags: ["가", "나"] });

    await store.updateNote(made!.id, (n) => editText(n, "고친 글"));
    expect((await store.getEntry(made!.id))!.revision).toBe(entry!.revision);

    await store.deleteNote(made!.id);
    expect(await store.updateNote(made!.id, (n) => addTag(n, "다"))).toBe(false);
  });
});

describe("목록 화면", () => {
  const render = (notes: StoredNote[], filter: Partial<Filter> = {}, pending: string[] = []) =>
    renderToStaticMarkup(
      createElement(NoteList, {
        notes,
        pending: new Set(pending),
        filter: { tag: null, query: "", ...filter },
        onFilter: () => {},
        onOpen: () => {},
      }),
    );

  it("빈 목록과 맞는 노트가 없는 경우를 알린다", () => {
    expect(render([])).toContain("아직 노트가 없습니다");
    expect(render([note("20260101000000", "글")], { query: "없음" })).toContain("맞는 노트가 없습니다");
  });

  it("노트를 HTML로 해석하지 않고 올리지 못한 상태를 보인다", () => {
    const html = render([note("20260101000000", "<img src=x onerror=alert(1)>", ["<b>"])], {}, ["20260101000000"]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("아직 올리지 못함");
  });

  it("없어진 태그를 고른 상태에서도 풀 수 있다", () => {
    expect(render([note("20260101000000", "글")], { tag: "사라짐" })).toMatch(
      /aria-pressed="true"[^>]*>사라짐/,
    );
  });

  it("200개까지만 먼저 보여준다", () => {
    const many = Array.from({ length: 201 }, (_, i) => note(String(20260101000000 + i), `노트 ${i}`));
    const html = render(many);
    expect(html.match(/class="note"/g)).toHaveLength(200);
    expect(html).toContain("1개 남음");
  });
});
