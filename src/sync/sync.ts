// 한 번의 동기화: 원격의 변경을 받아 합치고, 이 기기의 변경을 커밋한다 (설계 4절).
import { FormatError, idFromPath, notePath, parseVault, serializeNote, serializeVault, VAULT_PATH } from "../core/note-file.ts";
import type { Notice, Store } from "../storage/store.ts";
import { blobSha, createGitHub, GitHubError, type FileChange, type Remote, type Tree } from "./github.ts";
import { withVaultLock } from "./lock.ts";

const ATTEMPTS = 3;
export const COMMIT_BATCH = 100;

export interface SyncResult {
  status: "ok" | "unconfigured" | "error";
  message?: string;
  /** 다시 시도하면 풀릴 수 있는 실패 */
  retry?: boolean;
  notices: Notice[];
  /** 읽을 수 없어 건드리지 않은 파일 */
  unreadable: string[];
}

export type Connect = (repository: string, token: string) => Remote;

export function sync(store: Store, connect: Connect = createGitHub): Promise<SyncResult> {
  return withVaultLock(() => run(store, connect));
}

async function run(store: Store, connect: Connect): Promise<SyncResult> {
  const notices: Notice[] = [];
  const unreadable = new Set<string>();
  const done = (status: SyncResult["status"], message?: string, retry?: boolean): SyncResult => ({
    status,
    ...(message ? { message } : {}),
    ...(retry ? { retry } : {}),
    notices,
    unreadable: [...unreadable].map(notePath),
  });

  try {
    const { repository, githubToken } = await store.getSettings();
    if (!repository || !githubToken) return done("unconfigured");
    const remote = connect(repository, githubToken);

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const info = await remote.repository();
      // 공개 저장소에는 노트를 올리지 않는다.
      if (!info.isPrivate) {
        return done("error", "공개 저장소에는 노트를 올리지 않습니다. 비공개 저장소를 설정하세요.");
      }
      if (!info.branch) {
        await remote.init(VAULT_PATH, serializeVault(), "vault: 시작");
        continue;
      }
      const { name, head } = info.branch;

      unreadable.clear();
      const state = await store.getSyncState();
      if (state?.repository !== repository || state.head !== head) {
        const tree = await remote.tree(head);
        if (tree.vault === null) {
          const change = { path: VAULT_PATH, content: serializeVault() };
          await commit(remote, name, head, [change], "vault: 형식 버전");
          // 새 끝에서 다시 받는다.
          continue;
        }
        await pull(store, remote, tree, notices, unreadable);
        // 읽지 못한 파일이 있으면 다음에 다시 확인한다.
        if (!unreadable.size) await store.saveSyncState({ repository, head });
      }

      const pushed = await push(store, remote, name, head, unreadable);
      if (pushed === null) continue;
      if (pushed !== head && !unreadable.size) await store.saveSyncState({ repository, head: pushed });
      return done("ok");
    }
    return done("error", "저장소가 계속 바뀌고 있습니다. 잠시 뒤 다시 시도합니다.", true);
  } catch (error) {
    if (error instanceof GitHubError) {
      return done("error", error.message, error.kind === "network" || error.kind === "rate");
    }
    if (error instanceof FormatError) return done("error", error.message);
    return done("error", "동기화하지 못했습니다. 잠시 뒤 다시 시도하세요.", true);
  }
}

/** 커밋한 뒤의 끝. 그사이 원격이 바뀌었으면 null */
async function commit(
  remote: Remote,
  branch: string,
  head: string,
  changes: FileChange[],
  message: string,
): Promise<string | null> {
  try {
    return await remote.commit(branch, head, changes, message);
  } catch (error) {
    // 오류의 모양에 기대지 않고, 브랜치의 끝이 움직였는지로 판단한다.
    const now = await remote.repository().catch(() => null);
    if (now?.branch && now.branch.head !== head) return null;
    throw error;
  }
}

async function pull(store: Store, remote: Remote, tree: Tree, notices: Notice[], unreadable: Set<string>) {
  const vault = (await remote.blobs([tree.vault!])).get(tree.vault!);
  parseVault(vault ?? "");

  const files = new Map<string, string>();
  for (const [path, sha] of tree.notes) {
    const id = idFromPath(path);
    if (id) files.set(id, sha);
  }
  const entries = new Map((await store.listEntries()).map((e) => [e.id, e]));
  const changed = [...files].filter(([id, sha]) => {
    const entry = entries.get(id);
    return (entry?.conflict?.sha ?? entry?.sha) !== sha;
  });
  // 원격에 있던 노트가 목록에서 빠졌으면 지워진 것이다. 올리지 않고 지운 노트의 표시도 여기서 정리한다.
  const removed = [...entries.values()].filter(
    (e) => !files.has(e.id) && (e.base !== null || e.conflict || !e.note),
  );

  const contents = changed.length ? await remote.blobs([...new Set(changed.map(([, sha]) => sha))]) : new Map();
  const apply = async (id: string, file: { content: string; sha: string } | null) => {
    try {
      const notice = await store.receive(id, file, files.keys());
      if (notice) notices.push(notice);
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
      unreadable.add(id);
    }
  };
  for (const [id, sha] of changed) {
    const content: string | null = contents.get(sha) ?? null;
    if (content === null) unreadable.add(id);
    else await apply(id, { content, sha });
  }
  for (const entry of removed) await apply(entry.id, null);
}

/** 올린 뒤의 끝. 그사이 원격이 바뀌었으면 null */
async function push(
  store: Store,
  remote: Remote,
  branch: string,
  head: string,
  unreadable: Set<string>,
): Promise<string | null> {
  const pending = (await store.listPending()).filter((e) => !e.conflict && !unreadable.has(e.id));
  const uploads = [];
  for (const entry of pending) {
    // 올린 적 없이 지운 노트는 원격에서 할 일이 없다.
    if (!entry.note && entry.base === null) {
      await store.markUploaded(entry.id, entry.revision, null);
      continue;
    }
    uploads.push({
      id: entry.id,
      revision: entry.revision,
      content: entry.note ? serializeNote(entry.note) : null,
    });
  }

  let tip = head;
  for (let start = 0; start < uploads.length; start += COMMIT_BATCH) {
    const batch = uploads.slice(start, start + COMMIT_BATCH);
    await store.markSending(batch.flatMap((u) => (u.content === null ? [] : [{ id: u.id, content: u.content }])));
    // 커밋 이력에는 노트 내용을 적지 않는다.
    const next = await commit(
      remote,
      branch,
      tip,
      batch.map((u) => ({ path: notePath(u.id), content: u.content })),
      `notes: ${batch.length}개 변경`,
    );
    if (next === null) return null;
    tip = next;
    for (const u of batch) {
      const file = u.content === null ? null : { content: u.content, sha: await blobSha(u.content) };
      await store.markUploaded(u.id, u.revision, file);
    }
  }
  return tip;
}
