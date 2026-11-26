import { useCallback, useEffect, useState } from "react";
import { notePath, parseNote, type StoredNote } from "../core/note-file.ts";
import { isUnsent, requestPersistence, type Store } from "../storage/store.ts";
import { Capture } from "./Capture.tsx";
import { NoteDialog } from "./NoteDialog.tsx";
import { NoteList } from "./NoteList.tsx";
import { addTag, editText, removeTag, type Draft, type Filter } from "./notes.ts";
import { SyncBar } from "./SyncBar.tsx";
import { useSync } from "./useSync.ts";

const NO_FILTER: Filter = { tag: null, query: "" };
const READ_FAILURE = "노트를 읽지 못했습니다. 페이지를 다시 열어 보세요.";

interface Loaded {
  notes: StoredNote[];
  pending: Set<string>;
  /** 노트 ID → 충돌한 저장소 쪽 본문 */
  conflicts: Map<string, string>;
}

/** 입력창과 노트 화면. hidden이면 적던 글을 둔 채 감춘다. */
export function Vault({ store, hidden }: { store: Store; hidden: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState(NO_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const sync = useSync(store);
  const { now: syncNow, changed: syncChanged, version } = sync;

  const reload = useCallback(async () => {
    const [notes, entries] = await Promise.all([store.listNotes(), store.listPending()]);
    const conflicts = entries.flatMap((e) =>
      e.conflict ? [[e.id, parseNote(notePath(e.id), e.conflict.content).text] as const] : [],
    );
    setLoaded({
      notes,
      pending: new Set(entries.filter(isUnsent).map((e) => e.id)),
      conflicts: new Map(conflicts),
    });
  }, [store]);

  const run = useCallback(
    async (work: () => Promise<unknown>, failure: string) => {
      setError(null);
      try {
        await work();
        await reload();
        return true;
      } catch {
        setError(failure);
        return false;
      }
    },
    [reload],
  );

  // 동기화가 끝날 때마다 새로 읽는다.
  useEffect(() => {
    void reload().catch(() => setError(READ_FAILURE));
  }, [reload, version]);

  // 설정에서 지우거나 바꿨을 수 있으므로 다시 보일 때 새로 읽고 동기화한다.
  useEffect(() => {
    if (hidden) return;
    void reload().catch(() => setError(READ_FAILURE));
    syncNow();
  }, [hidden, reload, syncNow]);

  const unsaved = Boolean(input.trim()) || Object.keys(drafts).length > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const setDraft = (id: string, draft: Draft | undefined) =>
    setDrafts(({ [id]: _, ...rest }) => (draft === undefined ? rest : { ...rest, [id]: draft }));

  const add = async (lines: string[]) => {
    const raw = input;
    setInput("");
    setFilter(NO_FILTER);
    const saved = await run(
      () => store.addNotes(lines),
      "저장하지 못했습니다. 브라우저의 저장 공간을 확인하고 다시 저장하세요.",
    );
    // 실패하면 적은 글을 입력창에 돌려놓는다.
    if (!saved) setInput((now) => (now ? `${raw}\n${now}` : raw));
    else {
      void requestPersistence();
      syncChanged();
    }
  };

  /** 이 기기의 변경. 성공하면 올릴 차례를 잡는다. */
  const change = async (work: () => Promise<unknown>, failure: string) => {
    const ok = await run(work, failure);
    if (ok) syncChanged();
    return ok;
  };

  const edit = (id: string, apply: (note: StoredNote) => StoredNote) =>
    change(() => store.updateNote(id, apply), "고치지 못했습니다. 다시 시도하세요.");

  const open = loaded?.notes.find((n) => n.id === openId);
  // 다른 곳에서 지워진 노트의 저장하지 않은 수정
  const orphans = loaded ? Object.keys(drafts).filter((id) => !loaded.notes.some((n) => n.id === id)) : [];

  return (
    <div className="stack" hidden={hidden}>
      <Capture value={input} onChange={setInput} onSubmit={(lines) => void add(lines)} />
      {error && !open && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {loaded && (
        <SyncBar
          sync={sync}
          pending={loaded.pending.size}
          conflicts={loaded.conflicts.size}
          onNow={syncNow}
          onDismiss={sync.dismiss}
        />
      )}
      {orphans.map((id) => (
        <div className="notice field" key={id}>
          <p>지워진 노트에 저장하지 않은 수정이 있습니다.</p>
          <p className="version">{drafts[id]!.text}</p>
          <div className="row">
            <button type="button" onClick={() => setDraft(id, undefined)}>
              버리기
            </button>
            <button
              type="button"
              onClick={() =>
                void change(() => store.addNotes([drafts[id]!.text]), "저장하지 못했습니다. 다시 시도하세요.").then(
                  (ok) => ok && setDraft(id, undefined),
                )
              }
            >
              새 노트로 저장
            </button>
          </div>
        </div>
      ))}
      {loaded && (
        <NoteList
          notes={loaded.notes}
          pending={loaded.pending}
          conflicts={loaded.conflicts}
          filter={filter}
          onFilter={setFilter}
          onOpen={(id) => {
            setError(null);
            setOpenId(id);
          }}
        />
      )}
      {open && !hidden && (
        <NoteDialog
          key={open.id}
          note={open}
          pending={loaded!.pending.has(open.id)}
          draft={drafts[open.id]}
          theirs={loaded!.conflicts.get(open.id)}
          onResolve={(choice) =>
            void change(() => store.resolveConflict(open.id, choice), "고르지 못했습니다. 다시 시도하세요.")
          }
          error={error}
          onDraft={(draft) => setDraft(open.id, draft)}
          onSaveText={(text) =>
            void edit(open.id, (n) => editText(n, text)).then((ok) => ok && setDraft(open.id, undefined))
          }
          onAddTag={(tag) => void edit(open.id, (n) => addTag(n, tag))}
          onRemoveTag={(tag) => void edit(open.id, (n) => removeTag(n, tag))}
          onDelete={() =>
            void change(() => store.deleteNote(open.id), "지우지 못했습니다. 다시 시도하세요.").then((ok) => {
              if (!ok) return;
              setDraft(open.id, undefined);
              setOpenId(null);
            })
          }
          onClose={() => {
            setError(null);
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
}
