// OpenAI HTTP 호출. 키는 요청 헤더에만 쓰고 기록하지 않는다.
import type { Usage } from "./models.ts";

export interface OpenAI {
  embed(model: string, texts: string[]): Promise<{ vectors: number[][]; usage: Usage }>;
  json(request: JsonRequest): Promise<{ data: unknown; usage: Usage }>;
}

export interface JsonRequest {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: object;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 답은 왔지만 쓸 수 없는 경우. 쓴 토큰은 남긴다. */
export class AnswerError extends Error {
  usage: Usage;
  constructor(message: string, usage: Usage) {
    super(message);
    this.usage = usage;
  }
}

const EMBED_BATCH = 100;
const RETRIES = 3;

export function createOpenAI(
  apiKey: string,
  options: { fetch?: typeof fetch; wait?: (ms: number) => Promise<void> } = {},
): OpenAI {
  const send = options.fetch ?? fetch;
  const wait = options.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  async function post(path: string, body: object): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await send(`https://api.openai.com/v1/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return res.json();
      const detail: any = await res.json().catch(() => null);
      const retryable =
        (res.status === 429 && detail?.error?.code !== "insufficient_quota") || res.status >= 500;
      if (!retryable || attempt >= RETRIES) {
        // 인증 오류 문구에는 키의 일부가 담길 수 있어 옮기지 않는다.
        const message =
          res.status === 401 ? "API 키를 확인하세요." : (detail?.error?.message ?? res.statusText);
        throw new ApiError(res.status, `OpenAI ${res.status}: ${message}`);
      }
      await wait(1000 * 2 ** attempt);
    }
  }

  return {
    async embed(model, texts) {
      const vectors: number[][] = [];
      const usage = { inputTokens: 0, outputTokens: 0 };
      for (let start = 0; start < texts.length; start += EMBED_BATCH) {
        const batch = texts.slice(start, start + EMBED_BATCH);
        const out = await post("embeddings", { model, input: batch });
        if (out?.data?.length !== batch.length) throw new Error("임베딩 개수가 맞지 않습니다.");
        const ordered = [...out.data].sort((a: any, b: any) => a.index - b.index);
        for (const item of ordered) vectors.push(item.embedding);
        usage.inputTokens += out.usage?.prompt_tokens ?? 0;
      }
      return { vectors, usage };
    },

    async json({ model, instructions, input, schemaName, schema }) {
      const out = await post("responses", {
        model,
        instructions,
        input,
        store: false,
        text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
      });
      const usage = {
        inputTokens: out?.usage?.input_tokens ?? 0,
        outputTokens: out?.usage?.output_tokens ?? 0,
      };
      if (out?.status !== "completed") {
        const why = out?.incomplete_details?.reason ?? out?.status ?? "알 수 없음";
        throw new AnswerError(`답이 완료되지 않았습니다 (${why}).`, usage);
      }
      const parts: any[] = (out.output ?? [])
        .filter((item: any) => item.type === "message")
        .flatMap((item: any) => item.content ?? []);
      if (parts.some((p) => p.type === "refusal")) {
        throw new AnswerError("모델이 답하지 않았습니다.", usage);
      }
      const text = parts
        .filter((p) => p.type === "output_text")
        .map((p) => p.text)
        .join("");
      try {
        return { data: JSON.parse(text), usage };
      } catch {
        throw new AnswerError("답을 JSON으로 읽지 못했습니다.", usage);
      }
    },
  };
}
