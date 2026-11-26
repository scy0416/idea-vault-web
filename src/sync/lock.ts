// 동기화와 저장소 변경·지우기가 겹치지 않게 한다. 지원하면 탭 사이에서도 지킨다.

export const VAULT_LOCK = "idea-vault";

let queue: Promise<unknown> = Promise.resolve();

export function withVaultLock<T>(work: () => Promise<T>, locks = globalThis.navigator?.locks): Promise<T> {
  if (locks) return locks.request(VAULT_LOCK, work) as Promise<T>;
  const next = queue.then(work);
  queue = next.catch(() => {});
  return next;
}
