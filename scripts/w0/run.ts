import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MODELS } from "../../src/core/models.ts";
import { noteId } from "../../src/core/note-id.ts";
import { createOpenAI } from "../../src/core/openai.ts";
import { parseNotes } from "./input.ts";
import { runTrial } from "./pipeline.ts";
import { renderReport, totalCost } from "./report.ts";

const USAGE = `사용법: npm run w0 -- <노트 파일(.txt 또는 .json)> [옵션]

  --questions <파일>   검색해 볼 질문 (한 줄에 하나)
  --model <이름>       태그·연결 모델 (기본 ${DEFAULT_MODELS.link})
  --embedding <이름>   임베딩 모델 (기본 ${DEFAULT_MODELS.embedding})
  --seed <숫자>        무작위 후보의 씨앗 (기본 1)
  --out <폴더>         결과를 둘 폴더 (기본 local/w0)

OPENAI_API_KEY는 .env 파일이나 환경 변수에서 읽는다.
노트 내용은 OpenAI로 전송된다.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      questions: { type: "string" },
      model: { type: "string", default: DEFAULT_MODELS.link },
      embedding: { type: "string", default: DEFAULT_MODELS.embedding },
      seed: { type: "string", default: "1" },
      out: { type: "string", default: "local/w0" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [file] = positionals;
  if (values.help || !file) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed는 정수여야 합니다.");

  const notes = parseNotes(file, await readFile(file, "utf8"));
  if (!notes.length) throw new Error("노트가 없습니다. (시제품의 예시 노트는 제외합니다.)");
  const questions = values.questions
    ? (await readFile(values.questions, "utf8"))
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .map((q) => q.trim())
        .filter(Boolean)
    : [];

  if (existsSync(".env")) process.loadEnvFile(".env");
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY가 없습니다. .env 파일에 넣으세요.");

  console.log(`노트 ${notes.length}개를 OpenAI로 보내 시험합니다.`);
  if (notes.length < 30) console.log("참고: 설계의 시험 분량은 30~50개입니다.");

  const result = await runTrial({
    api: createOpenAI(key),
    notes,
    questions,
    models: { link: values.model, embedding: values.embedding },
    seed,
    log: (m) => console.log(m),
  });

  const dir = join(values.out, `${noteId(new Date())}_${values.model}_${values.embedding}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(join(dir, "report.md"), renderReport(result), "utf8");

  const cost = totalCost(result);
  console.log(`\n연결 ${result.links.length}개, 처리 안 됨 ${result.failed.length}개`);
  if (cost !== null) console.log(`비용(추정) $${cost.toFixed(4)}`);
  console.log(`보고서: ${join(dir, "report.md")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
