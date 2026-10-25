// Agent runs on a managed AI connection blank these vars to "" on purpose
// (ai-connection-runtime.ts, credential isolation). @ai-sdk/openai
// (openai-provider.ts:414) and @ai-sdk/anthropic (anthropic-provider.ts:258)
// build a default instance at import time and throw "baseURL must be a
// non-empty string" on "", so empty values must be removed before any import.
export const AI_SDK_BASE_URL_ENV_KEYS = [
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "XAI_BASE_URL",
] as const;

export function dropEmptyAiBaseUrlEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of AI_SDK_BASE_URL_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim() === "") {
      delete env[key];
    }
  }
}

dropEmptyAiBaseUrlEnv();
