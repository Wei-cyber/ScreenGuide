const DEFAULT_ORIGINS = new Set([
  "http://127.0.0.1:5174",
  "http://localhost:5174",
]);

const WINDOW_MS = 60_000;
const MAX_SESSIONS_PER_WINDOW = 10;
const rateWindows = new Map();

export function decodeGoal(value) {
  if (typeof value !== "string") return "";
  try {
    return decodeURIComponent(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  } catch {
    return "";
  }
}

export function isAllowedOrigin(origin, configuredOrigins = "") {
  if (!origin) return true;
  const configured = new Set(
    configuredOrigins.split(",").map((value) => value.trim()).filter(Boolean),
  );
  return (configured.size ? configured : DEFAULT_ORIGINS).has(origin);
}

export function consumeSessionLimit(identifier, now = Date.now()) {
  const key = identifier || "unknown";
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_SESSIONS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

export function createSessionConfig(goal) {
  return {
    type: "realtime",
    model: "gpt-realtime-2.1",
    output_modalities: ["audio"],
    instructions: `You are ScreenGuide, a calm screen coach. The user's goal is: ${goal}

Teach exactly one small, user-performed step at a time. Never click, type, control the computer, or claim you performed an action. Call display_guidance exactly once for each response and reuse the same stepId until the required user action genuinely changes. Use delivery "silent" for irrelevant or minor frame changes and repeated observations. Use "visual" only for a useful on-screen update that needs no speech. Use "spoken" for a new step, a direct user question, a blocker, uncertainty, or completion. Wait for visible progress before advancing. If the user asks which visible option to choose, inspect the newest overview and detail crop and answer directly. Ask rather than guess when text is unreadable. Never request secrets. Target coordinates are normalized to the complete overview image; omit them unless the target is clearly visible. Keep instructions short and practical.`,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        turn_detection: {
          type: "semantic_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: 24_000 },
        voice: "marin",
      },
    },
    tools: [
      {
        type: "function",
        name: "display_guidance",
        description: "Show the next validated coaching step in the ScreenGuide interface.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            stepId: { type: "string" },
            instruction: { type: "string" },
            explanation: { type: "string" },
            target: {
              type: "object",
              additionalProperties: false,
              properties: {
                x: { type: "number", minimum: 0, maximum: 1 },
                y: { type: "number", minimum: 0, maximum: 1 },
                width: { type: "number", exclusiveMinimum: 0, maximum: 1 },
                height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
              },
              required: ["x", "y", "width", "height"],
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            status: { type: "string", enum: ["waiting", "completed", "blocked"] },
            delivery: { type: "string", enum: ["silent", "visual", "spoken"] },
          },
          required: [
            "stepId",
            "instruction",
            "explanation",
            "confidence",
            "status",
            "delivery"
          ],
        },
      },
    ],
    tool_choice: "required",
  };
}

function corsHeaders(origin) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-ScreenGuide-Goal";
    headers.Vary = "Origin";
  }
  return headers;
}

export async function handleSessionRequest(input) {
  const headers = corsHeaders(input.origin);
  if (!isAllowedOrigin(input.origin, input.allowedOrigins)) {
    return { status: 403, headers, body: "Origin is not allowed." };
  }
  if (input.method === "OPTIONS") return { status: 204, headers, body: "" };
  if (input.method !== "POST") return { status: 405, headers, body: "Method not allowed." };
  if (!input.apiKey) return { status: 503, headers, body: "The session service is not configured." };
  if (!input.contentType?.toLowerCase().startsWith("application/sdp")) {
    return { status: 415, headers, body: "Expected application/sdp." };
  }
  if (!consumeSessionLimit(input.clientId)) {
    return { status: 429, headers: { ...headers, "Retry-After": "60" }, body: "Too many session attempts. Try again shortly." };
  }
  if (input.accessToken && input.authorization !== `Bearer ${input.accessToken}`) {
    return { status: 401, headers, body: "Invalid access code." };
  }

  const goal = decodeGoal(input.goalHeader);
  const sdp = typeof input.body === "string" ? input.body : "";
  if (goal.length < 3) return { status: 400, headers, body: "A goal is required." };
  if (!sdp.startsWith("v=0") || sdp.length > 128_000) {
    return { status: 400, headers, body: "Invalid session description." };
  }

  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(createSessionConfig(goal)));

  try {
    const response = await (input.fetchImpl ?? fetch)("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        status: response.status,
        headers,
        body: response.status === 401
          ? "The server's OpenAI credential was rejected."
          : `OpenAI could not create a realtime session (${response.status}).`,
      };
    }
    return {
      status: 200,
      headers: { ...headers, "Content-Type": "application/sdp" },
      body,
    };
  } catch {
    return { status: 502, headers, body: "Could not reach OpenAI. Try again." };
  }
}
