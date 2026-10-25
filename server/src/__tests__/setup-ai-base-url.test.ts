import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_SDK_BASE_URL_ENV_KEYS, dropEmptyAiBaseUrlEnv } from "./setup-ai-base-url.js";

describe("dropEmptyAiBaseUrlEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(AI_SDK_BASE_URL_ENV_KEYS)("removes an empty %s", (key) => {
    vi.stubEnv(key, "");
    dropEmptyAiBaseUrlEnv();
    expect(key in process.env).toBe(false);
  });

  it.each(AI_SDK_BASE_URL_ENV_KEYS)("removes a whitespace-only %s", (key) => {
    vi.stubEnv(key, "  \t\n ");
    dropEmptyAiBaseUrlEnv();
    expect(key in process.env).toBe(false);
  });

  it.each(AI_SDK_BASE_URL_ENV_KEYS)("keeps a non-empty %s unchanged", (key) => {
    vi.stubEnv(key, " https://proxy.example.test/v1 ");
    dropEmptyAiBaseUrlEnv();
    expect(process.env[key]).toBe(" https://proxy.example.test/v1 ");
  });

  it("leaves unset vars unset", () => {
    for (const key of AI_SDK_BASE_URL_ENV_KEYS) vi.stubEnv(key, undefined);
    dropEmptyAiBaseUrlEnv();
    for (const key of AI_SDK_BASE_URL_ENV_KEYS) expect(key in process.env).toBe(false);
  });

  it("does not touch other vars", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    dropEmptyAiBaseUrlEnv();
    expect(process.env.OPENAI_API_KEY).toBe("");
  });

  it("works on a passed env object", () => {
    const env: NodeJS.ProcessEnv = { OPENAI_BASE_URL: "", XAI_BASE_URL: "https://x.test" };
    dropEmptyAiBaseUrlEnv(env);
    expect(env).toEqual({ XAI_BASE_URL: "https://x.test" });
  });
});
