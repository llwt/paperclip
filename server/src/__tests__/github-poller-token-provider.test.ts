import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY,
  createGitHubPollerTokenProvider,
} from "../services/github-external-object-provider.js";

const COMPANY = "company-1";
const OTHER_COMPANY = "company-2";

type AgentRow = { id: string; companyId: string; status: string };

function fakeDb(rows: AgentRow[]) {
  const where = vi.fn(async () => rows);
  return { db: { select: () => ({ from: () => ({ where }) }) } as unknown as Db, where };
}

function buildSecretsFake(byName: Record<string, string>) {
  const getByName = vi.fn(async (_companyId: string, name: string) => (name in byName ? { id: `secret-${name}` } : null));
  const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string) => byName[secretId.replace(/^secret-/, "")] ?? "");
  return { getByName, resolveSecretValue };
}

function managedToken(token: string) {
  return vi.fn(async () => ({
    configured: true,
    identitySource: "dedicated" as const,
    credential: { token, source: "managed_connection" as const, secretName: null },
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGitHubPollerTokenProvider", () => {
  it("uses the poller agent's dedicated managed grant first", async () => {
    const { db } = fakeDb([{ id: "agent-1", companyId: COMPANY, status: "idle" }]);
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "secret-token" });
    const resolveManaged = managedToken("managed-token");
    const provider = createGitHubPollerTokenProvider(db, {
      secrets,
      resolveManaged,
      env: { [EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY]: "agent-1", GITHUB_TOKEN: "env-token" },
    });

    await expect(provider(COMPANY)).resolves.toBe("managed-token");
    expect(resolveManaged).toHaveBeenCalledWith(db, secrets, COMPANY, { agentId: "agent-1", allowStandingDelegation: false });
    expect(secrets.getByName).not.toHaveBeenCalled();
  });

  it("uses a company secret when the managed connection is not configured", async () => {
    const { db } = fakeDb([{ id: "agent-1", companyId: COMPANY, status: "idle" }]);
    const secrets = buildSecretsFake({ GH_TOKEN: " secret-token " });
    const resolveManaged = vi.fn(async () => ({ configured: false }));
    const provider = createGitHubPollerTokenProvider(db, {
      secrets,
      resolveManaged,
      env: { [EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY]: "agent-1", GITHUB_TOKEN: "env-token" },
    });

    await expect(provider(COMPANY)).resolves.toBe("secret-token");
    expect(resolveManaged).toHaveBeenCalledTimes(1);
  });

  it("uses the server environment when there is no connection and no secret", async () => {
    const { db } = fakeDb([]);
    const provider = createGitHubPollerTokenProvider(db, {
      secrets: buildSecretsFake({}),
      resolveManaged: vi.fn(async () => ({ configured: false })),
      env: { GH_TOKEN: "env-token" },
    });

    await expect(provider(COMPANY)).resolves.toBe("env-token");
  });

  it("returns null when no source has a token", async () => {
    const { db } = fakeDb([{ id: "agent-1", companyId: COMPANY, status: "idle" }]);
    const provider = createGitHubPollerTokenProvider(db, {
      secrets: buildSecretsFake({ GITHUB_TOKEN: "   " }),
      resolveManaged: vi.fn(async () => ({ configured: false })),
      env: { [EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY]: "agent-1" },
    });

    await expect(provider(COMPANY)).resolves.toBeNull();
  });

  it("skips the managed step when the agent list env is unset", async () => {
    const { db, where } = fakeDb([{ id: "agent-1", companyId: COMPANY, status: "idle" }]);
    const resolveManaged = managedToken("managed-token");
    const provider = createGitHubPollerTokenProvider(db, {
      secrets: buildSecretsFake({ GITHUB_TOKEN: "secret-token" }),
      resolveManaged,
      env: {},
    });

    await expect(provider(COMPANY)).resolves.toBe("secret-token");
    expect(where).not.toHaveBeenCalled();
    expect(resolveManaged).not.toHaveBeenCalled();
  });

  it("never uses a listed agent of another company or a terminated agent", async () => {
    const { db } = fakeDb([
      { id: "agent-other", companyId: OTHER_COMPANY, status: "idle" },
      { id: "agent-gone", companyId: COMPANY, status: "terminated" },
    ]);
    const resolveManaged = managedToken("managed-token");
    const provider = createGitHubPollerTokenProvider(db, {
      secrets: buildSecretsFake({ GITHUB_TOKEN: "secret-token" }),
      resolveManaged,
      env: { [EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY]: "agent-other, agent-gone" },
    });

    await expect(provider(COMPANY)).resolves.toBe("secret-token");
    expect(resolveManaged).not.toHaveBeenCalled();
  });

  it("picks the listed agent that belongs to the company", async () => {
    const { db } = fakeDb([
      { id: "agent-other", companyId: OTHER_COMPANY, status: "idle" },
      { id: "agent-1", companyId: COMPANY, status: "idle" },
    ]);
    const resolveManaged = managedToken("managed-token");
    const provider = createGitHubPollerTokenProvider(db, {
      secrets: buildSecretsFake({}),
      resolveManaged,
      env: { [EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY]: "agent-other,agent-1" },
    });

    await expect(provider(COMPANY)).resolves.toBe("managed-token");
    expect(resolveManaged).toHaveBeenCalledWith(db, expect.anything(), COMPANY, { agentId: "agent-1", allowStandingDelegation: false });
  });

  it("falls through to the secret when the agent has no dedicated grant (configured with an error)", async () => {
    const { db } = fakeDb([{ id: "agent-1", companyId: COMPANY, status: "idle" }]);
    const info = vi.spyOn(logger, "info");
    const provider = createGitHubPollerTokenProvider(db, {
      secrets: buildSecretsFake({ GITHUB_TOKEN: "secret-token" }),
      resolveManaged: vi.fn(async () => ({
        configured: true,
        identitySource: "dedicated" as const,
        error: "No managed GitHub identity is available for this run",
      })),
      env: { [EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY]: "agent-1" },
    });

    await expect(provider(COMPANY)).resolves.toBe("secret-token");
    await expect(provider(COMPANY)).resolves.toBe("secret-token");
    // One line per reason change, carrying the reason code only.
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({ companyId: COMPANY, reason: "managed_identity_unavailable" });
  });

  it("falls through without throwing when the managed lookup throws", async () => {
    const { db } = fakeDb([{ id: "agent-1", companyId: COMPANY, status: "idle" }]);
    const provider = createGitHubPollerTokenProvider(db, {
      secrets: buildSecretsFake({}),
      resolveManaged: vi.fn(async () => {
        throw new Error("refresh failed");
      }),
      env: { [EXTERNAL_OBJECTS_GITHUB_AGENT_IDS_ENV_KEY]: "agent-1", GITHUB_TOKEN: "env-token" },
    });

    await expect(provider(COMPANY)).resolves.toBe("env-token");
  });
});
