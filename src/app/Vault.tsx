import { useCallback, useEffect, useState } from "react";
import type { StoredNote } from "../core/note-file.ts";
import { isUnsent, requestPersistence, type Store } from "../storage/store.ts";
import { Capture } from "./Capture.tsx";
import { NoteDialog } from "./NoteDialog.tsx";
import { NoteList } from "./NoteList.tsx";
import { addTag, editText, removeTag, type Filter } from "./notes.ts";

const NO_FILTER: Filter = { tag: null, query: "" };

interface Loaded {
  notes: StoredNote[];
  pending: Set<string>;
}

/** 입력창과 노트 화면. hidden이면 적던 글을 둔 채 감춘다. */
export function Vault({ store, hidden }: { store: Store; hidden: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState(NO_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [notes, entries] = await Promise.all([store.listNotes(), store.listPending()]);
    setLoaded({ notes, pending: new Set(entries.filter(isUnsent).map((e) => e.id)) });
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

  // 설정에서 지웠을 수 있으므로 다시 보일 때 새로 읽는다.
  useEffect(() => {
    if (!hidden) void run(async () => {}, "노트를 읽지 못했습니다. 페이지를 다시 열어 보세요.");
  }, [hidden, run]);

  const unsaved = Boolean(input.trim()) || Object.keys(drafts).length > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const setDraft = (id: string, draft: string | undefined) =>
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
    else void requestPersistence();
  };

  const edit = (id: string, change: (note: StoredNote) => StoredNote) =>
    run(() => store.updateNote(id, change), "고치지 못했습니다. 다시 시도하세요.");

  const open = loaded?.notes.find((n) => n.id === openId);

  return (
    <div className="stack" hidden={hidden}>
      <Capture value={input} onChange={setInput} onSubmit={(lines) => void add(lines)} />
      {error && !open && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {loaded && loaded.pending.size > 0 && (
        <p className="notice" role="status">
          올리지 못한 변경 {loaded.pending.size}개가 이 기기에만 있습니다. GitHub에 올리는 기능은 아직 없습니다.
        </p>
      )}
      {loaded && (
        <NoteList
          notes={loaded.notes}
          pending={loaded.pending}
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
          error={error}
          onDraft={(draft) => setDraft(open.id, draft)}
          onSaveText={(text) =>
            void edit(open.id, (n) => editText(n, text)).then((ok) => ok && setDraft(open.id, undefined))
          }
          onAddTag={(tag) => void edit(open.id, (n) => addTag(n, tag))}
          onRemoveTag={(tag) => void edit(open.id, (n) => removeTag(n, tag))}
          onDelete={() =>
            void run(() => store.deleteNote(open.id), "지우지 못했습니다. 다시 시도하세요.").then((ok) => {
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
