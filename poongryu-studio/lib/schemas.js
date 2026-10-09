"use strict";

// claude -p --json-schema 로 넘기는 결과 형식. 버튼마다 같은 공통 필드
// (review_notes, claims, input_check)를 갖게 해서 화면·다운로드 형식을 통일한다.

const str = { type: "string" };
const strArr = { type: "array", items: str };
const idxOrNull = { type: ["integer", "null"], description: "사진 번호(1부터). 사진과 무관하면 null" };

const reviewNotes = {
  type: "array",
  description: "게시 전 사람이 확인할 검수 메모",
  items: {
    type: "object",
    properties: {
      category: { type: "string", enum: ["사실 확인 필요", "규칙 확인 필요", "사진", "표현", "개인정보", "기타"] },
      note: str,
    },
    required: ["category", "note"],
  },
};

const claims = {
  type: "array",
  description: "원문의 주요 주장을 사실/직접 경험/의견으로 분류",
  items: {
    type: "object",
    properties: {
      text: str,
      kind: { type: "string", enum: ["사실", "직접 경험", "의견"] },
      verification: {
        type: "string",
        enum: ["외부 검증 안 함", "원문 기재만 있음", "해당 없음"],
        description: "이 도구는 외부 검증을 하지 않는다. 사실 주장은 '외부 검증 안 함'",
      },
      used_in_post: { type: "boolean", description: "게시용 원고에 넣었는지" },
    },
    required: ["text", "kind", "verification", "used_in_post"],
  },
};

const inputCheck = {
  type: "object",
  description: "실제로 받은 입력에 대한 정직한 상태",
  properties: {
    photos_viewed: { type: "integer", description: "실제로 이미지로 받아 본 사진 수" },
    used_photo_notes_only: { type: "boolean", description: "사진 없이 설명 메모만으로 작성했는지" },
    source_url_read: { type: "boolean", description: "URL 본문을 읽었는지. 이 도구는 URL을 읽지 않으므로 항상 false" },
  },
  required: ["photos_viewed", "used_photo_notes_only", "source_url_read"],
};

const common = { review_notes: reviewNotes, claims, input_check: inputCheck };
const commonRequired = ["review_notes", "claims", "input_check"];

const clipPhoto = {
  type: "object",
  properties: {
    core_question: str,
    core_answer: str,
    cover_candidates: {
      type: "array",
      items: { type: "object", properties: { text: str, reason: str }, required: ["text", "reason"] },
    },
    cover_recommended: { type: "integer", description: "추천 표지 후보 번호(1부터)" },
    slides: {
      type: "array",
      description: "게시 순서대로 장면",
      items: {
        type: "object",
        properties: { photo: idxOrNull, on_screen_text: str, layout: str },
        required: ["photo", "on_screen_text", "layout"],
      },
    },
    order_reason: str,
    caption: { type: "string", description: "설명문" },
    hashtags: strArr,
    info_tags: { type: "array", items: str, description: "정보태그(장소·상품 등) 후보. 원문 근거가 있는 것만" },
    blog_link_guide: str,
    length_guide: {
      type: "object",
      properties: {
        editorial_recommendation: { type: "string", description: "편집 권장 장수·분량(공식 제한 아님)" },
        official_limit: { type: "string", description: "사용자 제공 공식 제한. 없으면 '공식 안내에서 확인 필요'" },
      },
      required: ["editorial_recommendation", "official_limit"],
    },
    ...common,
  },
  required: [
    "core_question", "core_answer", "cover_candidates", "cover_recommended", "slides", "order_reason",
    "caption", "hashtags", "info_tags", "blog_link_guide", "length_guide", ...commonRequired,
  ],
};

const clipVideo = {
  type: "object",
  properties: {
    concept: str,
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start_sec: { type: "number" },
          end_sec: { type: "number" },
          scene: str,
          source_material: { type: "string", description: "사용할 실제 보유 영상/사진(예: 사진 2, 메모의 영상 A). 없으면 '추가 촬영 필요'" },
          subtitle: str,
          narration: str,
          edit_note: str,
        },
        required: ["start_sec", "end_sec", "scene", "source_material", "subtitle", "narration", "edit_note"],
      },
    },
    narration_full: str,
    caption: str,
    hashtags: strArr,
    info_tags: strArr,
    missing_materials: { type: "array", items: str, description: "대본대로 만들려면 추가로 필요한 촬영·소스" },
    duration_note: { type: "string", description: "구간 시간은 계획값이며 낭독·렌더링으로 검증하지 않았음을 명시" },
    ...common,
  },
  required: [
    "concept", "segments", "narration_full", "caption", "hashtags", "info_tags", "missing_materials",
    "duration_note", ...commonRequired,
  ],
};

const lounge = {
  type: "object",
  properties: {
    fit: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["적합", "부분 적합", "부적합", "판단 불가"] },
        reason: str,
      },
      required: ["verdict", "reason"],
    },
    title_candidates: strArr,
    title_recommended: { type: "integer", description: "추천 제목 번호(1부터). 부적합이면 0" },
    body: { type: "string", description: "독립적으로 유용한 짧은 게시글. 부적합이면 빈 문자열" },
    question: { type: ["string", "null"], description: "자연스러울 때만 질문 하나, 아니면 null" },
    photo_placement: {
      type: "array",
      items: { type: "object", properties: { photo: idxOrNull, position: str }, required: ["photo", "position"] },
    },
    rule_check: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: str,
          status: { type: "string", enum: ["입력된 규칙과 맞음", "사용자 확인 필요", "규칙 위반 우려", "해당 없음"] },
          note: str,
        },
        required: ["item", "status", "note"],
      },
    },
    short_version: str,
    ...common,
  },
  required: [
    "fit", "title_candidates", "title_recommended", "body", "question", "photo_placement", "rule_check",
    "short_version", ...commonRequired,
  ],
};

const monetization = {
  type: "object",
  properties: {
    channel_fit: {
      type: "array",
      items: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["클립 사진", "클립 영상", "라운지", "블로그 유지"] },
          fit: { type: "string", enum: ["높음", "중간", "낮음", "부적합"] },
          reason: str,
        },
        required: ["format", "fit", "reason"],
      },
    },
    content_candidates: {
      type: "array",
      description: "실제 자료로 만들 수 있고 서로 중복되지 않는 독립 콘텐츠",
      items: {
        type: "object",
        properties: { title: str, format: str, materials: str, distinct_value: str },
        required: ["title", "format", "materials", "distinct_value"],
      },
    },
    additional_work: strArr,
    priorities: {
      type: "array",
      items: {
        type: "object",
        properties: { rank: { type: "integer" }, item: str, rationale: str },
        required: ["rank", "item", "rationale"],
      },
    },
    program_fit: {
      type: "array",
      description: "사용자가 등록한 프로그램별 적합성. 등록되지 않은 프로그램은 만들지 않는다",
      items: {
        type: "object",
        properties: {
          program_id: str,
          fit: { type: "string", enum: ["맞음", "일부 맞음", "맞지 않음", "조건 미확인"] },
          reason: str,
          to_check: str,
        },
        required: ["program_id", "fit", "reason", "to_check"],
      },
    },
    time_estimates: {
      type: "object",
      description: "한 편당 작업 시간(분) 가정값. 사용자가 화면에서 수정한다",
      properties: {
        writing: { type: "number" }, review: { type: "number" }, editing: { type: "number" }, upload: { type: "number" },
        basis: str,
      },
      required: ["writing", "review", "editing", "upload", "basis"],
    },
    ...common,
  },
  required: [
    "channel_fit", "content_candidates", "additional_work", "priorities", "program_fit", "time_estimates",
    ...commonRequired,
  ],
};

const all = {
  type: "object",
  properties: { clip_photo: clipPhoto, clip_video: clipVideo, lounge },
  required: ["clip_photo", "clip_video", "lounge"],
};

const SCHEMAS = { clip_photo: clipPhoto, clip_video: clipVideo, lounge, all, monetization };

const TYPE_LABELS = {
  clip_photo: "클립 사진 게시물",
  clip_video: "클립 영상 대본",
  lounge: "라운지 글",
  all: "전체 변환",
  monetization: "수익화 분석",
};

module.exports = { SCHEMAS, TYPE_LABELS };
