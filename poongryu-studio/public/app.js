/* 풍류 콘텐츠 스튜디오 - 화면 */
(function () {
  "use strict";

  var Calc = window.PoongryuCalc;
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  var RESULT_TYPES = ["clip_photo", "clip_video", "lounge", "monetization"];
  var LABELS = { clip_photo: "클립 사진", clip_video: "클립 영상", lounge: "라운지", monetization: "수익화 분석", all: "전체 변환" };
  var FULL_LABELS = { clip_photo: "클립 사진 게시물", clip_video: "클립 영상 대본", lounge: "라운지 글", monetization: "수익화 분석", all: "전체 변환" };
  var MAX_PHOTOS = 10;

  // ---------- DOM 도우미 (사용자 텍스트는 textContent로만 넣는다) ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "text") el.textContent = v;
      else if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v; // CSP: style 속성 대신 CSSOM으로 지정
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = Boolean(v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { append(el, x); });
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function debounce(fn, ms) {
    var t;
    var d = function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); };
    d.flush = function () { clearTimeout(t); fn(); };
    return d;
  }
  function toast(msg, ms) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("show"); }, ms || 2600);
  }
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function secToClock(s) {
    s = Math.max(0, Math.round(Number(s) || 0));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  // ---------- API ----------
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", credentials: "same-origin", headers: { "X-Poongryu": "1" }, keepalive: Boolean(opts.keepalive) };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && path !== "/api/login") {
          showLogin();
        }
        if (!res.ok) {
          var e = new Error(data.error || "요청 실패 (" + res.status + ")");
          e.status = res.status;
          throw e;
        }
        return data;
      });
    }, function () {
      var e = new Error("서버에 연결하지 못했습니다. 맥북에서 앱이 실행 중인지 확인하세요.");
      e.status = 0;
      throw e;
    });
  }

  // ---------- 브라우저 임시 저장(IndexedDB) ----------
  var DB = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        try {
          var req = indexedDB.open("poongryu-studio", 1);
          req.onupgradeneeded = function () { req.result.createObjectStore("kv"); };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        } catch (e) { reject(e); }
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction("kv", mode);
          var r = fn(t.objectStore("kv"));
          t.oncomplete = function () { resolve(r && r.result); };
          t.onerror = function () { reject(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx("readonly", function (s) { return s.get(k); }); },
      set: function (k, v) { return tx("readwrite", function (s) { return s.put(v, k); }); },
      del: function (k) { return tx("readwrite", function (s) { return s.delete(k); }); },
    };
  })();

  // ---------- 상태 ----------
  function emptyInput() {
    return { text: "", sourceUrl: "", photoNotes: "", videoMemo: "", officialLimits: "", disclosure: { kind: "unknown", detail: "" }, lounge: { topic: "", rules: "" }, goals: [] };
  }
  var state = {
    recordId: null,
    input: emptyInput(),
    photos: [], // {id, blob, thumb, note, thumbOnly}
    results: {}, // type -> {data, rev, generatedAt, meta, edited, versions}
    jobs: {}, // type -> {jobId, via, status, position, startedAt, code, message, retries}
    unsaved: {},
    activeResult: "clip_photo",
  };
  var server = { mock: false, status: null, programs: [], performance: [] };

  var saveDraft = debounce(function () {
    var draft = {
      v: 1,
      recordId: state.recordId,
      input: state.input,
      photos: state.photos.map(function (p) { return { id: p.id, blob: p.blob || null, thumb: p.thumb, note: p.note, thumbOnly: Boolean(p.thumbOnly) }; }),
      results: state.results,
      jobs: state.jobs,
      unsaved: state.unsaved,
      activeResult: state.activeResult,
      savedAt: new Date().toISOString(),
    };
    DB.set("draft", draft).catch(function () {
      // 사설 모드 등 IndexedDB를 못 쓰면 사진을 뺀 글만 localStorage에 둔다.
      try {
        var lite = Object.assign({}, draft, { photos: draft.photos.map(function (p) { return { id: p.id, thumb: p.thumb, note: p.note, thumbOnly: true }; }) });
        localStorage.setItem("poongryu-draft", JSON.stringify(lite));
      } catch (e) { /* 저장 불가 */ }
    });
  }, 400);

  function loadDraft() {
    return DB.get("draft").catch(function () { return null; }).then(function (d) {
      if (d) return d;
      try { return JSON.parse(localStorage.getItem("poongryu-draft") || "null"); } catch (e) { return null; }
    });
  }

  // ---------- 로그인 ----------
  function showLogin(configured) {
    $("#app-view").hidden = true;
    $("#login-view").hidden = false;
    $("#login-setup").hidden = configured !== false;
    stopPolling();
    setTimeout(function () { $("#login-password").focus(); }, 50);
  }
  $("#login-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    $("#login-error").textContent = "";
    api("/api/login", { method: "POST", body: { password: $("#login-password").value } })
      .then(function () {
        $("#login-password").value = "";
        start();
      })
      .catch(function (e) { $("#login-error").textContent = e.message; });
  });

  // ---------- 탭 ----------
  $$(".tab").forEach(function (b) {
    b.addEventListener("click", function () { showTab(b.dataset.tab); });
  });
  function showTab(name) {
    $$(".tab").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === name); b.setAttribute("aria-selected", b.dataset.tab === name); });
    $$(".tabpanel").forEach(function (p) { p.hidden = p.id !== "tab-" + name; });
    if (name === "history") loadHistory();
    if (name === "money") loadMoney();
    if (name === "info") renderInfo();
    try { sessionStorage.setItem("poongryu-tab", name); } catch (e) { /* 무시 */ }
  }

  // ---------- 입력 바인딩 ----------
  var inputBindings = [
    ["#in-text", function (v) { state.input.text = v; updateCount(); }, function () { return state.input.text; }],
    ["#in-url", function (v) { state.input.sourceUrl = v; }, function () { return state.input.sourceUrl; }],
    ["#in-photo-notes", function (v) { state.input.photoNotes = v; }, function () { return state.input.photoNotes; }],
    ["#in-video-memo", function (v) { state.input.videoMemo = v; }, function () { return state.input.videoMemo; }],
    ["#in-disclosure", function (v) { state.input.disclosure.kind = v; }, function () { return state.input.disclosure.kind; }],
    ["#in-disclosure-detail", function (v) { state.input.disclosure.detail = v; }, function () { return state.input.disclosure.detail; }],
    ["#in-lounge-topic", function (v) { state.input.lounge.topic = v; }, function () { return state.input.lounge.topic; }],
    ["#in-lounge-rules", function (v) { state.input.lounge.rules = v; }, function () { return state.input.lounge.rules; }],
    ["#in-official-limits", function (v) { state.input.officialLimits = v; }, function () { return state.input.officialLimits; }],
  ];
  inputBindings.forEach(function (b) {
    var el = $(b[0]);
    el.addEventListener("input", function () { b[1](el.value); saveDraft(); });
    el.addEventListener("change", function () { b[1](el.value); saveDraft(); });
  });
  $$("input[name=goal]").forEach(function (cb) {
    cb.addEventListener("change", function () {
      state.input.goals = $$("input[name=goal]").filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
      saveDraft();
    });
  });
  function fillInputs() {
    inputBindings.forEach(function (b) { $(b[0]).value = b[2]() || ""; });
    $$("input[name=goal]").forEach(function (cb) { cb.checked = state.input.goals.indexOf(cb.value) >= 0; });
    updateCount();
    renderPhotos();
  }
  function updateCount() {
    $("#text-count").textContent = (state.input.text || "").length.toLocaleString("ko-KR") + "자";
  }

  $("#text-file").addEventListener("change", function (ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    if (!/\.(txt|md|markdown)$/i.test(f.name) && !/^text\//.test(f.type)) return toast("TXT 또는 MD 파일만 불러올 수 있습니다.");
    if (f.size > 1024 * 1024) return toast("1MB 이하 텍스트 파일만 불러올 수 있습니다.");
    f.text().then(function (t) {
      if (state.input.text.trim() && !confirm("지금 입력된 원문을 파일 내용으로 바꿀까요?")) return;
      state.input.text = t.replace(/\r\n/g, "\n");
      fillInputs();
      saveDraft();
      toast("‘" + f.name + "’을 불러왔습니다.");
    });
  });

  $("#new-work").addEventListener("click", function () {
    if (!confirm("새 작업을 시작할까요? 지금 화면의 입력과 결과는 비워집니다. (이미 생성한 결과는 ‘기록’에 남아 있습니다.)")) return;
    resetWork();
    toast("새 작업을 시작했습니다.");
  });
  function resetWork() {
    state.recordId = null;
    state.input = emptyInput();
    state.photos = [];
    state.results = {};
    state.jobs = {};
    state.unsaved = {};
    fillInputs();
    renderResults();
    renderJobStatus();
    saveDraft();
  }

  // ---------- 사진 ----------
  function loadImageElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ src: img, width: img.naturalWidth, height: img.naturalHeight, done: function () { URL.revokeObjectURL(url); } }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }
  function decodeImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" })
        .then(function (b) { return { src: b, width: b.width, height: b.height, done: function () { b.close && b.close(); } }; })
        .catch(function () { return loadImageElement(file); });
    }
    return loadImageElement(file);
  }
  function drawTo(img, maxEdge, quality, asDataUrl) {
    var scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    var w = Math.max(1, Math.round(img.width * scale));
    var hgt = Math.max(1, Math.round(img.height * scale));
    var c = document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(img.src, 0, 0, w, hgt);
    if (asDataUrl) return Promise.resolve(c.toDataURL("image/jpeg", quality));
    return new Promise(function (resolve) { c.toBlob(resolve, "image/jpeg", quality); });
  }
  function processPhoto(file) {
    if (file.size > 40 * 1024 * 1024) return Promise.reject(new Error(file.name + ": 40MB를 넘는 파일은 올릴 수 없습니다."));
    if (file.type && !/^image\//.test(file.type) && !/\.(heic|heif)$/i.test(file.name)) {
      return Promise.reject(new Error(file.name + ": 사진 파일이 아닙니다."));
    }
    return decodeImage(file).then(function (img) {
      return Promise.all([drawTo(img, 1568, 0.85, false), drawTo(img, 240, 0.72, true)]).then(function (out) {
        img.done();
        if (!out[0]) throw new Error(file.name + ": 변환에 실패했습니다.");
        return { id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), blob: out[0], thumb: out[1], note: "", thumbOnly: false };
      });
    }, function () {
      var heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
      throw new Error(file.name + (heic
        ? ": 이 브라우저는 HEIC를 열지 못합니다. 휴대폰 사파리에서 올리거나, 맥 ‘미리보기’에서 JPEG로 내보낸 뒤 올려 주세요."
        : ": 이 형식은 열 수 없습니다. JPEG·PNG·WebP로 바꿔 주세요."));
    });
  }
  $("#photo-file").addEventListener("change", function (ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = "";
    $("#photo-error").textContent = "";
    var room = MAX_PHOTOS - state.photos.length;
    if (files.length > room) {
      $("#photo-error").textContent = "사진은 최대 " + MAX_PHOTOS + "장입니다. " + Math.max(0, room) + "장만 추가합니다.";
      files = files.slice(0, Math.max(0, room));
    }
    var errors = [];
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return processPhoto(f).then(function (p) { state.photos.push(p); renderPhotos(); }, function (e) { errors.push(e.message); });
      });
    });
    chain.then(function () {
      if (errors.length) $("#photo-error").textContent = errors.join("\n");
      saveDraft();
    });
  });
  function renderPhotos() {
    var list = clear($("#photo-list"));
    var thumbOnly = state.photos.filter(function (p) { return p.thumbOnly; }).length;
    $("#photo-count").textContent = state.photos.length + "/" + MAX_PHOTOS + "장" + (thumbOnly ? " · 썸네일만 " + thumbOnly + "장" : "");
    state.photos.forEach(function (p, i) {
      var note = h("textarea", { rows: 2, placeholder: "사진 " + (i + 1) + " 설명(무엇이 찍혔는지, 언제·어디서)", value: p.note || "", "aria-label": "사진 " + (i + 1) + " 설명" });
      note.addEventListener("input", function () { p.note = note.value; saveDraft(); });
      list.appendChild(h("li", { class: "photo-item" },
        h("img", { src: p.thumb, alt: "사진 " + (i + 1) }),
        h("div", null,
          h("div", { class: "row between" },
            h("span", { class: "num" }, "사진 " + (i + 1), p.thumbOnly ? h("span", { class: "badge", title: "기록에는 썸네일만 저장됩니다" }, "썸네일") : null),
            h("div", { class: "photo-tools" },
              h("button", { type: "button", "aria-label": "앞으로", disabled: i === 0, onclick: function () { movePhoto(i, -1); } }, "↑"),
              h("button", { type: "button", "aria-label": "뒤로", disabled: i === state.photos.length - 1, onclick: function () { movePhoto(i, 1); } }, "↓"),
              h("button", { type: "button", class: "danger", onclick: function () { removePhoto(i); } }, "삭제"))),
          note)));
    });
    if (thumbOnly) {
      list.appendChild(h("li", { class: "warnbox" }, "기록에서 불러온 사진은 저해상도 썸네일(240px)만 남아 있습니다. 다시 생성하면 썸네일이 그대로 전달되니, 정확한 분석이 필요하면 원본 사진을 다시 올려 주세요."));
    }
  }
  function movePhoto(i, d) {
    var j = i + d;
    if (j < 0 || j >= state.photos.length) return;
    var t = state.photos[i];
    state.photos[i] = state.photos[j];
    state.photos[j] = t;
    renderPhotos();
    saveDraft();
  }
  function removePhoto(i) {
    if (!confirm("사진 " + (i + 1) + "을 삭제할까요? 이후 사진 번호가 하나씩 당겨집니다.")) return;
    state.photos.splice(i, 1);
    renderPhotos();
    saveDraft();
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1]); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  // ---------- 생성 ----------
  function affected(type) { return type === "all" ? ["clip_photo", "clip_video", "lounge"] : [type]; }
  function isBusy(t) { var j = state.jobs[t]; return Boolean(j && (j.status === "queued" || j.status === "running" || j.status === "sending")); }

  $$(".gen").forEach(function (b) {
    b.addEventListener("click", function () { generate(b.dataset.type); });
  });

  function generate(type) {
    var types = affected(type);
    if (types.some(isBusy)) return toast("이미 생성 중인 결과가 있습니다. 끝난 뒤 다시 눌러 주세요.");
    if (!state.input.text.trim()) {
      $("#in-text").focus();
      return toast("블로그 원문을 먼저 붙여넣어 주세요.");
    }
    if (server.status && server.status.apiKeyBlocked) {
      return toast("API 키 과금 방지를 위해 실제 생성이 막혀 있습니다. ‘안내’ 탭을 확인하세요.", 5000);
    }
    var edited = types.filter(function (t) { return state.results[t] && state.results[t].edited; });
    if (edited.length && !confirm(edited.map(function (t) { return LABELS[t]; }).join(", ") + " 결과에 수정한 내용이 있습니다. 다시 생성하면 지금 결과(수정본 포함)는 ‘이전 버전’에 보관됩니다. 계속할까요?")) return;

    types.forEach(function (t) { state.jobs[t] = { status: "sending", via: type, startedAt: new Date().toISOString() }; });
    renderJobStatus();
    renderResultTabs();

    flushEdits()
      .then(function () {
        return Promise.all(state.photos.map(function (p) {
          var b64 = p.blob ? blobToBase64(p.blob) : Promise.resolve(String(p.thumb).split(",")[1]);
          return b64.then(function (data) { return { data: data, note: p.note || "", thumb: p.thumb }; });
        }));
      })
      .then(function (photos) {
        var input = Object.assign({}, state.input, { photos: photos });
        return api("/api/generate", { method: "POST", body: { type: type, recordId: state.recordId, input: input } });
      })
      .then(function (res) {
        state.recordId = res.recordId;
        types.forEach(function (t) {
          state.jobs[t] = { jobId: res.job.id, via: res.job.type, status: res.job.status, position: res.job.position, startedAt: res.job.createdAt };
        });
        if (res.duplicate) toast("같은 결과를 이미 생성하고 있습니다. 그 작업을 계속 보여 드립니다.");
        saveDraft();
        renderJobStatus();
        startPolling();
      })
      .catch(function (e) {
        types.forEach(function (t) { state.jobs[t] = { status: "error", via: type, message: e.message, code: "request" }; });
        saveDraft();
        renderJobStatus();
        renderResultTabs();
        if (state.activeResult && types.indexOf(state.activeResult) >= 0) renderResults();
        else toast(e.message, 4000);
      });
  }

  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollOnce, 1500);
    pollOnce();
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  var polling = false;
  function pollOnce() {
    if (polling) return;
    var ids = {};
    RESULT_TYPES.forEach(function (t) { var j = state.jobs[t]; if (j && j.jobId && (j.status === "queued" || j.status === "running")) ids[j.jobId] = true; });
    var list = Object.keys(ids);
    if (!list.length) { stopPolling(); renderJobStatus(); return; }
    polling = true;
    Promise.all(list.map(function (id) {
      return api("/api/jobs/" + id).then(function (r) { return r.job; }, function (e) { return { id: id, status: e.status === 404 ? "lost" : "poll_error", message: e.message }; });
    })).then(function (jobs) {
      var finished = [];
      jobs.forEach(function (job) {
        RESULT_TYPES.forEach(function (t) {
          var j = state.jobs[t];
          if (!j || j.jobId !== job.id) return;
          if (job.status === "poll_error") return; // 일시적인 연결 오류는 다음 주기에 다시 확인
          if (job.status === "lost") {
            state.jobs[t] = { status: "error", via: j.via, code: "lost", message: "서버가 재시작되어 진행 중이던 작업 정보가 사라졌습니다. 다시 생성해 주세요." };
            return;
          }
          j.status = job.status;
          j.position = job.position;
          j.retries = job.retries;
          j.startedAt = job.startedAt || j.startedAt;
          if (job.status === "done") {
            delete state.jobs[t];
            finished.push({ type: t, job: job });
          } else if (job.status === "error" || job.status === "cancelled") {
            state.jobs[t] = { status: job.status, via: j.via, code: job.code, message: job.message };
          }
        });
      });
      saveDraft();
      renderJobStatus();
      renderResultTabs();
      if (finished.length) {
        return refreshRecordResults(finished.map(function (f) { return f.type; })).then(function () {
          var done = {};
          finished.forEach(function (f) { done[f.job.type] = true; });
          var name = Object.keys(done).map(function (t) { return FULL_LABELS[t]; }).join(", ");
          toast(name + " 생성이 끝났습니다." + (server.mock ? " (테스트 응답)" : ""));
          if (finished.some(function (f) { return f.job.meta && f.job.meta.rateLimit; })) {
            server.status && (server.status.rateLimit = finished[0].job.meta.rateLimit);
            renderChips();
          }
        });
      }
      RESULT_TYPES.forEach(function (t) { if (state.jobs[t] && state.jobs[t].status === "error" && t === state.activeResult) renderResults(); });
    }).finally(function () { polling = false; });
  }
  function refreshRecordResults(types) {
    if (!state.recordId) return Promise.resolve();
    return api("/api/records/" + state.recordId).then(function (r) {
      types.forEach(function (t) {
        if (r.record.results && r.record.results[t]) {
          state.results[t] = r.record.results[t];
          delete state.unsaved[t];
        }
      });
      if (types.indexOf(state.activeResult) < 0) state.activeResult = types[0];
      saveDraft();
      renderResults();
    });
  }
  function cancelJob(t) {
    var j = state.jobs[t];
    if (!j || !j.jobId) return;
    api("/api/jobs/" + j.jobId + "/cancel", { method: "POST" }).then(function () { toast("취소를 요청했습니다."); pollOnce(); }, function (e) { toast(e.message); });
  }

  function renderJobStatus() {
    var box = clear($("#job-status"));
    var seen = {};
    $$(".gen").forEach(function (b) {
      var busy = affected(b.dataset.type).some(isBusy);
      b.disabled = busy;
      b.classList.toggle("busy", busy);
    });
    RESULT_TYPES.forEach(function (t) {
      var j = state.jobs[t];
      if (!j) return;
      var key = j.jobId || j.via + j.status;
      if (seen[key]) return;
      seen[key] = true;
      var label = FULL_LABELS[j.via] || FULL_LABELS[t];
      if (j.status === "sending") {
        box.appendChild(h("div", { class: "job-line" }, h("span", { class: "spinner" }), label + ": 요청 보내는 중(사진 변환 포함)…"));
      } else if (j.status === "queued") {
        box.appendChild(h("div", { class: "job-line" }, h("span", { class: "spinner" }), label + ": 대기 중" + (j.position ? " (" + j.position + "번째)" : ""),
          h("button", { class: "small", type: "button", onclick: function () { cancelJob(t); } }, "취소")));
      } else if (j.status === "running") {
        var secs = j.startedAt ? Math.round((Date.now() - Date.parse(j.startedAt)) / 1000) : 0;
        box.appendChild(h("div", { class: "job-line" }, h("span", { class: "spinner" }),
          label + ": 생성 중 " + secToClock(secs) + (j.retries ? " · 재시도 " + j.retries + "회" : "") + " · 보통 1~3분 걸립니다",
          h("button", { class: "small", type: "button", onclick: function () { cancelJob(t); } }, "취소")));
      } else if (j.status === "error" || j.status === "cancelled") {
        box.appendChild(h("div", { class: "job-line error" }, label + ": " + (j.message || "실패")));
      }
    });
  }
  setInterval(function () { if (RESULT_TYPES.some(function (t) { return state.jobs[t] && state.jobs[t].status === "running"; })) renderJobStatus(); }, 1000);

  // ---------- 결과 편집 저장 ----------
  var editTimers = {};
  function markEdited(type) {
    var slot = state.results[type];
    if (!slot) return;
    slot.edited = true;
    state.unsaved[type] = true;
    saveDraft();
    setSaveState(type, "저장 대기…");
    clearTimeout(editTimers[type]);
    editTimers[type] = setTimeout(function () { saveEdit(type); }, 900);
  }
  function saveEdit(type, keepalive) {
    clearTimeout(editTimers[type]);
    var slot = state.results[type];
    if (!slot || !state.unsaved[type] || !state.recordId) return Promise.resolve();
    setSaveState(type, "저장 중…");
    return api("/api/records/" + state.recordId + "/results/" + type, { method: "PUT", body: { data: slot.data, rev: slot.rev }, keepalive: keepalive })
      .then(function (r) {
        delete state.unsaved[type];
        var srv = r.record.results[type];
        if (r.conflict) {
          state.results[type] = srv;
          toast("그사이 새 결과가 생성되어, 수정본은 ‘이전 버전’에 보관했습니다.", 4000);
          if (state.activeResult === type) renderResults();
        } else {
          slot.rev = srv.rev;
          slot.versions = srv.versions;
          slot.edited = true;
          setSaveState(type, "저장됨 " + fmtTime(new Date().toISOString()));
        }
        saveDraft();
      })
      .catch(function (e) {
        setSaveState(type, "저장 실패: " + e.message + " (브라우저에는 남아 있음)");
      });
  }
  function flushEdits(keepalive) {
    return Promise.all(Object.keys(state.unsaved).map(function (t) { return saveEdit(t, keepalive); }));
  }
  function setSaveState(type, text) {
    var el = document.querySelector('.save-state[data-type="' + type + '"]');
    if (el) el.textContent = text;
  }
  window.addEventListener("pagehide", function () { flushEdits(true); saveDraft.flush(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") { flushEdits(true); saveDraft.flush(); } });

  // ---------- 복사·다운로드 ----------
  function copyText(text) {
    text = String(text || "");
    var fallback = function () {
      var ta = h("textarea", { value: text, style: "position:fixed;top:-1000px;opacity:0" });
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? "복사했습니다." : "복사하지 못했습니다. 길게 눌러 직접 복사해 주세요.");
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast("복사했습니다."); }, fallback);
    } else fallback();
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function fileStamp() {
    var d = new Date();
    return Calc.isoDate(d) + "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
  }
  function lines(arr) { return (arr || []).filter(Boolean).join("\n"); }
  function photoRef(n) { return n ? "사진 " + n : "사진 없음"; }

  function videoCheck(segs) {
    var list = (segs || []).slice().sort(function (a, b) { return (Number(a.start_sec) || 0) - (Number(b.start_sec) || 0); });
    var sum = 0;
    var issues = [];
    list.forEach(function (s, i) {
      var st = Number(s.start_sec), en = Number(s.end_sec);
      if (!isFinite(st) || !isFinite(en) || en <= st) issues.push((i + 1) + "구간: 시작·끝 시간이 올바르지 않음");
      else sum += en - st;
      if (i > 0) {
        var prev = Number(list[i - 1].end_sec);
        if (st > prev) issues.push((i) + "~" + (i + 1) + "구간 사이 " + (st - prev) + "초 빈틈");
        if (st < prev) issues.push((i) + "~" + (i + 1) + "구간 " + (prev - st) + "초 겹침");
      }
    });
    var span = list.length ? Number(list[list.length - 1].end_sec) - Number(list[0].start_sec) : 0;
    if (list.length && Number(list[0].start_sec) !== 0) issues.push("첫 구간이 0초에서 시작하지 않음");
    return { sum: Math.round(sum * 10) / 10, span: Math.round(span * 10) / 10, issues: issues };
  }

  /** 유형별 결과를 [제목, 본문] 목록으로 정리. MD·TXT·전체 복사에 공통으로 쓴다. */
  function sections(type, d) {
    if (!d) return [];
    var s = [];
    var reviews = function () {
      s.push(["검수 메모", lines((d.review_notes || []).map(function (r) { return "- [" + r.category + "] " + r.note; }))]);
      s.push(["주장 분류(사실/직접 경험/의견)", lines((d.claims || []).map(function (c) { return "- (" + c.kind + " · " + c.verification + (c.used_in_post ? " · 원고 사용" : " · 원고 제외") + ") " + c.text; }))]);
      var ic = d.input_check || {};
      s.push(["입력 확인", "실제로 본 사진: " + (ic.photos_viewed || 0) + "장" + (ic.used_photo_notes_only ? " / 사진 메모만 사용" : "") + " / URL 본문 읽음: " + (ic.source_url_read ? "예" : "아니요")]);
    };
    if (type === "clip_photo") {
      s.push(["핵심 질문", d.core_question], ["핵심 답", d.core_answer]);
      s.push(["표지 후보", lines((d.cover_candidates || []).map(function (c, i) { return (i + 1 === d.cover_recommended ? "★ " : "- ") + c.text + " (" + c.reason + ")"; }))]);
      s.push(["사진별 화면 문구", lines((d.slides || []).map(function (sl, i) { return (i + 1) + ". [" + photoRef(sl.photo) + "] " + sl.on_screen_text + "\n   배치: " + sl.layout; }))]);
      s.push(["순서 제안 이유", d.order_reason], ["설명문", d.caption]);
      s.push(["해시태그 후보", (d.hashtags || []).join(" ")], ["정보태그 후보", (d.info_tags || []).join(", ")]);
      s.push(["블로그 연결 안내", d.blog_link_guide]);
      var lg = d.length_guide || {};
      s.push(["분량", "편집 권장(공식 제한 아님): " + (lg.editorial_recommendation || "") + "\n공식 제한: " + (lg.official_limit || "")]);
      reviews();
    } else if (type === "clip_video") {
      var vc = videoCheck(d.segments);
      s.push(["콘셉트", d.concept]);
      s.push(["구간 구성", lines((d.segments || []).map(function (g, i) {
        return (i + 1) + ". " + secToClock(g.start_sec) + "–" + secToClock(g.end_sec) + " | 장면: " + g.scene + " | 소스: " + g.source_material + "\n   자막: " + g.subtitle + "\n   내레이션: " + g.narration + "\n   편집: " + g.edit_note;
      }))]);
      s.push(["시간 합계 확인", "구간 길이 합계 " + vc.sum + "초 / 전체 범위 " + vc.span + "초" + (vc.issues.length ? "\n주의: " + vc.issues.join("; ") : "\n빈틈·겹침 없음") + "\n※ 계획값입니다. 낭독·렌더링으로 길이를 검증하지 않았습니다."]);
      s.push(["내레이션 전문", d.narration_full], ["설명문", d.caption]);
      s.push(["해시태그 후보", (d.hashtags || []).join(" ")], ["정보태그 후보", (d.info_tags || []).join(", ")]);
      s.push(["추가로 필요한 소스", lines((d.missing_materials || []).map(function (x) { return "- " + x; }))], ["길이 메모", d.duration_note]);
      reviews();
    } else if (type === "lounge") {
      var fit = d.fit || {};
      s.push(["라운지 적합성", (fit.verdict || "") + " — " + (fit.reason || "")]);
      s.push(["제목 후보", lines((d.title_candidates || []).map(function (t, i) { return (i + 1 === d.title_recommended ? "★ " : "- ") + t; }))]);
      s.push(["본문", d.body], ["질문", d.question || "(없음)"]);
      s.push(["사진 배치", lines((d.photo_placement || []).map(function (p) { return "- " + photoRef(p.photo) + ": " + p.position; }))]);
      s.push(["링크·광고 규칙 확인", lines((d.rule_check || []).map(function (r) { return "- " + r.item + ": " + r.status + (r.note ? " (" + r.note + ")" : ""); }))]);
      s.push(["짧은 버전", d.short_version]);
      reviews();
    } else if (type === "monetization") {
      var progName = function (id) { var p = server.programs.find(function (x) { return x.id === id; }); return p ? p.name : id; };
      s.push(["채널·형식 적합성", lines((d.channel_fit || []).map(function (c) { return "- " + c.format + ": " + c.fit + " — " + c.reason; }))]);
      s.push(["독립 콘텐츠 후보", lines((d.content_candidates || []).map(function (c) { return "- " + c.title + " [" + c.format + "] 자료: " + c.materials + " / 차별점: " + c.distinct_value; }))]);
      s.push(["추가로 필요한 작업", lines((d.additional_work || []).map(function (x) { return "- " + x; }))]);
      s.push(["제작 우선순위", lines((d.priorities || []).map(function (p) { return p.rank + ". " + p.item + " — " + p.rationale; }))]);
      s.push(["프로그램 적합성", lines((d.program_fit || []).map(function (p) { return "- " + progName(p.program_id) + ": " + p.fit + " — " + p.reason + " / 확인할 것: " + p.to_check; }))]);
      var te = d.time_estimates || {};
      s.push(["한 편당 작업 시간 가정(분)", "작성 " + te.writing + " / 검수 " + te.review + " / 편집 " + te.editing + " / 업로드 " + te.upload + "\n근거: " + (te.basis || "")]);
      reviews();
    }
    return s.filter(function (x) { return x[1] !== undefined && x[1] !== null && String(x[1]).trim() !== ""; });
  }
  function toMarkdown(type, slot) {
    var head = "# " + FULL_LABELS[type] + "\n\n" + metaLine(slot) + "\n";
    return head + sections(type, slot.data).map(function (x) { return "\n## " + x[0] + "\n\n" + x[1] + "\n"; }).join("");
  }
  function toText(type, slot) {
    return "■ " + FULL_LABELS[type] + "\n" + metaLine(slot) + "\n" + sections(type, slot.data).map(function (x) { return "\n[" + x[0] + "]\n" + x[1] + "\n"; }).join("");
  }
  function metaLine(slot) {
    var m = slot.meta || {};
    return "생성: " + fmtTime(slot.generatedAt) + (m.mock ? " · 테스트 응답(실제 Claude 아님)" : m.model ? " · " + m.model : "") + (slot.edited ? " · 사용자 수정됨" : "") + " · 게시 전 검수 필요";
  }
  function postText(type, d) {
    if (type === "clip_photo") return [d.caption, (d.hashtags || []).join(" ")].filter(Boolean).join("\n\n");
    if (type === "clip_video") return d.narration_full || "";
    if (type === "lounge") {
      var title = (d.title_candidates || [])[(d.title_recommended || 1) - 1] || "";
      return [title, d.body, d.question].filter(Boolean).join("\n\n");
    }
    return sections(type, d).map(function (x) { return "[" + x[0] + "]\n" + x[1]; }).join("\n\n");
  }
  $("#dl-all-md").addEventListener("click", function () { downloadAll("md"); });
  $("#dl-all-txt").addEventListener("click", function () { downloadAll("txt"); });
  function downloadAll(fmt) {
    var types = RESULT_TYPES.filter(function (t) { return state.results[t] && state.results[t].data; });
    if (!types.length) return toast("다운로드할 결과가 없습니다.");
    var text = types.map(function (t) { return fmt === "md" ? toMarkdown(t, state.results[t]) : toText(t, state.results[t]); }).join(fmt === "md" ? "\n\n---\n\n" : "\n\n==========\n\n");
    download("풍류_전체_" + fileStamp() + "." + fmt, text, fmt === "md" ? "text/markdown" : "text/plain");
  }

  // ---------- 결과 화면 ----------
  function renderResultTabs() {
    var nav = clear($("#result-tabs"));
    RESULT_TYPES.forEach(function (t) {
      var j = state.jobs[t];
      var dotClass = isBusy(t) ? "busy" : j && (j.status === "error") ? "err" : state.results[t] && state.results[t].data ? "has" : "";
      nav.appendChild(h("button", { class: "subtab" + (state.activeResult === t ? " active" : ""), role: "tab", type: "button", onclick: function () { state.activeResult = t; saveDraft(); renderResultTabs(); renderResults(); } },
        LABELS[t], h("span", { class: "dot " + dotClass })));
    });
  }

  function field(label, obj, key, opt) {
    opt = opt || {};
    var type = opt.type || "textarea";
    var el;
    var val = obj[key];
    if (Array.isArray(val)) val = val.join("\n");
    if (type === "textarea") el = h("textarea", { rows: opt.rows || Math.min(12, Math.max(2, String(val || "").split("\n").length + 1)), value: val == null ? "" : val });
    else el = h("input", { type: type, value: val == null ? "" : val, step: opt.step });
    if (type === "textarea") el.addEventListener("input", function () { autosize(el); });
    el.addEventListener("input", function () {
      var v = el.value;
      if (opt.list) v = v.split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
      else if (type === "number") v = v === "" ? null : Number(v);
      obj[key] = v;
      if (opt.onChange) opt.onChange();
    });
    var head = h("div", { class: "field-head" }, h("label", null, label),
      opt.copy === false ? null : h("button", { class: "copy small", type: "button", onclick: function () { var v = obj[key]; copyText(Array.isArray(v) ? v.join(opt.joiner || "\n") : v); } }, "복사"));
    if (opt.hint) head.appendChild(h("span", { class: "muted small" }, opt.hint));
    return h("div", { class: "field" }, head, el);
  }
  function autosize(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + 2 + "px";
  }
  function thumbFor(n) {
    var p = n ? state.photos[n - 1] : null;
    return p ? h("img", { class: "thumb-inline", src: p.thumb, alt: "사진 " + n }) : null;
  }

  function renderResults() {
    renderResultTabs();
    var panel = clear($("#result-panel"));
    var t = state.activeResult;
    var slot = state.results[t];
    var j = state.jobs[t];
    if (j && (j.status === "error" || j.status === "cancelled")) {
      panel.appendChild(h("div", { class: "errbox" },
        h("b", null, (j.status === "cancelled" ? "취소됨: " : "생성 실패: ")), j.message || "",
        h("div", { class: "row gap", style: "margin-top:.5rem" },
          h("button", { class: "small", type: "button", onclick: function () { delete state.jobs[t]; saveDraft(); renderJobStatus(); generate(j.via || t); } }, "다시 시도"),
          h("button", { class: "small ghost", type: "button", onclick: function () { delete state.jobs[t]; saveDraft(); renderJobStatus(); renderResults(); } }, "닫기")),
        slot && slot.data ? h("div", { class: "small" }, "아래는 이전에 만든 결과입니다(그대로 보존됨).") : null));
    }
    if (isBusy(t)) panel.appendChild(h("div", { class: "okbox" }, "생성 중입니다. 화면을 닫거나 새로고침해도 맥북에서 계속 진행되고, 끝나면 기록에 저장됩니다."));
    if (!slot || !slot.data) {
      panel.appendChild(h("div", { class: "empty" }, "아직 " + FULL_LABELS[t] + " 결과가 없습니다. 위 버튼을 눌러 생성하세요."));
      return;
    }
    var d = slot.data;
    var onChange = function () { markEdited(t); };
    var m = slot.meta || {};
    panel.appendChild(h("div", { class: "result-meta" },
      h("span", null, "생성 " + fmtTime(slot.generatedAt)),
      m.mock ? h("span", { class: "badge" }, "테스트 응답 · 실제 Claude 아님") : h("span", null, m.model ? "모델 " + m.model : ""),
      slot.edited ? h("span", { class: "badge ok" }, "수정됨") : null,
      h("span", { class: "save-state", "data-type": t }, state.unsaved[t] ? "저장 대기…" : "")));
    panel.appendChild(h("div", { class: "row gap" },
      t !== "monetization" ? h("button", { class: "small primary", type: "button", onclick: function () { copyText(postText(t, d)); } }, t === "clip_video" ? "내레이션 복사" : "게시용 글 복사") : null,
      h("button", { class: "small", type: "button", onclick: function () { copyText(toText(t, slot)); } }, "전체 복사"),
      h("button", { class: "small", type: "button", onclick: function () { download("풍류_" + LABELS[t].replace(/\s/g, "") + "_" + fileStamp() + ".md", toMarkdown(t, slot), "text/markdown"); } }, "MD 다운로드"),
      h("button", { class: "small", type: "button", onclick: function () { download("풍류_" + LABELS[t].replace(/\s/g, "") + "_" + fileStamp() + ".txt", toText(t, slot), "text/plain"); } }, "TXT 다운로드")));

    var ic = d.input_check || {};
    var nPhotos = state.photos.length;
    if (t !== "monetization" && nPhotos && !ic.photos_viewed) panel.appendChild(h("div", { class: "warnbox" }, "이 결과는 사진 이미지를 보지 않고 설명 메모만으로 작성됐습니다. 사진별 문구가 실제 사진과 맞는지 확인하세요."));

    var body = h("div");
    panel.appendChild(body);
    if (t === "clip_photo") renderClipPhoto(body, d, onChange);
    else if (t === "clip_video") renderClipVideo(body, d, onChange);
    else if (t === "lounge") renderLounge(body, d, onChange);
    else renderMonetization(body, d, onChange);
    renderReview(body, d, onChange);
    renderVersions(panel, t, slot);
    requestAnimationFrame(function () { $$("textarea", panel).forEach(autosize); });
  }

  function renderClipPhoto(el, d, onChange) {
    el.appendChild(field("핵심 질문", d, "core_question", { type: "text", onChange: onChange }));
    el.appendChild(field("핵심 답", d, "core_answer", { onChange: onChange }));
    el.appendChild(h("h3", null, "표지 후보"));
    (d.cover_candidates || []).forEach(function (c, i) {
      var radio = h("input", { type: "radio", name: "cover-rec", checked: d.cover_recommended === i + 1, onchange: function () { d.cover_recommended = i + 1; onChange(); } });
      el.appendChild(h("div", { class: "item-card" },
        h("label", { class: "check" }, radio, "추천"),
        field("후보 " + (i + 1), c, "text", { type: "text", onChange: onChange }),
        h("div", { class: "muted small" }, "이유: " + (c.reason || ""))));
    });
    el.appendChild(h("h3", null, "사진별 화면 문구"));
    (d.slides || []).forEach(function (s, i) {
      el.appendChild(h("div", { class: "item-card" }, thumbFor(s.photo),
        h("b", null, (i + 1) + "장"),
        field("사진 번호", s, "photo", { type: "number", step: 1, copy: false, onChange: onChange }),
        field("화면 문구", s, "on_screen_text", { onChange: onChange }),
        field("배치", s, "layout", { onChange: onChange, copy: false })));
    });
    el.appendChild(field("순서 제안 이유", d, "order_reason", { onChange: onChange, copy: false }));
    el.appendChild(field("설명문", d, "caption", { onChange: onChange, rows: 6 }));
    el.appendChild(field("해시태그 후보 (한 줄에 하나)", d, "hashtags", { list: true, joiner: " ", onChange: onChange }));
    el.appendChild(field("정보태그 후보 (한 줄에 하나)", d, "info_tags", { list: true, joiner: ", ", onChange: onChange }));
    el.appendChild(field("블로그 연결 안내", d, "blog_link_guide", { onChange: onChange }));
    d.length_guide = d.length_guide || {};
    el.appendChild(field("편집 권장 분량 (공식 제한 아님)", d.length_guide, "editorial_recommendation", { onChange: onChange, copy: false }));
    el.appendChild(field("공식 제한", d.length_guide, "official_limit", { onChange: onChange, copy: false, hint: "공식 안내에서 직접 확인" }));
  }

  function renderClipVideo(el, d, onChange) {
    el.appendChild(h("div", { class: "warnbox" }, "이것은 대본입니다. 영상은 만들어지지 않았고, 시간은 낭독·렌더링으로 검증하지 않은 계획값입니다."));
    el.appendChild(field("콘셉트", d, "concept", { onChange: onChange, copy: false }));
    var checkBox = h("div");
    var refreshCheck = function () {
      var vc = videoCheck(d.segments);
      clear(checkBox).appendChild(h("div", { class: vc.issues.length ? "warnbox" : "okbox" },
        "구간 길이 합계 " + vc.sum + "초 · 전체 범위 " + vc.span + "초" + (vc.issues.length ? " · " + vc.issues.join(" / ") : " · 빈틈·겹침 없음")));
    };
    var segChange = function () { refreshCheck(); onChange(); };
    el.appendChild(h("h3", null, "구간별 구성"));
    (d.segments || []).forEach(function (s, i) {
      el.appendChild(h("div", { class: "item-card" },
        h("b", null, (i + 1) + "구간"),
        h("div", { class: "seg-times" }, field("시작(초)", s, "start_sec", { type: "number", step: "0.5", copy: false, onChange: segChange }), field("끝(초)", s, "end_sec", { type: "number", step: "0.5", copy: false, onChange: segChange })),
        field("장면", s, "scene", { onChange: onChange, copy: false }),
        field("사용할 소스", s, "source_material", { type: "text", onChange: onChange, copy: false }),
        field("자막", s, "subtitle", { onChange: onChange }),
        field("내레이션", s, "narration", { onChange: onChange }),
        field("편집 지시", s, "edit_note", { onChange: onChange, copy: false })));
    });
    el.appendChild(checkBox);
    refreshCheck();
    var nf = field("내레이션 전문", d, "narration_full", { onChange: onChange, rows: 8 });
    nf.querySelector(".field-head").appendChild(h("button", { class: "small", type: "button", onclick: function () {
      d.narration_full = (d.segments || []).map(function (s) { return s.narration; }).filter(Boolean).join(" ");
      nf.querySelector("textarea").value = d.narration_full;
      onChange();
    } }, "구간 내레이션으로 다시 합치기"));
    el.appendChild(nf);
    el.appendChild(field("설명문", d, "caption", { onChange: onChange }));
    el.appendChild(field("해시태그 후보 (한 줄에 하나)", d, "hashtags", { list: true, joiner: " ", onChange: onChange }));
    el.appendChild(field("정보태그 후보 (한 줄에 하나)", d, "info_tags", { list: true, joiner: ", ", onChange: onChange }));
    el.appendChild(field("추가로 필요한 촬영·소스 (한 줄에 하나)", d, "missing_materials", { list: true, onChange: onChange, copy: false }));
    el.appendChild(field("길이 메모", d, "duration_note", { onChange: onChange, copy: false }));
  }

  function renderLounge(el, d, onChange) {
    var fit = d.fit || {};
    var bad = fit.verdict === "부적합";
    el.appendChild(h("div", { class: bad ? "errbox" : fit.verdict === "적합" ? "okbox" : "warnbox" },
      h("b", null, "라운지 적합성: " + (fit.verdict || "?")), " — " + (fit.reason || "")));
    if (bad) {
      el.appendChild(h("p", { class: "muted" }, "원문이 지정한 라운지 주제와 맞지 않아 게시글을 만들지 않았습니다. 다른 라운지 주제를 입력해 다시 생성하거나, 클립으로 활용하세요."));
    }
    el.appendChild(h("h3", null, "제목 후보"));
    (d.title_candidates || []).forEach(function (tt, i) {
      var wrap = { v: tt };
      var radio = h("input", { type: "radio", name: "title-rec", checked: d.title_recommended === i + 1, onchange: function () { d.title_recommended = i + 1; onChange(); } });
      el.appendChild(h("div", { class: "item-card" }, h("label", { class: "check" }, radio, "추천"),
        field("후보 " + (i + 1), wrap, "v", { type: "text", onChange: function () { d.title_candidates[i] = wrap.v; onChange(); } })));
    });
    el.appendChild(field("본문", d, "body", { onChange: onChange, rows: 10 }));
    var q = { v: d.question || "" };
    el.appendChild(field("질문 (자연스러울 때만, 비우면 없음)", q, "v", { type: "text", onChange: function () { d.question = q.v.trim() ? q.v : null; onChange(); } }));
    el.appendChild(h("h3", null, "사진 배치"));
    (d.photo_placement || []).forEach(function (p) {
      el.appendChild(h("div", { class: "item-card" }, thumbFor(p.photo), field("사진 번호", p, "photo", { type: "number", step: 1, copy: false, onChange: onChange }), field("위치", p, "position", { onChange: onChange, copy: false })));
    });
    el.appendChild(h("h3", null, "링크·광고 규칙 확인"));
    (d.rule_check || []).forEach(function (r) {
      var cls = r.status === "규칙 위반 우려" ? "badge bad" : r.status === "입력된 규칙과 맞음" ? "badge ok" : "badge";
      el.appendChild(h("div", { class: "item-card" }, h("b", null, r.item), h("span", { class: cls }, r.status), h("div", { class: "small" }, r.note)));
    });
    el.appendChild(field("짧은 버전", d, "short_version", { onChange: onChange }));
  }

  function renderMonetization(el, d, onChange) {
    el.appendChild(h("div", { class: "warnbox" }, "조회수·선발·수익을 예측하지 않습니다. 보상 계산은 ‘수익화’ 탭에서 확인된 조건만으로 합니다."));
    el.appendChild(h("h3", null, "채널·형식 적합성"));
    (d.channel_fit || []).forEach(function (c) { el.appendChild(h("div", { class: "item-card" }, h("b", null, c.format), h("span", { class: "badge" + (c.fit === "높음" ? " ok" : c.fit === "부적합" ? " bad" : "") }, c.fit), h("div", { class: "small" }, c.reason))); });
    el.appendChild(h("h3", null, "실제 자료로 만들 수 있는 독립 콘텐츠"));
    (d.content_candidates || []).forEach(function (c) {
      el.appendChild(h("div", { class: "item-card" }, field("제목", c, "title", { type: "text", onChange: onChange }), h("div", { class: "small" }, "형식: " + c.format + " · 자료: " + c.materials + " · 차별점: " + c.distinct_value)));
    });
    el.appendChild(field("추가로 필요한 작업 (한 줄에 하나)", d, "additional_work", { list: true, onChange: onChange }));
    el.appendChild(h("h3", null, "제작 우선순위"));
    (d.priorities || []).slice().sort(function (a, b) { return a.rank - b.rank; }).forEach(function (p) { el.appendChild(h("div", { class: "item-card" }, h("b", null, p.rank + ". " + p.item), h("div", { class: "small" }, p.rationale))); });
    el.appendChild(h("h3", null, "프로그램 적합성"));
    if (!(d.program_fit || []).length) el.appendChild(h("p", { class: "muted small" }, "등록된 프로그램 조건이 없습니다."));
    (d.program_fit || []).forEach(function (p) {
      var prog = server.programs.find(function (x) { return x.id === p.program_id; });
      el.appendChild(h("div", { class: "item-card" }, h("b", null, prog ? prog.name : p.program_id), h("span", { class: "badge" }, p.fit), h("div", { class: "small" }, p.reason), h("div", { class: "small muted" }, "확인할 것: " + p.to_check)));
    });
    var te = d.time_estimates || {};
    el.appendChild(h("h3", null, "한 편당 작업 시간 가정"));
    el.appendChild(h("div", { class: "seg-times" },
      field("작성(분)", te, "writing", { type: "number", copy: false, onChange: onChange }), field("검수(분)", te, "review", { type: "number", copy: false, onChange: onChange }),
      field("편집(분)", te, "editing", { type: "number", copy: false, onChange: onChange }), field("업로드(분)", te, "upload", { type: "number", copy: false, onChange: onChange })));
    el.appendChild(h("div", { class: "muted small" }, "근거(가정): " + (te.basis || "")));
    el.appendChild(h("button", { class: "small primary", type: "button", onclick: function () {
      $("#c-writing").value = te.writing || 0; $("#c-review").value = te.review || 0; $("#c-editing").value = te.editing || 0; $("#c-upload").value = te.upload || 0;
      $("#c-count").value = Math.max(1, (d.content_candidates || []).length);
      showTab("money");
      recalc();
      toast("시간 가정을 계산기에 넣었습니다. 실제 작업 시간에 맞게 고쳐 주세요.");
    } }, "이 가정을 계산기에 적용"));
  }

  function renderReview(el, d, onChange) {
    el.appendChild(h("h3", null, "게시 전 검수 메모"));
    (d.review_notes || []).forEach(function (r) { el.appendChild(h("div", { class: "item-card" }, h("span", { class: "badge" }, r.category), " ", field("메모", r, "note", { onChange: onChange, copy: false }))); });
    if ((d.claims || []).length) {
      el.appendChild(h("h3", null, "사실 / 직접 경험 / 의견 구분"));
      var tbody = h("tbody");
      d.claims.forEach(function (c) {
        tbody.appendChild(h("tr", null, h("td", null, c.kind), h("td", null, c.text), h("td", null, c.verification), h("td", null, c.used_in_post ? "사용" : "제외")));
      });
      el.appendChild(h("table", { class: "claims" }, h("thead", null, h("tr", null, h("th", null, "구분"), h("th", null, "내용"), h("th", null, "검증"), h("th", null, "원고"))), tbody));
      el.appendChild(h("p", { class: "muted small" }, "이 앱은 외부 사실 검증을 하지 않습니다. ‘외부 검증 안 함’ 항목은 게시 전에 직접 확인하세요."));
    }
    var ic = d.input_check || {};
    el.appendChild(h("p", { class: "muted small" }, "입력 확인: 실제로 본 사진 " + (ic.photos_viewed || 0) + "장 · URL 본문 읽음 " + (ic.source_url_read ? "예" : "아니요")));
  }

  function renderVersions(panel, t, slot) {
    var vs = slot.versions || [];
    if (!vs.length) return;
    var ul = h("ul", { class: "versions" });
    vs.forEach(function (v, i) {
      ul.appendChild(h("li", null, fmtTime(v.savedAt) + (v.edited ? " · 수정본" : " · 생성본") + (v.note ? " · " + v.note : "") + " ",
        h("button", { class: "small", type: "button", onclick: function () {
          if (!confirm("이 버전으로 되돌릴까요? 지금 결과는 이전 버전 목록에 보관됩니다.")) return;
          flushEdits().then(function () {
            return api("/api/records/" + state.recordId + "/results/" + t + "/restore", { method: "POST", body: { index: i } });
          }).then(function (r) { state.results[t] = r.record.results[t]; saveDraft(); renderResults(); toast("되돌렸습니다."); }, function (e) { toast(e.message); });
        } }, "되돌리기")));
    });
    panel.appendChild(h("details", { class: "card" }, h("summary", null, "이전 버전 " + vs.length + "개 (재생성·복원 전 결과 보관)"), ul));
  }

  // ---------- 기록 ----------
  function loadHistory() {
    $("#hist-where").textContent = "저장 위치: 맥북 " + ((server.status && server.status.dataDir) || "data") + "/records (글·결과·사진 썸네일만, 원본 사진은 저장하지 않음). 삭제하면 맥북에서 바로 지워집니다.";
    var ul = clear($("#hist-list"));
    ul.appendChild(h("li", { class: "empty" }, "불러오는 중…"));
    api("/api/records").then(function (r) {
      clear(ul);
      if (!r.records.length) ul.appendChild(h("li", { class: "empty" }, "저장된 기록이 없습니다. 생성하면 자동으로 저장됩니다."));
      r.records.forEach(function (rec) {
        ul.appendChild(h("li", { class: "hist-item" },
          h("input", { type: "checkbox", class: "hist-check", value: rec.id, "aria-label": rec.title + " 선택" }),
          h("div", null, h("div", { class: "hist-title" }, rec.title, rec.id === state.recordId ? h("span", { class: "badge ok" }, "현재 작업") : null),
            h("div", { class: "muted small" }, fmtTime(rec.updatedAt) + " · " + (rec.types.map(function (t) { return LABELS[t]; }).join(", ") || "결과 없음") + " · 사진 " + rec.photoCount + "장")),
          h("button", { class: "small", type: "button", onclick: function () { openRecord(rec.id); } }, "열기")));
      });
    }, function (e) { clear(ul).appendChild(h("li", { class: "error" }, e.message)); });
  }
  $("#hist-refresh").addEventListener("click", loadHistory);
  $("#hist-delete").addEventListener("click", function () {
    var ids = $$(".hist-check").filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
    if (!ids.length) return toast("삭제할 기록을 선택하세요.");
    if (!confirm("선택한 기록 " + ids.length + "개를 맥북에서 영구 삭제할까요? 되돌릴 수 없습니다.")) return;
    Promise.all(ids.map(function (id) { return api("/api/records/" + id, { method: "DELETE" }).then(function () { return id; }, function () { return null; }); }))
      .then(function (done) {
        var n = done.filter(Boolean).length;
        if (done.indexOf(state.recordId) >= 0) {
          state.recordId = null;
          state.results = {};
          state.unsaved = {};
          renderResults();
          saveDraft();
        }
        toast(n + "개 기록을 삭제했습니다.");
        loadHistory();
      });
  });
  function openRecord(id) {
    var hasWork = state.input.text.trim() && !state.recordId;
    if (hasWork && !confirm("지금 화면의 입력은 아직 기록에 없습니다. 기록을 열면 사라집니다. 계속할까요?")) return;
    if (RESULT_TYPES.some(isBusy)) return toast("생성 중에는 다른 기록을 열 수 없습니다.");
    flushEdits().then(function () { return api("/api/records/" + id); }).then(function (r) {
      var rec = r.record;
      state.recordId = rec.id;
      state.input = Object.assign(emptyInput(), rec.input, { photos: undefined });
      delete state.input.photos;
      state.photos = (rec.input.photos || []).map(function (p, i) { return { id: "r" + i, blob: null, thumb: p.thumb || "icon.svg", note: p.note || "", thumbOnly: true }; });
      state.results = rec.results || {};
      state.jobs = {};
      state.unsaved = {};
      state.activeResult = RESULT_TYPES.find(function (t) { return state.results[t] && state.results[t].data; }) || "clip_photo";
      fillInputs();
      renderResults();
      renderJobStatus();
      saveDraft();
      showTab("work");
      toast("기록을 열었습니다.");
    }, function (e) { toast(e.message); });
  }

  // ---------- 수익화: 프로그램·계산·성과 ----------
  var progDirty = false;
  var perfDirty = false;
  function loadMoney() {
    $("#prog-help").textContent = "공식 공고를 직접 확인해 입력하세요. 공식 출처 URL과 확인 날짜가 없거나, 기간이 끝났거나, 확인한 지 " + Calc.STALE_DAYS + "일이 지난 조건은 ‘현재 조건’으로 쓰지 않고 보상도 합산하지 않습니다. 이 앱은 네이버 공고를 자동으로 가져오지 않습니다.";
    var p1 = progDirty ? Promise.resolve() : api("/api/programs").then(function (r) { server.programs = r.programs; server.categories = r.categories; });
    var p2 = perfDirty ? Promise.resolve() : api("/api/performance").then(function (r) { server.performance = r.performance; });
    return Promise.all([p1, p2]).then(function () { renderPrograms(); renderPerf(); recalc(); }, function (e) { toast(e.message); });
  }
  function progInput(p, key, label, type, opts) {
    opts = opts || {};
    var el;
    if (type === "select") {
      el = h("select", null, opts.options.map(function (o) { return h("option", { value: o, selected: p[key] === o }, o); }));
    } else if (type === "textarea") el = h("textarea", { rows: 2, value: p[key] || "" });
    else el = h("input", { type: type, value: p[key] == null ? "" : p[key], placeholder: opts.placeholder || "", inputmode: type === "number" ? "numeric" : null });
    el.addEventListener("input", function () {
      p[key] = type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value;
      progDirty = true;
      if (opts.rerender) renderProgramStatus();
      recalc();
    });
    el.addEventListener("change", function () { p[key] = type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value; progDirty = true; renderProgramStatus(); recalc(); });
    return h("label", null, label, el);
  }
  function renderPrograms() {
    var box = clear($("#prog-list"));
    server.programs.forEach(function (p, i) {
      box.appendChild(h("div", { class: "prog", "data-id": p.id },
        h("div", { class: "row between" }, h("b", { class: "prog-name" }, p.name || "(이름 없음)"), h("span", { class: "prog-status" })),
        h("div", { class: "grid2" },
          progInput(p, "category", "구분", "select", { options: server.categories || [] }),
          progInput(p, "name", "프로그램명", "text"),
          progInput(p, "sourceUrl", "공식 출처 URL", "url", { placeholder: "https://...", rerender: true }),
          progInput(p, "checkedOn", "확인 날짜", "date", { rerender: true }),
          progInput(p, "periodStart", "적용 시작일", "date", { rerender: true }),
          progInput(p, "periodEnd", "적용 종료일", "date", { rerender: true })),
        progInput(p, "eligibility", "참여·선발 자격", "textarea"),
        progInput(p, "qualifyingContent", "인정 콘텐츠 기준", "textarea"),
        progInput(p, "requirements", "필요한 개수·태그·등록 방식", "textarea"),
        h("div", { class: "grid2" },
          progInput(p, "reward", "보상 조건(공고 문구)", "text"),
          progInput(p, "rewardAmount", "조건 충족 시 보상 금액(원, 확정된 금액만)", "number"),
          progInput(p, "stackable", "중복 수령", "select", { options: ["확인 안 됨", "가능", "불가", "일부 가능"] })),
        progInput(p, "notes", "메모", "textarea"),
        h("button", { class: "small danger", type: "button", onclick: function () {
          if (!confirm("‘" + (p.name || "이 조건") + "’을 목록에서 지울까요? 저장을 눌러야 반영됩니다.")) return;
          server.programs.splice(i, 1); progDirty = true; renderPrograms(); recalc();
        } }, "이 조건 삭제")));
    });
    renderProgramStatus();
  }
  function renderProgramStatus() {
    $$(".prog").forEach(function (el) {
      var p = server.programs.find(function (x) { return x.id === el.dataset.id; });
      if (!p) return;
      var st = Calc.programStatus(p);
      var s = clear($(".prog-status", el));
      s.appendChild(h("span", { class: "badge" + (st.usable ? " ok" : st.code === "expired" ? " bad" : "") }, st.label));
      $(".prog-name", el).textContent = p.name || "(이름 없음)";
    });
  }
  $("#prog-add").addEventListener("click", function () {
    server.programs.push({ id: "", category: "기타", name: "새 조건", sourceUrl: "", checkedOn: Calc.isoDate(new Date()), periodStart: "", periodEnd: "", eligibility: "", qualifyingContent: "", requirements: "", reward: "", rewardAmount: null, stackable: "확인 안 됨", notes: "" });
    progDirty = true;
    renderPrograms();
  });
  $("#prog-save").addEventListener("click", function () {
    api("/api/programs", { method: "PUT", body: { programs: server.programs } }).then(function (r) {
      server.programs = r.programs; progDirty = false; renderPrograms(); recalc(); toast("프로그램 조건을 저장했습니다.");
    }, function (e) { toast(e.message); });
  });

  var calcIds = ["#c-count", "#c-writing", "#c-review", "#c-editing", "#c-upload", "#c-extra-min", "#c-extra-cost"];
  calcIds.forEach(function (s) { $(s).addEventListener("input", recalc); });
  var calcSelected = {};
  function recalc() {
    var box = clear($("#c-programs"));
    box.appendChild(h("div", { class: "small", style: "font-weight:600;margin-top:.6rem" }, "계산에 넣을 프로그램"));
    server.programs.forEach(function (p) {
      var st = Calc.programStatus(p);
      var cb = h("input", { type: "checkbox", checked: Boolean(calcSelected[p.id]), onchange: function () { calcSelected[p.id] = cb.checked; recalc(); } });
      box.appendChild(h("label", { class: "check" }, cb, (p.name || "(이름 없음)") + " ", h("span", { class: "badge" + (st.usable ? " ok" : "") }, st.label)));
    });
    var res = Calc.scenario({
      count: $("#c-count").value,
      minutes: { writing: $("#c-writing").value, review: $("#c-review").value, editing: $("#c-editing").value, upload: $("#c-upload").value },
      extraMinutes: $("#c-extra-min").value,
      extraCost: $("#c-extra-cost").value,
      selectedPrograms: Object.keys(calcSelected).filter(function (k) { return calcSelected[k]; }),
    }, server.programs);
    var ol = clear($("#c-formulas"));
    res.formulas.forEach(function (f) { ol.appendChild(h("li", null, f)); });
    var ex = clear($("#c-excluded"));
    if (res.excluded.length) ex.appendChild(h("div", null, "합산에서 뺀 조건: " + res.excluded.map(function (x) { return x.name + "(" + x.reason + ")"; }).join(", ")));
    ex.appendChild(h("div", null, "‘조건 충족 시’ 금액은 조건부 보상입니다. 실제 지급액은 아래 성과 기록에 따로 적습니다. 중복 수령 여부는 각 공고에서 확인하세요."));
  }

  var PERF_CHANNELS = ["클립 사진", "클립 영상", "라운지", "블로그", "기타"];
  function renderPerf() {
    var box = clear($("#perf-list"));
    server.performance.forEach(function (p, i) {
      var inp = function (key, label, type, opts) {
        opts = opts || {};
        var el = type === "select"
          ? h("select", null, opts.options.map(function (o) { return h("option", { value: o, selected: p[key] === o }, o); }))
          : h("input", { type: type, value: p[key] == null ? "" : p[key], placeholder: type === "number" ? "미측정" : "", min: type === "number" ? 0 : null, inputmode: type === "number" ? "numeric" : null });
        var upd = function () { p[key] = type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value; perfDirty = true; renderPerfSummary(); };
        el.addEventListener("input", upd);
        el.addEventListener("change", upd);
        return h("label", null, label, el);
      };
      box.appendChild(h("div", { class: "prog" },
        h("div", { class: "grid4" },
          inp("postedOn", "게시일", "date"), inp("channel", "채널", "select", { options: PERF_CHANNELS }), inp("minutes", "제작 시간(분)", "number"), inp("views", "조회수", "number"),
          inp("linkClicks", "링크 클릭(확인된 값)", "number"), inp("blogVisits", "블로그 유입(확인된 값)", "number"), inp("missionCount", "미션 인정 건수", "number"), inp("paidAmount", "실제 지급액(원)", "number")),
        inp("url", "게시물 URL", "url"),
        inp("memo", "메모", "text"),
        h("button", { class: "small danger", type: "button", onclick: function () { server.performance.splice(i, 1); perfDirty = true; renderPerf(); } }, "삭제")));
    });
    if (!server.performance.length) box.appendChild(h("p", { class: "empty" }, "아직 성과 기록이 없습니다."));
    renderPerfSummary();
  }
  function renderPerfSummary() {
    var a = Calc.actuals(server.performance);
    var box = clear($("#perf-summary"));
    var stat = function (label, key, unit) {
      var n = a.measured[key];
      box.appendChild(h("div", { class: "stat" }, h("span", { class: "small muted" }, label), h("b", null, n ? a.sums[key].toLocaleString("ko-KR") + unit : "미측정"), h("span", { class: "small muted" }, "측정 " + n + "/" + a.total + "건")));
    };
    stat("제작 시간", "minutes", "분");
    stat("조회수", "views", "");
    stat("링크 클릭", "linkClicks", "");
    stat("블로그 유입", "blogVisits", "");
    stat("미션 인정", "missionCount", "건");
    stat("실제 지급액", "paidAmount", "원");
    box.appendChild(h("div", { class: "stat" }, h("span", { class: "small muted" }, "시간당 실제 지급액"),
      h("b", null, a.paidPerHour === null ? "계산 불가" : Calc.won(a.paidPerHour)), h("span", { class: "small muted" }, "제작시간·지급액 모두 기록된 " + a.paidPerHourBasis + "건 기준")));
  }
  $("#perf-add").addEventListener("click", function () {
    server.performance.unshift({ id: "", postedOn: Calc.isoDate(new Date()), channel: "클립 사진", url: "", recordId: state.recordId || "", minutes: null, views: null, linkClicks: null, blogVisits: null, missionCount: null, paidAmount: null, memo: "" });
    perfDirty = true;
    renderPerf();
  });
  $("#perf-save").addEventListener("click", function () {
    api("/api/performance", { method: "PUT", body: { performance: server.performance } }).then(function (r) {
      server.performance = r.performance; perfDirty = false; renderPerf(); toast("성과 기록을 저장했습니다.");
    }, function (e) { toast(e.message); });
  });
  window.addEventListener("beforeunload", function (ev) {
    if (progDirty || perfDirty) { ev.preventDefault(); ev.returnValue = ""; }
  });

  // ---------- 상태·안내 ----------
  function loadStatus(force) {
    return api("/api/status" + (force ? "?refresh=1" : "")).then(function (s) {
      server.status = s;
      server.mock = s.mock;
      renderChips();
      renderPrivacy();
      if ($("#tab-info").hidden === false) renderInfo();
      return s;
    });
  }
  function pct(x) { return Math.round((Number(x) || 0) * 100) + "%"; }
  function epochTime(sec) { return sec ? new Date(sec * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""; }
  function renderChips() {
    var s = server.status;
    var box = clear($("#status-chips"));
    if (!s) return;
    if (s.mock) box.appendChild(h("span", { class: "chip warn" }, "테스트 모드 · 실제 Claude 호출 없음"));
    else {
      var c = s.claude || {};
      if (!c.installed) box.appendChild(h("span", { class: "chip bad" }, "Claude Code 없음"));
      else if (!c.auth || !c.auth.loggedIn) box.appendChild(h("span", { class: "chip bad" }, "Claude 로그인 필요"));
      else box.appendChild(h("span", { class: "chip ok" }, "Claude Code " + (c.version || "") + " · " + (c.auth.authMethod || "")));
      if (s.apiKeyBlocked) box.appendChild(h("span", { class: "chip bad" }, "API 키 감지 · 생성 차단"));
      if (s.apiKeyAllowed) box.appendChild(h("span", { class: "chip warn" }, "API 키 과금 모드"));
    }
    var rl = s.rateLimit;
    if (rl && rl.windows) {
      Object.keys(rl.windows).forEach(function (k) {
        var w = rl.windows[k];
        var name = k === "five_hour" ? "5시간" : k === "seven_day" ? "7일" : k;
        box.appendChild(h("span", { class: "chip" + (w.utilization > 0.8 ? " warn" : "") }, name + " " + pct(w.utilization) + (w.resetsAt ? " · " + epochTime(w.resetsAt) + " 초기화" : "")));
      });
    }
    if (s.guides && s.guides.length) box.appendChild(h("span", { class: "chip" }, "지침 " + s.guides.length + "개 적용"));
  }
  function renderPrivacy() {
    var box = clear($("#privacy-notice"));
    if (server.mock) {
      box.appendChild(h("b", null, "테스트 모드: "));
      box.appendChild(document.createTextNode("입력은 외부로 전송되지 않고 고정된 테스트 응답이 돌아옵니다."));
      return;
    }
    box.appendChild(h("b", null, "전송 안내: "));
    box.appendChild(document.createTextNode("생성 버튼을 누르면 원문·사진(긴 변 1568px JPEG, 위치정보 제거)·메모가 이 맥북의 Claude Code를 거쳐 Anthropic 서버로 전송되어 처리됩니다(본인 Claude 계정 약관 적용). 수익화 분석에는 사진 이미지를 보내지 않습니다. 이 앱은 네이버에 아무것도 게시하지 않으며, URL의 본문도 가져오지 않습니다."));
  }
  function renderInfo() {
    var s = server.status || {};
    var c = s.claude || {};
    var box = clear($("#info-body"));
    box.appendChild(h("h2", null, "실행 상태"));
    var rows = [];
    if (s.mock) rows.push("모드: 테스트 응답(POONGRYU_MOCK=1). 실제 Claude를 호출하지 않습니다.");
    else {
      rows.push("Claude Code: " + (c.installed ? "설치됨 " + (c.version || "") : "찾지 못함"));
      rows.push("인증: " + (c.auth ? (c.auth.loggedIn ? "로그인됨 (" + c.auth.authMethod + ", " + (c.auth.apiProvider || "") + ")" : "로그인 필요 — 맥북 터미널에서 직접 claude 실행 후 로그인") : "확인 불가"));
      rows.push("모델: " + (s.model || "계정 기본값"));
      if (s.apiKeyBlocked) rows.push("ANTHROPIC_API_KEY 환경변수가 있어 실제 생성을 막았습니다. 이 상태로는 구독이 아니라 API 사용량으로 과금됩니다. 구독으로 쓰려면 변수를 해제하고 앱을 다시 시작하세요.");
    }
    box.appendChild(h("ul", null, rows.map(function (r) { return h("li", null, r); })));
    box.appendChild(h("h2", null, "사용량·비용"));
    box.appendChild(h("ul", null,
      h("li", null, "생성 한 번마다 Claude Code를 비대화형(claude -p)으로 1회 실행합니다. 전체 변환은 1회, 각 버튼도 1회입니다."),
      h("li", null, "구독(Pro/Max) 로그인이면 플랜 사용 한도에서 차감됩니다. 무제한이 아니며, 한도에 닿으면 초기화 시각까지 실패합니다. 이 앱은 추가 결제를 하지 않습니다."),
      h("li", null, "화면 상단의 5시간·7일 사용률은 마지막 생성 응답에 포함된 값입니다(생성 전에는 표시되지 않음).")));
    box.appendChild(h("h2", null, "저장 위치와 삭제 방법"));
    box.appendChild(h("ul", null,
      h("li", null, "생성 기록·프로그램 조건·성과: 맥북 " + (s.dataDir || "data") + " (권한 700/600). 기록에는 글·결과·240px 썸네일만 저장하고 원본 사진은 저장하지 않습니다."),
      h("li", null, "삭제: ‘기록’ 탭에서 선택 삭제. 전부 지우려면 앱을 끄고 위 data 폴더를 삭제하세요(접속 비밀번호도 함께 지워져 npm run setup이 다시 필요)."),
      h("li", null, "현재 작업 임시 저장: 이 브라우저의 IndexedDB(축소한 사진 포함). 기기마다 따로 저장됩니다. ‘새 작업’으로 비우거나 브라우저 사이트 데이터 삭제로 지웁니다."),
      h("li", null, "생성 중 입력은 맥북 메모리에서 처리 후 지우며, 로그에는 원문·사진을 남기지 않습니다.")));
    box.appendChild(h("h2", null, "작성 지침 파일"));
    box.appendChild(h("p", { class: "small" }, "블로그 지침·검수 지침·클립/라운지 프롬프트를 " + (s.guideDir || "guides") + " 폴더에 .md/.txt로 두면 생성 때마다 읽어 반영합니다."));
    box.appendChild(h("ul", null, (s.guides || []).length ? s.guides.map(function (g) { return h("li", null, g.name + " (" + g.chars + "자" + (g.truncated ? ", 일부만 사용" : "") + (g.skipped ? ", 전체 한도 초과로 제외" : "") + ")"); }) : h("li", null, "없음")));
    box.appendChild(h("h2", null, "휴대폰 접속(Tailscale)"));
    box.appendChild(h("ol", null,
      h("li", null, "맥북과 휴대폰에 Tailscale을 설치하고 같은 계정으로 직접 로그인합니다."),
      h("li", null, "맥북 터미널: tailscale serve --bg " + (s.port || 8787)),
      h("li", null, "휴대폰 브라우저에서 https://<맥북 이름>.<tailnet>.ts.net 으로 접속 → 접속 비밀번호 입력."),
      h("li", null, "공개 인터넷 공개(tailscale funnel)는 사용하지 마세요. 끄기: tailscale serve --https=443 off")));
  }
  $("#status-refresh").addEventListener("click", function () { loadStatus(true).then(function () { renderInfo(); toast("상태를 다시 확인했습니다."); }, function (e) { toast(e.message); }); });
  $("#logout").addEventListener("click", function () {
    flushEdits().then(function () { return api("/api/logout", { method: "POST" }); }).then(function () { showLogin(); });
  });

  // ---------- 시작 ----------
  function restoreDraft(d) {
    if (!d) return;
    state.recordId = d.recordId || null;
    state.input = Object.assign(emptyInput(), d.input || {});
    state.input.disclosure = Object.assign({ kind: "unknown", detail: "" }, state.input.disclosure);
    state.input.lounge = Object.assign({ topic: "", rules: "" }, state.input.lounge);
    state.photos = (d.photos || []).filter(function (p) { return p && p.thumb; });
    state.results = d.results || {};
    state.jobs = d.jobs || {};
    state.unsaved = d.unsaved || {};
    state.activeResult = d.activeResult || "clip_photo";
    // '요청 보내는 중' 상태로 새로고침되면 실제로 접수됐는지 알 수 없으므로 정리한다.
    RESULT_TYPES.forEach(function (t) { if (state.jobs[t] && state.jobs[t].status === "sending") delete state.jobs[t]; });
  }
  var started = false;
  function start() {
    $("#login-view").hidden = true;
    $("#app-view").hidden = false;
    if (started) { loadStatus(); return; }
    started = true;
    loadDraft().then(function (d) {
      restoreDraft(d);
      fillInputs();
      renderResults();
      renderJobStatus();
      return loadStatus().catch(function () {});
    }).then(function () {
      // 서버 기록이 기준. 저장 못 한 수정본은 다시 보낸다.
      var resend = flushEdits();
      if (!state.recordId) return resend;
      return resend.then(function () { return api("/api/records/" + state.recordId); }).then(function (r) {
        RESULT_TYPES.forEach(function (t) { if (!state.unsaved[t] && r.record.results[t]) state.results[t] = r.record.results[t]; });
        saveDraft();
        renderResults();
      }, function (e) {
        if (e.status === 404) { state.recordId = null; saveDraft(); }
      });
    }).then(function () {
      startPolling();
      api("/api/programs").then(function (r) { server.programs = r.programs; server.categories = r.categories; }).catch(function () {});
      var tab = null;
      try { tab = sessionStorage.getItem("poongryu-tab"); } catch (e) { tab = null; }
      if (tab && tab !== "work") showTab(tab);
    });
  }

  api("/api/session").then(function (s) {
    if (s.authenticated) start();
    else showLogin(s.configured);
  }, function (e) {
    showLogin();
    $("#login-error").textContent = e.message;
  });
})();
