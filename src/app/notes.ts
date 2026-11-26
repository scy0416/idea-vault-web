// 입력, 목록 거르기, 노트 수정의 규칙.
import { cleanTag } from "../core/linking.ts";
import type { StoredNote } from "../core/note-file.ts";

/** 여러 줄을 붙여 넣으면 한 줄이 노트 하나다. 목록 기호는 뗀다. */
export function splitInput(text: string): string[] {
  return text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

/** PC는 Enter로 저장한다. 휴대폰의 Enter와 한글을 조합하는 중의 Enter는 저장이 아니다. */
export function isSaveKey(
  event: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number },
  finePointer: boolean,
): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && finePointer;
}

export interface Filter {
  tag: string | null;
  query: string;
}

/** 검색어의 낱말이 본문, 태그, 번호 어딘가에 모두 있는 노트 */
export function filterNotes(notes: StoredNote[], { tag, query }: Filter): StoredNote[] {
  const words = fold(query).split(/\s+/).map((w) => w.replace(/^#+/, "")).filter(Boolean);
  return notes.filter((n) => {
    if (tag !== null && !n.tags.includes(tag)) return false;
    if (!words.length) return true;
    const haystack = fold(`${n.text} ${n.tags.join(" ")} ${n.id}`);
    return words.every((w) => haystack.includes(w));
  });
}

// 맥 등에서 풀어 쓴 한글도 같은 글자로 본다.
const fold = (text: string) => text.normalize("NFC").toLowerCase();

/** 많이 쓴 태그부터 */
export function tagCounts(notes: StoredNote[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of new Set(n.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
}

// 아래 수정은 바뀐 것이 없으면 받은 노트를 그대로 돌려준다. 직접 고친 태그는 AI가 덮어쓰지 않는다.

export function addTag(note: StoredNote, input: string): StoredNote {
  const tag = cleanTag(input);
  if (!tag || note.tags.includes(tag)) return note;
  return { ...note, tags: [...note.tags, tag], tagsByUser: true };
}

export function removeTag(note: StoredNote, tag: string): StoredNote {
  if (!note.tags.includes(tag)) return note;
  return { ...note, tags: note.tags.filter((t) => t !== tag), tagsByUser: true };
}

/** 저장하지 않은 본문과, 적기 시작할 때의 본문 */
export interface Draft {
  text: string;
  from: string;
}

/** 저장할 본문. 앞뒤 빈 줄만 다듬는다. */
export const cleanBody = (text: string): string => text.replace(/\r\n?/g, "\n").trim();

export function editText(note: StoredNote, text: string): StoredNote {
  const next = cleanBody(text);
  return !next || next === note.text ? note : { ...note, text: next };
}

/** "2026-11-26T15:30:12+09:00" → "2026-11-26 15:30". 적은 곳의 시각을 그대로 보여준다. */
export const shortTime = (created: string): string => created.slice(0, 16).replace("T", " ");
