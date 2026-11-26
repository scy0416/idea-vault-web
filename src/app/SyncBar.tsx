import type { Notice } from "../storage/store.ts";
import type { SyncStatus } from "./useSync.ts";

export const NOTICE_TEXT: Record<Notice, string> = {
  "kept-edit": "다른 곳에서 본문을 고친 노트는 지우지 않고 남겼습니다.",
  "kept-local": "다른 곳에서 지웠지만 이 기기에서 본문을 고친 노트는 남겼습니다.",
  renamed: "같은 번호의 다른 노트가 있어 이 기기의 노트에 새 번호를 줬습니다.",
  conflict: "본문이 양쪽에서 바뀐 노트가 있습니다. 노트를 열어 남길 내용을 고르세요.",
};

const time = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

export function SyncBar(props: {
  sync: SyncStatus;
  pending: number;
  conflicts: number;
  onNow: () => void;
  onDismiss: () => void;
}) {
  const { running, result, syncedAt } = props.sync;
  const waiting = props.pending ? `올리지 못한 변경 ${props.pending}개` : "";
  const state = running
    ? "동기화 중…"
    : result?.status === "unconfigured"
      ? "설정에서 저장소와 GitHub 토큰을 넣으면 올립니다."
      : result?.status === "ok" && syncedAt
        ? `${time(syncedAt)}에 동기화`
        : "";
  // 충돌은 고를 때까지 개수로 알린다.
  const notices = props.sync.notices.filter((n) => n !== "conflict");

  return (
    <div className="field" role="status">
      <div className="row between head">
        <span className="hint">
          {[waiting, state].filter(Boolean).join(" · ")}
        </span>
        {result?.status !== "unconfigured" && (
          <button type="button" className="small" disabled={running} onClick={props.onNow}>
            동기화
          </button>
        )}
      </div>
      {result?.status === "error" && <p className="notice error">{result.message}</p>}
      {props.conflicts > 0 && (
        <p className="notice error">
          {NOTICE_TEXT.conflict} ({props.conflicts}개)
        </p>
      )}
      {notices.length > 0 && (
        <div className="notice row between head">
          <span>{notices.map((n) => NOTICE_TEXT[n]).join(" ")}</span>
          <button type="button" className="small" onClick={props.onDismiss}>
            확인
          </button>
        </div>
      )}
      {result && result.unreadable.length > 0 && (
        <p className="notice error">읽을 수 없어 건드리지 않은 파일: {result.unreadable.join(", ")}</p>
      )}
    </div>
  );
}
