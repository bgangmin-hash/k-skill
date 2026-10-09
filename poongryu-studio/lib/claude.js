"use strict";

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLAUDE_BIN = process.env.POONGRYU_CLAUDE_BIN || "claude";

/**
 * 환경변수: 이 앱의 설정값(POONGRYU_*)은 넘기지 않고, CLAUDE.md·자동 메모리를 끈다.
 * 인증 관련 변수는 바꾸지 않는다(사용자의 기존 인증을 그대로 사용).
 */
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("POONGRYU_")) continue;
    env[k] = v;
  }
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

function apiKeyPresent() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function execJson(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, args, { timeout: timeoutMs, env: childEnv() }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

/** 설치 버전과 인증 상태. 토큰·이메일 등은 화면에 보내지 않는다. */
async function getStatus() {
  const v = await execJson(["--version"]);
  if (v.err && v.err.code === "ENOENT") {
    return { installed: false, message: "Claude Code(claude 명령)를 찾지 못했습니다." };
  }
  const version = v.stdout.trim().split(/\s+/)[0] || null;
  const a = await execJson(["auth", "status"]);
  let auth = null;
  try {
    const j = JSON.parse(a.stdout);
    auth = { loggedIn: Boolean(j.loggedIn), authMethod: j.authMethod || null, apiProvider: j.apiProvider || null };
  } catch {
    auth = { loggedIn: false, authMethod: null, apiProvider: null, raw: "auth status를 해석하지 못했습니다." };
  }
  return { installed: true, version, auth, apiKeyEnv: apiKeyPresent() };
}

function classifyFailure({ resultMsg, stderr, exitCode, timedOut, aborted }) {
  if (aborted) return { code: "cancelled", message: "사용자가 생성을 취소했습니다." };
  if (timedOut) return { code: "timeout", message: "응답 시간이 초과되었습니다. 입력을 줄이거나 잠시 뒤 다시 시도해 주세요." };
  const text = `${resultMsg ? resultMsg.result || "" : ""}\n${(resultMsg && resultMsg.errors) || ""}\n${stderr || ""}`;
  const status = resultMsg && resultMsg.api_error_status;
  if (/not logged in|please run \/login|invalid api key|authentication|oauth|401/i.test(text) || status === 401) {
    return {
      code: "auth",
      message: "Claude Code 로그인이 필요하거나 만료되었습니다. 맥북 터미널에서 직접 `claude`를 실행해 로그인한 뒤 다시 시도해 주세요.",
    };
  }
  if (/usage limit|rate limit|hit your .*limit|limit reached|429|overloaded|529/i.test(text) || status === 429) {
    return {
      code: "limit",
      message: "사용 한도에 도달했거나 서버가 혼잡합니다. 표시된 초기화 시각 이후 다시 시도해 주세요. 추가 결제는 이 앱이 하지 않습니다.",
    };
  }
  if (/credit balance|billing/i.test(text)) {
    return { code: "billing", message: "결제·크레딧 문제로 실패했습니다. 계정 설정을 직접 확인해 주세요." };
  }
  if (resultMsg && resultMsg.subtype === "error_max_structured_output_retries") {
    return { code: "format", message: "결과 형식을 맞추지 못했습니다. 다시 생성해 주세요." };
  }
  if (exitCode === 127 || /ENOENT/.test(text)) {
    return { code: "not_installed", message: "claude 명령을 실행하지 못했습니다. 설치 상태를 확인해 주세요." };
  }
  const brief = String((resultMsg && resultMsg.result) || stderr || "").slice(0, 300);
  return { code: "unknown", message: `생성에 실패했습니다.${brief ? ` (${brief})` : ""}` };
}

/**
 * claude -p 를 도구 없이 실행한다.
 * - 입력은 stdin(stream-json)으로만 전달: 사용자 입력이 셸·명령행 인자로 가지 않는다.
 * - --tools "" : 셸·파일·웹 도구를 모두 끈다(구조화 출력 도구만 남음).
 * - --strict-mcp-config, --setting-sources "" : MCP 서버와 설정 파일의 hook을 불러오지 않는다.
 */
function runClaude({ systemPrompt, userMessage, schema, model, timeoutMs = 8 * 60 * 1000, signal, onEvent }) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "poongryu-run-"));
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--system-prompt", systemPrompt,
      "--json-schema", JSON.stringify(schema),
    ];
    if (model) args.push("--model", model);

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      cleanup();
      resolve({ ok: false, code: "not_installed", message: `claude 실행 실패: ${e.message}` });
      return;
    }

    let buf = "";
    let stderr = "";
    let resultMsg = null;
    let rateLimit = null;
    let model_used = null;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    function stop() {
      if (child.exitCode === null) {
        child.kill("SIGINT");
        setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 3000).unref();
      }
    }
    function cleanup() {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* 정리 실패는 무시 */
      }
    }
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") model_used = msg.model || null;
        if (msg.type === "rate_limit_event") rateLimit = summarizeRateLimit(msg.rate_limit_info);
        if (msg.type === "system" && msg.subtype === "api_retry" && onEvent) {
          onEvent({ kind: "retry", attempt: msg.attempt, error: msg.error });
        }
        if (msg.type === "stream_event" && onEvent) onEvent({ kind: "progress" });
        if (msg.type === "result") resultMsg = msg;
      }
    });
    child.stderr.on("data", (c) => {
      stderr = (stderr + c).slice(-4000);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const notFound = e && e.code === "ENOENT";
      resolve({
        ok: false,
        code: notFound ? "not_installed" : "unknown",
        message: notFound ? "claude 명령을 찾지 못했습니다. Claude Code 설치를 확인해 주세요." : `claude 실행 오류: ${e.message}`,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      cleanup();
      const meta = {
        model: model_used,
        rateLimit,
        durationMs: resultMsg ? resultMsg.duration_ms : null,
        // 클라이언트 측 추정치(정가 기준). 구독 사용자는 이 금액이 청구되지 않고 플랜 한도에서 차감된다.
        costEstimateUsd: resultMsg ? resultMsg.total_cost_usd : null,
      };
      if (!aborted && !timedOut && resultMsg && !resultMsg.is_error && resultMsg.structured_output) {
        resolve({ ok: true, data: resultMsg.structured_output, meta });
        return;
      }
      const f = classifyFailure({ resultMsg, stderr, exitCode, timedOut, aborted });
      resolve({ ok: false, ...f, meta });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(userMessage)}\n`);
  });
}

function summarizeRateLimit(info) {
  if (!info || typeof info !== "object") return null;
  const out = { status: info.status || null, resetsAt: info.resetsAt || null, windows: {} };
  const w = info.unifiedWindows || {};
  for (const [name, v] of Object.entries(w)) {
    if (v && typeof v === "object") out.windows[name] = { utilization: v.utilization, resetsAt: v.resetsAt };
  }
  return out;
}

module.exports = { runClaude, getStatus, classifyFailure, apiKeyPresent, summarizeRateLimit, childEnv };
