// 설정 화면의 처리. 토큰과 키는 저장소에만 두고 화면에는 있는지 여부만 돌려준다.
import { parseEnv } from "../core/env-file.ts";
import { parseRepository } from "../core/repository.ts";
import { isUnsent, type Settings, type Store } from "../storage/store.ts";

export const MAX_ENV_BYTES = 64 * 1024;

export interface Summary {
  repository: string;
  hasGithubToken: boolean;
  hasOpenaiKey: boolean;
}

export type SecretField = "githubToken" | "openaiKey";

export const SECRET_LABELS: Record<SecretField, string> = {
  githubToken: "GitHub 토큰",
  openaiKey: "OpenAI API 키",
};

/** 사용자에게 그대로 보여줄 수 있는 오류. 입력한 값은 담지 않는다. */
export class SettingsError extends Error {}

const summarize = (s: Settings): Summary => ({
  repository: s.repository ?? "",
  hasGithubToken: Boolean(s.githubToken),
  hasOpenaiKey: Boolean(s.openaiKey),
});

export const loadSummary = async (store: Store): Promise<Summary> => summarize(await store.getSettings());

export async function saveRepository(store: Store, input: string): Promise<Summary> {
  const repository = input.trim() ? parseRepository(input) : "";
  if (repository === null) throw new SettingsError("저장소는 `소유자/저장소` 형식으로 적으세요.");
  const current = (await store.getSettings()).repository ?? "";
  if (repository.toLowerCase() !== current.toLowerCase() && (await store.hasSynced())) {
    throw new SettingsError(
      "지금 저장소에서 받은 노트가 있어 바꿀 수 없습니다. 먼저 `이 기기에서 지우기`를 하세요.",
    );
  }
  return summarize(await store.saveSettings({ repository }));
}

function checkSecret(field: SecretField, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new SettingsError(`${SECRET_LABELS[field]}을(를) 입력하세요.`);
  if (/[^\x21-\x7e]/.test(trimmed)) {
    throw new SettingsError(`${SECRET_LABELS[field]}에 쓸 수 없는 글자나 공백이 있습니다.`);
  }
  return trimmed;
}

export async function saveSecret(store: Store, field: SecretField, value: string): Promise<Summary> {
  return summarize(await store.saveSettings({ [field]: checkSecret(field, value) }));
}

export async function removeSecret(store: Store, field: SecretField): Promise<Summary> {
  return summarize(await store.saveSettings({ [field]: "" }));
}

/** 파일에 있는 값만 바꾼다. 하나라도 잘못되면 아무것도 저장하지 않는다. */
export async function importEnv(
  store: Store,
  file: { size: number; text(): Promise<string> },
): Promise<{ summary: Summary; loaded: SecretField[] }> {
  if (file.size > MAX_ENV_BYTES) throw new SettingsError("파일이 너무 큽니다. `.env` 파일을 고르세요.");
  const secrets = parseEnv(await file.text());
  const loaded = Object.keys(secrets) as SecretField[];
  if (!loaded.length) throw new SettingsError("파일에 `GITHUB_TOKEN`이나 `OPENAI_API_KEY`가 없습니다.");
  for (const field of loaded) secrets[field] = checkSecret(field, secrets[field]!);
  return { summary: summarize(await store.saveSettings(secrets)), loaded };
}

export const pendingCount = async (store: Store): Promise<number> => (await store.listPending()).filter(isUnsent).length;

export async function wipeDevice(store: Store): Promise<Summary> {
  await store.wipe();
  return loadSummary(store);
}
