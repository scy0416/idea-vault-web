import { describe, expect, it, vi } from "vitest";
import { blobSha, createGitHub, encodeBase64, GitHubError } from "../src/sync/github.ts";
import { withVaultLock } from "../src/sync/lock.ts";
import { createRunner } from "../src/sync/runner.ts";

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function fake(...replies: Reply[]) {
  const calls: { url: string; method: string; body: any; headers: Record<string, string> }[] = [];
  const api = createGitHub("owner/notes", "test-token", (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method!,
      body: JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    });
    const reply = replies[Math.min(calls.length, replies.length) - 1]!;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
  }) as typeof fetch);
  return { api, calls };
}
const repo = (value: unknown) => ({ body: { data: { repository: value } } });
const SHA = "a".repeat(40);

describe("GitHub 호출", () => {
  it("토큰은 헤더에만 담아 GitHub로 보낸다", async () => {
    const { api, calls } = fake(repo({ isPrivate: true, defaultBranchRef: { name: "main", target: { oid: "h" } } }));
    expect(await api.repository()).toEqual({ isPrivate: true, branch: { name: "main", head: "h" } });
    expect(calls[0]!.url).toBe("https://api.github.com/graphql");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-token");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("test-token");
    expect(calls[0]!.body.variables).toEqual({ owner: "owner", name: "notes" });
  });

  it("비공개라고 하지 않으면 공개로, 브랜치가 없으면 빈 저장소로 본다", async () => {
    expect(await fake(repo({ defaultBranchRef: null })).api.repository()).toEqual({ isPrivate: false, branch: null });
  });

  it("vault.json과 notes 폴더의 파일만 읽는다", async () => {
    const { api, calls } = fake(
      repo({
        vault: { oid: "v" },
        notes: { entries: [{ name: "a.md", type: "blob", oid: "1" }, { name: "sub", type: "tree", oid: "2" }] },
      }),
    );
    expect(await api.tree("h")).toEqual({ vault: "v", notes: new Map([["notes/a.md", "1"]]) });
    expect(calls[0]!.body.variables).toMatchObject({ vault: "h:vault.json", notes: "h:notes" });
    expect(await fake(repo({ vault: null, notes: null })).api.tree("h")).toEqual({ vault: null, notes: new Map() });
  });

  it("파일을 50개씩 받고, 읽을 수 없는 것은 null이다", async () => {
    const shas = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(40, "0"));
    const page = (n: number) =>
      repo(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { text: "글", isBinary: false, isTruncated: i === 1 }])));
    const { api, calls } = fake(page(50), page(1));
    const found = await api.blobs(shas);
    expect(calls).toHaveLength(2);
    expect([found.get(shas[0]!), found.get(shas[1]!), found.get(shas[50]!)]).toEqual(["글", null, "글"]);
  });

  it("해시 모양이 아니면 질의에 넣지 않는다", async () => {
    const { api, calls } = fake(repo({}));
    await expect(api.blobs([`${SHA}") { x } #`])).rejects.toBeInstanceOf(GitHubError);
    expect(calls).toEqual([]);
  });

  it("읽은 끝을 함께 보내 커밋하고 내용은 UTF-8 base64다", async () => {
    const { api, calls } = fake({ body: { data: { createCommitOnBranch: { commit: { oid: "next" } } } } });
    const changes = [
      { path: "notes/a.md", content: "한글 😀" },
      { path: "notes/b.md", content: null },
    ];
    expect(await api.commit("main", "head", changes, "notes: 2개 변경")).toBe("next");
    const input = calls[0]!.body.variables.input;
    expect(input).toMatchObject({
      branch: { repositoryNameWithOwner: "owner/notes", branchName: "main" },
      expectedHeadOid: "head",
      fileChanges: { deletions: [{ path: "notes/b.md" }] },
    });
    expect(Buffer.from(input.fileChanges.additions[0].contents, "base64").toString()).toBe("한글 😀");
  });

  it("빈 저장소에는 파일 API로 첫 파일을 만든다", async () => {
    const { api, calls } = fake({ status: 201, body: {} });
    await api.init("vault.json", "{}", "시작");
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://api.github.com/repos/owner/notes/contents/vault.json",
      body: { message: "시작", content: encodeBase64("{}") },
    });
  });

  it.each([
    ["auth", { status: 401, body: {} }],
    ["not-found", { status: 404, body: {} }],
    ["not-found", { body: { errors: [{ type: "NOT_FOUND", message: "x" }] } }],
    ["not-found", repo(null)],
    ["rate", { status: 403, body: {}, headers: { "x-ratelimit-remaining": "0" } }],
    ["rate", { status: 403, body: { message: "You have exceeded a secondary rate limit" } }],
    ["rate", { status: 429, body: {} }],
    ["rate", { body: { errors: [{ type: "RATE_LIMITED", message: "x" }] } }],
    ["other", { status: 403, body: { message: "Resource not accessible" } }],
    ["other", { status: 502, body: null }],
    ["other", { body: { errors: [{ message: "x" }] } }],
  ])("%s 오류로 가린다", async (kind, reply) => {
    const error = await fake(reply as Reply).api.repository().catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.kind).toBe(kind);
    expect(error.message).not.toContain("test-token");
  });

  it("연결 실패는 network 오류다", async () => {
    const api = createGitHub("owner/notes", "t", (async () => Promise.reject(new TypeError("fail"))) as typeof fetch);
    await expect(api.repository()).rejects.toMatchObject({ kind: "network" });
  });

  it("Git과 같은 파일 해시를 만든다", async () => {
    expect(await blobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await blobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("차례", () => {
  it("잠금을 지원하지 않아도 차례로 하며, 실패가 다음을 막지 않는다", async () => {
    const log: string[] = [];
    const job = (name: string, fail = false) =>
      withVaultLock(async () => {
        log.push(`${name} 시작`);
        await Promise.resolve();
        log.push(`${name} 끝`);
        if (fail) throw new Error(name);
      }, null as never);
    await Promise.allSettled([job("가", true), job("나")]);
    expect(log).toEqual(["가 시작", "가 끝", "나 시작", "나 끝"]);
  });

  it("한 번에 하나만 돌고, 도는 중의 요청은 한 번으로 모은다", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let finish = () => {};
    const runner = createRunner(() => {
      runs++;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    runner.request(2000);
    runner.request(5000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(runs).toBe(0);
    runner.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    runner.request();
    runner.request();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runs).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    runner.stop();
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    runner.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(2);
    vi.useRealTimers();
  });
});
