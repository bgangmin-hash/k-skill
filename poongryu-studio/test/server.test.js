"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.POONGRYU_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "poongryu-srv-"));
process.env.POONGRYU_MOCK = "1";
process.env.POONGRYU_MOCK_DELAY = "150";

const auth = require("../lib/auth");
const { createServer } = require("../server");

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64");
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(8)]).toString("base64");
const PASSWORD = "test-password-123";

let base;
let cookie = "";
let server;

async function call(method, p, body, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (opts.csrf !== false) headers["X-Poongryu"] = "1";
  if (opts.origin) headers.Origin = opts.origin;
  if (cookie && opts.cookie !== false) headers.Cookie = cookie;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && opts.keepCookie !== false) cookie = setCookie.split(";")[0];
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 정적 파일 */
  }
  return { status: res.status, data, headers: res.headers };
}

async function waitJob(id) {
  for (let i = 0; i < 100; i++) {
    const r = await call("GET", `/api/jobs/${id}`);
    if (!["queued", "running"].includes(r.data.job.status)) return r.data.job;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("job timeout");
}

const input = (extra = {}) => ({
  text: "제목 줄\n본문입니다.",
  sourceUrl: "https://blog.naver.com/test/1",
  photos: [{ data: JPEG, note: "책상 위 노트", thumb: "data:image/jpeg;base64,AAAA" }],
  disclosure: { kind: "none" },
  lounge: { topic: "책", rules: "링크 금지" },
  goals: ["info"],
  ...extra,
});

test.before(async () => {
  auth.setPassword(PASSWORD);
  server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("보안 헤더와 정적 화면", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await fetch(base + "/../server.js")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/server.js")).status, 404);
});

test("인증: 로그인 전 API 차단, CSRF 헤더 필수, 틀린 비밀번호 거부", async () => {
  assert.equal((await call("GET", "/api/records", undefined, { cookie: false })).status, 401);
  assert.equal((await call("POST", "/api/login", { password: PASSWORD }, { csrf: false })).status, 403);
  assert.equal((await call("POST", "/api/login", { password: PASSWORD }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("POST", "/api/login", { password: "wrong-password" }, { keepCookie: false })).status, 401);
  // Tailscale Serve 주소(https, *.ts.net)는 출처 검사를 통과한다(틀린 비밀번호라 401).
  assert.equal((await call("POST", "/api/login", { password: "wrong-2" }, { origin: "https://mac.tail1234.ts.net", keepCookie: false })).status, 401);
  assert.equal((await call("POST", "/api/login", { password: PASSWORD }, { origin: "http://mac.tail1234.ts.net" })).status, 403);
  const ok = await call("POST", "/api/login", { password: PASSWORD });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const st = await call("GET", "/api/status");
  assert.equal(st.data.mock, true);
  assert.ok(!JSON.stringify(st.data).includes(PASSWORD));
  const authFile = fs.readFileSync(path.join(process.env.POONGRYU_DATA_DIR, "auth.json"), "utf8");
  assert.ok(!authFile.includes(PASSWORD), "비밀번호 원문은 저장하지 않음");
});

test("생성: 각 버튼 → 작업 완료 → 기록에 저장, 중복 클릭은 같은 작업", async () => {
  const first = await call("POST", "/api/generate", { type: "clip_photo", input: input() });
  assert.equal(first.status, 200);
  const recordId = first.data.recordId;
  const dup = await call("POST", "/api/generate", { type: "clip_photo", recordId, input: input() });
  assert.equal(dup.data.duplicate, true);
  assert.equal(dup.data.job.id, first.data.job.id);
  assert.equal((await waitJob(first.data.job.id)).status, "done");

  for (const type of ["clip_video", "lounge", "monetization", "all"]) {
    const r = await call("POST", "/api/generate", { type, recordId, input: input() });
    assert.equal(r.status, 200, type);
    const job = await waitJob(r.data.job.id);
    assert.equal(job.status, "done", type);
    assert.equal(job.meta.mock, true);
  }
  const rec = (await call("GET", `/api/records/${recordId}`)).data.record;
  for (const t of ["clip_photo", "clip_video", "lounge", "monetization"]) assert.ok(rec.results[t].data, t);
  assert.equal(rec.results.clip_photo.rev, 2, "전체 변환이 클립 사진을 다시 생성");
  assert.equal(rec.results.clip_photo.versions.length, 1, "이전 결과 보존");
  assert.equal(rec.input.photos[0].note, "책상 위 노트");
  assert.equal(rec.input.photos[0].thumb, "data:image/jpeg;base64,AAAA");
  assert.ok(!JSON.stringify(rec).includes(JPEG.slice(0, 8) + "AAA"), "원본 사진 데이터 미저장");

  const edit = await call("PUT", `/api/records/${recordId}/results/lounge`, { data: { ...rec.results.lounge.data, body: "직접 고친 본문" }, rev: rec.results.lounge.rev });
  assert.equal(edit.data.conflict, false);
  assert.equal(edit.data.record.results.lounge.data.body, "직접 고친 본문");

  const list = await call("GET", "/api/records");
  assert.ok(list.data.records.some((x) => x.id === recordId && x.title === "제목 줄"));
});

test("입력 검증: 빈 원문·HEIC·잘못된 유형", async () => {
  assert.equal((await call("POST", "/api/generate", { type: "lounge", input: input({ text: "  " }) })).status, 400);
  const heic = await call("POST", "/api/generate", { type: "lounge", input: input({ photos: [{ data: HEIC }] }) });
  assert.equal(heic.status, 400);
  assert.match(heic.data.error, /HEIC/);
  assert.equal((await call("POST", "/api/generate", { type: "rm -rf", input: input() })).status, 400);
});

test("오류 처리: 사용 한도·로그인 오류가 작업 상태로 전달되고, 대기 중 취소 가능", async () => {
  const lim = await call("POST", "/api/generate", { type: "lounge", input: input({ text: "본문 [[mock-error:limit]]" }) });
  const job = await waitJob(lim.data.job.id);
  assert.equal(job.status, "error");
  assert.equal(job.code, "limit");
  const au = await call("POST", "/api/generate", { type: "lounge", input: input({ text: "본문 [[mock-error:auth]]" }) });
  assert.equal((await waitJob(au.data.job.id)).code, "auth");

  const a = await call("POST", "/api/generate", { type: "clip_video", input: input({ text: "작업 A" }) });
  const b = await call("POST", "/api/generate", { type: "clip_video", input: input({ text: "작업 B" }) });
  const c = await call("POST", `/api/jobs/${b.data.job.id}/cancel`);
  assert.equal(c.data.job.status, "cancelled");
  assert.equal((await waitJob(a.data.job.id)).status, "done");
  assert.equal((await call("GET", "/api/jobs/job-nope-1234")).status, 404);
});

test("프로그램 조건·성과 기록 저장, 미측정 값은 null 유지", async () => {
  const p = await call("GET", "/api/programs");
  assert.equal(p.data.programs.length, 4, "기본 4개 구분(조건은 비어 있음)");
  assert.ok(p.data.programs.every((x) => !x.sourceUrl && x.rewardAmount === null));
  const saved = await call("PUT", "/api/programs", { programs: [{ name: "테스트", sourceUrl: "javascript:alert(1)", rewardAmount: "abc" }] });
  assert.equal(saved.data.programs[0].sourceUrl, "", "http(s)가 아닌 URL 제거");
  assert.equal(saved.data.programs[0].rewardAmount, null);
  const perf = await call("PUT", "/api/performance", { performance: [{ channel: "클립 사진", views: "", paidAmount: 1000 }] });
  assert.equal(perf.data.performance[0].views, null);
  assert.equal(perf.data.performance[0].paidAmount, 1000);
});

test("기록 삭제와 로그아웃", async () => {
  const r = await call("POST", "/api/records", { input: { text: "삭제용" } });
  assert.equal((await call("DELETE", `/api/records/${r.data.record.id}`)).status, 200);
  assert.equal((await call("GET", `/api/records/${r.data.record.id}`)).status, 404);
  await call("POST", "/api/logout");
  assert.equal((await call("GET", "/api/records")).status, 401);
});
