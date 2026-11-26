// 배포본의 콘텐츠 보안 정책. 스크립트는 자기 자신, 통신은 GitHub와 OpenAI API만 허용한다.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src https://api.github.com https://api.openai.com",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
