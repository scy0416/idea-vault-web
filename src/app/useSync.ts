import { useCallback, useEffect, useRef, useState } from "react";
import type { Notice, Store } from "../storage/store.ts";
import { createRunner, type Runner } from "../sync/runner.ts";
import { sync, type SyncResult } from "../sync/sync.ts";

/** 고친 직후에는 이어지는 수정을 모아 한 번에 올린다. */
const EDIT_DELAY = 2000;
/** 열어 둔 동안 실패한 것과 다른 기기의 변경을 확인하는 간격 */
const INTERVAL = 60_000;

export interface SyncStatus {
  running: boolean;
  result: SyncResult | null;
  /** 확인하기 전까지 남는 알림 */
  notices: Notice[];
  /** 마지막으로 성공한 시각 */
  syncedAt: Date | null;
  /** 끝날 때마다 늘어난다. 화면이 노트를 다시 읽는 신호다. */
  version: number;
}

export interface Sync extends SyncStatus {
  /** 지금 동기화한다. */
  now: () => void;
  /** 이 기기에서 고친 뒤 부른다. */
  changed: () => void;
  dismiss: () => void;
}

export function useSync(store: Store): Sync {
  const [status, setStatus] = useState<SyncStatus>({
    running: false,
    result: null,
    notices: [],
    syncedAt: null,
    version: 0,
  });
  const runner = useRef<Runner | null>(null);

  useEffect(() => {
    let active = true;
    // 토큰이나 설정이 문제면 때마다 되풀이하지 않는다. 고치거나 화면으로 돌아오면 다시 한다.
    let blocked = false;
    const current = createRunner(async () => {
      setStatus((s) => ({ ...s, running: true }));
      const result = await sync(store);
      if (!active) return;
      blocked = result.status === "error" && !result.retry;
      setStatus((s) => ({
        running: false,
        result,
        notices: [...new Set([...s.notices, ...result.notices])],
        syncedAt: result.status === "ok" ? new Date() : s.syncedAt,
        version: s.version + 1,
      }));
    });
    runner.current = current;
    const check = () => {
      if (document.visibilityState === "visible") current.request();
    };
    const timer = setInterval(() => {
      if (!blocked) check();
    }, INTERVAL);
    document.addEventListener("visibilitychange", check);
    addEventListener("online", check);
    current.request();
    return () => {
      active = false;
      current.stop();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      removeEventListener("online", check);
    };
  }, [store]);

  const now = useCallback(() => runner.current?.request(), []);
  const changed = useCallback(() => runner.current?.request(EDIT_DELAY), []);
  const dismiss = useCallback(() => setStatus((s) => ({ ...s, notices: [] })), []);
  return { ...status, now, changed, dismiss };
}
