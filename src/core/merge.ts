// 같은 노트가 이 기기와 원격에서 모두 바뀌었을 때 합친다.
// 태그와 연결은 합치고, 본문이 양쪽에서 다르게 바뀌면 사용자가 고른다.
import type { StoredLink, StoredNote } from "./note-file.ts";

export interface Merged {
  /** 본문이 충돌하면 이 기기의 본문을 담는다. */
  note: StoredNote;
  textConflict: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 한쪽만 바꿨으면 바꾼 쪽. 둘 다 바꿨으면 both가 고른다. */
function pick<T>(base: T, local: T, remote: T, both: () => T): T {
  if (same(local, base)) return remote;
  if (same(remote, base) || same(local, remote)) return local;
  return both();
}

export function mergeNotes(base: StoredNote, local: StoredNote, remote: StoredNote): Merged {
  let textConflict = false;
  const text = pick(base.text, local.text, remote.text, () => {
    textConflict = true;
    return local.text;
  });
  // 처리 해시는 고른 본문 쪽의 값을 따른다.
  const processed =
    text === local.text && local.processed !== base.processed ? local.processed : remote.processed;

  const note: StoredNote = {
    id: local.id,
    created: remote.created,
    text,
    ...mergeTags(base, local, remote),
    links: mergeLinks(base.links, local.links, remote.links),
  };
  if (processed !== undefined) note.processed = processed;
  const extra = mergeRecord(base.extra, local.extra, remote.extra);
  if (extra) note.extra = extra;
  return { note, textConflict };
}

function mergeTags(base: StoredNote, local: StoredNote, remote: StoredNote) {
  const tagsByUser = local.tagsByUser || remote.tagsByUser;
  // 직접 고친 태그를 AI의 태그가 덮지 않는다.
  if (!base.tagsByUser && local.tagsByUser !== remote.tagsByUser) {
    return { tags: (local.tagsByUser ? local : remote).tags, tagsByUser };
  }
  const tags = pick(base.tags, local.tags, remote.tags, () => {
    const removed = new Set(base.tags.filter((t) => !local.tags.includes(t) || !remote.tags.includes(t)));
    return [...new Set([...remote.tags, ...local.tags])].filter((t) => !removed.has(t));
  });
  return { tags, tagsByUser };
}

function mergeLinks(base: StoredLink[], local: StoredLink[], remote: StoredLink[]): StoredLink[] {
  const index = (links: StoredLink[]) => new Map(links.map((l) => [l.to, l]));
  const [b, l, r] = [index(base), index(local), index(remote)];
  const targets = new Set([...r.keys(), ...l.keys()]);
  return [...targets].flatMap((to) => {
    const link = pick(b.get(to), l.get(to), r.get(to), () => {
      const [mine, theirs] = [l.get(to), r.get(to)];
      // 한쪽에서 항목이 없어졌으면 가리키던 노트를 지운 것이다.
      if (!mine || !theirs) return undefined;
      // 나중에 한 결정을 따르고, 같으면 끊은 쪽을 남긴다.
      const order = Date.parse(mine.at) - Date.parse(theirs.at);
      if (order !== 0) return order > 0 ? mine : theirs;
      return mine.removed ? mine : theirs;
    });
    return link ? [link] : [];
  });
}

function mergeRecord(
  base: Record<string, unknown> = {},
  local: Record<string, unknown> = {},
  remote: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const keys = new Set([...Object.keys(remote), ...Object.keys(local)]);
  const entries = [...keys].flatMap((key) => {
    const value = pick(base[key], local[key], remote[key], () => local[key]);
    return value === undefined ? [] : [[key, value] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
