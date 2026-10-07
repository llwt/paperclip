import { is, SQL, sql } from "drizzle-orm";
import { toolConnections, type Db } from "@paperclipai/db";

/**
 * Fork-only (llwt/paperclip, NX-617): keeps the per-connection OAuth sign-in
 * settings (`config.oauth.loopbackRedirect`, `config.oauth.requestedScopes`)
 * from being undone by a write that built its config from an older read.
 *
 * Upstream code updates a connection by reading the row, awaiting something
 * (discovery, a token exchange, a catalog request), and writing the whole
 * `config` back. There are dozens of such writes and upstream adds more, so the
 * rule is applied where they all pass, not at each one: the database handle the
 * service uses is wrapped, and any update of `tool_connections` that sets
 * `config` or `transportConfig` to a plain object takes the two settings from
 * the row as it is at the moment of the update, in the same statement.
 *
 * The one writer that owns the settings, the setup form's connect request,
 * passes its config through `ownedConnectionConfig`, which the wrapper leaves
 * alone. For a connection without the settings, a wrapped write stores exactly
 * the object it was given.
 */

const WRAPPED = Symbol("paperclip.oauthSignInPreservingDb");

function isPlainConfig(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !is(value, SQL);
}

/** `nextConfig` with the two sign-in settings replaced by the row's current ones. */
export function configKeepingLatestOAuthSignIn(nextConfig: Record<string, unknown>) {
  const next = sql`${JSON.stringify(nextConfig)}::jsonb`;
  const latest = sql`jsonb_strip_nulls(jsonb_build_object('loopbackRedirect', ${toolConnections.config} #> '{oauth,loopbackRedirect}', 'requestedScopes', ${toolConnections.config} #> '{oauth,requestedScopes}'))`;
  return sql<Record<string, unknown>>`case when (${next} -> 'oauth') is null and ${latest} = '{}'::jsonb then ${next} else jsonb_set(${next}, '{oauth}', (coalesce(${next} -> 'oauth', '{}'::jsonb) - 'loopbackRedirect' - 'requestedScopes') || ${latest}) end`;
}

/**
 * A config written exactly as given, settings included. Only for the writer
 * that owns the sign-in settings.
 */
export function ownedConnectionConfig(config: Record<string, unknown>) {
  return sql<Record<string, unknown>>`${JSON.stringify(config)}::jsonb`;
}

function preserveInSet(values: unknown): unknown {
  if (typeof values !== "object" || values === null) return values;
  const record = values as Record<string, unknown>;
  if (!isPlainConfig(record.config) && !isPlainConfig(record.transportConfig)) return values;
  return {
    ...record,
    ...(isPlainConfig(record.config) ? { config: configKeepingLatestOAuthSignIn(record.config) } : {}),
    ...(isPlainConfig(record.transportConfig)
      ? { transportConfig: configKeepingLatestOAuthSignIn(record.transportConfig) }
      : {}),
  };
}

function bound(target: object, property: string | symbol, receiver: unknown): unknown {
  const value = Reflect.get(target, property, receiver === undefined ? target : target);
  return typeof value === "function" ? value.bind(target) : value;
}

export function withOAuthSignInPreservingWrites<T extends Pick<Db, "update" | "transaction">>(db: T): T {
  if ((db as { [WRAPPED]?: true })[WRAPPED]) return db;
  return new Proxy(db, {
    get(target, property) {
      if (property === WRAPPED) return true;
      if (property === "update") {
        return (table: unknown) => {
          const builder = (target.update as (table: unknown) => object)(table);
          if (table !== toolConnections) return builder;
          return new Proxy(builder, {
            get(builderTarget, builderProperty) {
              if (builderProperty === "set") {
                return (values: unknown) =>
                  (builderTarget as { set: (values: unknown) => unknown }).set(preserveInSet(values));
              }
              return bound(builderTarget, builderProperty, undefined);
            },
          });
        };
      }
      if (property === "transaction") {
        return (callback: (tx: unknown, ...rest: unknown[]) => unknown, ...config: unknown[]) =>
          (target.transaction as (...args: unknown[]) => unknown)(
            (tx: unknown, ...rest: unknown[]) =>
              callback(withOAuthSignInPreservingWrites(tx as Pick<Db, "update" | "transaction">), ...rest),
            ...config,
          );
      }
      return bound(target, property, undefined);
    },
  }) as T;
}
