"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DATA_DIR = path.resolve(process.env.POONGRYU_DATA_DIR || path.join(__dirname, "..", "data"));
const RECORD_DIR = path.join(DATA_DIR, "records");
const MAX_VERSIONS = 5;
const RESULT_TYPES = ["clip_photo", "clip_video", "lounge", "monetization"];

function ensureDirs() {
  for (const d of [DATA_DIR, RECORD_DIR]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* 일부 파일시스템은 chmod 미지원 */
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 임시 파일에 쓰고 rename 해서 중간에 꺼져도 파일이 깨지지 않게 한다. */
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const ID_RE = /^[a-z0-9-]{8,64}$/;
function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}
function recordPath(id) {
  if (!ID_RE.test(id)) throw Object.assign(new Error("잘못된 기록 ID"), { status: 400 });
  return path.join(RECORD_DIR, `${id}.json`);
}

// ---- 기록 ----

function listRecords() {
  ensureDirs();
  return fs
    .readdirSync(RECORD_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(RECORD_DIR, f), null))
    .filter(Boolean)
    .map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      types: Object.keys(r.results || {}).filter((t) => r.results[t] && r.results[t].data),
      photoCount: ((r.input && r.input.photos) || []).length,
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function getRecord(id) {
  const r = readJson(recordPath(id), null);
  if (!r) throw Object.assign(new Error("기록을 찾지 못했습니다."), { status: 404 });
  return r;
}

function deriveTitle(input) {
  const first = String((input && input.text) || "")
    .split(/\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return (first || "제목 없는 작업").slice(0, 60);
}

/** 기록에는 원본 사진 대신 작은 썸네일만 남긴다(개인정보·용량). */
function sanitizeInput(input) {
  const i = input || {};
  const photos = Array.isArray(i.photos) ? i.photos.slice(0, 10) : [];
  return {
    text: String(i.text || "").slice(0, 60000),
    sourceUrl: String(i.sourceUrl || "").slice(0, 500),
    photoNotes: String(i.photoNotes || "").slice(0, 5000),
    videoMemo: String(i.videoMemo || "").slice(0, 5000),
    officialLimits: String(i.officialLimits || "").slice(0, 3000),
    disclosure: {
      kind: ["none", "ad", "sponsored", "affiliate", "unknown"].includes(i.disclosure && i.disclosure.kind)
        ? i.disclosure.kind
        : "unknown",
      detail: String((i.disclosure && i.disclosure.detail) || "").slice(0, 1000),
    },
    lounge: {
      topic: String((i.lounge && i.lounge.topic) || "").slice(0, 500),
      rules: String((i.lounge && i.lounge.rules) || "").slice(0, 5000),
    },
    goals: (Array.isArray(i.goals) ? i.goals : []).filter((g) => typeof g === "string").slice(0, 4),
    photos: photos.map((p) => ({
      note: String((p && p.note) || "").slice(0, 1000),
      thumb: typeof (p && p.thumb) === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.thumb) && p.thumb.length <= 120000
        ? p.thumb
        : null,
    })),
  };
}

function createRecord(input) {
  ensureDirs();
  const now = new Date().toISOString();
  const clean = sanitizeInput(input);
  const r = { id: newId(), title: deriveTitle(clean), createdAt: now, updatedAt: now, input: clean, results: {} };
  writeJson(recordPath(r.id), r);
  return r;
}

function updateRecordInput(id, input) {
  const r = getRecord(id);
  r.input = sanitizeInput(input);
  r.title = deriveTitle(r.input);
  r.updatedAt = new Date().toISOString();
  writeJson(recordPath(id), r);
  return r;
}

function pushVersion(slot) {
  if (!slot || !slot.data) return [];
  const versions = Array.isArray(slot.versions) ? slot.versions : [];
  const snapshot = { data: slot.data, savedAt: new Date().toISOString(), edited: Boolean(slot.edited), rev: slot.rev };
  return [snapshot, ...versions].slice(0, MAX_VERSIONS);
}

/** 생성 결과 저장. 기존 결과(수정본 포함)는 versions에 보존한다. */
function saveGenerated(id, type, data, meta) {
  const r = getRecord(id);
  r.results = r.results || {};
  const types = type === "all" ? ["clip_photo", "clip_video", "lounge"] : [type];
  for (const t of types) {
    const prev = r.results[t];
    r.results[t] = {
      data: type === "all" ? data[t] : data,
      generatedAt: new Date().toISOString(),
      meta: meta || null,
      edited: false,
      rev: ((prev && prev.rev) || 0) + 1,
      versions: pushVersion(prev),
    };
  }
  r.updatedAt = new Date().toISOString();
  writeJson(recordPath(id), r);
  return r;
}

/**
 * 사용자가 화면에서 수정한 결과 저장.
 * baseRev가 서버 rev와 다르면(그사이 재생성됨) 새 결과를 덮지 않고 수정본을 versions에 넣는다.
 */
function saveEdit(id, type, data, baseRev) {
  if (!RESULT_TYPES.includes(type)) throw Object.assign(new Error("잘못된 결과 유형"), { status: 400 });
  const r = getRecord(id);
  const slot = r.results && r.results[type];
  if (!slot) throw Object.assign(new Error("수정할 결과가 없습니다."), { status: 404 });
  let conflict = false;
  if (Number(baseRev) !== slot.rev) {
    conflict = true;
    slot.versions = [{ data, savedAt: new Date().toISOString(), edited: true, rev: baseRev, note: "재생성 중 수정한 내용" }, ...(slot.versions || [])].slice(0, MAX_VERSIONS);
  } else {
    slot.data = data;
    slot.edited = true;
  }
  r.updatedAt = new Date().toISOString();
  writeJson(recordPath(id), r);
  return { record: r, conflict };
}

function restoreVersion(id, type, index) {
  const r = getRecord(id);
  const slot = r.results && r.results[type];
  const v = slot && slot.versions && slot.versions[index];
  if (!v) throw Object.assign(new Error("복원할 버전이 없습니다."), { status: 404 });
  const versions = slot.versions.filter((_, i) => i !== index);
  r.results[type] = {
    ...slot,
    data: v.data,
    edited: true,
    rev: slot.rev + 1,
    versions: [{ data: slot.data, savedAt: new Date().toISOString(), edited: slot.edited, rev: slot.rev }, ...versions].slice(0, MAX_VERSIONS),
  };
  r.updatedAt = new Date().toISOString();
  writeJson(recordPath(id), r);
  return r;
}

function deleteRecord(id) {
  const p = recordPath(id);
  if (!fs.existsSync(p)) throw Object.assign(new Error("기록을 찾지 못했습니다."), { status: 404 });
  fs.unlinkSync(p);
}

// ---- 프로그램 조건 / 성과 기록 ----

const programsFile = () => path.join(DATA_DIR, "programs.json");
const performanceFile = () => path.join(DATA_DIR, "performance.json");

const PROGRAM_CATEGORIES = ["오늘 클립 챌린지", "클립 크리에이터 프로그램", "별도 이벤트(인증태그 등)", "라운지 서포터즈", "기타"];

function defaultPrograms() {
  // 조건은 비워 둔다. 사용자가 공식 공고를 확인해 직접 입력해야 '확인됨'이 된다.
  return PROGRAM_CATEGORIES.slice(0, 4).map((category) => ({
    id: newId(),
    category,
    name: category,
    sourceUrl: "",
    checkedOn: "",
    periodStart: "",
    periodEnd: "",
    eligibility: "",
    qualifyingContent: "",
    requirements: "",
    reward: "",
    rewardAmount: null,
    stackable: "확인 안 됨",
    notes: "",
  }));
}

const STR_FIELDS = ["category", "name", "sourceUrl", "checkedOn", "periodStart", "periodEnd", "eligibility", "qualifyingContent", "requirements", "reward", "stackable", "notes"];

function cleanProgram(p) {
  const out = { id: p && typeof p.id === "string" && ID_RE.test(p.id) ? p.id : newId() };
  for (const f of STR_FIELDS) out[f] = String((p && p[f]) || "").slice(0, 3000);
  const amt = p && p.rewardAmount;
  out.rewardAmount = amt === null || amt === "" || amt === undefined || !Number.isFinite(Number(amt)) ? null : Number(amt);
  if (!/^https?:\/\//i.test(out.sourceUrl)) out.sourceUrl = "";
  return out;
}

function listPrograms() {
  ensureDirs();
  const file = programsFile();
  if (!fs.existsSync(file)) writeJson(file, defaultPrograms());
  return readJson(file, []);
}
function savePrograms(list) {
  ensureDirs();
  const clean = (Array.isArray(list) ? list : []).slice(0, 50).map(cleanProgram);
  writeJson(programsFile(), clean);
  return clean;
}

const PERF_NUM = ["minutes", "views", "linkClicks", "blogVisits", "missionCount", "paidAmount"];
function cleanPerf(p) {
  const out = {
    id: p && typeof p.id === "string" && ID_RE.test(p.id) ? p.id : newId(),
    postedOn: String((p && p.postedOn) || "").slice(0, 20),
    channel: String((p && p.channel) || "").slice(0, 50),
    url: String((p && p.url) || "").slice(0, 500),
    recordId: String((p && p.recordId) || "").slice(0, 64),
    memo: String((p && p.memo) || "").slice(0, 1000),
  };
  // 측정하지 않은 값은 0이 아니라 null(미측정)로 둔다.
  for (const f of PERF_NUM) {
    const v = p && p[f];
    out[f] = v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  }
  return out;
}
function listPerformance() {
  ensureDirs();
  return readJson(performanceFile(), []);
}
function savePerformance(list) {
  ensureDirs();
  const clean = (Array.isArray(list) ? list : []).slice(0, 2000).map(cleanPerf);
  writeJson(performanceFile(), clean);
  return clean;
}

module.exports = {
  DATA_DIR,
  RECORD_DIR,
  RESULT_TYPES,
  ensureDirs,
  readJson,
  writeJson,
  newId,
  listRecords,
  getRecord,
  createRecord,
  updateRecordInput,
  saveGenerated,
  saveEdit,
  restoreVersion,
  deleteRecord,
  sanitizeInput,
  listPrograms,
  savePrograms,
  listPerformance,
  savePerformance,
  PROGRAM_CATEGORIES,
};
