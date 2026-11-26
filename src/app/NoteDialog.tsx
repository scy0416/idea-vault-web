import { useEffect, useRef, useState } from "react";
import type { StoredNote } from "../core/note-file.ts";
import type { Choice } from "../storage/store.ts";
import { cleanBody, shortTime, type Draft } from "./notes.ts";

export function NoteDialog(props: {
  note: StoredNote;
  pending: boolean;
  /** 저장하지 않은 본문. 없으면 undefined. 창을 닫아도 남는다. */
  draft: Draft | undefined;
  /** 본문이 충돌하면 저장소 쪽 본문 */
  theirs?: string | undefined;
  onResolve: (choice: Choice) => void;
  error: string | null;
  onDraft: (draft: Draft | undefined) => void;
  onSaveText: (text: string) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { note, draft } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const text = draft?.text ?? note.text;
  const changed = draft !== undefined && cleanBody(draft.text) !== note.text;
  // 적기 시작한 뒤에 동기화로 본문이 바뀌었는지
  const moved = changed && draft.from !== note.text;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return (
    <dialog ref={dialog} aria-label="노트" onClose={props.onClose}>
      <div className="sheet">
        <div className="row between head">
          <span className="hint">
            {note.id} · {shortTime(note.created)}
            {props.pending && props.theirs === undefined && <span className="pending"> · 아직 올리지 못함</span>}
          </span>
          <button type="button" onClick={() => dialog.current?.close()}>
            닫기
          </button>
        </div>
        {props.error && (
          <p className="notice error" role="alert">
            {props.error}
          </p>
        )}
        {props.theirs !== undefined && (
          <div className="stack">
            <p className="error">본문이 이 기기와 저장소에서 다르게 바뀌었습니다. 남길 내용을 고르세요.</p>
            <div className="field">
              <h2>이 기기</h2>
              <p className="version">{note.text}</p>
              <button type="button" onClick={() => props.onResolve("local")}>
                이 기기 것 남기기
              </button>
            </div>
            <div className="field">
              <h2>저장소</h2>
              <p className="version">{props.theirs}</p>
              <button type="button" onClick={() => props.onResolve("remote")}>
                저장소 것 남기기
              </button>
            </div>
            <button type="button" className="primary" onClick={() => props.onResolve("both")}>
              둘 다 남기기 (이 기기 것은 새 노트로)
            </button>
          </div>
        )}
        <div className="field" hidden={props.theirs !== undefined}>
          {moved && (
            <div className="notice field">
              <p className="error">적는 동안 저장된 본문이 바뀌었습니다. 수정 저장을 누르면 아래 내용을 덮어씁니다.</p>
              <p className="version">{note.text}</p>
            </div>
          )}
          <textarea
            aria-label="노트 내용"
            rows={5}
            value={text}
            onChange={(e) => {
              const value = e.currentTarget.value;
              props.onDraft(value === note.text ? undefined : { text: value, from: draft?.from ?? note.text });
            }}
          />
          {changed && (
            <div className="row between">
              <span className="hint">{cleanBody(text) ? "저장하지 않은 수정이 있습니다." : "내용이 비어 있습니다."}</span>
              <span className="row">
                <button type="button" onClick={() => props.onDraft(undefined)}>
                  되돌리기
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!cleanBody(text)}
                  onClick={() => props.onSaveText(text)}
                >
                  수정 저장
                </button>
              </span>
            </div>
          )}
        </div>
        <div className="field">
          <h2>태그</h2>
          {note.tags.length ? (
            <div className="chips">
              {note.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="chip"
                  aria-label={`${tag} 태그 빼기`}
                  onClick={() => props.onRemoveTag(tag)}
                >
                  {tag} ×
                </button>
              ))}
            </div>
          ) : (
            <p className="hint">태그가 없습니다.</p>
          )}
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              props.onAddTag(String(new FormData(form).get("tag") ?? ""));
              form.reset();
            }}
          >
            <input name="tag" aria-label="새 태그" placeholder="태그 추가" maxLength={20} autoComplete="off" />
            <button type="submit">추가</button>
          </form>
        </div>
        {confirming ? (
          <div className="row" role="alertdialog" aria-label="삭제 확인">
            <span className="error">이 노트를 지울까요?</span>
            <button type="button" onClick={() => setConfirming(false)}>
              취소
            </button>
            <button type="button" className="danger" onClick={props.onDelete}>
              지우기
            </button>
          </div>
        ) : (
          <button type="button" className="danger" onClick={() => setConfirming(true)}>
            삭제
          </button>
        )}
      </div>
    </dialog>
  );
}
