// 기기 저장 (설계 8절). 원본은 GitHub이며 이곳은 지워져도 되는 캐시다.
// 예외는 아직 올리지 못한 변경으로, 올리기 전에는 원격 내용으로 덮어쓰지 않는다.
import { createNote, notePath, parseNote, serializeNote, type StoredNote } from "../core/note-file.ts";
import { uniqueNoteId } from "../core/note-id.ts";
import { result, transact } from "./idb.ts";
import { reconcile, type Entry, type Notice, type RemoteFile } from "./reconcile.ts";

export type { Entry, Notice, RemoteFile };

export const DB_NAME = "idea-vault";
const DB_VERSION = 1;
const NOTES = "notes";
const META = "meta";
const SETTINGS_KEY = "settings";
const SYNC_KEY = "sync";

/** 사용자가 알아야 할 올리지 못한 변경인지. 올린 적 없이 지운 노트는 잃을 것이 없다. */
export const isUnsent = (e: Entry): boolean => e.dirty === 1 && (e.note !== null || e.base !== null);

export interface Settings {
  /** "소유자/저장소" */
  repository?: string;
  githubToken?: string;
  openaiKey?: string;
}

/** 마지막으로 전부 받아 온 원격의 위치 */
export interface SyncState {
  repository: string;
  head: string;
}

/** 충돌한 본문 중 남길 것. both는 이 기기의 본문을 새 노트로 함께 남긴다. */
export type Choice = "local" | "remote" | "both";

export type Store = Awaited<ReturnType<typeof openStore>>;

export async function openStore(factory: IDBFactory = indexedDB, name: string = DB_NAME) {
  const request = factory.open(name, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore(NOTES, { keyPath: "id" }).createIndex("dirty", "dirty");
    db.createObjectStore(META);
  };
  const db = await result(request);
  // 다른 탭에서 지우거나 새 버전을 열 때 막지 않는다.
  db.onversionchange = () => db.close();

  const read = <T>(store: string, work: (s: IDBObjectStore) => Promise<T>) =>
    transact(db, [store], "readonly", (tx) => work(tx.objectStore(store)));
  const write = <T>(store: string, work: (s: IDBObjectStore) => Promise<T>) =>
    transact(db, [store], "readwrite", (tx) => work(tx.objectStore(store)));

  const getEntry = (s: IDBObjectStore, id: string) => result<Entry | undefined>(s.get(id));
  const allEntries = (s: IDBObjectStore) => result<Entry[]>(s.getAll());

  /** 이 기기의 변경으로 기록한다. */
  async function change(s: IDBObjectStore, previous: Entry | undefined, id: string, note: StoredNote | null) {
    const entry: Entry = {
      ...previous,
      id,
      note,
      base: previous?.base ?? null,
      dirty: 1,
      revision: (previous?.revision ?? 0) + 1,
    };
    // 충돌한 노트를 지우면 지금의 원격 내용을 지우는 것이다.
    if (note === null && entry.conflict) {
      entry.base = entry.conflict.content;
      entry.sha = entry.conflict.sha;
      delete entry.conflict;
    }
    await result(s.put(entry));
  }

  return {
    /** 새 것부터 */
    async listNotes(): Promise<StoredNote[]> {
      const entries = await read(NOTES, allEntries);
      return entries.flatMap((e) => (e.note ? [e.note] : [])).sort((a, b) => b.id.localeCompare(a.id));
    },

    getEntry: (id: string) => read(NOTES, (s) => getEntry(s, id)),

    listEntries: () => read(NOTES, allEntries),

    /** 원격과 맞춘 적이 있는 노트가 있는지. 있으면 저장소를 바꿀 때 섞인다. */
    async hasSynced(): Promise<boolean> {
      return (await read(NOTES, allEntries)).some((e) => e.base !== null);
    },

    /** 아직 올리지 못한 변경. 오래된 노트부터 */
    listPending: () => read(NOTES, (s) => result<Entry[]>(s.index("dirty").getAll(1))),

    /** 여러 노트를 한 번에 만든다. ID는 같은 트랜잭션 안에서 골라 겹치지 않는다. */
    addNotes(texts: string[], now: Date = new Date()): Promise<StoredNote[]> {
      return write(NOTES, async (s) => {
        const used = new Set((await result(s.getAllKeys())) as string[]);
        const notes = texts.filter((t) => t.trim()).map((t) => createNote(t, used, now));
        for (const note of notes) await change(s, undefined, note.id, note);
        return notes;
      });
    },

    /** 있는 노트의 수정. 그사이 지운 노트는 되살리지 않고 false를 돌려준다. */
    saveNote(note: StoredNote): Promise<boolean> {
      return write(NOTES, async (s) => {
        const previous = await getEntry(s, note.id);
        if (!previous?.note) return false;
        await change(s, previous, note.id, note);
        return true;
      });
    },

    /**
     * 저장된 최신 내용에 edit를 적용한다. 잇따라 고쳐도 앞의 변경을 덮어쓰지 않는다.
     * edit가 받은 노트를 그대로 돌려주면 아무것도 바꾸지 않는다. 지운 노트면 false
     */
    updateNote(id: string, edit: (note: StoredNote) => StoredNote): Promise<boolean> {
      return write(NOTES, async (s) => {
        const previous = await getEntry(s, id);
        if (!previous?.note) return false;
        const next = edit(previous.note);
        if (next !== previous.note) await change(s, previous, id, next);
        return true;
      });
    },

    /** 노트를 지우고, 그 노트를 가리키는 연결도 함께 지운다. */
    deleteNote(id: string): Promise<void> {
      return write(NOTES, async (s) => {
        for (const entry of await allEntries(s)) {
          if (!entry.note) continue;
          if (entry.id === id) {
            // 올리는 중일 수 있으므로 원격에 없던 노트도 지운 표시를 남긴다.
            await change(s, entry, id, null);
          } else if (entry.note.links.some((l) => l.to === id)) {
            const links = entry.note.links.filter((l) => l.to !== id);
            await change(s, entry, entry.id, { ...entry.note, links });
          }
        }
      });
    },

    /** 올리기 전에 부른다. 응답을 받지 못해도 다음에 받은 내용이 내 것인지 알 수 있다. */
    markSending(items: { id: string; content: string }[]): Promise<void> {
      return write(NOTES, async (s) => {
        for (const { id, content } of items) {
          const entry = await getEntry(s, id);
          if (entry) await result(s.put({ ...entry, sent: content } satisfies Entry));
        }
      });
    },

    /**
     * 올리기에 성공한 뒤 부른다. revision은 올린 시점의 값, file은 올린 파일(지웠으면 null)이다.
     * 올리는 동안 또 바뀌었으면 아직 올리지 못한 상태로 남는다.
     */
    markUploaded(id: string, revision: number, file: RemoteFile | null): Promise<void> {
      return write(NOTES, async (s) => {
        const entry = await getEntry(s, id);
        if (!entry) return;
        const unchanged = entry.revision === revision;
        if (unchanged && !entry.note) return void (await result(s.delete(id)));
        const next: Entry = { ...entry, base: file?.content ?? null, dirty: unchanged ? 0 : 1 };
        if (file) next.sha = file.sha;
        else delete next.sha;
        delete next.sent;
        await result(s.put(next));
      });
    },

    /**
     * 원격에서 받은 파일을 반영한다. remote가 null이면 원격에 없는 것이다.
     * 올리지 못한 변경은 합친다. 읽을 수 없는 파일이면 FormatError를 던지고 이전 내용을 남긴다.
     * remoteIds는 새 ID를 줄 때 피할 원격의 ID다.
     */
    receive(id: string, remote: RemoteFile | null, remoteIds: Iterable<string> = []): Promise<Notice | undefined> {
      return write(NOTES, async (s) => {
        const outcome = reconcile(id, await getEntry(s, id), remote);
        if (outcome.entry === null) await result(s.delete(id));
        else if (outcome.entry) await result(s.put(outcome.entry));
        if (outcome.moved) {
          const used = new Set([...((await result(s.getAllKeys())) as string[]), ...remoteIds]);
          const newId = uniqueNoteId(id, used);
          // 함께 올리기 전이던 노트의 연결은 새 ID를 따라간다.
          for (const entry of await allEntries(s)) {
            if (entry.base !== null || !entry.note?.links.some((l) => l.to === id)) continue;
            const links = entry.note.links.map((l) => (l.to === id ? { ...l, to: newId } : l));
            await change(s, entry, entry.id, { ...entry.note, links });
          }
          await change(s, undefined, newId, { ...outcome.moved, id: newId });
        }
        return outcome.notice;
      });
    },

    /** 충돌한 본문 중 남길 것을 고른다. 태그와 연결은 이미 합쳐져 있다. */
    resolveConflict(id: string, choice: Choice, now: Date = new Date()): Promise<boolean> {
      return write(NOTES, async (s) => {
        const entry = await getEntry(s, id);
        if (!entry?.note || !entry.conflict) return false;
        const { conflict, ...rest } = entry;
        const theirs = parseNote(notePath(id), conflict.content);
        let note = entry.note;
        if (choice !== "local") {
          note = { ...note, text: theirs.text };
          if (theirs.processed === undefined) delete note.processed;
          else note.processed = theirs.processed;
        }
        await result(
          s.put({
            ...rest,
            note,
            base: conflict.content,
            sha: conflict.sha,
            dirty: serializeNote(note) === serializeNote(theirs) ? 0 : 1,
            revision: entry.revision + 1,
          } satisfies Entry),
        );
        if (choice === "both") {
          const used = new Set((await result(s.getAllKeys())) as string[]);
          const copy = createNote(entry.note.text, used, now);
          const { tags, tagsByUser, text } = entry.note;
          await change(s, undefined, copy.id, { ...copy, text, tags, tagsByUser });
        }
        return true;
      });
    },

    getSyncState: () => read(META, (s) => result<SyncState | undefined>(s.get(SYNC_KEY))),

    saveSyncState(state: SyncState): Promise<void> {
      return write(META, async (s) => {
        await result(s.put(state, SYNC_KEY));
      });
    },

    async getSettings(): Promise<Settings> {
      return (await read(META, (s) => result<Settings | undefined>(s.get(SETTINGS_KEY)))) ?? {};
    },

    /** 준 항목만 바꾼다. 빈 값은 지운다. */
    saveSettings(patch: Settings): Promise<Settings> {
      return write(META, async (s) => {
        const merged: Settings = { ...(await result<Settings | undefined>(s.get(SETTINGS_KEY))), ...patch };
        for (const key of Object.keys(merged) as (keyof Settings)[]) {
          merged[key] = merged[key]?.trim();
          if (!merged[key]) delete merged[key];
        }
        await result(s.put(merged, SETTINGS_KEY));
        return merged;
      });
    },

    /** 이 기기에서 지우기: 토큰, 키, 캐시, 올리지 못한 변경까지 모두. 부르기 전에 사용자에게 알린다. */
    async wipe(): Promise<void> {
      await transact(db, [NOTES, META], "readwrite", async (tx) => {
        await result(tx.objectStore(NOTES).clear());
        await result(tx.objectStore(META).clear());
      });
    },

    close: () => db.close(),
  };
}

/** 브라우저에 저장 공간을 지우지 말아 달라고 요청한다. 거절되거나 지원하지 않으면 false */
export async function requestPersistence(storage: StorageManager | undefined = navigator.storage): Promise<boolean> {
  try {
    return (await storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
