// 원격에서 받은 파일 하나를 이 기기의 항목에 반영하는 규칙. 저장은 하지 않는다.
import { mergeNotes } from "../core/merge.ts";
import { notePath, parseNote, serializeNote, type StoredNote } from "../core/note-file.ts";

export interface RemoteFile {
  content: string;
  /** Git blob의 해시 */
  sha: string;
}

export interface Entry {
  id: string;
  /** 이 기기에서 보는 내용. null이면 지웠고 아직 올리지 못한 상태다. */
  note: StoredNote | null;
  /** 마지막으로 맞춘 원격 파일 내용. null이면 원격에 없다. 합칠 때의 기준이다. */
  base: string | null;
  /** base의 blob 해시 */
  sha?: string;
  /** 1이면 아직 올리지 못했다. (IndexedDB 색인은 참/거짓을 담지 못한다) */
  dirty: 0 | 1;
  /** 이 기기에서 바꿀 때마다 늘어난다. 올리는 동안 또 바뀌었는지 가린다. */
  revision: number;
  /** 마지막으로 올리려 한 내용. 응답을 받지 못해도 내가 올린 것을 알아본다. */
  sent?: string;
  /** 본문이 양쪽에서 바뀌어 사용자가 골라야 하는 원격 내용 */
  conflict?: RemoteFile;
}

/** 사용자에게 알릴 일 */
export type Notice =
  /** 이 기기에서 지웠지만 다른 곳에서 본문을 고쳐 되살렸다. */
  | "kept-edit"
  /** 다른 곳에서 지웠지만 이 기기에서 본문을 고쳐 남겼다. */
  | "kept-local"
  /** 같은 ID의 다른 노트가 있어 이 기기의 노트에 새 ID를 줬다. */
  | "renamed"
  | "conflict";

export interface Outcome {
  /** undefined면 그대로, null이면 항목을 지운다. */
  entry?: Entry | null;
  /** 새 ID를 줘서 따로 남겨야 하는 이 기기의 노트 */
  moved?: StoredNote;
  notice?: Notice;
}

/** 읽을 수 없는 파일이면 FormatError를 던진다. */
export function reconcile(id: string, entry: Entry | undefined, remote: RemoteFile | null): Outcome {
  const parse = (content: string) => parseNote(notePath(id), content);
  const theirs = remote && parse(remote.content);
  const clean = (): Entry => ({
    id,
    note: theirs,
    base: remote!.content,
    sha: remote!.sha,
    dirty: 0,
    revision: (entry?.revision ?? 0) + 1,
  });

  if (!entry?.dirty) {
    if (remote) return { entry: clean() };
    return entry ? { entry: null } : {};
  }

  const mine = entry.note;
  // 내가 올린 내용이 돌아온 경우에는 그것이 새 기준이다.
  const base = remote && remote.content === entry.sent ? entry.sent : entry.base;
  const pending = (note: StoredNote | null, newBase: string | null, sha?: string): Entry => ({
    id,
    note,
    base: newBase,
    ...(sha === undefined ? {} : { sha }),
    dirty: 1,
    revision: entry.revision + 1,
  });

  if (!remote) {
    if (!mine) return { entry: null };
    if (base === null) return {};
    if (mine.text === parse(base).text) return { entry: null };
    return { entry: pending(mine, null), notice: "kept-local" };
  }

  if (mine && serializeNote(mine) === serializeNote(theirs!)) return { entry: clean() };
  if (remote.content === base) return { entry: pending(mine, base, remote.sha) };

  if (base === null) {
    // 지운 노트를 올린 적이 없다면 원격의 것은 다른 노트다.
    if (!mine) return { entry: clean() };
    if (mine.created === theirs!.created && mine.text === theirs!.text) {
      return { entry: pending(mergeNotes(theirs!, mine, theirs!).note, remote.content, remote.sha) };
    }
    return { entry: clean(), moved: mine, notice: "renamed" };
  }

  const before = parse(base);
  if (!mine) {
    if (theirs!.text !== before.text) return { entry: clean(), notice: "kept-edit" };
    return { entry: pending(null, remote.content, remote.sha) };
  }

  const merged = mergeNotes(before, mine, theirs!);
  if (merged.textConflict) {
    // 기준은 그대로 두어, 원격이 또 바뀌어도 같은 방법으로 다시 합친다.
    return {
      entry: { ...pending(merged.note, base, entry.sha), conflict: remote },
      notice: entry.conflict ? undefined : "conflict",
    };
  }
  if (serializeNote(merged.note) === serializeNote(theirs!)) return { entry: clean() };
  return { entry: pending(merged.note, remote.content, remote.sha) };
}
