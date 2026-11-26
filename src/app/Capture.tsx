import { useRef, type FormEvent } from "react";
import { isSaveKey, splitInput } from "./notes.ts";

export function Capture(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (lines: string[]) => void;
}) {
  const form = useRef<HTMLFormElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const lines = splitInput(props.value);
    if (lines.length) props.onSubmit(lines);
  };

  const count = splitInput(props.value).length;

  return (
    <form className="field" ref={form} onSubmit={submit}>
      <textarea
        aria-label="새 아이디어"
        placeholder="떠오른 아이디어를 한 줄로 적으세요"
        rows={2}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          const { key, shiftKey, nativeEvent } = e;
          const { isComposing, keyCode } = nativeEvent;
          if (isSaveKey({ key, shiftKey, isComposing, keyCode }, matchMedia("(pointer: fine)").matches)) {
            e.preventDefault();
            form.current?.requestSubmit();
          }
        }}
      />
      <div className="row between">
        <span className="hint">
          {count > 1 ? `한 줄이 노트 하나입니다. ${count}개로 저장합니다.` : "한 줄이 노트 하나입니다."}
        </span>
        <button type="submit" className="primary" disabled={!count}>
          저장
        </button>
      </div>
    </form>
  );
}
