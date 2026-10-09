// 수익화 계산과 프로그램 조건 상태 판정. 브라우저와 Node(테스트·서버)가 같은 코드를 쓴다.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PoongryuCalc = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 확인한 지 이 일수가 지나면 '오래됨'으로 보고 현재 조건처럼 쓰지 않는다. */
  var STALE_DAYS = 14;

  function isoDate(d) {
    var x = d instanceof Date ? d : new Date(d);
    var y = x.getFullYear();
    var m = String(x.getMonth() + 1).padStart(2, "0");
    var day = String(x.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function daysBetween(a, b) {
    var t1 = Date.parse(a + "T00:00:00");
    var t2 = Date.parse(b + "T00:00:00");
    if (isNaN(t1) || isNaN(t2)) return null;
    return Math.round((t2 - t1) / 86400000);
  }

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /**
   * 반환: { code, label, usable }
   * usable=true 일 때만 보상 계산·현재 조건 표시에 쓴다.
   */
  function programStatus(p, today) {
    today = today || isoDate(new Date());
    if (!p || !p.sourceUrl || !DATE_RE.test(p.checkedOn || "")) {
      return { code: "unverified", label: "미확인(공식 출처·확인 날짜 필요)", usable: false };
    }
    if (p.periodEnd && DATE_RE.test(p.periodEnd) && p.periodEnd < today) {
      return { code: "expired", label: "기간 종료", usable: false };
    }
    if (p.periodStart && DATE_RE.test(p.periodStart) && p.periodStart > today) {
      return { code: "upcoming", label: "시작 전", usable: false };
    }
    var age = daysBetween(p.checkedOn, today);
    if (age === null || age < 0) return { code: "unverified", label: "확인 날짜 오류", usable: false };
    if (age > STALE_DAYS) {
      return { code: "stale", label: "오래됨(" + age + "일 전 확인, 재확인 필요)", usable: false };
    }
    if (!p.periodEnd) {
      return { code: "verified", label: "확인됨(종료일 미입력)", usable: true };
    }
    return { code: "verified", label: "확인됨", usable: true };
  }

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /**
   * 제작 시간 대비 보상 시나리오.
   * - 총 제작시간(분) = 콘텐츠 수 × 한 편 제작시간(작성+검수+편집+업로드)
   * - 시간당 순보상 = (조건 충족 시 보상 − 추가 비용) ÷ 총 작업시간(시간)
   * 프로그램 보상은 '콘텐츠당'이 아니라 '조건 충족 시 받는 금액'으로 입력받는다
   * (예: 기간 내 N편 이상 → X원). 콘텐츠 수를 곱하지 않는다.
   */
  function scenario(input, programs, today) {
    var count = Math.max(0, Math.floor(num(input.count) || 0));
    var m = input.minutes || {};
    var parts = {
      writing: Math.max(0, num(m.writing) || 0),
      review: Math.max(0, num(m.review) || 0),
      editing: Math.max(0, num(m.editing) || 0),
      upload: Math.max(0, num(m.upload) || 0),
    };
    var perContent = parts.writing + parts.review + parts.editing + parts.upload;
    var extraMinutes = Math.max(0, num(input.extraMinutes) || 0);
    var totalMinutes = count * perContent + extraMinutes;
    var totalHours = totalMinutes / 60;
    var extraCost = Math.max(0, num(input.extraCost) || 0);

    var selected = input.selectedPrograms || [];
    var included = [];
    var excluded = [];
    (programs || []).forEach(function (p) {
      if (selected.indexOf(p.id) < 0) return;
      var st = programStatus(p, today);
      var amt = num(p.rewardAmount);
      if (!st.usable) excluded.push({ id: p.id, name: p.name, reason: st.label });
      else if (amt === null) excluded.push({ id: p.id, name: p.name, reason: "보상 금액 미입력(금액이 정해지지 않은 보상은 합산하지 않음)" });
      else included.push({ id: p.id, name: p.name, amount: amt });
    });
    var conditionalReward = included.reduce(function (s, x) { return s + x.amount; }, 0);
    var hourlyIfMet = totalHours > 0 ? (conditionalReward - extraCost) / totalHours : null;
    var hourlyIfNotMet = totalHours > 0 ? (0 - extraCost) / totalHours : null;

    return {
      count: count,
      parts: parts,
      perContent: perContent,
      extraMinutes: extraMinutes,
      totalMinutes: totalMinutes,
      totalHours: totalHours,
      extraCost: extraCost,
      included: included,
      excluded: excluded,
      conditionalReward: conditionalReward,
      hourlyIfMet: hourlyIfMet,
      hourlyIfNotMet: hourlyIfNotMet,
      formulas: [
        "한 편 제작시간 = 작성 " + parts.writing + " + 검수 " + parts.review + " + 편집 " + parts.editing + " + 업로드 " + parts.upload + " = " + perContent + "분",
        "총 제작시간 = 콘텐츠 수 " + count + " × " + perContent + "분" + (extraMinutes ? " + 기타 " + extraMinutes + "분" : "") + " = " + totalMinutes + "분 (" + round(totalHours, 2) + "시간)",
        "조건 충족 시 보상 = " + (included.length ? included.map(function (x) { return x.name + " " + won(x.amount); }).join(" + ") : "확인된 보상 없음") + " = " + won(conditionalReward),
        "시간당 순보상(조건 충족 시) = (" + won(conditionalReward) + " − 추가 비용 " + won(extraCost) + ") ÷ " + round(totalHours, 2) + "시간 = " + (hourlyIfMet === null ? "계산 불가(작업시간 0)" : won(hourlyIfMet) + "/시간"),
        "조건 미충족 시 = (0 − " + won(extraCost) + ") ÷ " + round(totalHours, 2) + "시간 = " + (hourlyIfNotMet === null ? "계산 불가" : won(hourlyIfNotMet) + "/시간"),
      ],
    };
  }

  /** 실제 성과: 측정된 값만 합산하고, 측정 안 된 건수를 따로 센다. */
  function actuals(perf) {
    var fields = ["minutes", "views", "linkClicks", "blogVisits", "missionCount", "paidAmount"];
    var sums = {};
    var measured = {};
    fields.forEach(function (f) {
      sums[f] = 0;
      measured[f] = 0;
    });
    (perf || []).forEach(function (p) {
      fields.forEach(function (f) {
        var v = num(p[f]);
        if (v !== null) {
          sums[f] += v;
          measured[f] += 1;
        }
      });
    });
    // 시간당 실제 지급액은 제작시간과 지급액이 둘 다 기록된 게시물만으로 계산한다.
    var both = (perf || []).filter(function (p) { return num(p.minutes) !== null && num(p.paidAmount) !== null; });
    var bothMin = both.reduce(function (s, p) { return s + num(p.minutes); }, 0);
    var bothPaid = both.reduce(function (s, p) { return s + num(p.paidAmount); }, 0);
    return {
      total: (perf || []).length,
      sums: sums,
      measured: measured,
      paidPerHour: bothMin > 0 ? bothPaid / (bothMin / 60) : null,
      paidPerHourBasis: both.length,
    };
  }

  function round(n, d) {
    var k = Math.pow(10, d || 0);
    return Math.round(n * k) / k;
  }
  function won(n) {
    return Math.round(n).toLocaleString("ko-KR") + "원";
  }

  return { STALE_DAYS: STALE_DAYS, programStatus: programStatus, scenario: scenario, actuals: actuals, isoDate: isoDate, won: won };
});
