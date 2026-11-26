// 가짜 GitHub 하나를 두 기기가 함께 쓰는 상황을 시험한다.
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { parseNote, serializeNote, serializeVault, type StoredNote } from "../src/core/note-file.ts";
import { openStore, type Store } from "../src/storage/store.ts";
import { blobSha, GitHubError, type FileChange, type Remote } from "../src/sync/github.ts";
import { sync } from "../src/sync/sync.ts";

class FakeGitHub implements Remote {
  files = new Map<string, string>();
  isPrivate = true;
  head: string | null = "head0";
  commits: { message: string; paths: string[] }[] = [];
  fetched: string[] = [];
  /** 다음 커밋 직전에 한 번 실행한다. 그사이 원격이 바뀌는 상황 */
  beforeCommit: (() => void) | null = null;
  /** 커밋은 되고 응답만 잃는다. */
  loseResponse = false;
  offline = false;
  private count = 0;
  private bySha = new Map<string, string>();

  write(path: string, content: string | null) {
    if (content === null) this.files.delete(path);
    else this.files.set(path, content);
    this.head = `head${++this.count}`;
  }
  private online() {
    if (this.offline) throw new GitHubError("network", "연결 없음");
  }
  async repository() {
    this.online();
    return { isPrivate: this.isPrivate, branch: this.head ? { name: "main", head: this.head } : null };
  }
  async init(path: string, content: string) {
    this.write(path, content);
  }
  async tree() {
    const notes = new Map<string, string>();
    let vault: string | null = null;
    for (const [path, content] of this.files) {
      const sha = await blobSha(content);
      this.bySha.set(sha, content);
      if (path === "vault.json") vault = sha;
      else if (path.startsWith("notes/")) notes.set(path, sha);
    }
    return { vault, notes };
  }
  async blobs(shas: string[]) {
    this.fetched.push(...shas);
    return new Map(shas.map((s) => [s, this.bySha.get(s) ?? null]));
  }
  async commit(_: string, head: string, changes: FileChange[], message: string) {
    this.online();
    this.beforeCommit?.();
    this.beforeCommit = null;
    if (head !== this.head) throw new GitHubError("other", "stale");
    for (const c of changes) {
      if (c.content === null && !this.files.has(c.path)) throw new GitHubError("other", "없는 파일 삭제");
    }
    for (const c of changes) {
      if (c.content === null) this.files.delete(c.path);
      else this.files.set(c.path, c.content);
    }
    this.head = `head${++this.count}`;
    this.commits.push({ message, paths: changes.map((c) => c.path) });
    if (this.loseResponse) {
      this.loseResponse = false;
      this.offline = true;
      throw new GitHubError("network", "응답 없음");
    }
    return this.head;
  }

  note(id: string): StoredNote {
    return parseNote(`notes/${id}.md`, this.files.get(`notes/${id}.md`)!);
  }
  noteIds() {
    return [...this.files.keys()].filter((p) => p.startsWith("notes/")).map((p) => p.slice(6, -3)).sort();
  }
}

const NOW = new Date(2026, 10, 26, 15, 30, 12);
let github: FakeGitHub;

async function device(): Promise<Store> {
  const store = await openStore(new IDBFactory());
  await store.saveSettings({ repository: "owner/notes", githubToken: "test-token" });
  return store;
}
const run = (store: Store) => sync(store, () => github);
const texts = async (store: Store) => (await store.listNotes()).map((n) => n.text).sort();
const pending = async (store: Store) => (await store.listPending()).length;

let pc: Store;
let phone: Store;
beforeEach(async () => {
  github = new FakeGitHub();
  github.write("vault.json", serializeVault());
  [pc, phone] = [await device(), await device()];
});

/** 노트 하나를 두 기기가 함께 가진 상태 */
async function shared(text = "함께 보는 글") {
  const [note] = await pc.addNotes([text], NOW);
  await run(pc);
  await run(phone);
  return note!;
}
const retext = (store: Store, id: string, text: string) => store.updateNote(id, (n) => ({ ...n, text }));

describe("설정과 저장소", () => {
  it("저장소나 토큰이 없으면 아무것도 하지 않는다", async () => {
    const empty = await openStore(new IDBFactory());
    expect((await run(empty)).status).toBe("unconfigured");
    await empty.saveSettings({ repository: "owner/notes" });
    expect((await run(empty)).status).toBe("unconfigured");
  });

  it("공개 저장소에는 올리지도 받지도 않는다", async () => {
    github.isPrivate = false;
    github.write("notes/20260101000000.md", "공개된 파일");
    await pc.addNotes(["비밀 노트"], NOW);
    const result = await run(pc);
    expect(result).toMatchObject({ status: "error", message: expect.stringContaining("공개 저장소") });
    expect(github.commits).toEqual([]);
    expect(github.fetched).toEqual([]);
    expect(await pending(pc)).toBe(1);
  });

  it("빈 저장소에 vault.json을 만들고 올린다", async () => {
    github = new FakeGitHub();
    github.head = null;
    await pc.addNotes(["첫 노트"], NOW);
    expect((await run(pc)).status).toBe("ok");
    expect(github.files.get("vault.json")).toBe(serializeVault());
    expect(github.noteIds()).toHaveLength(1);
  });

  it("vault.json이 없는 저장소에 만든다", async () => {
    github = new FakeGitHub();
    github.write("README.md", "설명");
    expect((await run(pc)).status).toBe("ok");
    expect(github.files.has("vault.json")).toBe(true);
    expect(github.files.get("README.md")).toBe("설명");
  });

  it("더 새로운 형식의 저장소는 건드리지 않는다", async () => {
    github.write("vault.json", '{"version":2}');
    await pc.addNotes(["가"], NOW);
    expect(await run(pc)).toMatchObject({ status: "error", message: expect.stringContaining("업데이트") });
    expect(github.commits).toEqual([]);
  });
});

describe("올리고 받기", () => {
  it("한 기기에서 적은 노트가 저장소와 다른 기기에 보인다", async () => {
    await pc.addNotes(["첫째", "둘째"], NOW);
    expect((await run(pc)).status).toBe("ok");
    expect(await pending(pc)).toBe(0);
    expect(github.commits).toEqual([{ message: "notes: 2개 변경", paths: expect.any(Array) }]);

    await run(phone);
    expect(await texts(phone)).toEqual(["둘째", "첫째"]);
  });

  it("바뀐 것이 없으면 커밋하지 않고, 바뀐 파일만 받는다", async () => {
    await pc.addNotes(["첫째", "둘째"], NOW);
    await run(pc);
    await run(phone);
    github.fetched = [];
    await run(phone);
    expect(github.fetched).toEqual([]);

    await retext(pc, (await pc.listNotes())[0]!.id, "바꾼 글");
    await run(pc);
    github.fetched = [];
    await run(phone);
    // vault.json과 바뀐 노트 하나
    expect(github.fetched).toHaveLength(2);
    expect(github.commits).toHaveLength(2);
  });

  it("삭제가 저장소와 다른 기기에 반영된다", async () => {
    const note = await shared();
    await phone.deleteNote(note.id);
    await run(phone);
    expect(github.noteIds()).toEqual([]);
    await run(pc);
    expect(await texts(pc)).toEqual([]);
    expect(await pc.listEntries()).toEqual([]);
  });

  it("연결이 끊긴 채 적은 노트는 나중에 올라간다", async () => {
    github.offline = true;
    await pc.addNotes(["끊긴 채 적음"], NOW);
    expect(await run(pc)).toMatchObject({ status: "error", retry: true });
    expect(await pending(pc)).toBe(1);
    github.offline = false;
    await run(pc);
    expect(github.noteIds()).toHaveLength(1);
    expect(await pending(pc)).toBe(0);
  });

  it("커밋하는 사이 원격이 바뀌면 다시 받아서 올린다", async () => {
    await pc.addNotes(["내 노트"], NOW);
    const other = { ...(await pc.listNotes())[0]!, id: "20260101000000", text: "그사이 올라온 노트" };
    github.beforeCommit = () => github.write(`notes/${other.id}.md`, serializeNote(other));
    expect((await run(pc)).status).toBe("ok");
    expect(github.noteIds()).toHaveLength(2);
    expect(await texts(pc)).toEqual(["그사이 올라온 노트", "내 노트"]);
  });

  it("원격이 그대로인데 커밋이 실패하면 오류를 알린다", async () => {
    await pc.addNotes(["가"], NOW);
    github.commit = async () => {
      throw new GitHubError("other", "권한 없음");
    };
    expect(await run(pc)).toMatchObject({ status: "error", message: "권한 없음" });
    expect(await pending(pc)).toBe(1);
  });

  it("커밋 응답을 잃어도 노트가 둘이 되지 않는다", async () => {
    const [note] = await pc.addNotes(["처음"], NOW);
    github.loseResponse = true;
    expect((await run(pc)).status).toBe("error");
    await retext(pc, note!.id, "그 뒤에 고침");
    github.offline = false;
    const result = await run(pc);
    expect(result.notices).toEqual([]);
    expect(github.noteIds()).toEqual([note!.id]);
    expect(github.note(note!.id).text).toBe("그 뒤에 고침");
    expect(await texts(pc)).toEqual(["그 뒤에 고침"]);
  });

  it("올리는 동안 고친 내용은 다음에 올라간다", async () => {
    const [note] = await pc.addNotes(["처음"], NOW);
    let edit: Promise<unknown> | undefined;
    github.beforeCommit = () => (edit = retext(pc, note!.id, "올리는 중에 고침"));
    await run(pc);
    await edit;
    expect(await pending(pc)).toBe(1);
    await run(pc);
    expect(github.note(note!.id).text).toBe("올리는 중에 고침");
  });

  it("두 기기가 같은 초에 만든 노트를 둘 다 남긴다", async () => {
    await pc.addNotes(["PC에서"], NOW);
    await phone.addNotes(["휴대폰에서"], NOW);
    await run(pc);
    const result = await run(phone);
    expect(result.notices).toEqual(["renamed"]);
    await run(pc);
    expect(github.noteIds()).toHaveLength(2);
    expect(await texts(pc)).toEqual(["PC에서", "휴대폰에서"]);
    expect(await texts(phone)).toEqual(["PC에서", "휴대폰에서"]);
  });

  it("100개를 넘으면 나누어 커밋한다", async () => {
    await pc.addNotes(Array.from({ length: 101 }, (_, i) => `노트 ${i}`), NOW);
    expect((await run(pc)).status).toBe("ok");
    expect(github.commits.map((c) => c.paths.length)).toEqual([100, 1]);
  });

  it("동시에 두 번 불러도 한 번만 올린다", async () => {
    await pc.addNotes(["가"], NOW);
    await Promise.all([run(pc), run(pc)]);
    expect(github.commits).toHaveLength(1);
  });
});

describe("충돌", () => {
  async function conflict() {
    const note = await shared();
    await retext(pc, note.id, "PC에서 고침");
    await retext(phone, note.id, "휴대폰에서 고침");
    await run(pc);
    const result = await run(phone);
    return { id: note.id, result };
  }

  it("고르기 전에는 올리지 않는다", async () => {
    const { id, result } = await conflict();
    expect(result.notices).toEqual(["conflict"]);
    await run(phone);
    expect(github.note(id).text).toBe("PC에서 고침");
    expect(await texts(phone)).toEqual(["휴대폰에서 고침"]);
  });

  it.each([
    ["local", ["휴대폰에서 고침"]],
    ["remote", ["PC에서 고침"]],
    ["both", ["PC에서 고침", "휴대폰에서 고침"]],
  ] as const)("%s 를 고르면 두 기기가 같아진다", async (choice, expected) => {
    const { id } = await conflict();
    expect(await phone.resolveConflict(id, choice, NOW)).toBe(true);
    await run(phone);
    await run(pc);
    expect(await texts(phone)).toEqual(expected);
    expect(await texts(pc)).toEqual(expected);
    expect(await pending(phone)).toBe(0);
  });

  it("충돌한 노트를 지우면 지워진다", async () => {
    const { id } = await conflict();
    await phone.deleteNote(id);
    await run(phone);
    expect(github.noteIds()).toEqual([]);
  });

  it("서로 다른 태그는 묻지 않고 합친다", async () => {
    const note = await shared();
    await pc.updateNote(note.id, (n) => ({ ...n, tags: ["가"], tagsByUser: true }));
    await phone.updateNote(note.id, (n) => ({ ...n, tags: ["나"], tagsByUser: true }));
    await run(pc);
    expect((await run(phone)).notices).toEqual([]);
    expect(github.note(note.id).tags.sort()).toEqual(["가", "나"]);
  });
});

describe("읽을 수 없는 파일", () => {
  it("알리고 덮어쓰지 않으며, 고쳐지면 다시 받는다", async () => {
    const note = await shared();
    const path = `notes/${note.id}.md`;
    github.write(path, "손으로 고치다 깨진 파일");
    await retext(phone, note.id, "휴대폰에서 고침");
    await phone.addNotes(["다른 노트"], NOW);

    const result = await run(phone);
    expect(result).toMatchObject({ status: "ok", unreadable: [path] });
    expect(github.files.get(path)).toBe("손으로 고치다 깨진 파일");
    expect(github.noteIds()).toHaveLength(2);
    expect(await pending(phone)).toBe(1);

    github.write(path, serializeNote(note));
    expect((await run(phone)).unreadable).toEqual([]);
    expect(github.note(note.id).text).toBe("휴대폰에서 고침");
  });
});
