// 기기 저장 (설계 8절). 원본은 GitHub이며 이곳은 지워져도 되는 캐시다.
// 예외는 아직 올리지 못한 변경으로, 올리기 전에는 원격 내용으로 덮어쓰지 않는다.
import { createNote, notePath, parseNote, type StoredNote } from "../core/note-file.ts";
import { result, transact } from "./idb.ts";

export const DB_NAME = "idea-vault";
const DB_VERSION = 1;
const NOTES = "notes";
const META = "meta";
const SETTINGS_KEY = "settings";

export interface Entry {
  id: string;
  /** 이 기기에서 보는 내용. null이면 지웠고 아직 올리지 못한 상태다. */
  note: StoredNote | null;
  /** 마지막으로 맞춘 원격 파일 내용. null이면 원격에 없다. 합칠 때의 기준이다. */
  base: string | null;
  /** 1이면 아직 올리지 못했다. (IndexedDB 색인은 참/거짓을 담지 못한다) */
  dirty: 0 | 1;
  /** 이 기기에서 바꿀 때마다 늘어난다. 올리는 동안 또 바뀌었는지 가린다. */
  revision: number;
}

export interface Settings {
  /** "소유자/저장소" */
  repository?: string;
  githubToken?: string;
  openaiKey?: string;
}

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
      id,
      note,
      base: previous?.base ?? null,
      dirty: 1,
      revision: (previous?.revision ?? 0) + 1,
    };
    await result(s.put(entry));
  }

  return {
    /** 새 것부터 */
    async listNotes(): Promise<StoredNote[]> {
      const entries = await read(NOTES, allEntries);
      return entries.flatMap((e) => (e.note ? [e.note] : [])).sort((a, b) => b.id.localeCompare(a.id));
    },

    getEntry: (id: string) => read(NOTES, (s) => getEntry(s, id)),

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

    /**
     * 올리기에 성공한 뒤 부른다. revision은 올린 시점의 값, content는 올린 파일 내용(지웠으면 null)이다.
     * 올리는 동안 또 바뀌었으면 아직 올리지 못한 상태로 남는다.
     */
    markUploaded(id: string, revision: number, content: string | null): Promise<void> {
      return write(NOTES, async (s) => {
        const entry = await getEntry(s, id);
        if (!entry) return;
        const unchanged = entry.revision === revision;
        if (unchanged && !entry.note) await result(s.delete(id));
        else await result(s.put({ ...entry, base: content, dirty: unchanged ? 0 : 1 } satisfies Entry));
      });
    },

    /**
     * 원격에서 받은 내용을 반영한다. content가 null이면 원격에서 지워진 것이다.
     * 아직 올리지 못한 변경이 있으면 건드리지 않고 "pending"을 돌려준다. 합치기는 동기화가 한다.
     * 읽을 수 없는 파일이면 FormatError를 던지고 이전 내용을 남긴다.
     */
    async applyRemote(id: string, content: string | null): Promise<"applied" | "pending"> {
      const note = content === null ? null : parseNote(notePath(id), content);
      return write(NOTES, async (s) => {
        if ((await getEntry(s, id))?.dirty) return "pending";
        if (note === null) await result(s.delete(id));
        else await result(s.put({ id, note, base: content, dirty: 0, revision: 0 } satisfies Entry));
        return "applied";
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
