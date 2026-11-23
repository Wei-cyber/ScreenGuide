import { createServer } from "node:http";
import { handleSessionRequest } from "./session-core.mjs";

const port = Number.parseInt(process.env.SCREENGUIDE_SESSION_PORT || "8787", 10);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 128_000) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    const body = request.method === "POST" ? await readBody(request) : "";
    const result = await handleSessionRequest({
      method: request.method,
      origin: request.headers.origin,
      contentType: request.headers["content-type"],
      authorization: request.headers.authorization,
      goalHeader: request.headers["x-screenguide-goal"],
      body,
      clientId: request.socket.remoteAddress,
      apiKey: process.env.OPENAI_API_KEY,
      accessToken: process.env.SCREENGUIDE_ACCESS_TOKEN,
      allowedOrigins: process.env.ALLOWED_ORIGINS,
    });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  } catch {
    response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain" });
    response.end("Invalid request.");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ScreenGuide session service listening on http://127.0.0.1:${port}`);
  if (!process.env.OPENAI_API_KEY) console.log("Add OPENAI_API_KEY to .env before starting a coaching session.");
});
