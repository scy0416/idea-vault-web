import { readFile } from "node:fs/promises";
import { scoreReport } from "./report.ts";

const files = process.argv.slice(2);
if (!files.length) {
  console.log("사용법: npm run w0:score -- <report.md> [...]");
  process.exitCode = 1;
}
for (const file of files) {
  console.log(`\n${file}`);
  for (const s of scoreReport(await readFile(file, "utf8"))) {
    const judged = s.good + s.bad;
    const rate = judged ? `${Math.round((s.good / judged) * 100)}%` : "-";
    console.log(`  ${s.label}: 납득 ${s.good} / 판정 ${judged} (${rate}), 빈칸 ${s.blank}`);
    if (s.unreadable.length) console.log(`    O/X가 아닌 판정: ${s.unreadable.join(", ")}`);
  }
}
