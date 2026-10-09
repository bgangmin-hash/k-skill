"use strict";

// 테스트 모드(POONGRYU_MOCK=1) 전용 고정 응답. 실제 Claude를 호출하지 않으며 화면에 '테스트 응답'으로 표시된다.

const note = (category, text) => ({ category, note: text });
const MOCK_TAG = "[테스트 응답]";

function common(photoCount) {
  return {
    review_notes: [note("기타", `${MOCK_TAG} 실제 Claude가 만든 내용이 아닙니다.`)],
    claims: [{ text: "테스트 주장", kind: "의견", verification: "해당 없음", used_in_post: true }],
    input_check: { photos_viewed: 0, used_photo_notes_only: photoCount > 0, source_url_read: false },
  };
}

function clipPhoto(n) {
  const slides = (n ? Array.from({ length: n }, (_, i) => i + 1) : [null]).map((photo, i) => ({
    photo,
    on_screen_text: `${MOCK_TAG} 장면 ${i + 1} 문구`,
    layout: photo ? "사진 전체, 문구는 하단" : "추가 사진 필요",
  }));
  return {
    core_question: `${MOCK_TAG} 핵심 질문`,
    core_answer: `${MOCK_TAG} 핵심 답`,
    cover_candidates: [{ text: `${MOCK_TAG} 표지 A`, reason: "질문형" }, { text: `${MOCK_TAG} 표지 B`, reason: "결론형" }],
    cover_recommended: 1,
    slides,
    order_reason: "원문 순서",
    caption: `${MOCK_TAG} 설명문`,
    hashtags: ["#테스트"],
    info_tags: [],
    blog_link_guide: "자세한 기록은 블로그에 있습니다.",
    length_guide: { editorial_recommendation: "5~7장 권장(편집 기준)", official_limit: "네이버 클립 공식 안내에서 확인 필요" },
    ...common(n),
  };
}

function clipVideo(n) {
  return {
    concept: `${MOCK_TAG} 영상 콘셉트`,
    segments: [
      { start_sec: 0, end_sec: 3, scene: "도입", source_material: n ? "사진 1" : "추가 촬영 필요", subtitle: "자막1", narration: "첫 문장입니다.", edit_note: "컷 전환" },
      { start_sec: 3, end_sec: 10, scene: "본론", source_material: "영상 메모 A", subtitle: "자막2", narration: "두 번째 문장입니다.", edit_note: "확대" },
    ],
    narration_full: "첫 문장입니다. 두 번째 문장입니다.",
    caption: `${MOCK_TAG} 영상 설명문`,
    hashtags: ["#테스트"],
    info_tags: [],
    missing_materials: [],
    duration_note: "계획값이며 낭독·렌더링으로 검증하지 않았습니다.",
    ...common(n),
  };
}

function lounge(n) {
  return {
    fit: { verdict: "판단 불가", reason: `${MOCK_TAG} 라운지 주제가 테스트 값입니다.` },
    title_candidates: [`${MOCK_TAG} 제목 1`, `${MOCK_TAG} 제목 2`],
    title_recommended: 1,
    body: `${MOCK_TAG} 라운지 본문 첫 문단.\n\n둘째 문단.`,
    question: null,
    photo_placement: n ? [{ photo: 1, position: "본문 위" }] : [],
    rule_check: [{ item: "링크 허용 여부", status: "사용자 확인 필요", note: "규칙 미입력" }],
    short_version: `${MOCK_TAG} 짧은 버전`,
    ...common(n),
  };
}

function monetization(n, programs) {
  return {
    channel_fit: [{ format: "클립 사진", fit: "중간", reason: MOCK_TAG }],
    content_candidates: [{ title: `${MOCK_TAG} 후보`, format: "클립 사진", materials: "원문 1~3문단", distinct_value: "요약" }],
    additional_work: ["표지용 사진 1장 추가 촬영"],
    priorities: [{ rank: 1, item: "클립 사진 1편", rationale: MOCK_TAG }],
    program_fit: (programs || []).map((p) => ({ program_id: p.id, fit: "조건 미확인", reason: MOCK_TAG, to_check: "공식 공고 확인" })),
    time_estimates: { writing: 20, review: 10, editing: 15, upload: 5, basis: `${MOCK_TAG} 가정값` },
    ...common(n),
  };
}

function mockResponse(type, input, programs) {
  const n = (input.photos || []).length;
  const text = String(input.text || "");
  const forced = text.match(/\[\[mock-error:(\w+)\]\]/);
  if (forced) {
    const messages = {
      limit: "사용 한도에 도달했거나 서버가 혼잡합니다. (테스트 오류)",
      auth: "Claude Code 로그인이 필요합니다. (테스트 오류)",
      timeout: "응답 시간이 초과되었습니다. (테스트 오류)",
    };
    return { ok: false, code: forced[1], message: messages[forced[1]] || "테스트 오류" };
  }
  const map = {
    clip_photo: () => clipPhoto(n),
    clip_video: () => clipVideo(n),
    lounge: () => lounge(n),
    monetization: () => monetization(n, programs),
    all: () => ({ clip_photo: clipPhoto(n), clip_video: clipVideo(n), lounge: lounge(n) }),
  };
  return { ok: true, data: map[type](), meta: { model: "mock", mock: true, rateLimit: null, durationMs: 0, costEstimateUsd: 0 } };
}

module.exports = { mockResponse };
