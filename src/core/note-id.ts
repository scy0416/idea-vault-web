// 노트 ID: 만든 시각 14자리 YYYYMMDDHHmmss (기기의 현지 시각). 만든 뒤에는 바꾸지 않는다.

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

export function noteId(date: Date): string {
  return (
    pad(date.getFullYear(), 4) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

export const isNoteId = (value: string): boolean => /^\d{14}$/.test(value);

/**
 * 이미 쓰는 ID면 1초씩 뒤로 민다. 고른 ID는 used에 더한다.
 * 달력 계산만 하므로 서머타임으로 건너뛰는 시각에도 멈춘다.
 */
export function uniqueNoteId(id: string, used: Set<string>): string {
  let next = id;
  while (used.has(next)) next = nextSecond(next);
  used.add(next);
  return next;
}

function nextSecond(id: string): string {
  const part = (from: number, to: number) => Number(id.slice(from, to));
  const date = new Date(
    Date.UTC(part(0, 4), part(4, 6) - 1, part(6, 8), part(8, 10), part(10, 12), part(12, 14) + 1),
  );
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

/** 시차를 붙인 ISO 8601. 예: 2026-11-26T15:30:12+09:00 */
export function localTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
  );
}
