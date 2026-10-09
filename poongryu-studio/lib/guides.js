"use strict";

const fs = require("node:fs");
const path = require("node:path");

// guides/ 폴더의 .md/.txt 지침(블로그 지침, 검수 지침, 클립·라운지 프롬프트 등)을 읽는다.
// README.md는 안내문이므로 제외한다.
const GUIDE_DIR = path.resolve(process.env.POONGRYU_GUIDE_DIR || path.join(__dirname, "..", "guides"));
const MAX_EACH = 30000;
const MAX_TOTAL = 60000;

function loadGuides() {
  let names = [];
  try {
    names = fs.readdirSync(GUIDE_DIR).filter((n) => /\.(md|txt)$/i.test(n) && n.toLowerCase() !== "readme.md").sort();
  } catch {
    return [];
  }
  const out = [];
  let total = 0;
  for (const name of names) {
    let content = fs.readFileSync(path.join(GUIDE_DIR, name), "utf8");
    const truncated = content.length > MAX_EACH;
    content = content.slice(0, MAX_EACH);
    if (total + content.length > MAX_TOTAL) {
      out.push({ name, content: "", skipped: true, chars: content.length });
      continue;
    }
    total += content.length;
    out.push({ name, content, truncated, chars: content.length });
  }
  return out;
}

module.exports = { loadGuides, GUIDE_DIR };
