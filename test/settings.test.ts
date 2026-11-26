import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  importEnv,
  loadSummary,
  MAX_ENV_BYTES,
  pendingCount,
  removeSecret,
  saveRepository,
  saveSecret,
  SettingsError,
  wipeDevice,
} from "../src/app/settings.ts";
import { parseEnv } from "../src/core/env-file.ts";
import { serializeNote } from "../src/core/note-file.ts";
import { parseRepository } from "../src/core/repository.ts";
import { openStore, type Store } from "../src/storage/store.ts";

let store: Store;
beforeEach(async () => {
  store = await openStore(new IDBFactory());
});

const file = (content: string, size = content.length) => ({ size, text: async () => content });
const NONE = { repository: "", hasGithubToken: false, hasOpenaiKey: false };

async function receiveRemote(id = "20260101000000") {
  await store.applyRemote(
    id,
    serializeNote({
      id,
      created: "2026-01-01T00:00:00+09:00",
      text: "받은 노트",
      tags: [],
      tagsByUser: false,
      links: [],
    }),
  );
}

describe(".env 해석", () => {
  it("두 값만 읽는다", () => {
    const content = [
      "﻿# 설명",
      "export GITHUB_TOKEN = 'test-token' # 메모",
      'OPENAI_API_KEY="test#key"',
      "OTHER=무시",
      "XGITHUB_TOKEN=무시",
      "constructor=무시",
    ].join("\r\n");
    expect(parseEnv(content)).toEqual({ githubToken: "test-token", openaiKey: "test#key" });
  });

  it("빈 값과 주석은 없는 것으로 본다", () => {
    expect(parseEnv("GITHUB_TOKEN=\nOPENAI_API_KEY= # 여기에 적기\n")).toEqual({});
    expect(parseEnv('GITHUB_TOKEN=""')).toEqual({});
  });
});

describe("저장소 이름", () => {
  it.each([
    "owner/idea-notes",
    " owner/idea-notes ",
    "https://github.com/owner/idea-notes.git",
    "github.com/owner/idea-notes/",
  ])("%s 를 받는다", (input) => {
    expect(parseRepository(input)).toBe("owner/idea-notes");
  });

  it.each(["", "owner", "owner/a/b", "owner/..", "-owner/a", "owner/한글", "https://example.com/a/b"])(
    "%j 는 거절한다",
    (input) => {
      expect(parseRepository(input)).toBeNull();
    },
  );
});

describe("설정 처리", () => {
  it("저장한 값은 있는지 여부만 돌려준다", async () => {
    expect(await loadSummary(store)).toEqual(NONE);
    await saveSecret(store, "githubToken", " test-token ");
    const summary = await saveSecret(store, "openaiKey", "test-key");
    expect(summary).toEqual({ repository: "", hasGithubToken: true, hasOpenaiKey: true });
    expect(JSON.stringify(summary)).not.toContain("test-");
    expect((await store.getSettings()).githubToken).toBe("test-token");

    expect(await removeSecret(store, "githubToken")).toMatchObject({ hasGithubToken: false, hasOpenaiKey: true });
  });

  it.each(["", "   ", "두 단어", "test key", "한글키"])("%j 는 저장하지 않고 값을 알리지 않는다", async (value) => {
    await saveSecret(store, "openaiKey", "old-key");
    const error = await saveSecret(store, "openaiKey", value).catch((e) => e);
    expect(error).toBeInstanceOf(SettingsError);
    if (value.trim()) expect(error.message).not.toContain(value);
    expect((await store.getSettings()).openaiKey).toBe("old-key");
  });

  it(".env에 있는 값만 바꾼다", async () => {
    await saveSecret(store, "openaiKey", "old-key");
    const out = await importEnv(store, file("GITHUB_TOKEN=test-token\n"));
    expect(out.loaded).toEqual(["githubToken"]);
    expect(await store.getSettings()).toEqual({ openaiKey: "old-key", githubToken: "test-token" });
  });

  it.each([
    ["값이 없는 파일", file("A=1")],
    ["너무 큰 파일", file("GITHUB_TOKEN=a", MAX_ENV_BYTES + 1)],
    ["한 값이 잘못된 파일", file("GITHUB_TOKEN=test-token\nOPENAI_API_KEY=두 단어")],
  ])("%s은 아무것도 저장하지 않는다", async (_, input) => {
    await expect(importEnv(store, input)).rejects.toBeInstanceOf(SettingsError);
    expect(await store.getSettings()).toEqual({});
  });

  it("저장소를 저장하고 형식이 틀리면 거절한다", async () => {
    expect((await saveRepository(store, "https://github.com/owner/notes")).repository).toBe("owner/notes");
    await expect(saveRepository(store, "notes")).rejects.toBeInstanceOf(SettingsError);
    expect((await loadSummary(store)).repository).toBe("owner/notes");
  });

  it("올린 적 없는 노트만 있으면 저장소를 바꿀 수 있다", async () => {
    await saveRepository(store, "owner/typo");
    await store.addNotes(["지어낸 노트"]);
    expect((await saveRepository(store, "owner/notes")).repository).toBe("owner/notes");
  });

  it("받은 노트가 있으면 다른 저장소로 바꾸거나 비울 수 없다", async () => {
    await saveRepository(store, "owner/notes");
    await receiveRemote();
    await expect(saveRepository(store, "owner/other")).rejects.toThrow("이 기기에서 지우기");
    await expect(saveRepository(store, "")).rejects.toBeInstanceOf(SettingsError);
    expect((await saveRepository(store, "Owner/Notes")).repository).toBe("Owner/Notes");
  });

  it("올린 적 없이 지운 노트는 세지 않고, 원격에 있던 노트의 삭제는 센다", async () => {
    const [made] = await store.addNotes(["가"]);
    await store.deleteNote(made!.id);
    expect(await pendingCount(store)).toBe(0);

    await receiveRemote();
    await store.deleteNote("20260101000000");
    expect(await pendingCount(store)).toBe(1);
  });

  it("올리지 못한 수를 알려주고 지우면 처음 상태가 된다", async () => {
    await saveRepository(store, "owner/notes");
    await saveSecret(store, "openaiKey", "test-key");
    await receiveRemote();
    await store.addNotes(["가", "나"]);
    expect(await pendingCount(store)).toBe(2);

    expect(await wipeDevice(store)).toEqual(NONE);
    expect(await pendingCount(store)).toBe(0);
    expect(await store.listNotes()).toEqual([]);
    expect((await saveRepository(store, "owner/other")).repository).toBe("owner/other");
  });
});
