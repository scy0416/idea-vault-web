// 노트 저장소의 파일 형식: notes/<id>.md 와 vault.json (설계 3절).
import { Document, isSeq, parse } from "yaml";
import { isNoteId, localTimestamp, noteId, uniqueNoteId } from "./note-id.ts";
import type { Note } from "./types.ts";

export interface StoredLink {
  to: string;
  why: string;
  by: "ai" | "user";
  at: string;
  /** 끊은 연결. 지우지 않고 남긴다. */
  removed?: boolean;
  /** 앱이 모르는 항목. 다시 쓸 때 그대로 둔다. */
  extra?: Record<string, unknown>;
}

export interface StoredNote extends Note {
  created: string;
  tagsByUser: boolean;
  /** 태그·연결을 처리한 본문의 해시. 없으면 처리 전이다. */
  processed?: string;
  links: StoredLink[];
  extra?: Record<string, unknown>;
}

/** 읽을 수 없는 파일. 덮어쓰지 말고 사용자에게 알려야 한다. */
export class FormatError extends Error {}

export const NOTES_DIR = "notes";
export const notePath = (id: string): string => `${NOTES_DIR}/${id}.md`;

/** 노트 파일의 경로가 아니면 null */
export function idFromPath(path: string): string | null {
  return /^notes\/(\d{14})\.md$/.exec(path)?.[1] ?? null;
}

export function createNote(text: string, usedIds: Set<string>, now: Date = new Date()): StoredNote {
  return {
    id: uniqueNoteId(noteId(now), usedIds),
    created: localTimestamp(now),
    text: normalize(text).trim(),
    tags: [],
    tagsByUser: false,
    links: [],
  };
}

const normalize = (content: string) => content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

export function serializeNote(note: StoredNote): string {
  const front = new Document({
    id: note.id,
    created: note.created,
    tags: note.tags,
    tagsByUser: note.tagsByUser,
    ...(note.processed === undefined ? {} : { processed: note.processed }),
    links: note.links.map(({ to, why, by, at, removed, extra }) => ({
      to,
      why,
      by,
      at,
      ...(removed ? { removed: true } : {}),
      ...extra,
    })),
    ...note.extra,
  });
  const tags = front.get("tags", true);
  if (isSeq(tags)) tags.flow = true;
  const yaml = front.toString({ lineWidth: 0, flowCollectionPadding: false });
  return `---\n${yaml}---\n${normalize(note.text)}\n`;
}

export function parseNote(path: string, content: string): StoredNote {
  const fileId = idFromPath(path);
  const fail = (reason: string): never => {
    throw new FormatError(`${path}: ${reason}`);
  };
  if (!fileId) fail("노트 파일 경로가 아닙니다.");

  const match = /^---\n([\s\S]*?)^---(?:\n|$)([\s\S]*)$/m.exec(normalize(content));
  if (!match || match.index !== 0) fail("머리말(---)이 없습니다.");
  const [, head, body] = match as unknown as [string, string, string];

  let data: unknown;
  try {
    data = parse(head);
  } catch {
    fail("머리말을 읽을 수 없습니다.");
  }
  if (!isRecord(data)) fail("머리말을 읽을 수 없습니다.");
  const { id, created, tags, tagsByUser, processed, links, ...extra } = data as Record<string, unknown>;

  if (asId(id) !== fileId) fail("id가 파일 이름과 다릅니다.");
  if (!isTime(created)) fail("created가 시각이 아닙니다.");
  if (tags != null && !(Array.isArray(tags) && tags.every(isScalar))) fail("tags가 목록이 아닙니다.");
  if (tagsByUser != null && typeof tagsByUser !== "boolean") fail("tagsByUser가 참/거짓이 아닙니다.");
  if (processed != null && typeof processed !== "string") fail("processed가 글자가 아닙니다.");
  if (links != null && !Array.isArray(links)) fail("links가 목록이 아닙니다.");

  const note: StoredNote = {
    id: fileId!,
    created: created as string,
    text: body.replace(/\n$/, ""),
    tags: ((tags ?? []) as unknown[]).map(String),
    tagsByUser: (tagsByUser as boolean | undefined) ?? false,
    links: ((links ?? []) as unknown[]).map((raw, i) => {
      const where = `links ${i + 1}번째`;
      if (!isRecord(raw)) fail(`${where}를 읽을 수 없습니다.`);
      const { to, why, by, at, removed, ...rest } = raw as Record<string, unknown>;
      const target = asId(to);
      if (!target) fail(`${where}의 to가 노트 ID가 아닙니다.`);
      if (typeof why !== "string") fail(`${where}에 why가 없습니다.`);
      if (by !== "ai" && by !== "user") fail(`${where}의 by는 ai 또는 user여야 합니다.`);
      if (!isTime(at)) fail(`${where}의 at이 시각이 아닙니다.`);
      if (removed != null && typeof removed !== "boolean") fail(`${where}의 removed가 참/거짓이 아닙니다.`);
      return {
        to: target!,
        why: why as string,
        by: by as StoredLink["by"],
        at: at as string,
        ...(removed ? { removed: true } : {}),
        ...(Object.keys(rest).length ? { extra: rest } : {}),
      };
    }),
  };
  if (typeof processed === "string") note.processed = processed;
  if (Object.keys(extra).length) note.extra = extra;
  return note;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown) => typeof value === "string" || typeof value === "number";
const isTime = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));

/** 손으로 고쳐 따옴표가 빠진 ID는 숫자로 읽힌다. */
function asId(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && isNoteId(text) ? text : null;
}

export const VAULT_PATH = "vault.json";
export const VAULT_VERSION = 1;

export const serializeVault = (): string => `${JSON.stringify({ version: VAULT_VERSION }, null, 2)}\n`;

/** 이 앱이 다룰 수 있는 저장소인지 확인한다. */
export function parseVault(content: string): { version: number } {
  let data: unknown;
  try {
    data = JSON.parse(normalize(content));
  } catch {
    throw new FormatError(`${VAULT_PATH}: JSON이 아닙니다.`);
  }
  const version = isRecord(data) ? data.version : undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new FormatError(`${VAULT_PATH}: version이 없습니다.`);
  }
  if (version > VAULT_VERSION) {
    throw new FormatError(`${VAULT_PATH}: 더 새로운 형식(${version})입니다. 앱을 업데이트하세요.`);
  }
  return { version };
}
