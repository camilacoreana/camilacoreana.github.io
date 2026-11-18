// 복숭아숲 글쓰기 공방 — 서버 기능 (writer-api)
// 필요한 비밀값(Edge Function Secrets):
//   ANTHROPIC_API_KEY : Claude API 키 (필수, AI 기능)
//   TEACHER_PIN       : 선생님 화면 비밀번호 (필수, 6자 이상 권장)
//   DAILY_AI_LIMIT    : 하루 AI 사용 횟수 한도 (선택, 기본 800)
//   AI_MODEL          : 사용할 모델 (선택, 기본 claude-sonnet-5-5)
//   ALLOWED_ORIGINS   : 쉼표로 구분한 허용 주소 (선택, 기본 https://camilacoreana.github.io)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "https://camilacoreana.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MODEL = Deno.env.get("AI_MODEL") || "claude-sonnet-5-5";
const DAILY_LIMIT = parseInt(Deno.env.get("DAILY_AI_LIMIT") || "800", 10);

const GENRES: Record<string, { label: string; desc: string; book: boolean; crit: [string, string, string][] }> = {
  review: { label: "서평", desc: "책을 소개하고 평가하며 추천하는 글", book: true,
    crit: [["intro", "책 소개", "어떤 책인지, 줄거리나 내용을 짧게 소개했나"], ["impressive", "인상 깊은 부분", "인상 깊은 장면·문장과 그 까닭을 썼나"], ["thoughts", "나의 생각·느낌", "자기 생각이나 느낌, 자기 경험과의 연결이 있나"], ["recommend", "평가와 추천", "책에 대한 평가, 누구에게 왜 추천하는지 썼나"]] },
  reading: { label: "독서감상문", desc: "책을 읽고 느낀 점을 쓰는 글", book: true,
    crit: [["motive", "읽게 된 까닭", "책을 읽게 된 까닭이나 처음 느낌을 썼나"], ["content", "책의 내용", "줄거리나 중요한 내용을 간추려 썼나"], ["feeling", "인상 깊은 장면과 느낌", "인상 깊은 장면과 그때의 생각·느낌을 함께 썼나"], ["lesson", "깨달은 점", "책을 읽고 깨달은 점, 나에게 생긴 변화나 다짐을 썼나"]] },
  life: { label: "생활문", desc: "내가 겪은 일과 그때의 마음을 쓰는 글", book: false,
    crit: [["event", "겪은 일", "언제, 어디서, 누구와 무슨 일이 있었는지 알 수 있나"], ["detail", "생생한 장면", "보고, 듣고, 말하고, 한 일을 자세히 썼나"], ["feeling", "그때의 마음", "그때의 마음이나 생각이 드러나나"], ["meaning", "깨달은 점", "그 일로 깨달은 점이나 지금의 생각을 썼나"]] },
  opinion: { label: "주장하는 글", desc: "내 의견을 까닭과 함께 밝히는 글", book: false,
    crit: [["issue", "문제 상황", "어떤 문제에 대한 글인지 처음에 밝혔나"], ["claim", "나의 주장", "내 주장이 분명하게 드러나나"], ["reason", "근거", "주장을 뒷받침하는 까닭이 두 가지 이상 있고, 알맞은가"], ["conclusion", "마무리", "끝에서 주장을 다시 강조하거나 실천을 권했나"]] },
  explain: { label: "설명하는 글", desc: "어떤 대상을 알기 쉽게 알려 주는 글", book: false,
    crit: [["subject", "대상 소개", "무엇을 설명하는지 처음에 소개했나"], ["info", "정확한 내용", "내용이 정확하고 읽는 사람이 궁금할 점을 담았나"], ["structure", "짜임", "처음-가운데-끝으로 나누어 차례대로 설명했나"], ["example", "예시·비교", "예를 들거나 비교해서 이해하기 쉽게 했나"]] },
  letter: { label: "편지", desc: "마음을 전하고 싶은 사람에게 쓰는 글", book: false,
    crit: [["greeting", "받는 사람과 첫인사", "받는 사람을 부르고 첫인사를 했나"], ["purpose", "쓰는 까닭", "왜 편지를 쓰는지 알 수 있나"], ["body", "전하고 싶은 이야기", "전하고 싶은 마음과 이야기를 자세히 썼나"], ["closing", "끝인사", "끝인사, 날짜, 쓴 사람을 썼나"]] },
  free: { label: "자유 글", desc: "정해진 틀 없이 자유롭게 쓰는 글", book: false,
    crit: [["content", "내용", "하고 싶은 말이 분명하고 내용이 알찬가"], ["structure", "짜임", "처음-가운데-끝이 자연스럽게 이어지나"], ["expression", "표현", "생생한 표현이나 꾸며 주는 말을 썼나"], ["voice", "나만의 생각", "나만의 생각이나 느낌이 드러나나"]] },
};
const gOf = (k: unknown) => GENRES[String(k || "review")] || GENRES.review;

class HttpErr extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }
const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const int = (v: unknown) => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : 0; };

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  const allow = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/* ---------------- AI ---------------- */
async function claude(content: unknown[], maxTokens = 4096): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new HttpErr(503, "no_ai", "AI 키가 아직 설정되지 않았어요.");
  const { data: ok, error } = await sb.rpc("bump_writing_ai_usage", { p_limit: DAILY_LIMIT });
  if (error) throw new HttpErr(500, "server", "사용량 확인 실패");
  if (!ok) throw new HttpErr(429, "daily_limit", "오늘 AI 사용 횟수를 다 썼어요.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (r.status === 429 || r.status === 529) throw new HttpErr(429, "rate_limited", "AI가 바빠요.");
  if (!r.ok) { console.error("anthropic", r.status, await r.text()); throw new HttpErr(502, "ai_failed", "AI 응답 실패"); }
  const j = await r.json();
  return (j.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
}
function parseJSON(t: string) {
  let s = String(t || "").trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) s = m[1];
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < 0) throw new HttpErr(502, "ai_failed", "AI 응답 형식 오류");
  return JSON.parse(s.slice(a, b + 1));
}

async function doOcr(p: Record<string, unknown>) {
  const imgs = Array.isArray(p.images) ? p.images.slice(0, 4) : [];
  if (!imgs.length) throw new HttpErr(400, "bad", "사진이 없어요.");
  const g = gOf(p.genre); const about = str(p.about, 200);
  const blocks: unknown[] = imgs.map((d) => {
    const s = String(d);
    if (s.length > 2_500_000) throw new HttpErr(413, "too_big", "사진이 너무 커요.");
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: s } };
  });
  blocks.push({ type: "text", text: `너는 초등학생이 종이에 손으로 쓴 ${g.label} 원고를 글자로 옮겨 적는 도우미야.
첨부한 사진 ${imgs.length}장(여러 장이면 1쪽부터 순서대로 이어지는 글)의 손글씨를 옮겨 적어.
글 종류: ${g.label}${about ? "\n참고: " + about : ""}

규칙:
1. 학생이 쓴 그대로 옮겨. 맞춤법, 띄어쓰기, 문장부호가 틀려도 절대 고치지 마. 낱말을 더하거나 빼지도 마.
2. 원고지나 줄 공책의 줄바꿈은 무시하고 이어서 적어. 학생이 문단을 바꾼 곳(들여쓰기, 줄을 비움)만 빈 줄(\\n\\n)로 나눠.
3. 줄을 그어 지운 글자는 빼고, 끼워 넣은 글자(∨ 표시 등)는 그 자리에 넣어.
4. 글씨가 흐리거나 모양이 애매해서 확실하지 않은 낱말은 네가 가장 그럴듯하게 읽은 글자로 적고 [[ ]]로 감싸. 예: 나는 [[주인공]]이 부러웠다. 확실하지 않으면 망설이지 말고 표시해.
5. 학년·반·이름 같은 머리글은 빼고 본문만 적어. (편지의 받는 사람, 끝인사, 날짜, 쓴 사람은 본문이니 그대로 적어.)

JSON 하나만 출력해: {"readable": true 또는 false, "text": "옮긴 글", "note": "사진에 대한 짧은 안내(문제가 없으면 빈 문자열)"}
글을 읽을 수 없는 사진(너무 흐림, 글이 없음 등)이면 readable을 false로, note에 초등학생이 이해할 말로 이유를 적어.` });
  const r = parseJSON(await claude(blocks, 6000));
  return { readable: !!r.readable, text: str(r.text, 20000), note: str(r.note, 300) };
}

async function doSpell(p: Record<string, unknown>) {
  const g = gOf(p.genre); const text = str(p.text, 12000);
  if (!text.trim()) throw new HttpErr(400, "bad", "글이 없어요.");
  const r = parseJSON(await claude([{ type: "text", text: `너는 초등학교 4~6학년 학생이 쓴 ${g.label}에서 맞춤법을 고쳐 주는 국어 선생님이야.
아래 <글>에서 맞춤법, 띄어쓰기, 문장부호(마침표 빠짐 등)만 고쳐. 표준 한국어 맞춤법 기준으로.
낱말 고르기, 문장 순서, 내용, 표현, 말투는 절대 바꾸지 마. 문장을 새로 만들거나 다듬지 마. 줄바꿈은 그대로 둬.

출력은 JSON 하나만: {"segments":[ ... ]}
segments는 원문을 앞에서부터 순서대로 나눈 조각의 배열이야. 조각은 두 종류:
- 고치지 않은 부분: {"t":"원문 그대로"}
- 고친 부분: {"b":"원래 쓴 글자","a":"고친 글자","why":"초등학생이 이해할 수 있는 짧은 이유"}
중요한 규칙:
1. 모든 조각의 t와 b를 순서대로 이으면 원문과 글자 하나, 띄어쓰기 하나, 줄바꿈 하나까지 똑같아야 해.
2. 고친 부분은 낱말 하나나 어절 두어 개 정도로 짧게. 띄어쓰기를 고칠 때는 앞뒤 낱말을 함께 넣어서 b와 a가 공백만으로 되지 않게 해. 예: {"b":"먹었다그리고","a":"먹었다. 그리고","why":"문장이 끝나면 마침표를 찍고 띄어 써요."}
3. why는 한 문장, 다정한 말투로. 예: "'안'과 '않'은 달라요. '아니하'로 바꿀 수 있으면 '않'이에요."
4. 틀린 곳이 없으면 {"segments":[{"t":"원문 전체"}]}.

<글>
${text}
</글>` }], 8000));
  return { segments: Array.isArray(r.segments) ? r.segments : [] };
}

async function doCoach(p: Record<string, unknown>) {
  const g = gOf(p.genre); const grade = int(p.grade) || 5;
  const text = str(p.text, 12000); const about = str(p.about, 200);
  const round = Math.max(1, Math.min(10, int(p.round) || 1));
  const prevQ = (Array.isArray(p.prevQuestions) ? p.prevQuestions : []).slice(0, 3).map((q) => "- " + str(q, 300));
  const prevText = str(p.prevText, 12000);
  const prev = prevText ? `\n<지난번에 준 질문>\n${prevQ.join("\n")}\n</지난번에 준 질문>\n<지난번 글>\n${prevText}\n</지난번 글>\n` : "";
  const r = parseJSON(await claude([{ type: "text", text: `너는 초등학교 도서관에서 ${grade}학년 학생의 글쓰기를 돕는 다정한 선생님이야. 학생이 쓴 글은 '${g.label}'(${g.desc})이야.
가장 중요한 규칙: 학생의 글을 대신 써 주지 마. 고친 문장, 예시 문장, 바꿀 낱말을 절대 제시하지 마. 학생이 스스로 생각하고 고칠 수 있도록 질문만 해.

${about ? (g.book ? "읽은 책: " : "글감: ") + about : ""}
이번이 ${round}번째로 보여 주는 거야.
${prev}
<지금 글>
${text}
</지금 글>

${g.label}의 네 가지 요소로 살펴봐:
${g.crit.map((c) => "- " + c[0] + "(" + c[1] + "): " + c[2]).join("\n")}
그리고 flow(글의 흐름): 문단 나눔, 같은 말 되풀이, 앞뒤 연결.

JSON 하나만 출력해:
{"praise":"이 글에서 구체적으로 잘한 점 1~2문장(지난번보다 나아진 점이 있으면 꼭 알아봐 줘)",
 "checks":{${g.crit.map((c) => '"' + c[0] + '":0').join(",")}},
 "questions":[{"area":"${g.crit.map((c) => c[0]).join("|")}|flow","q":"학생이 생각해 볼 질문 한 문장","hint":"생각의 실마리가 되는 짧은 힌트(답이나 예시 문장은 주지 말 것)"}],
 "done": false}
checks 값: 0=없음, 1=조금 있음, 2=충분함.
questions는 가장 부족한 요소부터 최대 3개. 맞춤법 지적은 하지 마. 네 요소가 모두 2라면 questions는 0~1개로 하고 done을 true로.
${grade}학년이 바로 이해할 쉬운 말로, 다정한 반말(예: "~는 어땠어?", "~를 써 보면 어떨까?")로 써.` }], 2000));
  return r;
}

/* ---------------- 저장 ---------------- */
type Who = { grade: number; cls: number; num: number; name: string };
function who(p: Record<string, unknown>): Who {
  const w = { grade: int(p.grade), cls: int(p.cls), num: int(p.num), name: str(p.name, 20).trim() };
  if (!w.grade || !w.cls || !w.num || !w.name) throw new HttpErr(400, "bad", "학생 정보가 없어요.");
  return w;
}
const sameWho = (row: Who, w: Who) => row.grade === w.grade && row.cls === w.cls && row.num === w.num && row.name === w.name;

async function doSave(p: Record<string, unknown>) {
  const id = str(p.id, 40);
  if (!/^[a-z0-9]{6,40}$/.test(id)) throw new HttpErr(400, "bad", "잘못된 글 번호");
  const doc = (p.doc && typeof p.doc === "object") ? p.doc as Record<string, unknown> : null;
  if (!doc) throw new HttpErr(400, "bad", "글이 없어요.");
  const w = who(doc);
  const body = JSON.stringify(doc);
  if (body.length > 200_000) throw new HttpErr(413, "too_big", "글이 너무 길어요.");
  const { data: ex } = await sb.from("writings").select("grade,cls,num,name").eq("id", id).maybeSingle();
  if (ex && !sameWho(ex as Who, w)) throw new HttpErr(403, "not_yours", "다른 친구의 글이에요.");
  const { error } = await sb.from("writings").upsert({
    id, ...w, genre: str(doc.genre, 20), status: str(doc.status, 20), data: doc, updated_at: new Date().toISOString(),
  });
  if (error) { console.error(error); throw new HttpErr(500, "server", "저장 실패"); }
  return { ok: true };
}
async function doFind(p: Record<string, unknown>) {
  const w = who(p);
  const { data, error } = await sb.from("writings").select("id,data,updated_at")
    .eq("grade", w.grade).eq("cls", w.cls).eq("num", w.num).eq("name", w.name)
    .order("updated_at", { ascending: false }).limit(8);
  if (error) throw new HttpErr(500, "server", "불러오기 실패");
  return { items: (data || []).map((r) => ({ id: r.id, data: r.data })) };
}

/* ---------------- 선생님 ---------------- */
async function checkPin(p: Record<string, unknown>) {
  const pin = Deno.env.get("TEACHER_PIN");
  if (!pin) throw new HttpErr(503, "no_pin", "선생님 비밀번호가 아직 설정되지 않았어요.");
  const given = str(p.pin, 100);
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(pin);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (diff !== 0) { await new Promise((r) => setTimeout(r, 1200)); throw new HttpErr(401, "bad_pin", "비밀번호가 달라요."); }
}
async function doTList(p: Record<string, unknown>) {
  await checkPin(p);
  const { data, error } = await sb.from("writings").select("id,data,updated_at").order("updated_at", { ascending: false }).limit(1000);
  if (error) throw new HttpErr(500, "server", "불러오기 실패");
  return { items: (data || []).map((r) => ({ id: r.id, ...(r.data as Record<string, unknown>) })) };
}
async function doTDelete(p: Record<string, unknown>) {
  await checkPin(p);
  const id = str(p.id, 40);
  const { error } = await sb.from("writings").delete().eq("id", id);
  if (error) throw new HttpErr(500, "server", "삭제 실패");
  return { ok: true };
}

const ACTIONS: Record<string, (p: Record<string, unknown>) => Promise<unknown>> = {
  ocr: doOcr, spell: doSpell, coach: doCoach, save: doSave, find: doFind,
  t_check: async (p) => { await checkPin(p); return { ok: true }; }, t_list: doTList, t_delete: doTDelete,
};

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ code: "bad", message: "POST only" }, 405);
  try {
    const p = await req.json();
    const fn = ACTIONS[String(p?.action)];
    if (!fn) throw new HttpErr(400, "bad", "알 수 없는 요청");
    return json(await fn(p));
  } catch (e) {
    if (e instanceof HttpErr) return json({ code: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ code: "server", message: "서버 오류" }, 500);
  }
});
