// IndexedDB 호출을 Promise로 감싸는 최소 도구.

export const result = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * 한 트랜잭션에서 work를 실행하고, 저장이 끝난 뒤에 값을 돌려준다.
 * work 안에서는 이 트랜잭션의 요청만 기다려야 한다. 다른 것을 기다리면 트랜잭션이 먼저 끝난다.
 */
export async function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  // 아직 올리지 못한 변경을 잃지 않도록 디스크에 쓴 뒤 완료로 본다.
  const tx = db.transaction(stores, mode, { durability: "strict" });
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("저장이 취소되었습니다."));
  });
  done.catch(() => {});
  let value: T;
  try {
    value = await work(tx);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // 이미 끝난 트랜잭션
    }
    throw error;
  }
  await done;
  return value;
}
