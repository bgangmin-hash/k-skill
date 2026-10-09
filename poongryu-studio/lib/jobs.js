"use strict";

const crypto = require("node:crypto");

// 한 번에 하나씩 실행하는 생성 작업 대기열. 같은 요청을 중복 클릭하면 기존 작업을 돌려준다.

const MAX_PENDING = 4;
const KEEP_MS = 2 * 60 * 60 * 1000;

function createQueue(runner) {
  const jobs = new Map();
  const order = [];
  let running = null;

  function publicJob(j) {
    if (!j) return null;
    const position = j.status === "queued" ? order.filter((id) => jobs.get(id).status === "queued").indexOf(j.id) + 1 : 0;
    return {
      id: j.id,
      type: j.type,
      recordId: j.recordId,
      status: j.status,
      position,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      code: j.code || null,
      message: j.message || null,
      meta: j.meta || null,
      retries: j.retries || 0,
    };
  }

  function gc() {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (j.finishedAt && now - Date.parse(j.finishedAt) > KEEP_MS) {
        jobs.delete(id);
        const i = order.indexOf(id);
        if (i >= 0) order.splice(i, 1);
      }
    }
  }

  function pump() {
    if (running) return;
    const next = order.map((id) => jobs.get(id)).find((j) => j && j.status === "queued");
    if (!next) return;
    running = next;
    next.status = "running";
    next.startedAt = new Date().toISOString();
    next.controller = new AbortController();
    Promise.resolve()
      .then(() => runner(next, next.controller.signal, (ev) => {
        if (ev && ev.kind === "retry") next.retries = ev.attempt;
      }))
      .then((res) => {
        if (next.status === "cancelled") return;
        if (res && res.ok) {
          next.status = "done";
          next.meta = res.meta || null;
        } else {
          next.status = res && res.code === "cancelled" ? "cancelled" : "error";
          next.code = (res && res.code) || "unknown";
          next.message = (res && res.message) || "알 수 없는 오류";
          next.meta = (res && res.meta) || null;
        }
      })
      .catch((e) => {
        next.status = "error";
        next.code = "internal";
        next.message = `내부 오류: ${e && e.message}`;
      })
      .finally(() => {
        next.finishedAt = new Date().toISOString();
        delete next.payload; // 사진 등 입력은 끝나면 메모리에서 지운다.
        delete next.controller;
        running = null;
        gc();
        pump();
      });
  }

  function enqueue({ type, recordId, payload, fingerprint }) {
    gc();
    const key = crypto.createHash("sha256").update(`${type}|${recordId}|${fingerprint}`).digest("hex");
    for (const j of jobs.values()) {
      if ((j.status === "queued" || j.status === "running") && j.recordId === recordId && j.type === type) {
        return { job: publicJob(j), duplicate: true, sameInput: j.key === key };
      }
    }
    const pending = [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running").length;
    if (pending >= MAX_PENDING) {
      const err = new Error("대기 중인 작업이 많습니다. 앞 작업이 끝난 뒤 다시 눌러 주세요.");
      err.status = 429;
      throw err;
    }
    const j = {
      id: `job-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
      key,
      type,
      recordId,
      payload,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    jobs.set(j.id, j);
    order.push(j.id);
    pump();
    return { job: publicJob(j), duplicate: false };
  }

  function get(id) {
    return publicJob(jobs.get(id));
  }

  function cancel(id) {
    const j = jobs.get(id);
    if (!j) return null;
    if (j.status === "queued") {
      j.status = "cancelled";
      j.code = "cancelled";
      j.message = "대기 중 취소했습니다.";
      j.finishedAt = new Date().toISOString();
      delete j.payload;
    } else if (j.status === "running" && j.controller) {
      j.controller.abort();
    }
    return publicJob(j);
  }

  function active() {
    return [...jobs.values()].filter((j) => j.status === "queued" || j.status === "running").map(publicJob);
  }

  return { enqueue, get, cancel, active };
}

module.exports = { createQueue };
