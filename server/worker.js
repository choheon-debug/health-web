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

let model = "";            // 지난번에 잘 된 AI 모델
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
    if (req.method === "GET") return reply({ ok: true, key: env.GEMINI_KEY ? "있음" : "없음 (GEMINI_KEY를 넣어 주세요)", model: model || "첫 질문 때 자동으로 골라요",
      last: last.at ? `${(last.ms / 1000).toFixed(1)}초 걸림 · ${last.model} · 웹 검색 ${last.search ? "함" : "안 함"}` : "아직 없음",
      search: Date.now() > searchOffUntil ? "켜짐" : "잠시 꺼짐 (구글 무료 사용량 초과)" });
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

    const parts = /** @type {any[]} */ ([{ text: prompt }]);   // 글자 + (있으면) 사진
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

// 빠르게 답하도록: 구글이 검색을 거절한 적이 있으면 한동안 검색 없이 묻고,
// 모델이 "생각"하는 시간을 줄인다 (모델마다 받는 설정이 달라서, 안 받으면 기억해 두고 빼고 보낸다)
let searchOffUntil = 0;
const noThink = new Set();
const thinkCfg = m => noThink.has(m) ? null : /2\.5/.test(m) ? { thinkingBudget: 0 } : { thinkingLevel: "low" };
const last = { ms: 0, model: "", search: false, at: "" };   // 마지막 질문이 얼마나 걸렸는지 (확인용)

async function ask(key, payload) {
  // 구글이 "사용량 초과(429)"라고 하면 검색 없이 다시 묻고, 그래도 안 되면 다른 모델로 바꿔서 묻는다
  const t0 = Date.now();
  const models = await pickModels(key);
  const search = payload.tools && Date.now() > searchOffUntil;
  const tries = [];
  for (const m of models.slice(0, 3)) {
    if (search) tries.push([m, true]);
    tries.push([m, false]);
  }
  let fail = null;
  for (let k = 0; k < tries.length && k < 6; k++) {
    const [m, useSearch] = tries[k];
    const cfg = thinkCfg(m);
    const p = { ...payload, tools: useSearch ? payload.tools : undefined, generationConfig: cfg ? { thinkingConfig: cfg } : undefined };
    let res;
    try {
      res = await fetch(`${API}/models/${m}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(p),
      });
    } catch (e) { return { status: 502, body: { error: "AI 서버에 연결하지 못했어요. 잠시 뒤에 다시 해 주세요." } }; }
    if (res.status === 400 && cfg) {
      const detail = await googleMessage(res);
      if (/think/i.test(detail)) { noThink.add(m); tries.splice(k + 1, 0, tries[k]); continue; }   // 생각 설정을 빼고 다시
      return { status: 400, body: { error: "AI 서버의 API 키를 확인해야 해요. 관리자에게 알려 주세요.", detail } };
    }
    if (res.status === 429 || res.status === 404 || res.status === 503) {
      if (res.status === 429 && useSearch) searchOffUntil = Date.now() + 30 * 60000;   // 30분 동안은 검색 없이
      fail = { status: res.status, detail: await googleMessage(res), model: m };
      continue;
    }
    if (!res.ok) {
      const detail = await googleMessage(res);
      const msg = res.status === 400 || res.status === 403 ? "AI 서버의 API 키를 확인해야 해요. 관리자에게 알려 주세요."
        : "AI 서버가 잠시 바빠요. 잠시 뒤에 다시 해 주세요.";
      return { status: res.status, body: { error: msg, detail } };
    }
    model = m;   // 잘 된 모델을 기억해 두고 다음에 먼저 쓴다
    const j = await res.json();
    const c = j.candidates?.[0];
    const text = (c?.content?.parts || []).filter(x => !x.thought).map(x => x.text || "").join("").trim();
    Object.assign(last, { ms: Date.now() - t0, model: m, search: useSearch, at: new Date().toISOString() });
    if (!text) return { status: 422, body: { error: c?.finishReason === "SAFETY" ? "이 질문에는 답할 수 없다고 해요. 다르게 물어봐 주세요." : "AI가 답을 주지 않았어요. 다시 해 주세요." } };
    const seen = new Set(), sources = [];
    for (const g of c?.groundingMetadata?.groundingChunks || []) {
      if (g.web?.uri && !seen.has(g.web.uri)) { seen.add(g.web.uri); sources.push({ uri: g.web.uri, title: g.web.title || g.web.uri }); }
    }
    return { status: 200, body: { text, sources: sources.slice(0, 6), model: m, search: useSearch, ms: last.ms } };
  }
  const msg = fail?.status === 429 ? "오늘 무료 사용량을 다 썼거나 사용하는 사람이 많아요. 잠시 뒤에 다시 해 주세요."
    : "쓸 수 있는 AI 모델을 찾지 못했어요. 관리자에게 알려 주세요.";
  return { status: fail?.status || 404, body: { error: msg, detail: fail?.detail, model: fail?.model } };
}

/** 구글이 보낸 오류 설명 (원인 확인용) */
async function googleMessage(res) {
  try { const j = await res.json(); return String(j.error?.message || "").slice(0, 300); } catch (e) { return ""; }
}

/** 쓸 수 있는 Flash 모델을 좋은 순서대로 고른다 (구글이 옛 모델을 없애도 저절로 따라간다) */
let modelList = null;
async function pickModels(key) {
  if (!modelList) {
    let names = [];
    try {
      const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
      const j = await res.json();
      names = (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ""));
    } catch (e) {}
    const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const byVer = re => names.filter(n => re.test(n)).sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    const list = [];
    if (names.includes("gemini-flash-latest")) list.push("gemini-flash-latest");
    list.push(...byVer(/^gemini-[\d.]+-flash(-\d+)?$/));
    if (names.includes("gemini-flash-lite-latest")) list.push("gemini-flash-lite-latest");
    list.push(...byVer(/^gemini-[\d.]+-flash-lite(-\d+)?$/));
    modelList = list.length ? [...new Set(list)] : ["gemini-flash-latest"];
  }
  // 지난번에 잘 된 모델을 맨 앞에, 그 다음은 서로 다른 모델이 섞이게
  const rest = modelList.filter(m => m !== model);
  const lite = rest.filter(m => m.includes("lite")), full = rest.filter(m => !m.includes("lite"));
  return [...(model ? [model] : []), full[0], lite[0], ...full.slice(1), ...lite.slice(1)].filter(Boolean);
}
