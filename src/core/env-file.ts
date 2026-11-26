// 사용자가 고른 .env 파일에서 두 값만 읽는다. 다른 줄은 무시한다.

const KEYS = { GITHUB_TOKEN: "githubToken", OPENAI_API_KEY: "openaiKey" } as const;

export type Secrets = Partial<Record<(typeof KEYS)[keyof typeof KEYS], string>>;

export function parseEnv(content: string): Secrets {
  const found: Secrets = {};
  for (const line of content.replace(/^﻿/, "").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=(.*)$/.exec(line);
    // "constructor" 같은 객체의 기본 이름을 값으로 읽지 않는다.
    if (!match || !Object.hasOwn(KEYS, match[1]!)) continue;
    const field = KEYS[match[1] as keyof typeof KEYS];
    const raw = match[2]!.trim();
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw);
    const value = (quoted ? quoted[2]! : raw.replace(/(^|\s+)#.*$/, "")).trim();
    if (value) found[field] = value;
  }
  return found;
}
