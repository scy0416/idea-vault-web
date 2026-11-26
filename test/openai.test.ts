import { describe, expect, it } from "vitest";
import { AnswerError, ApiError, createOpenAI } from "../src/core/openai.ts";

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

function fake(...replies: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const api = createOpenAI("test-key", {
    wait: async () => {},
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
      const reply = replies[Math.min(calls.length, replies.length) - 1]!;
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }) as typeof fetch,
  });
  return { api, calls };
}

const request = { model: "m", instructions: "지시", input: "입력", schemaName: "s", schema: { type: "object" } };
const answer = (content: unknown[], status = "completed") => ({
  body: {
    status,
    output: [{ type: "reasoning" }, { type: "message", content }],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});

describe("OpenAI 호출", () => {
  it("응답을 보관하지 않도록 요청하고 JSON을 읽는다", async () => {
    const { api, calls } = fake(answer([{ type: "output_text", text: '{"ok":true}' }]));
    await expect(api.json(request)).resolves.toEqual({
      data: { ok: true },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]!.body.store).toBe(false);
    expect(calls[0]!.body.text.format).toMatchObject({ type: "json_schema", name: "s", strict: true });
    expect(calls[0]!.headers.authorization).toBe("Bearer test-key");
  });

  it.each([
    ["거절", answer([{ type: "refusal", refusal: "no" }])],
    ["미완료", answer([], "incomplete")],
    ["깨진 JSON", answer([{ type: "output_text", text: "{" }])],
  ])("%s이면 쓴 토큰과 함께 실패한다", async (_, reply) => {
    const error = await fake(reply).api.json(request).catch((e) => e);
    expect(error).toBeInstanceOf(AnswerError);
    expect(error.usage.inputTokens).toBe(10);
  });

  it("일시적인 오류는 다시 보낸다", async () => {
    const { api, calls } = fake(
      { status: 500, body: {} },
      { status: 429, body: {} },
      answer([{ type: "output_text", text: "{}" }]),
    );
    await api.json(request);
    expect(calls).toHaveLength(3);
  });

  it("한도 소진과 인증 오류는 바로 실패하고, 키 문구를 옮기지 않는다", async () => {
    const quota = fake({ status: 429, body: { error: { code: "insufficient_quota", message: "quota" } } });
    await expect(quota.api.json(request)).rejects.toBeInstanceOf(ApiError);
    expect(quota.calls).toHaveLength(1);

    const auth = fake({ status: 401, body: { error: { message: "Incorrect key: test-k**" } } });
    await expect(auth.api.json(request)).rejects.toThrow("OpenAI 401: API 키를 확인하세요.");
    expect(auth.calls).toHaveLength(1);
  });

  it("임베딩은 100개씩 보내고 번호 순서로 돌려준다", async () => {
    const reply = (n: number) => ({
      body: {
        data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i] })).reverse(),
        usage: { prompt_tokens: n },
      },
    });
    const { api, calls } = fake(reply(100), reply(1));
    const out = await api.embed("e", Array.from({ length: 101 }, (_, i) => `노트 ${i}`));
    expect(calls.map((c) => c.body.input.length)).toEqual([100, 1]);
    expect(out.vectors.slice(0, 3)).toEqual([[0], [1], [2]]);
    expect(out.vectors).toHaveLength(101);
    expect(out.usage.inputTokens).toBe(101);
  });
});
