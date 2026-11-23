import { describe, expect, it } from "vitest";
// The production endpoint intentionally stays dependency-free JavaScript so it
// can run on Node-compatible serverless hosts without a build step.
// @ts-expect-error JavaScript module has no declaration file.
import { createSessionConfig, decodeGoal, handleSessionRequest } from "../web/server/session-core.mjs";

describe("web session service", () => {
  it("sanitizes and bounds goals", () => {
    expect(decodeGoal("Open%20a%20file%00now")).toBe("Open a file now");
    expect(decodeGoal("x".repeat(600))).toHaveLength(500);
  });

  it("includes the required output rate and validated guidance tool", () => {
    const config = createSessionConfig("Open a point cloud");
    expect(config.model).toBe("gpt-realtime-2.1");
    expect(config.audio.output.format.rate).toBe(24_000);
    expect(config.tools[0].name).toBe("display_guidance");
    expect(config.tool_choice).toBe("required");
  });

  it("rejects public session requests without their access code", async () => {
    const result = await handleSessionRequest({
      method: "POST",
      origin: "https://example.github.io",
      allowedOrigins: "https://example.github.io",
      contentType: "application/sdp",
      goalHeader: "Open%20a%20file",
      body: "v=0\r\n",
      clientId: "auth-test",
      apiKey: "server-only-key",
      accessToken: "private-code",
      authorization: "Bearer wrong",
    });
    expect(result.status).toBe(401);
  });

  it("forwards only SDP and fixed server configuration to OpenAI", async () => {
    let forwardedSession = "";
    const result = await handleSessionRequest({
      method: "POST",
      origin: "http://127.0.0.1:5174",
      contentType: "application/sdp",
      goalHeader: "Inspect%20CloudCompare",
      body: "v=0\r\no=test\r\n",
      clientId: "success-test",
      apiKey: "server-only-key",
      fetchImpl: async (_url: string, init: RequestInit) => {
        const form = init.body as FormData;
        forwardedSession = String(form.get("session"));
        return new Response("v=0\r\no=answer\r\n", {
          status: 200,
          headers: { "Content-Type": "application/sdp" },
        });
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toContain("o=answer");
    expect(JSON.parse(forwardedSession).instructions).toContain("Inspect CloudCompare");
    expect(forwardedSession).not.toContain("server-only-key");
  });
});
