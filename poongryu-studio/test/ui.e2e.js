#!/usr/bin/env node
"use strict";

// 브라우저 화면 흐름 테스트(테스트 모드 서버 + Playwright Chromium).
// 실행: npm run test:ui   (playwright가 설치되어 있어야 함. PLAYWRIGHT_MODULE로 경로 지정 가능)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poongryu-ui-"));
process.env.POONGRYU_DATA_DIR = dataDir;
const auth = require("../lib/auth");

const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "ui-test-password";
const SHOTS = process.env.SCREENSHOT_DIR || path.join(__dirname, "output");
const FIX = path.join(__dirname, "fixtures");
fs.mkdirSync(SHOTS, { recursive: true });

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, POONGRYU_MOCK: "1", POONGRYU_MOCK_DELAY: "400", POONGRYU_PORT: String(PORT), POONGRYU_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      try {
        await fetch(BASE + "/api/session");
        clearInterval(t);
        resolve({ child, log: () => log });
      } catch {
        /* 대기 */
      }
    }, 100);
    setTimeout(() => { clearInterval(t); reject(new Error("server start timeout\n" + log)); }, 8000);
  });
}

const steps = [];
async function step(name, fn) {
  try {
    await fn();
    steps.push(`ok   ${name}`);
    console.log(`ok   ${name}`);
  } catch (e) {
    steps.push(`FAIL ${name}: ${e.message}`);
    console.log(`FAIL ${name}: ${e.stack}`);
    process.exitCode = 1;
  }
}

async function waitResult(page, text) {
  // 결과 문구는 편집칸(input/textarea) 값에도 들어 있으므로 함께 확인한다.
  await page.waitForFunction((t) => {
    const p = document.querySelector("#result-panel");
    return p.textContent.includes(t) || Array.from(p.querySelectorAll("input, textarea")).some((e) => e.value.includes(t));
  }, text, { timeout: 15000 });
}

(async () => {
  auth.setPassword(PASSWORD);
  const srv = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    // ---------- 맥북 크기 ----------
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await step("로그인 화면 → 틀린 비밀번호 거부 → 로그인", async () => {
      await page.goto(BASE);
      await page.fill("#login-password", "wrong-pass-123");
      await page.click("#login-form button[type=submit]");
      await page.waitForSelector("#login-error:has-text('맞지 않습니다')");
      await page.fill("#login-password", PASSWORD);
      await page.click("#login-form button[type=submit]");
      await page.waitForSelector("#app-view:not([hidden])");
      await page.waitForSelector(".chip:has-text('테스트 모드')");
    });

    await step("원문 붙여넣기·TXT 불러오기·조건 입력", async () => {
      const txt = path.join(SHOTS, "blog.txt");
      fs.writeFileSync(txt, "주말에 다녀온 독립서점 기록\n\n작은 서점에서 시집 두 권을 골랐습니다. 고른 이유는 표지보다 첫 시의 리듬이었습니다.\n\n가격은 한 권 12,000원이었습니다.");
      await page.setInputFiles("#text-file", txt);
      await page.waitForFunction(() => document.querySelector("#in-text").value.includes("독립서점"));
      await page.fill("#in-url", "https://blog.naver.com/example/123");
      await page.selectOption("#in-disclosure", "none");
      await page.check("input[name=goal][value=info]");
      await page.fill("#in-lounge-topic", "책 읽는 사람들");
      await page.fill("#in-lounge-rules", "외부 링크 금지");
      await page.fill("#in-video-memo", "영상 A: 서점 입구 10초");
    });

    await step("사진 업로드·미리보기·순서 변경·삭제·HEIC 오류 안내", async () => {
      await page.setInputFiles("#photo-file", [path.join(FIX, "red.png"), path.join(FIX, "blue.png"), path.join(FIX, "red.png")]);
      await page.waitForFunction(() => document.querySelectorAll(".photo-item").length === 3);
      const notes = await page.$$(".photo-item textarea");
      await notes[0].fill("빨간 표지 시집");
      await notes[1].fill("파란 서가");
      await page.click(".photo-item:nth-child(1) button[aria-label='뒤로']");
      const firstNote = await page.inputValue(".photo-item:nth-child(1) textarea");
      assert.equal(firstNote, "파란 서가");
      page.once("dialog", (d) => d.accept());
      await page.click(".photo-item:nth-child(3) button.danger");
      await page.waitForFunction(() => document.querySelectorAll(".photo-item").length === 2);
      await page.setInputFiles("#photo-file", path.join(FIX, "fake.heic"));
      await page.waitForSelector("#photo-error:has-text('HEIC')");
      const src = await page.getAttribute(".photo-item img", "src");
      assert.match(src, /^data:image\/jpeg;base64,/);
    });

    await step("클립 사진 생성 → 상태 표시 → 결과 표시", async () => {
      await page.click(".gen[data-type=clip_photo]");
      await page.waitForSelector(".job-line .spinner");
      assert.equal(await page.isDisabled(".gen[data-type=clip_photo]"), true, "생성 중 중복 클릭 방지");
      await waitResult(page, "[테스트 응답] 핵심 질문");
      await page.waitForSelector(".badge:has-text('테스트 응답')");
      await page.screenshot({ path: path.join(SHOTS, "desktop-clip-photo.png"), fullPage: true });
    });

    await step("결과 직접 수정 → 새로고침 후에도 보존(서버 저장)", async () => {
      const caption = page.locator(".field:has(label:text-is('설명문')) textarea");
      await caption.fill("직접 고친 설명문입니다.");
      await page.waitForSelector(".save-state:has-text('저장됨')", { timeout: 5000 });
      await page.reload();
      await page.waitForSelector("#app-view:not([hidden])");
      await page.waitForFunction(() => Array.from(document.querySelectorAll("#result-panel textarea")).some((t) => t.value === "직접 고친 설명문입니다."));
      assert.equal(await page.inputValue("#in-url"), "https://blog.naver.com/example/123", "입력도 보존");
      assert.equal(await page.locator(".photo-item").count(), 2, "사진도 보존");
    });

    await step("항목 복사·게시용 복사", async () => {
      await page.click(".field:has(label:text-is('설명문')) button.copy");
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "직접 고친 설명문입니다.");
      await page.click("button:has-text('게시용 글 복사')");
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /직접 고친 설명문입니다\.\n\n#테스트/);
    });

    await step("MD·TXT 다운로드", async () => {
      const [md] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('MD 다운로드')")]);
      const mdText = fs.readFileSync(await md.path(), "utf8");
      assert.match(mdText, /^# 클립 사진 게시물/);
      assert.match(mdText, /## 설명문\n\n직접 고친 설명문입니다\./);
      assert.match(mdText, /사용자 수정됨/);
      const [txt] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('TXT 다운로드')")]);
      assert.match(fs.readFileSync(await txt.path(), "utf8"), /\[설명문\]/);
    });

    await step("재생성 시 수정본 보존(이전 버전) → 되돌리기", async () => {
      page.once("dialog", (d) => d.accept());
      await page.click(".gen[data-type=clip_photo]");
      await page.waitForSelector("details summary:has-text('이전 버전 1개')", { timeout: 15000 });
      await page.click("details summary");
      page.once("dialog", (d) => d.accept());
      await page.click("details button:has-text('되돌리기')");
      await page.waitForFunction(() => Array.from(document.querySelectorAll("#result-panel textarea")).some((t) => t.value === "직접 고친 설명문입니다."));
    });

    await step("전체 변환 → 수정본 경고 확인 → 세 결과 생성, 영상 시간 합계 확인", async () => {
      let warned = "";
      page.once("dialog", (d) => { warned = d.message(); d.accept(); });
      await page.click(".gen[data-type=all]");
      await page.waitForFunction(() => document.querySelector(".gen[data-type=all]").disabled);
      assert.match(warned, /이전 버전/, "수정본이 있으면 재생성 전에 알림");
      await page.waitForFunction(() => document.querySelectorAll(".subtab .dot.has").length >= 3, null, { timeout: 15000 });
      await page.click(".subtab:has-text('클립 영상')");
      await waitResult(page, "구간 길이 합계 10초");
      await page.click(".subtab:has-text('라운지')");
      await waitResult(page, "라운지 적합성");
    });

    await step("수익화 분석 → 계산기 적용", async () => {
      await page.click(".gen[data-type=monetization]");
      await page.click(".subtab:has-text('수익화 분석')");
      await waitResult(page, "프로그램 적합성");
      await page.click("button:has-text('이 가정을 계산기에 적용')");
      await page.waitForSelector("#tab-money:not([hidden])");
      await page.waitForSelector("#c-formulas li:has-text('한 편 제작시간 = 작성 20 + 검수 10 + 편집 15 + 업로드 5 = 50분')");
    });

    await step("프로그램 조건 입력: 미확인 보상은 합산 제외, 확인된 조건만 계산", async () => {
      const prog = page.locator(".prog").first();
      await prog.locator("label:has-text('조건 충족 시 보상 금액') input").fill("50000");
      await page.check("#c-programs label:first-of-type input");
      await page.waitForSelector("#c-formulas li:has-text('확인된 보상 없음')");
      await page.waitForSelector("#c-excluded:has-text('미확인')");
      await prog.locator("label:has-text('공식 출처 URL') input").fill("https://example.com/notice");
      const today = await page.evaluate(() => PoongryuCalc.isoDate(new Date()));
      await prog.locator("label:has-text('확인 날짜') input").fill(today);
      await page.waitForSelector("#c-formulas li:has-text('50,000원')");
      await page.fill("#c-extra-cost", "5000");
      await page.waitForSelector("#c-formulas li:has-text('시간당 순보상(조건 충족 시) = (50,000원 − 추가 비용 5,000원)')");
      await page.click("#prog-save");
      await page.waitForSelector("#toast:has-text('저장')");
    });

    await step("성과 기록: 빈 칸은 미측정", async () => {
      await page.click("#perf-add");
      await page.locator("#perf-list label:has-text('실제 지급액') input").fill("3000");
      await page.locator("#perf-list label:has-text('제작 시간') input").fill("30");
      await page.waitForSelector(".stat:has-text('조회수') b:text-is('미측정')");
      await page.waitForSelector(".stat:has-text('시간당 실제 지급액') b:text-is('6,000원')");
      await page.click("#perf-save");
      await page.screenshot({ path: path.join(SHOTS, "desktop-money.png"), fullPage: true });
    });

    await step("오류 처리: 사용 한도 오류 표시 → 기존 결과 유지", async () => {
      await page.click(".tab[data-tab=work]");
      await page.fill("#in-text", "본문 [[mock-error:limit]]");
      await page.click(".subtab:has-text('라운지')");
      await page.click(".gen[data-type=lounge]");
      await page.waitForSelector(".errbox:has-text('사용 한도')", { timeout: 15000 });
      await page.waitForSelector(".errbox:has-text('이전에 만든 결과')");
      await page.click(".errbox button:has-text('닫기')");
    });

    await step("기록: 목록 → 새 작업 → 다시 열기 → 선택 삭제", async () => {
      page.once("dialog", (d) => d.accept());
      await page.click("#new-work");
      assert.equal(await page.inputValue("#in-text"), "");
      await page.click(".tab[data-tab=history]");
      await page.waitForSelector(".hist-item");
      await page.click(".hist-item button:has-text('열기')");
      await page.waitForSelector("#tab-work:not([hidden])");
      await page.waitForFunction(() => document.querySelector("#in-text").value.includes("mock-error"));
      await page.waitForSelector(".photo-item .badge:has-text('썸네일')");
      await page.click(".tab[data-tab=history]");
      await page.waitForSelector(".hist-item");
      await page.check(".hist-check");
      page.once("dialog", (d) => d.accept());
      await page.click("#hist-delete");
      await page.waitForSelector(".hist-list .empty:has-text('저장된 기록이 없습니다')");
    });

    await step("콘솔 오류 없음(CSP 위반 포함)", async () => {
      assert.deepEqual(consoleErrors.filter((e) => !/status of 4\d\d/.test(e)), []);
    });
    await ctx.close();

    // ---------- 휴대폰 크기 ----------
    await step("모바일(iPhone 13): 가로 스크롤 없음·버튼 크기·결과 화면", async () => {
      const m = await browser.newContext({ ...devices["iPhone 13"], acceptDownloads: true });
      const mp = await m.newPage();
      await mp.goto(BASE);
      await mp.fill("#login-password", PASSWORD);
      await mp.click("#login-form button[type=submit]");
      await mp.waitForSelector("#app-view:not([hidden])");
      await mp.fill("#in-text", "모바일에서 붙여넣은 글\n짧은 본문");
      await mp.setInputFiles("#photo-file", path.join(FIX, "blue.png"));
      await mp.waitForSelector(".photo-item");
      await mp.screenshot({ path: path.join(SHOTS, "mobile-input.png"), fullPage: false });
      await mp.click(".gen[data-type=lounge]");
      await mp.click(".subtab:has-text('라운지')");
      await waitResult(mp, "라운지 적합성");
      // 모바일 Chromium은 넘치는 내용에 맞춰 레이아웃 뷰포트를 넓히므로 기기 화면 폭과 요소 위치를 직접 비교한다.
      const overflowCheck = () => mp.evaluate(() => {
        const W = screen.width;
        return Array.from(document.querySelectorAll("#app-view *"))
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.right > W + 1 && !el.closest(".tabs, .subtabs"); })
          .slice(0, 5)
          .map((el) => el.tagName + "." + el.className + " right=" + Math.round(el.getBoundingClientRect().right));
      });
      assert.deepEqual(await overflowCheck(), [], "결과 화면 가로 넘침");
      await mp.evaluate(() => window.scrollTo(0, 0));
      assert.deepEqual(await overflowCheck(), [], "입력 화면 가로 넘침");
      const small = await mp.evaluate(() => Array.from(document.querySelectorAll(".gen")).filter((b) => b.getBoundingClientRect().height < 44).length);
      assert.equal(small, 0, "생성 버튼 높이 44px 이상");
      await mp.locator("#result-panel").scrollIntoViewIfNeeded();
      await mp.screenshot({ path: path.join(SHOTS, "mobile-result.png"), fullPage: false });
      await m.close();
    });
  } finally {
    await browser.close();
    srv.child.kill();
    const log = srv.log();
    if (/책상|독립서점|ui-test-password/.test(log)) {
      console.log("FAIL 서버 로그에 원문·비밀번호가 남음");
      process.exitCode = 1;
    } else console.log("ok   서버 로그에 원문·비밀번호 없음");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\n${steps.filter((s) => s.startsWith("ok")).length}/${steps.length} 단계 통과. 스크린샷: ${SHOTS}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
