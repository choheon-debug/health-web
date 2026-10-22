// 건강 레시피 앱의 AI 중계 서버 (Cloudflare Worker)
// 사장님의 Gemini API 키는 Cloudflare의 비밀 변수 GEMINI_KEY에만 넣어 두고, 앱 코드에는 넣지 않는다.
// 앱 → 이 서버 → 구글 Gemini 순서로 질문이 전달되고, 답만 앱으로 돌려준다.

// 이 주소에서 연 앱만 쓸 수 있다 (다른 사이트가 키를 몰래 쓰지 못하게)
const ALLOWED_ORIGINS = ["https://choheon-debug.github.io"];
// 한 사람(인터넷 주소)당 사용 한도. 무료 사용량을 지키기 위한 것.
const PER_MINUTE = 8;
const PER_DAY = 150;
const MAX_BODY = 6 * 1024 * 1024;   // 사진 포함 최대 6MB
const SYSTEM = "당신은 20년 경력의 세계적인 건강식단 연구가이자 식품영양학 박사이며, 미슐랭급 셰프입니다. 모든 답변은 한국어로, 전문가의 입장에서 친절하고 상세하게 제공해야 합니다. 질병이 있는 사람에게는 주의할 점도 함께 알려 주세요.";
const API = "https://generativelanguage.googleapis.com/v1beta";

let model = "";            // 지금 쓰는 AI 모델 (처음 요청 때 자동으로 고른다)
const usage = new Map();   // 인터넷 주소별 사용 횟수 (서버가 다시 켜지면 초기화)

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    // 브라우저로 서버 주소를 열면 상태를 보여 준다 (설정이 잘 됐는지 확인용)
    if (req.method === "GET") return reply({ ok: true, key: env.GEMINI_KEY ? "있음" : "없음 (GEMINI_KEY를 넣어 주세요)", model: model || "첫 질문 때 자동으로 골라요" });
    if (req.method !== "POST") return reply({ error: "지원하지 않는 요청이에요." }, 405);
    if (!allowed) return reply({ error: "건강 레시피 앱에서만 쓸 수 있어요." }, 403);
    if (!env.GEMINI_KEY) return reply({ error: "AI 서버에 API 키가 아직 없어요. 관리자에게 알려 주세요." }, 500);

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const limit = checkLimit(ip);
    if (limit) return reply({ error: limit }, 429);

    if (+(req.headers.get("Content-Length") || 0) > MAX_BODY) return reply({ error: "사진이 너무 커요. 다른 사진으로 해 주세요." }, 413);
    let body;
    try { body = await req.json(); } catch (e) { return reply({ error: "요청 내용을 읽을 수 없어요." }, 400); }
    const prompt = String(body.prompt || "").slice(0, 4000);
    if (!prompt) return reply({ error: "질문이 비어 있어요." }, 400);

    const parts = [{ text: prompt }];
    const img = body.image;
    if (img && /^image\/(jpeg|png|webp|heic|heif)$/.test(img.type || "") && typeof img.data === "string") {
      parts.push({ inlineData: { mimeType: img.type, data: img.data } });
    }
    const payload = { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts }] };
    if (body.search !== false) payload.tools = [{ google_search: {} }];   // 실시간 웹 검색

    const r = await ask(env.GEMINI_KEY, payload);
    return reply(r.body, r.status);
  },
};

function checkLimit(ip) {
  const now = Date.now(), day = new Date().toISOString().slice(0, 10);
  let u = usage.get(ip);
  if (!u || u.day !== day) { u = { day, count: 0, recent: [] }; usage.set(ip, u); }
  u.recent = u.recent.filter(t => now - t < 60000);
  if (u.count >= PER_DAY) return "오늘 쓸 수 있는 횟수를 다 썼어요. 내일 다시 써 주세요.";
  if (u.recent.length >= PER_MINUTE) return "너무 빨리 여러 번 눌렀어요. 1분 뒤에 다시 해 주세요.";
  u.count++; u.recent.push(now);
  if (usage.size > 5000) usage.clear();   // 메모리를 너무 쓰지 않게
  return "";
}

async function ask(key, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!model) model = await pickModel(key);
    let res;
    try {
      res = await fetch(`${API}/models/${model}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(payload),
      });
    } catch (e) { return { status: 502, body: { error: "AI 서버에 연결하지 못했어요. 잠시 뒤에 다시 해 주세요." } }; }
    if (res.status === 404 && attempt === 0) { model = ""; continue; }   // 모델이 없어졌으면 다시 고른다
    if (!res.ok) {
      const msg = res.status === 429 ? "지금 사용하는 사람이 많아요. 1~2분 뒤에 다시 해 주세요."
        : res.status === 400 || res.status === 403 ? "AI 서버의 API 키를 확인해야 해요. 관리자에게 알려 주세요."
        : "AI 서버가 잠시 바빠요. 잠시 뒤에 다시 해 주세요.";
      return { status: res.status, body: { error: msg } };
    }
    const j = await res.json();
    const c = j.candidates?.[0];
    const text = (c?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (!text) return { status: 422, body: { error: c?.finishReason === "SAFETY" ? "이 질문에는 답할 수 없다고 해요. 다르게 물어봐 주세요." : "AI가 답을 주지 않았어요. 다시 해 주세요." } };
    const seen = new Set(), sources = [];
    for (const g of c?.groundingMetadata?.groundingChunks || []) {
      if (g.web?.uri && !seen.has(g.web.uri)) { seen.add(g.web.uri); sources.push({ uri: g.web.uri, title: g.web.title || g.web.uri }); }
    }
    return { status: 200, body: { text, sources: sources.slice(0, 6), model } };
  }
  return { status: 404, body: { error: "쓸 수 있는 AI 모델을 찾지 못했어요. 관리자에게 알려 주세요." } };
}

/** 지금 쓸 수 있는 Flash 모델 중 가장 새 것을 고른다 (구글이 옛 모델을 없애도 저절로 따라간다) */
async function pickModel(key) {
  try {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    const j = await res.json();
    const names = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""));
    if (names.includes("gemini-flash-latest")) return "gemini-flash-latest";
    const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const flash = names.filter(n => /^gemini-[\d.]+-flash(-\d+)?$/.test(n)).sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    if (flash.length) return flash[0];
  } catch (e) {}
  return "gemini-flash-latest";
}
