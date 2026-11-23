import { handleSessionRequest } from "../web/server/session-core.mjs";

function readBody(request) {
  if (typeof request.body === "string") return Promise.resolve(request.body);
  if (Buffer.isBuffer(request.body)) return Promise.resolve(request.body.toString("utf8"));
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export default async function session(request, response) {
  const body = request.method === "POST" ? await readBody(request) : "";
  const result = await handleSessionRequest({
    method: request.method,
    origin: request.headers.origin,
    contentType: request.headers["content-type"],
    authorization: request.headers.authorization,
    goalHeader: request.headers["x-screenguide-goal"],
    body,
    clientId: request.headers["x-forwarded-for"]?.split(",")[0] || request.socket?.remoteAddress,
    apiKey: process.env.OPENAI_API_KEY,
    accessToken: process.env.SCREENGUIDE_ACCESS_TOKEN,
    allowedOrigins: process.env.ALLOWED_ORIGINS,
  });
  for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
  response.status(result.status).send(result.body);
}
