import { useEffect, useState, type FormEvent } from "react";
import type { Store } from "../storage/store.ts";
import {
  importEnv,
  loadSummary,
  pendingCount,
  removeSecret,
  SECRET_LABELS,
  saveRepository,
  saveSecret,
  SettingsError,
  wipeDevice,
  type SecretField,
  type Summary,
} from "./settings.ts";

interface Message {
  error: boolean;
  text: string;
}

export function SettingsScreen({ store }: { store: Store }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  /** 지우기를 확인하는 중이면 올리지 못한 변경의 수 */
  const [confirming, setConfirming] = useState<number | null>(null);
  /** 바꾸면 입력칸을 저장된 값으로 되돌린다. */
  const [generation, setGeneration] = useState(0);

  async function run(work: () => Promise<string | void>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ error: false, text });
    } catch (error) {
      setMessage({
        error: true,
        text: error instanceof SettingsError ? error.message : "처리하지 못했습니다. 페이지를 다시 열어 보세요.",
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run(async () => setSummary(await loadSummary(store)));
  }, [store]);

  if (!summary) return <Notice message={message} />;

  const submitRepository = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = String(new FormData(event.currentTarget).get("repository") ?? "");
    void run(async () => {
      setSummary(await saveRepository(store, input));
      setGeneration((n) => n + 1);
      return "저장소를 저장했습니다.";
    });
  };

  const chooseEnv = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // 같은 파일을 다시 고를 수 있게 비운다.
    input.value = "";
    if (!file) return;
    void run(async () => {
      const { summary, loaded } = await importEnv(store, file);
      setSummary(summary);
      return `${loaded.map((f) => SECRET_LABELS[f]).join(", ")}을(를) 불러왔습니다.`;
    });
  };

  return (
    <div className="stack">
      <Notice message={message} />

      <section className="card">
        <h2>노트 저장소</h2>
        <p className="hint">노트를 보관할 비공개 GitHub 저장소입니다.</p>
        <form className="row" key={generation} onSubmit={submitRepository}>
          <input
            name="repository"
            aria-label="노트 저장소"
            placeholder="소유자/저장소"
            defaultValue={summary.repository}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={busy}>
            저장
          </button>
        </form>
      </section>

      <section className="card">
        <h2>토큰과 키</h2>
        <p className="hint">이 기기에만 저장하며, 저장한 값은 다시 보여주지 않습니다.</p>
        <SecretRow
          field="githubToken"
          saved={summary.hasGithubToken}
          busy={busy}
          onSave={(value, done) =>
            run(async () => {
              setSummary(await saveSecret(store, "githubToken", value));
              done();
              return "GitHub 토큰을 저장했습니다.";
            })
          }
          onRemove={() =>
            run(async () => {
              setSummary(await removeSecret(store, "githubToken"));
              return "GitHub 토큰을 지웠습니다.";
            })
          }
        />
        <SecretRow
          field="openaiKey"
          saved={summary.hasOpenaiKey}
          busy={busy}
          onSave={(value, done) =>
            run(async () => {
              setSummary(await saveSecret(store, "openaiKey", value));
              done();
              return "OpenAI API 키를 저장했습니다.";
            })
          }
          onRemove={() =>
            run(async () => {
              setSummary(await removeSecret(store, "openaiKey"));
              return "OpenAI API 키를 지웠습니다.";
            })
          }
        />
        <label className="field">
          <span>
            <code>.env</code> 파일 불러오기
          </span>
          <input type="file" disabled={busy} onChange={(e) => chooseEnv(e.currentTarget)} />
        </label>
      </section>

      <section className="card">
        <h2>이 기기에서 지우기</h2>
        <p className="hint">토큰, 키, 이 기기에 둔 노트를 지웁니다. GitHub 저장소의 노트는 그대로 남습니다.</p>
        {confirming === null ? (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void run(async () => setConfirming(await pendingCount(store)))}
          >
            이 기기에서 지우기
          </button>
        ) : (
          <div className="stack" role="alertdialog" aria-label="지우기 확인">
            <p className={confirming ? "error" : undefined}>
              {confirming
                ? `아직 올리지 못한 변경 ${confirming}개가 있습니다. 지우면 되돌릴 수 없습니다.`
                : "지울까요? 다시 쓰려면 토큰과 키를 입력해야 합니다."}
            </p>
            <div className="row">
              <button type="button" onClick={() => setConfirming(null)}>
                취소
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setSummary(await wipeDevice(store));
                    setGeneration((n) => n + 1);
                    setConfirming(null);
                    return "이 기기에서 지웠습니다.";
                  })
                }
              >
                {confirming ? "올리지 못한 변경까지 지우기" : "지우기"}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Notice({ message }: { message: Message | null }) {
  // 화면 낭독기가 바뀐 내용을 읽도록 영역은 늘 둔다.
  return (
    <div className="status" role="status" aria-live="polite">
      {message && <p className={message.error ? "notice error" : "notice"}>{message.text}</p>}
    </div>
  );
}

function SecretRow(props: {
  field: SecretField;
  saved: boolean;
  busy: boolean;
  onSave: (value: string, done: () => void) => void;
  onRemove: () => void;
}) {
  const label = SECRET_LABELS[props.field];
  return (
    <form
      className="field"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const value = String(new FormData(form).get(props.field) ?? "");
        props.onSave(value, () => form.reset());
      }}
    >
      <span>
        {label} <small className="hint">{props.saved ? "저장됨" : "없음"}</small>
      </span>
      <div className="row">
        <input
          type="password"
          name={props.field}
          aria-label={label}
          placeholder={props.saved ? "새 값으로 바꾸기" : "붙여 넣기"}
          autoComplete="new-password"
          spellCheck={false}
        />
        <button type="submit" disabled={props.busy}>
          저장
        </button>
        {props.saved && (
          <button type="button" disabled={props.busy} onClick={props.onRemove} aria-label={`${label} 지우기`}>
            지우기
          </button>
        )}
      </div>
    </form>
  );
}
