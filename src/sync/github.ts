// GitHub API 호출. 토큰은 요청 헤더에만 쓰고 기록하지 않는다.

export interface RepositoryInfo {
  isPrivate: boolean;
  /** 비어 있는 저장소면 null */
  branch: { name: string; head: string } | null;
}

export interface Tree {
  /** vault.json의 blob 해시 */
  vault: string | null;
  /** notes/ 안의 파일 경로 → blob 해시 */
  notes: Map<string, string>;
}

export interface FileChange {
  path: string;
  /** null이면 지운다. */
  content: string | null;
}

export interface Remote {
  repository(): Promise<RepositoryInfo>;
  /** 비어 있는 저장소에 첫 파일을 만든다. */
  init(path: string, content: string, message: string): Promise<void>;
  tree(head: string): Promise<Tree>;
  /** 해시 → 내용. 글로 읽을 수 없거나 너무 큰 파일은 null */
  blobs(shas: string[]): Promise<Map<string, string | null>>;
  /** head가 브랜치의 끝일 때만 커밋한다. 새 끝을 돌려준다. */
  commit(branch: string, head: string, changes: FileChange[], message: string): Promise<string>;
}

export type FailureKind = "network" | "auth" | "not-found" | "rate" | "other";

export class GitHubError extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const API = "https://api.github.com";
const BLOB_BATCH = 50;
const TIMEOUT = 30_000;

const MESSAGES: Record<Exclude<FailureKind, "other">, string> = {
  network: "GitHub에 연결할 수 없습니다. 연결되면 다시 보냅니다.",
  auth: "GitHub 토큰을 확인하세요. 만료되었거나 잘못된 토큰입니다.",
  "not-found": "저장소를 찾을 수 없습니다. 저장소 이름과 토큰의 대상 저장소를 확인하세요.",
  rate: "GitHub 요청 한도에 닿았습니다. 잠시 뒤 다시 보냅니다.",
};
const failure = (kind: Exclude<FailureKind, "other">) => new GitHubError(kind, MESSAGES[kind]);

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Git이 파일 내용에 붙이는 해시 */
export async function blobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const data = new Uint8Array(header.length + body.length);
  data.set(header);
  data.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function createGitHub(repository: string, token: string, send: typeof fetch = fetch): Remote {
  const [owner, name] = repository.split("/") as [string, string];

  async function request(method: string, path: string, body: object): Promise<any> {
    let response: Response;
    try {
      response = await send(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw failure("network");
    }
    const data: any = await response.json().catch(() => null);
    const limited = response.headers.get("x-ratelimit-remaining") === "0";
    if (response.status === 401) throw failure("auth");
    if (response.status === 429 || (response.status === 403 && (limited || /rate limit/i.test(data?.message)))) {
      throw failure("rate");
    }
    if (response.status === 404) throw failure("not-found");
    if (!response.ok) {
      throw new GitHubError("other", `GitHub ${response.status}: ${data?.message ?? "요청에 실패했습니다."}`);
    }
    if (limited && data?.errors) throw failure("rate");
    return data;
  }

  async function graphql(query: string, variables: object): Promise<any> {
    const out = await request("POST", "/graphql", { query, variables });
    const error = out?.errors?.[0];
    if (error) {
      if (error.type === "NOT_FOUND") throw failure("not-found");
      if (error.type === "RATE_LIMITED") throw failure("rate");
      throw new GitHubError("other", `GitHub: ${error.message}`);
    }
    return out?.data;
  }

  /** 저장소 안을 묻는 질의 */
  async function inRepository(fields: string, declarations: string, variables: object): Promise<any> {
    const data = await graphql(
      `query($owner: String!, $name: String!${declarations}) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner, name, ...variables },
    );
    if (!data?.repository) throw failure("not-found");
    return data.repository;
  }

  return {
    async repository() {
      const repo = await inRepository("isPrivate defaultBranchRef { name target { oid } }", "", {});
      const ref = repo.defaultBranchRef;
      return {
        // 값이 없으면 공개로 본다.
        isPrivate: repo.isPrivate === true,
        branch: ref?.target?.oid ? { name: ref.name, head: ref.target.oid } : null,
      };
    },

    async init(path, content, message) {
      await request("PUT", `/repos/${owner}/${name}/contents/${path}`, {
        message,
        content: encodeBase64(content),
      });
    },

    async tree(head) {
      const repo = await inRepository(
        "vault: object(expression: $vault) { ... on Blob { oid } } " +
          "notes: object(expression: $notes) { ... on Tree { entries { name type oid } } }",
        ", $vault: String!, $notes: String!",
        { vault: `${head}:vault.json`, notes: `${head}:notes` },
      );
      const notes = new Map<string, string>();
      for (const entry of repo.notes?.entries ?? []) {
        if (entry.type === "blob") notes.set(`notes/${entry.name}`, entry.oid);
      }
      return { vault: repo.vault?.oid ?? null, notes };
    },

    async blobs(shas) {
      const found = new Map<string, string | null>();
      for (let start = 0; start < shas.length; start += BLOB_BATCH) {
        const batch = shas.slice(start, start + BLOB_BATCH);
        // 해시는 질의문에 직접 넣으므로 모양을 확인한다.
        if (!batch.every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
          throw new GitHubError("other", "GitHub가 알 수 없는 해시를 보냈습니다.");
        }
        const fields = batch
          .map((sha, i) => `f${i}: object(oid: "${sha}") { ... on Blob { text isBinary isTruncated } }`)
          .join(" ");
        const repo = await inRepository(fields, "", {});
        batch.forEach((sha, i) => {
          const blob = repo[`f${i}`];
          if (!blob) throw new GitHubError("other", "GitHub에서 파일을 받지 못했습니다.");
          found.set(sha, blob.isBinary || blob.isTruncated || typeof blob.text !== "string" ? null : blob.text);
        });
      }
      return found;
    },

    async commit(branch, head, changes, message) {
      const additions = changes.flatMap((c) =>
        c.content === null ? [] : [{ path: c.path, contents: encodeBase64(c.content) }],
      );
      const deletions = changes.flatMap((c) => (c.content === null ? [{ path: c.path }] : []));
      const data = await graphql(
        "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }",
        {
          input: {
            branch: { repositoryNameWithOwner: repository, branchName: branch },
            message: { headline: message },
            expectedHeadOid: head,
            fileChanges: { additions, deletions },
          },
        },
      );
      const oid = data?.createCommitOnBranch?.commit?.oid;
      if (!oid) throw new GitHubError("other", "GitHub가 커밋 결과를 돌려주지 않았습니다.");
      return oid;
    },
  };
}
