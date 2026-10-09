#!/usr/bin/env node
"use strict";

// 접속 비밀번호 설정. 비밀번호는 scrypt 해시로만 data/auth.json 에 저장된다.
//   npm run setup              → 직접 입력(화면에 표시되지 않음)
//   npm run setup -- --generate → 임의 비밀번호를 만들어 이 터미널에 한 번만 보여 줌

const readline = require("node:readline");
const crypto = require("node:crypto");
const auth = require("../lib/auth");
const store = require("../lib/store");

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    // @ts-ignore 입력 문자를 화면에 찍지 않는다.
    rl._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  store.ensureDirs();
  if (auth.isConfigured() && !process.argv.includes("--force")) {
    console.log("이미 접속 비밀번호가 설정되어 있습니다. 바꾸려면: npm run setup -- --force");
    return;
  }
  if (process.argv.includes("--generate")) {
    const pw = crypto.randomBytes(12).toString("base64url");
    auth.setPassword(pw);
    console.log("임의 접속 비밀번호를 만들었습니다. 지금 비밀번호 관리자에 저장하세요(다시 표시되지 않습니다):");
    console.log(`\n  ${pw}\n`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("터미널에서 직접 실행해 주세요. (또는 npm run setup -- --generate)");
    process.exit(1);
  }
  const a = await askHidden("새 접속 비밀번호(10자 이상): ");
  const b = await askHidden("한 번 더 입력: ");
  if (a !== b) {
    console.error("두 입력이 다릅니다. 다시 실행하세요.");
    process.exit(1);
  }
  auth.setPassword(a);
  console.log(`저장했습니다. (해시만 저장: ${store.DATA_DIR}/auth.json)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
