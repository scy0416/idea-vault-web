import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/app/App.tsx";

it("저장 공간이 열리기 전에는 설정을 누를 수 없다", () => {
  const html = renderToStaticMarkup(createElement(App, { open: () => new Promise<never>(() => {}) }));
  expect(html).toContain("<h1>아이디어 볼트</h1>");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>설정<\/button>/);
});

describe("배포본", () => {
  let out: string;
  let html: string;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "idea-vault-build-"));
    // 테스트 환경 값이 배포 빌드에 섞이지 않게 한다.
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await build({ logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
    } finally {
      process.env.NODE_ENV = env;
    }
    // Vite는 속성의 따옴표를 &#39;로 적는다. 브라우저가 읽는 값으로 되돌려 확인한다.
    html = (await readFile(join(out, "index.html"), "utf8")).replaceAll("&#39;", "'");
  }, 60_000);

  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it("스크립트보다 앞에 보안 정책이 있고 통신을 두 API로 막는다", () => {
    const policy = html.indexOf("Content-Security-Policy");
    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(html.indexOf("<script"));
    expect(html).toContain("default-src 'none';");
    expect(html).toContain("connect-src https://api.github.com https://api.openai.com;");
    expect(html).not.toContain("unsafe-");
  });

  it("외부 자원과 인라인 스크립트가 없고 상대 경로를 쓴다", () => {
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toContain('src="./assets/');
      expect(body!.trim()).toBe("");
    }
  });

  it("보안 정책에 걸리는 미리 읽기 보조 코드가 없다", async () => {
    const files = await readdir(join(out, "assets"));
    for (const file of files.filter((f) => f.endsWith(".js"))) {
      // Vite의 보조 코드는 relList로 지원 여부를 확인한다. React에도 "modulepreload" 문구는 있다.
      expect(await readFile(join(out, "assets", file), "utf8")).not.toContain("relList");
    }
  });
});
