/** "소유자/저장소"로 다듬는다. GitHub 주소를 붙여 넣어도 받는다. 형식이 아니면 null */
export function parseRepository(input: string): string | null {
  const text = input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(text);
  if (!match || match[2] === "." || match[2] === "..") return null;
  return text;
}
