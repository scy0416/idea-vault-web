import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { FormatError, serializeNote, type StoredNote } from "../src/core/note-file.ts";
import { openStore, requestPersistence, type Store } from "../src/storage/store.ts";

const NOW = new Date(2026, 10, 26, 15, 30, 12);
let factory: IDBFactory;
let store: Store;

beforeEach(async () => {
  factory = new IDBFactory();
  store = await openStore(factory);
});

const remoteNote = (id: string, text = "원격에서 온 노트"): StoredNote => ({
  id,
  created: "2026-11-26T15:30:12+09:00",
  text,
  tags: [],
  tagsByUser: false,
  links: [],
});
const link = (to: string) => ({ to, why: "지어낸 이유", by: "user" as const, at: "2026-11-26T15:30:12+09:00" });
const file = (content: string) => ({ content, sha: `sha:${content}` });
const receive = (note: StoredNote) => store.receive(note.id, file(serializeNote(note)));
const pendingIds = async () => (await store.listPending()).map((e) => e.id);

describe("적기", () => {
  it("저장한 노트는 올리지 못한 상태이며 다시 열어도 남는다", async () => {
    const [first, second] = await store.addNotes(["첫째", "  ", "둘째"], NOW);
    expect([first!.id, second!.id]).toEqual(["20261126153012", "20261126153013"]);

    store.close();
    store = await openStore(factory);
    expect((await store.listNotes()).map((n) => n.text)).toEqual(["둘째", "첫째"]);
    expect(await pendingIds()).toEqual([first!.id, second!.id]);
    expect(await store.getEntry(first!.id)).toMatchObject({ base: null, dirty: 1, revision: 1 });
  });

  it("동시에 만들어도 ID가 겹치지 않는다", async () => {
    const made = await Promise.all([store.addNotes(["가"], NOW), store.addNotes(["나"], NOW)]);
    expect(new Set(made.flat().map((n) => n.id)).size).toBe(2);
  });

  it("수정하면 기준 내용은 두고 올리지 못한 상태가 된다", async () => {
    const note = remoteNote("20260101000000");
    await receive(note);
    expect(await store.saveNote({ ...note, text: "고친 글" })).toBe(true);
    expect(await store.getEntry(note.id)).toMatchObject({ base: serializeNote(note), dirty: 1, revision: 2 });
  });

  it("없거나 지운 노트는 수정으로 되살아나지 않는다", async () => {
    const [note] = await store.addNotes(["가"], NOW);
    await store.deleteNote(note!.id);
    expect(await store.saveNote(note!)).toBe(false);
    expect(await store.saveNote(remoteNote("20250101000000"))).toBe(false);
    expect(await store.listNotes()).toEqual([]);
  });

  it("지운 노트의 ID는 올리기 전까지 다시 쓰지 않는다", async () => {
    const [first] = await store.addNotes(["가"], NOW);
    await store.deleteNote(first!.id);
    const [second] = await store.addNotes(["나"], NOW);
    expect(second!.id).not.toBe(first!.id);
  });

  it("지우면 그 노트를 가리키는 연결도 지우고 그 노트들도 올릴 대상이 된다", async () => {
    const [a, b, c] = ["20260101000000", "20260102000000", "20260103000000"];
    await receive(remoteNote(a!));
    await receive({ ...remoteNote(b!), links: [link(a!), link(c!)] });
    await receive(remoteNote(c!));

    await store.deleteNote(a!);

    expect((await store.listNotes()).map((n) => n.id)).toEqual([c, b]);
    expect((await store.getEntry(b!))!.note!.links.map((l) => l.to)).toEqual([c]);
    expect(await pendingIds()).toEqual([a, b]);
    expect(await store.getEntry(a!)).toMatchObject({ note: null, dirty: 1 });
  });
});

describe("올린 뒤", () => {
  it("올리면 대기 목록에서 빠지고 올린 내용이 기준이 된다", async () => {
    const [note] = await store.addNotes(["가"], NOW);
    const content = serializeNote(note!);
    await store.markUploaded(note!.id, 1, file(content));
    expect(await pendingIds()).toEqual([]);
    expect(await store.getEntry(note!.id)).toMatchObject({ base: content, dirty: 0 });
  });

  it("올리는 동안 고쳤으면 남는다", async () => {
    const [note] = await store.addNotes(["가"], NOW);
    await store.saveNote({ ...note!, text: "그사이 고침" });
    await store.markUploaded(note!.id, 1, file(serializeNote(note!)));
    expect(await store.getEntry(note!.id)).toMatchObject({
      note: { text: "그사이 고침" },
      base: serializeNote(note!),
      dirty: 1,
    });
  });

  it("새 노트를 올리는 동안 지웠으면 삭제도 올려야 한다", async () => {
    const [note] = await store.addNotes(["가"], NOW);
    await store.deleteNote(note!.id);
    await store.markUploaded(note!.id, 1, file(serializeNote(note!)));
    expect(await store.getEntry(note!.id)).toMatchObject({ note: null, dirty: 1 });

    await store.markUploaded(note!.id, 2, null);
    expect(await store.getEntry(note!.id)).toBeUndefined();
  });
});

describe("원격 반영", () => {
  const ID = "20260101000000";

  it("받은 노트를 넣고 바꾸고 지운다", async () => {
    await receive(remoteNote(ID));
    await receive(remoteNote(ID, "바뀐 글"));
    expect((await store.listNotes())[0]!.text).toBe("바뀐 글");
    await store.receive(ID, null);
    expect(await store.listNotes()).toEqual([]);
    expect(await pendingIds()).toEqual([]);
  });

  it("올리지 못한 본문은 덮어쓰지 않고 고르게 한다", async () => {
    await receive(remoteNote(ID));
    await store.saveNote(remoteNote(ID, "이 기기에서 고침"));
    expect(await receive(remoteNote(ID, "원격에서 고침"))).toBe("conflict");
    expect((await store.listNotes())[0]!.text).toBe("이 기기에서 고침");
    expect((await store.getEntry(ID))!.conflict!.content).toContain("원격에서 고침");
  });

  it("읽을 수 없는 파일은 알리고 이전 내용을 남긴다", async () => {
    await receive(remoteNote(ID));
    await expect(store.receive(ID, file("깨진 파일"))).rejects.toThrow(FormatError);
    expect(await store.listNotes()).toHaveLength(1);
  });
});

describe("설정과 지우기", () => {
  it("준 항목만 바꾸고 빈 값은 지운다", async () => {
    expect(await store.getSettings()).toEqual({});
    await store.saveSettings({ repository: " 지어낸/저장소 ", githubToken: "test-token" });
    await store.saveSettings({ openaiKey: "test-key", githubToken: "" });
    expect(await store.getSettings()).toEqual({ repository: "지어낸/저장소", openaiKey: "test-key" });
  });

  it("이 기기에서 지우면 노트, 변경, 설정이 모두 없어진다", async () => {
    await store.addNotes(["가"], NOW);
    await store.saveSettings({ openaiKey: "test-key" });
    await store.wipe();
    store.close();
    store = await openStore(factory);
    expect(await store.listNotes()).toEqual([]);
    expect(await store.listPending()).toEqual([]);
    expect(await store.getSettings()).toEqual({});
  });
});

describe("실패", () => {
  it("저장할 수 없는 값이 섞이면 전체를 취소한다", async () => {
    const [a, b] = ["20260101000000", "20260102000000"];
    await receive(remoteNote(a!));
    const broken = { ...remoteNote(a!), extra: { fn: () => {} } };
    await expect(store.saveNote(broken)).rejects.toThrow();
    expect(await pendingIds()).toEqual([]);
    expect(await store.getEntry(b!)).toBeUndefined();
  });

  it("저장 공간 보존 요청은 지원하지 않거나 실패해도 오류가 아니다", async () => {
    const manager = (persist?: () => Promise<boolean>) => ({ persist }) as unknown as StorageManager;
    expect(await requestPersistence(manager(async () => true))).toBe(true);
    expect(await requestPersistence(manager(async () => Promise.reject(new Error("no"))))).toBe(false);
    expect(await requestPersistence(manager())).toBe(false);
  });
});
