// 동기화를 언제 돌릴지 정한다. 한 번에 하나만 돌고, 도는 중에 요청하면 끝난 뒤 한 번 더 돈다.

export interface Runner {
  /** delay 뒤에 돈다. 기다리는 중에 다시 요청하면 더 이른 쪽을 따른다. */
  request(delay?: number): void;
  stop(): void;
}

export function createRunner(task: () => Promise<void>, now: () => number = Date.now): Runner {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = Infinity;
  let running = false;
  let again = false;
  let stopped = false;

  async function start() {
    timer = undefined;
    due = Infinity;
    running = true;
    try {
      await task();
    } catch {
      // 결과와 오류는 task가 알린다.
    }
    running = false;
    if (again) {
      again = false;
      request();
    }
  }

  function request(delay = 0) {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (now() + delay >= due) return;
    clearTimeout(timer);
    due = now() + delay;
    timer = setTimeout(() => void start(), delay);
  }

  return {
    request,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
