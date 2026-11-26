// 시험할 노트를 읽는다: 한 줄에 하나인 글 파일, 또는 시제품에서 내려받은 JSON.
import { isNoteId, noteId, uniqueNoteId } from "../../src/core/note-id.ts";
import type { Note } from "../../src/core/types.ts";

export const MAX_TEXT = 2000;

export function parseLines(content: string, start: Date = new Date()): Note[] {
  const used = new Set<string>();
  return content
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .map((text) => ({ id: uniqueNoteId(noteId(start), used), text: text.slice(0, MAX_TEXT), tags: [] }));
}

/** 시제품 JSON. 예시 노트는 빼고, 태그와 연결은 새로 시험하므로 가져오지 않는다. */
export function parseExport(content: string): Note[] {
  const data = JSON.parse(content.replace(/^﻿/, ""));
  if (!Array.isArray(data?.notes)) throw new Error("notes 배열이 없는 JSON입니다.");
  const used = new Set<string>();
  return (data.notes as any[])
    .filter((n) => !n?.example && typeof n?.text === "string" && n.text.trim())
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
    .map((n) => {
      const id = isNoteId(String(n.zid)) ? String(n.zid) : noteId(new Date(n.created ?? Date.now()));
      return { id: uniqueNoteId(id, used), text: n.text.trim().slice(0, MAX_TEXT), tags: [] };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function parseNotes(fileName: string, content: string): Note[] {
  return fileName.toLowerCase().endsWith(".json") ? parseExport(content) : parseLines(content);
}
