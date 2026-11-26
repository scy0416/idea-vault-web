import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { CSP } from "./src/app/csp.ts";

/** 개발 서버는 인라인 스크립트와 웹소켓을 쓰므로 빌드할 때만 넣는다. */
const contentSecurityPolicy: Plugin = {
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
      injectTo: "head-prepend",
    },
  ],
};

export default defineConfig({
  // Pages의 하위 경로에서도 열리도록 상대 경로를 쓴다.
  base: "./",
  plugins: [react(), contentSecurityPolicy],
  build: {
    // 보조 코드가 fetch를 써서 통신 제한에 걸린다.
    modulePreload: { polyfill: false },
  },
});
