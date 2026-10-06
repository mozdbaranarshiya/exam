/** GPT Actions gateway. Ownership and token scopes are checked by the database RPCs. */
type JsonObject = Record<string, unknown>;
type Question = {
  type: "mcq" | "essay";
  prompt: string;
  points: number;
  options?: string[];
  correct?: number;
};
type Grade = { submission_id: string; question_id: string; score: number };

export type HandlerConfig = {
  supabaseUrl?: string;
  publishableKey?: string;
  allowedOrigins?: string[];
};

const MAX_BODY_BYTES = 256 * 1024;
const EXAM_SITE_URL = "https://mozdbaranarshiya.github.io/exam";
const DEFAULT_ORIGINS = ["https://mozdbaranarshiya.github.io"];
const EXAM_ID = /^\d{12}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function textField(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && [...normalized].length <= max ? normalized : null;
}

function validateExam(value: unknown): { title: string; questions: Question[] } | string {
  if (!isObject(value) || !hasOnlyKeys(value, ["title", "questions"])) {
    return "Provide an object with title and questions.";
  }
  const title = textField(value.title, 200);
  if (!title) return "The title must contain 1 to 200 characters.";
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 100) {
    return "Provide between 1 and 100 questions.";
  }
  const questions: Question[] = [];
  let totalCents = 0;
  for (let index = 0; index < value.questions.length; index++) {
    const item = value.questions[index];
    const label = `Question ${index + 1}`;
    if (!isObject(item) || !hasOnlyKeys(item, ["type", "prompt", "points", "options", "correct"])) {
      return `${label} contains unsupported fields.`;
    }
    const prompt = textField(item.prompt, 5000);
    if (!prompt) return `${label} must have a prompt containing 1 to 5000 characters.`;
    if (typeof item.points !== "number" || !Number.isFinite(item.points) || item.points <= 0 || item.points > 100 ||
      Math.abs(item.points * 100 - Math.round(item.points * 100)) > 1e-8) {
      return `${label} must have points greater than 0 and at most 100, with at most two decimal places.`;
    }
    totalCents += Math.round(item.points * 100);
    if (totalCents > 100000) return "The total score must not exceed 1000 points.";
    if (item.type === "mcq") {
      if (!Array.isArray(item.options) || item.options.length !== 4) {
        return `${label} must have exactly four options.`;
      }
      const options = item.options.map((option) => textField(option, 1000));
      if (options.some((option) => option === null)) {
        return `${label} options must contain 1 to 1000 characters each.`;
      }
      if (typeof item.correct !== "number" || !Number.isInteger(item.correct) || item.correct < 0 || item.correct > 3) {
        return `${label} must identify the correct option using an index from 0 to 3.`;
      }
      questions.push({ type: "mcq", prompt, points: item.points, options: options as string[], correct: item.correct });
    } else if (item.type === "essay") {
      if ("options" in item || "correct" in item) return `${label} is an essay question and must omit options and correct.`;
      questions.push({ type: "essay", prompt, points: item.points });
    } else {
      return `${label} type must be mcq or essay.`;
    }
  }
  return { title, questions };
}

function validateGrade(value: unknown): Grade | string {
  if (!isObject(value) || !hasOnlyKeys(value, ["submission_id", "question_id", "score"])) {
    return "Provide an object with submission_id, question_id, and score.";
  }
  if (typeof value.submission_id !== "string" || !UUID.test(value.submission_id) ||
    typeof value.question_id !== "string" || !UUID.test(value.question_id)) {
    return "Provide valid submission and question UUIDs from this exam's results.";
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100 ||
    Math.abs(value.score * 100 - Math.round(value.score * 100)) > 1e-8) {
    return "The score must be between 0 and 100, with at most two decimal places.";
  }
  return { submission_id: value.submission_id.toLowerCase(), question_id: value.question_id.toLowerCase(), score: value.score };
}

async function readBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw new RangeError("payload_too_large");
  }
  if (!request.body) throw new SyntaxError("invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("payload_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function createHandler(config: HandlerConfig, requestFetch: typeof fetch = fetch) {
  const allowedOrigins = new Set(config.allowedOrigins ?? DEFAULT_ORIGINS);

  return async function handler(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Vary": "Origin",
    });
    if (origin && allowedOrigins.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Headers", "authorization, content-type");
      headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    }
    function respond(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), { status, headers });
    }
    function fail(status: number, code: string, message: string): Response {
      return respond({ error: { code, message } }, status);
    }

    if (origin && !allowedOrigins.has(origin)) return fail(403, "forbidden", "This origin is not allowed.");
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const route = path.match(/^\/(?:functions\/v1\/)?exam-api\/exams(?:\/(\d{12})\/(results|grades))?$/);
    if (!route) return fail(404, "not_found", "Endpoint not found.");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const examId = route[1];
    const grading = route[2] === "grades";
    const requiredMethod = grading ? "PATCH" : examId ? "GET" : "POST";
    if (request.method !== requiredMethod) {
      headers.set("Allow", `${requiredMethod}, OPTIONS`);
      return fail(405, "method_not_allowed", `Use ${requiredMethod} for this endpoint.`);
    }
    const bearer = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_.-]{32,256})$/i);
    if (!bearer) return fail(401, "unauthorized", "A valid teacher API token is required.");
    if (!config.supabaseUrl || !config.publishableKey) {
      return fail(503, "unavailable", "The API is not configured. Please contact the administrator.");
    }

    let payload: { title: string; questions: Question[] } | undefined;
    let grade: Grade | undefined;
    if (!examId || grading) {
      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        return fail(415, "unsupported_media_type", "Send an application/json request body.");
      }
      let value: unknown;
      try {
        value = await readBody(request);
      } catch (error) {
        if (error instanceof RangeError) return fail(413, "payload_too_large", "The request body must not exceed 256 KiB.");
        return fail(400, "invalid_input", "The request body must contain valid UTF-8 JSON.");
      }
      if (grading) {
        const validated = validateGrade(value);
        if (typeof validated === "string") return fail(400, "invalid_input", validated);
        grade = validated;
      } else {
        const validated = validateExam(value);
        if (typeof validated === "string") return fail(400, "invalid_input", validated);
        payload = validated;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const rpcName = grading ? "api_grade_answer" : examId ? "api_results" : "api_create_exam";
      const args = grading
        ? { p_token: bearer[1], p_exam_id: Number(examId), p_submission_id: grade!.submission_id,
            p_question_id: grade!.question_id, p_score: grade!.score }
        : examId
        ? { p_token: bearer[1], p_exam_id: Number(examId) }
        : { p_token: bearer[1], p_title: payload!.title, p_questions: payload!.questions };
      const upstream = await requestFetch(`${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        headers: { "apikey": config.publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      const result: unknown = await upstream.json();
      if (!upstream.ok) {
        const code = isObject(result) ? result.code : undefined;
        if (code === "28000") return fail(401, "unauthorized", "The teacher API token is invalid, expired, or revoked.");
        if (code === "42501") return fail(403, "forbidden", grading
          ? "This answer is unavailable for this teacher or token. Older tokens need a new teacher API key with grading permission."
          : "This exam is unavailable for this teacher or token.");
        if (code === "22023") return fail(400, "invalid_input", grading
          ? "Grades must be for essay answers and within their question points, with at most two decimal places."
          : "The database rejected the exam input.");
        if (code === "P0002") return fail(404, "not_found", "The requested answer is unavailable.");
        return fail(502, "upstream_error", "The exam service could not complete the request. Please try again later.");
      }
      if (!isObject(result)) return fail(502, "upstream_error", "The exam service returned an invalid response.");
      if (grading) {
        if (String(result.exam_id) !== examId || result.submission_id !== grade!.submission_id ||
          result.question_id !== grade!.question_id || result.score !== grade!.score ||
          typeof result.total_score !== "number" || !Number.isFinite(result.total_score) ||
          result.total_score < grade!.score || result.total_score > 1000 ||
          (result.status !== "pending" && result.status !== "graded")) {
          return fail(502, "upstream_error", "The exam service returned an invalid response.");
        }
        return respond({ exam_id: result.exam_id, submission_id: result.submission_id,
          question_id: result.question_id, score: result.score, total_score: result.total_score, status: result.status });
      }
      if (examId) {
        if (String(result.id) !== examId || !Array.isArray(result.questions) || !Array.isArray(result.submissions)) {
          return fail(502, "upstream_error", "The exam service returned an invalid response.");
        }
        return respond(result);
      }
      if (!EXAM_ID.test(String(result.id)) || typeof result.title !== "string" ||
        !Number.isInteger(result.question_count) || typeof result.total_points !== "number" || !Number.isFinite(result.total_points)) {
        return fail(502, "upstream_error", "The exam service returned an invalid response.");
      }
      return respond({
        id: result.id,
        title: result.title,
        question_count: result.question_count,
        total_points: result.total_points,
        url: `${EXAM_SITE_URL}/id/${result.id}`,
      }, 201);
    } catch {
      return fail(502, "upstream_error", "The exam service could not complete the request. Please try again later.");
    } finally {
      clearTimeout(timer);
    }
  };
}

// Keeping runtime initialization separate also permits local request-level tests under Node.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};

if (typeof Deno !== "undefined") {
  const extraOrigins = Deno.env.get("EXAM_ALLOWED_ORIGINS")?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
  Deno.serve(createHandler({
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    publishableKey: Deno.env.get("EXAM_PUBLISHABLE_KEY"),
    allowedOrigins: [...DEFAULT_ORIGINS, ...extraOrigins],
  }));
}
