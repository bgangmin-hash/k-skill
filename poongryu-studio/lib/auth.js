"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const store = require("./store");

const SESSION_DAYS = 30;
const COOKIE = "pr_session";
const authFile = () => path.join(store.DATA_DIR, "auth.json");
const sessionsFile = () => path.join(store.DATA_DIR, "sessions.json");

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), algo: "scrypt-16384-8-1" };
}

function isConfigured() {
  return fs.existsSync(authFile());
}

function setPassword(password) {
  if (String(password).length < 10) throw new Error("접속 비밀번호는 10자 이상이어야 합니다.");
  store.ensureDirs();
  store.writeJson(authFile(), hashPassword(password));
  store.writeJson(sessionsFile(), {}); // 비밀번호를 바꾸면 기존 로그인은 모두 끊는다.
}

function verifyPassword(password) {
  const cfg = store.readJson(authFile(), null);
  if (!cfg) return false;
  const salt = Buffer.from(cfg.salt, "base64");
  const expected = Buffer.from(cfg.hash, "base64");
  const got = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

function loadSessions() {
  const all = store.readJson(sessionsFile(), {});
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(all)) {
    if (!v || v.expires < now) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) store.writeJson(sessionsFile(), all);
  return all;
}

/** 세션 토큰은 해시만 저장한다. 원문 토큰은 쿠키에만 있다. */
function createSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  const all = loadSessions();
  all[sha(token)] = { created: Date.now(), expires: Date.now() + SESSION_DAYS * 86400000 };
  store.writeJson(sessionsFile(), all);
  return token;
}

function destroySession(token) {
  if (!token) return;
  const all = loadSessions();
  delete all[sha(token)];
  store.writeJson(sessionsFile(), all);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = loadSessions()[sha(token)];
  return s ? token : null;
}

function cookieHeader(token, secure, maxAgeSec = SESSION_DAYS * 86400) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

// 로그인 시도 제한(메모리): 10분에 5회 실패하면 잠시 막는다.
const attempts = new Map();
function loginAllowed(key) {
  const a = attempts.get(key);
  if (!a) return true;
  if (Date.now() - a.first > 10 * 60 * 1000) {
    attempts.delete(key);
    return true;
  }
  return a.count < 5;
}
function recordFailure(key) {
  const a = attempts.get(key) || { count: 0, first: Date.now() };
  a.count += 1;
  attempts.set(key, a);
}
function clearFailures(key) {
  attempts.delete(key);
}

module.exports = {
  COOKIE,
  isConfigured,
  setPassword,
  verifyPassword,
  createSession,
  destroySession,
  sessionFromRequest,
  parseCookies,
  cookieHeader,
  loginAllowed,
  recordFailure,
  clearFailures,
};
