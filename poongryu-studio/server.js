#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const store = require("./lib/store");
const auth = require("./lib/auth");
const { validatePhotos } = require("./lib/images");
const { SCHEMAS, TYPE_LABELS } = require("./lib/schemas");
const { buildSystemPrompt, buildUserMessage } = require("./lib/prompts");
const claude = require("./lib/claude");
const { mockResponse } = require("./lib/mock");
const { createQueue } = require("./lib/jobs");
const { loadGuides, GUIDE_DIR } = require("./lib/guides");
const calc = require("./public/calc");

const HOST = process.env.POONGRYU_HOST || "127.0.0.1";
const PORT = Number(process.env.POONGRYU_PORT || 8787);
const MOCK = process.env.POONGRYU_MOCK === "1";
const MOCK_DELAY = Number(process.env.POONGRYU_MOCK_DELAY || 800);
const ALLOW_API_KEY = process.env.POONGRYU_ALLOW_API_KEY === "1";
const MODEL = process.env.POONGRYU_MODEL || "";
const TIMEOUT_MS = Number(process.env.POONGRYU_TIMEOUT_MS || 8 * 60 * 1000);
const EXTRA_ORIGINS = String(process.env.POONGRYU_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, "public");
const GENERATE_TYPES = Object.keys(SCHEMAS);

// ---------- 생성 작업 ----------

function programsForPrompt() {
  const today = calc.isoDate(new Date());
  return store.listPrograms().map((p) => {
    const st = calc.programStatus(p, today);
    const base = {
      id: p.id,
      name: p.name,
      category: p.category,
      status: st.usable ? "확인됨" : st.label,
      sourceUrl: p.sourceUrl || null,
      checkedOn: p.checkedOn || null,
    };
    if (!st.usable) return base; // 미확인·만료·오래된 조건은 내용·보상을 넘기지 않는다.
    return {
      ...base,
      period: `${p.periodStart || "?"} ~ ${p.periodEnd || "?"}`,
      eligibility: p.eligibility,
      qualifyingContent: p.qualifyingContent,
      requirements: p.requirements,
      reward: p.reward,
      stackable: p.stackable,
    };
  });
}

async function runJob(job, signal, onEvent) {
  const { type, recordId } = job;
  const { input, photos } = job.payload;
  const fullInput = { ...input, photos };
  const programs = type === "monetization" ? programsForPrompt() : [];
  let res;
  if (MOCK) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, MOCK_DELAY);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (signal.aborted) return { ok: false, code: "cancelled", message: "사용자가 생성을 취소했습니다." };
    res = mockResponse(type, fullInput, programs);
  } else {
    if (claude.apiKeyPresent() && !ALLOW_API_KEY) {
      return {
        ok: false,
        code: "api_key_env",
        message:
          "ANTHROPIC_API_KEY 환경변수가 설정되어 있어, 이대로 실행하면 구독이 아니라 API 사용량으로 과금됩니다. 구독으로 쓰려면 이 변수를 해제하고 다시 시작하세요. API 과금을 알고 쓰려면 POONGRYU_ALLOW_API_KEY=1로 시작하세요.",
      };
    }
    const guides = loadGuides().filter((g) => g.content);
    res = await claude.runClaude({
      systemPrompt: buildSystemPrompt(type, guides),
      userMessage: buildUserMessage(type, fullInput, { programs }),
      schema: SCHEMAS[type],
      model: MODEL || undefined,
      timeoutMs: TIMEOUT_MS,
      signal,
      onEvent,
    });
  }
  if (res.ok) {
    if (type === "all" && !(res.data && res.data.clip_photo && res.data.clip_video && res.data.lounge)) {
      return { ok: false, code: "format", message: "전체 변환 결과 일부가 비어 있습니다. 다시 생성해 주세요.", meta: res.meta };
    }
    store.saveGenerated(recordId, type, res.data, res.meta);
    if (res.meta && res.meta.rateLimit) lastRateLimit = { ...res.meta.rateLimit, at: new Date().toISOString() };
  } else if (res.meta && res.meta.rateLimit) {
    lastRateLimit = { ...res.meta.rateLimit, at: new Date().toISOString() };
  }
  const secs = job.startedAt ? ((Date.now() - Date.parse(job.startedAt)) / 1000).toFixed(1) : "?";
  // 로그에는 원문·사진·비밀번호를 남기지 않는다.
  console.log(`[job] ${type} ${res.ok ? "완료" : `실패(${res.code})`} ${secs}s${MOCK ? " [테스트 모드]" : ""}`);
  return res;
}

let lastRateLimit = null;
const queue = createQueue(runJob);

// ---------- HTTP 유틸 ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function fail(res, status, message, extra = {}) {
  send(res, status, { error: message, ...extra });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`요청 용량이 너무 큽니다(최대 ${Math.round(limit / 1048576)}MB).`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("JSON 형식이 올바르지 않습니다."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function isSecure(req) {
  return req.headers["x-forwarded-proto"] === "https" || /^https:/i.test(String(req.headers.origin || ""));
}

/** 상태를 바꾸는 요청은 같은 출처 + 전용 헤더가 있어야 한다(CSRF 방지). */
function sameOriginOk(req) {
  if (req.headers["x-poongryu"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true; // 일부 브라우저는 같은 출처 fetch에 Origin을 생략한다. 전용 헤더로 방어.
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const allowed = [req.headers.host, req.headers["x-forwarded-host"]].filter(Boolean);
  if (allowed.includes(u.host)) return true;
  if (EXTRA_ORIGINS.includes(origin)) return true;
  // Tailscale Serve(https://<기기>.<tailnet>.ts.net)가 Host를 바꿔 전달하는 경우
  return u.protocol === "https:" && /\.ts\.net$/i.test(u.hostname);
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, "Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

function clientKey(req) {
  return String(req.headers["tailscale-user-login"] || req.socket.remoteAddress || "local");
}

let statusCache = null;
async function claudeStatus(force) {
  if (MOCK) return { installed: null, mock: true };
  if (!force && statusCache && Date.now() - statusCache.at < 60000) return statusCache.value;
  const value = await claude.getStatus();
  statusCache = { at: Date.now(), value };
  return value;
}

// ---------- 라우터 ----------

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/session" && m === "GET") {
    return send(res, 200, { configured: auth.isConfigured(), authenticated: Boolean(auth.sessionFromRequest(req)) });
  }

  if (m !== "GET" && !sameOriginOk(req)) return fail(res, 403, "허용되지 않은 요청입니다.");

  if (p === "/api/login" && m === "POST") {
    if (!auth.isConfigured()) return fail(res, 503, "접속 비밀번호가 설정되지 않았습니다. 맥북 터미널에서 npm run setup 을 실행하세요.");
    const key = clientKey(req);
    if (!auth.loginAllowed(key)) return fail(res, 429, "로그인 시도가 많습니다. 10분 뒤 다시 시도하세요.");
    const body = await readBody(req, 10000);
    if (!auth.verifyPassword(body.password || "")) {
      auth.recordFailure(key);
      return fail(res, 401, "비밀번호가 맞지 않습니다.");
    }
    auth.clearFailures(key);
    const token = auth.createSession();
    return send(res, 200, { ok: true }, { "Set-Cookie": auth.cookieHeader(token, isSecure(req)) });
  }

  const session = auth.sessionFromRequest(req);
  if (!session) return fail(res, 401, "로그인이 필요합니다.");

  if (p === "/api/logout" && m === "POST") {
    auth.destroySession(session);
    return send(res, 200, { ok: true }, { "Set-Cookie": auth.cookieHeader("", isSecure(req), 0) });
  }

  if (p === "/api/status" && m === "GET") {
    const st = await claudeStatus(url.searchParams.get("refresh") === "1");
    const guides = loadGuides().map((g) => ({ name: g.name, chars: g.chars, truncated: Boolean(g.truncated), skipped: Boolean(g.skipped) }));
    return send(res, 200, {
      mock: MOCK,
      claude: st,
      apiKeyBlocked: !MOCK && claude.apiKeyPresent() && !ALLOW_API_KEY,
      apiKeyAllowed: !MOCK && claude.apiKeyPresent() && ALLOW_API_KEY,
      model: MODEL || null,
      rateLimit: lastRateLimit,
      dataDir: store.DATA_DIR,
      guideDir: GUIDE_DIR,
      guides,
      host: HOST,
      port: PORT,
      jobs: queue.active(),
      staleDays: calc.STALE_DAYS,
    });
  }

  // 기록
  if (p === "/api/records" && m === "GET") return send(res, 200, { records: store.listRecords() });
  if (p === "/api/records" && m === "POST") {
    const body = await readBody(req, 3 * 1048576);
    return send(res, 200, { record: store.createRecord(body.input) });
  }
  let mm = p.match(/^\/api\/records\/([a-z0-9-]+)$/);
  if (mm) {
    if (m === "GET") return send(res, 200, { record: store.getRecord(mm[1]) });
    if (m === "DELETE") {
      store.deleteRecord(mm[1]);
      return send(res, 200, { ok: true });
    }
  }
  mm = p.match(/^\/api\/records\/([a-z0-9-]+)\/input$/);
  if (mm && m === "PUT") {
    const body = await readBody(req, 3 * 1048576);
    return send(res, 200, { record: store.updateRecordInput(mm[1], body.input) });
  }
  mm = p.match(/^\/api\/records\/([a-z0-9-]+)\/results\/([a-z_]+)$/);
  if (mm && m === "PUT") {
    const body = await readBody(req, 2 * 1048576);
    const out = store.saveEdit(mm[1], mm[2], body.data, body.rev);
    return send(res, 200, out);
  }
  mm = p.match(/^\/api\/records\/([a-z0-9-]+)\/results\/([a-z_]+)\/restore$/);
  if (mm && m === "POST") {
    const body = await readBody(req, 10000);
    return send(res, 200, { record: store.restoreVersion(mm[1], mm[2], Number(body.index)) });
  }

  // 생성
  if (p === "/api/generate" && m === "POST") {
    const body = await readBody(req, 32 * 1048576);
    const type = body.type;
    if (!GENERATE_TYPES.includes(type)) return fail(res, 400, "알 수 없는 생성 유형입니다.");
    const input = body.input || {};
    if (!String(input.text || "").trim()) return fail(res, 400, "블로그 원문을 입력해 주세요.");
    if (String(input.text).length > 60000) return fail(res, 400, "원문이 너무 깁니다(6만 자 이하).");
    const v = validatePhotos(type === "monetization" ? [] : input.photos);
    if (!v.ok) return fail(res, 400, v.message);
    // 사진 설명은 수익화 분석에도 쓰므로 메모는 항상 유지한다.
    const notes = (Array.isArray(input.photos) ? input.photos : []).map((ph) => ({ note: ph && ph.note }));
    const photos = type === "monetization" ? notes : v.photos;

    let recordId = body.recordId;
    if (recordId) {
      store.updateRecordInput(recordId, input);
    } else {
      recordId = store.createRecord(input).id;
    }
    const clean = store.sanitizeInput(input);
    delete clean.photos;
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(clean))
      .update(photos.map((x) => `${x.data ? crypto.createHash("sha1").update(x.data).digest("hex") : ""}:${x.note || ""}`).join("|"))
      .digest("hex");
    const r = queue.enqueue({ type, recordId, payload: { input: clean, photos }, fingerprint });
    return send(res, 200, { recordId, ...r });
  }
  if (p === "/api/jobs" && m === "GET") return send(res, 200, { jobs: queue.active() });
  mm = p.match(/^\/api\/jobs\/([a-z0-9-]+)$/);
  if (mm && m === "GET") {
    const j = queue.get(mm[1]);
    return j ? send(res, 200, { job: j }) : fail(res, 404, "작업을 찾지 못했습니다(서버가 재시작되었을 수 있습니다).");
  }
  mm = p.match(/^\/api\/jobs\/([a-z0-9-]+)\/cancel$/);
  if (mm && m === "POST") {
    const j = queue.cancel(mm[1]);
    return j ? send(res, 200, { job: j }) : fail(res, 404, "작업을 찾지 못했습니다.");
  }

  // 수익화 조건·성과
  if (p === "/api/programs" && m === "GET") return send(res, 200, { programs: store.listPrograms(), categories: store.PROGRAM_CATEGORIES });
  if (p === "/api/programs" && m === "PUT") {
    const body = await readBody(req, 1048576);
    return send(res, 200, { programs: store.savePrograms(body.programs) });
  }
  if (p === "/api/performance" && m === "GET") return send(res, 200, { performance: store.listPerformance() });
  if (p === "/api/performance" && m === "PUT") {
    const body = await readBody(req, 2 * 1048576);
    return send(res, 200, { performance: store.savePerformance(body.performance) });
  }

  return fail(res, 404, "없는 API입니다.");
}

function createServer() {
  store.ensureDirs();
  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return send(res, 400, "Bad request");
    }
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error("[error]", e && e.message);
      if (!res.headersSent) fail(res, status, status >= 500 ? "서버 오류가 발생했습니다." : e.message);
    }
  });
}

if (require.main === module) {
  if (!auth.isConfigured()) {
    console.error("접속 비밀번호가 아직 없습니다. 먼저 `npm run setup` 을 실행하세요.");
    process.exit(1);
  }
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") {
    console.warn(`[주의] ${HOST} 에 바인딩합니다. 같은 네트워크의 다른 기기에서 접속할 수 있습니다. 휴대폰 접속은 Tailscale Serve 사용을 권장합니다.`);
  }
  createServer().listen(PORT, HOST, () => {
    console.log(`풍류 콘텐츠 스튜디오: http://${HOST === "::1" ? "[::1]" : HOST}:${PORT}`);
    console.log(MOCK ? "모드: 테스트 응답(실제 Claude 호출 없음)" : "모드: 실제 Claude Code 호출");
    console.log(`데이터 위치: ${store.DATA_DIR}`);
  });
}

module.exports = { createServer, TYPE_LABELS };
