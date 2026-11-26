import { describe, expect, it } from "vitest";
import { mergeNotes } from "../src/core/merge.ts";
import { serializeNote, type StoredLink, type StoredNote } from "../src/core/note-file.ts";
import { reconcile, type Entry } from "../src/storage/reconcile.ts";

const ID = "20260101000000";
const note = (over: Partial<StoredNote> = {}): StoredNote => ({
  id: ID,
  created: "2026-01-01T00:00:00+09:00",
  text: "처음 글",
  tags: [],
  tagsByUser: false,
  links: [],
  ...over,
});
const link = (to: string, over: Partial<StoredLink> = {}): StoredLink => ({
  to,
  why: "지어낸 이유",
  by: "ai",
  at: "2026-01-01T00:00:00+09:00",
  ...over,
});
const [A, B, C] = ["20260102000000", "20260103000000", "20260104000000"];

describe("합치기", () => {
  const base = note({ tags: ["가", "나"], links: [link(A)] });

  it("한쪽만 바꾼 본문을 따른다", () => {
    for (const [mine, theirs] of [
      [note({ text: "고침" }), note()],
      [note(), note({ text: "고침" })],
      [note({ text: "고침" }), note({ text: "고침" })],
    ] as const) {
      expect(mergeNotes(note(), mine, theirs)).toMatchObject({ textConflict: false, note: { text: "고침" } });
    }
  });

  it("본문이 다르게 바뀌면 충돌이며 이 기기의 글을 담는다", () => {
    const out = mergeNotes(note(), note({ text: "이쪽" }), note({ text: "저쪽" }));
    expect(out).toMatchObject({ textConflict: true, note: { text: "이쪽" } });
  });

  it("태그는 양쪽의 추가와 삭제를 모두 반영한다", () => {
    const out = mergeNotes(
      base,
      note({ tags: ["가", "다"], tagsByUser: true }),
      note({ tags: ["나", "가", "라"], tagsByUser: true }),
    );
    expect(out.note.tags.sort()).toEqual(["가", "다", "라"]);
  });

  it("직접 고친 태그를 AI의 태그가 덮지 않는다", () => {
    const mine = note({ tags: ["내것"], tagsByUser: true });
    const ai = note({ tags: ["기계"] });
    expect(mergeNotes(note(), mine, ai).note).toMatchObject({ tags: ["내것"], tagsByUser: true });
    expect(mergeNotes(note(), ai, mine).note).toMatchObject({ tags: ["내것"], tagsByUser: true });
  });

  it("연결은 합치고, 지운 항목은 지운 채로 둔다", () => {
    const out = mergeNotes(base, note({ links: [link(A), link(B)] }), note({ links: [link(C)] }));
    expect(out.note.links.map((l) => l.to).sort()).toEqual([B, C]);
  });

  it("같은 연결을 양쪽에서 바꾸면 나중 것을, 시각이 같으면 끊은 것을 남긴다", () => {
    const removed = link(B, { removed: true, at: "2026-01-02T00:00:00+09:00" });
    const added = link(B, { by: "user", at: "2026-01-03T00:00:00+09:00" });
    expect(mergeNotes(note(), note({ links: [removed] }), note({ links: [added] })).note.links).toEqual([added]);
    const tie = { ...added, at: removed.at };
    expect(mergeNotes(note(), note({ links: [tie] }), note({ links: [removed] })).note.links).toEqual([removed]);
  });

  it("처리 해시는 고른 본문을 따르고, 모르는 항목을 남긴다", () => {
    const out = mergeNotes(
      note({ processed: "old", extra: { title: "처음" } }),
      note({ text: "이쪽", processed: "mine", extra: { title: "처음" } }),
      note({ processed: "old", extra: { title: "저쪽", memo: 1 } }),
    );
    expect(out.note).toMatchObject({ processed: "mine", extra: { title: "저쪽", memo: 1 } });
  });
});

describe("원격 반영 규칙", () => {
  const file = (n: StoredNote) => ({ content: serializeNote(n), sha: `sha:${n.text}${n.tags}` });
  const entry = (local: StoredNote | null, base: StoredNote | null, over: Partial<Entry> = {}): Entry => ({
    id: ID,
    note: local,
    base: base && serializeNote(base),
    dirty: 1,
    revision: 3,
    ...over,
  });

  it("고친 것이 없으면 원격을 따른다", () => {
    expect(reconcile(ID, undefined, file(note())).entry).toMatchObject({ dirty: 0, note: note() });
    expect(reconcile(ID, entry(note(), note(), { dirty: 0 }), null).entry).toBeNull();
    expect(reconcile(ID, undefined, null)).toEqual({});
  });

  it("원격이 기준 그대로면 이 기기의 변경을 남긴다", () => {
    const out = reconcile(ID, entry(note({ text: "고침" }), note()), file(note()));
    expect(out.entry).toMatchObject({ dirty: 1, note: { text: "고침" }, sha: file(note()).sha });
  });

  it("양쪽이 같아졌으면 올릴 것이 없다", () => {
    const next = note({ text: "고침" });
    expect(reconcile(ID, entry(next, note()), file(next)).entry).toMatchObject({ dirty: 0 });
  });

  it("태그와 본문을 따로 고치면 합쳐서 올린다", () => {
    const out = reconcile(
      ID,
      entry(note({ text: "고침" }), note()),
      file(note({ tags: ["가"], tagsByUser: true })),
    );
    expect(out.entry).toMatchObject({ dirty: 1, revision: 4, note: { text: "고침", tags: ["가"] } });
    expect(out.entry!.conflict).toBeUndefined();
  });

  it("충돌은 기준을 두고 원격 내용을 보관하며, 알림은 한 번이다", () => {
    const first = reconcile(ID, entry(note({ text: "이쪽" }), note()), file(note({ text: "저쪽" })));
    expect(first.notice).toBe("conflict");
    expect(first.entry).toMatchObject({ base: serializeNote(note()), conflict: file(note({ text: "저쪽" })) });
    const second = reconcile(ID, first.entry!, file(note({ text: "저쪽 다시" })));
    expect(second.notice).toBeUndefined();
    expect(second.entry!.conflict!.content).toContain("저쪽 다시");
  });

  it("원격이 본문을 되돌리면 충돌이 풀린다", () => {
    const conflicted = reconcile(ID, entry(note({ text: "이쪽" }), note()), file(note({ text: "저쪽" }))).entry!;
    expect(reconcile(ID, conflicted, file(note())).entry!.conflict).toBeUndefined();
  });

  it("지웠는데 원격에서 본문을 고쳤으면 되살린다", () => {
    const out = reconcile(ID, entry(null, note()), file(note({ text: "저쪽" })));
    expect(out).toMatchObject({ notice: "kept-edit", entry: { dirty: 0, note: { text: "저쪽" } } });
  });

  it("지웠고 원격은 태그만 바뀌었으면 지운다", () => {
    const out = reconcile(ID, entry(null, note()), file(note({ tags: ["가"] })));
    expect(out.entry).toMatchObject({ note: null, dirty: 1, base: serializeNote(note({ tags: ["가"] })) });
  });

  it("원격에서 지워진 노트는 본문을 고쳤을 때만 남긴다", () => {
    const kept = reconcile(ID, entry(note({ text: "고침" }), note()), null);
    expect(kept).toMatchObject({ notice: "kept-local", entry: { base: null, dirty: 1 } });
    expect(reconcile(ID, entry(note({ tags: ["가"] }), note()), null).entry).toBeNull();
    expect(reconcile(ID, entry(null, note()), null).entry).toBeNull();
    expect(reconcile(ID, entry(note(), null), null)).toEqual({});
  });

  it("응답을 받지 못한 내 새 노트를 알아본다", () => {
    const sent = note({ text: "올린 글" });
    const edited = note({ text: "그 뒤에 고침" });
    const out = reconcile(ID, entry(edited, null, { sent: serializeNote(sent) }), file(sent));
    expect(out.moved).toBeUndefined();
    expect(out.entry).toMatchObject({ dirty: 1, base: serializeNote(sent), note: { text: "그 뒤에 고침" } });
  });

  it("같은 ID의 다른 새 노트면 이 기기의 것을 옮긴다", () => {
    const mine = note({ text: "내 노트" });
    const out = reconcile(ID, entry(mine, null), file(note({ text: "남의 노트" })));
    expect(out).toMatchObject({ notice: "renamed", moved: mine, entry: { dirty: 0 } });
  });
});
