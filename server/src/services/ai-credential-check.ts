import { isSetupTokenShape } from "@paperclipai/adapter-claude-local/server";
import { supportsAiConnectionRevalidation, type AiConnectionMetadata } from "@paperclipai/shared";

export type AiCredentialCheck =
  | { valid: true; limited: boolean }
  | { valid: false; code: AiCredentialCheckFailure; message: string };
export type AiCredentialCheckFailure =
  | "ai_connection_setup_token_invalid"
  | "ai_connection_credential_rejected"
  | "ai_connection_verification_failed"
  | "ai_connection_check_unsupported";

const REJECTED_MESSAGE = "The provider rejected this credential. Paste a new setup-token or sign in again.";
const UNREACHABLE_MESSAGE = "Could not check this account with the provider. Try again.";

/** A pasted token must pass the same shape check as a token parsed from `claude setup-token`. */
export function checkSetupTokenShape(token: string): AiCredentialCheck | null {
  return isSetupTokenShape(token) ? null : {
    valid: false, code: "ai_connection_setup_token_invalid",
    message: "This is not a Claude setup-token. Run claude setup-token and paste the token that starts with sk-ant-oat01-.",
  };
}

async function readErrorType(response: Response): Promise<{ type?: string; message?: string }> {
  // Bounded read of the provider error. It is classified here and never returned.
  try {
    const text = (await response.text()).slice(0, 16 * 1024);
    const error = JSON.parse(text)?.error;
    return { type: typeof error?.type === "string" ? error.type : undefined, message: typeof error?.message === "string" ? error.message : undefined };
  } catch {
    return {};
  }
}

/**
 * Checks a credential with one read-only provider request. No run starts and no
 * model tokens are spent.
 *
 * - Claude subscription (setup-token): `GET /api/oauth/usage`. Setup-tokens carry
 *   only `user:inference`, so Anthropic authenticates the token and then answers
 *   403 `permission_error` for the missing `user:profile` scope
 *   (doc/connections/AI-CONNECTIONS.md). That answer, 200 and 429 mean signed in.
 * - Claude API key: `GET /v1/models`. 200 and 429 mean valid.
 * - 401, and any other 403, mean rejected. Network errors and other statuses fail
 *   the check without calling the credential bad.
 */
export async function checkAiCredential(
  metadata: AiConnectionMetadata,
  value: string,
  request: typeof fetch = fetch,
): Promise<AiCredentialCheck> {
  if (!supportsAiConnectionRevalidation(metadata.provider, metadata.method))
    return { valid: false, code: "ai_connection_check_unsupported", message: "Check again is not available for this provider. Reconnect the account instead." };
  if (!value.trim()) return { valid: false, code: "ai_connection_credential_rejected", message: REJECTED_MESSAGE };
  const subscription = metadata.method === "subscription";
  let response: Response;
  try {
    response = await request(
      subscription ? "https://api.anthropic.com/api/oauth/usage" : "https://api.anthropic.com/v1/models?limit=1",
      {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: subscription
          ? { Authorization: `Bearer ${value.trim()}`, "anthropic-beta": "oauth-2025-04-20" }
          : { "x-api-key": value.trim(), "anthropic-version": "2023-06-01" },
      },
    );
  } catch {
    return { valid: false, code: "ai_connection_verification_failed", message: UNREACHABLE_MESSAGE };
  }
  if (response.ok || response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    return { valid: true, limited: response.status === 429 };
  }
  if (response.status === 403 && subscription) {
    const error = await readErrorType(response);
    if (error.type === "permission_error" && /scope/i.test(error.message ?? ""))
      return { valid: true, limited: false };
    return { valid: false, code: "ai_connection_credential_rejected", message: REJECTED_MESSAGE };
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403)
    return { valid: false, code: "ai_connection_credential_rejected", message: REJECTED_MESSAGE };
  return { valid: false, code: "ai_connection_verification_failed", message: UNREACHABLE_MESSAGE };
}
