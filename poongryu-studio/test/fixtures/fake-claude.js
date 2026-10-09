#!/usr/bin/env node
"use strict";
// 테스트용 가짜 claude. 받은 인자와 stdin을 결과로 되돌려 준다.
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", email: "secret@example.com" })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const msg = JSON.parse(input.trim());
  const mode = process.env.FAKE_CLAUDE_MODE || "ok";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  out({ type: "system", subtype: "init", model: "fake-model", tools: [] });
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1 } } } });
  if (mode === "auth") { out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }); process.exit(1); }
  if (mode === "hang") { setTimeout(() => {}, 100000); return; }
  out({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, duration_ms: 5,
    structured_output: { args, cwd: process.cwd(), env: { mds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, mem: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, leak: process.env.POONGRYU_SECRET_TEST || null }, content: msg.message.content.map((c) => c.type) } });
});
