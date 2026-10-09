"use strict";

// 업로드 사진 검증. 브라우저가 HEIC 등을 JPEG로 바꿔 보내지만, 서버는 실제 바이트를 다시 확인한다.

const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude 이미지 입력 한도(장당 5MB)
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return "image/gif";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic";
    if (/^avi[fs]$/.test(brand)) return "image/avif";
  }
  return null;
}

/**
 * @returns {{ok:true, photos:Array}|{ok:false, message:string}}
 */
function validatePhotos(photos) {
  if (photos === undefined || photos === null) return { ok: true, photos: [] };
  if (!Array.isArray(photos)) return { ok: false, message: "사진 형식이 올바르지 않습니다." };
  if (photos.length > MAX_IMAGES) return { ok: false, message: `사진은 최대 ${MAX_IMAGES}장까지 보낼 수 있습니다.` };
  let total = 0;
  const out = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i] || {};
    const label = `사진 ${i + 1}`;
    if (typeof p.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)) {
      return { ok: false, message: `${label}: 이미지 데이터가 올바르지 않습니다.` };
    }
    const buf = Buffer.from(p.data, "base64");
    if (buf.length > MAX_IMAGE_BYTES) return { ok: false, message: `${label}: 5MB를 넘습니다. 더 작게 줄여 주세요.` };
    total += buf.length;
    const type = sniff(buf);
    if (type === "image/heic" || type === "image/avif") {
      return {
        ok: false,
        message: `${label}: HEIC/AVIF는 바로 보낼 수 없습니다. 휴대폰(사파리)에서 올리면 자동으로 JPEG로 바뀝니다. 맥에서는 '미리보기'로 JPEG 내보내기 후 올려 주세요.`,
      };
    }
    if (!type) return { ok: false, message: `${label}: JPEG·PNG·WebP·GIF 사진만 지원합니다.` };
    out.push({ mediaType: type, data: p.data, note: String(p.note || "").slice(0, 1000), bytes: buf.length });
  }
  if (total > MAX_TOTAL_BYTES) return { ok: false, message: "사진 전체 용량이 20MB를 넘습니다." };
  return { ok: true, photos: out };
}

module.exports = { validatePhotos, sniff, MAX_IMAGES, MAX_IMAGE_BYTES };
