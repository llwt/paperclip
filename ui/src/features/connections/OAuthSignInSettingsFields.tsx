import { parseOAuthScopeList } from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { oauthSignInDraftError, type OAuthSignInDraft } from "./oauth-sign-in-settings";

/**
 * Fork-only (llwt/paperclip, NX-617). Shown under "Advanced authentication" for
 * a pasted MCP URL, so both settings are stored before the first sign-in starts.
 */
export function OAuthSignInSettingsFields({
  draft,
  onChange,
  disabled,
}: {
  draft: OAuthSignInDraft;
  onChange: (next: OAuthSignInDraft) => void;
  disabled?: boolean;
}) {
  const error = oauthSignInDraftError(draft);
  const scopeCount = parseOAuthScopeList(draft.scopesText).scopes.length;
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <p className="text-sm font-medium text-foreground">Sign-in options</p>
      <div className="flex items-start gap-3">
        <Checkbox
          id="generic-mcp-loopback-redirect"
          checked={draft.loopbackRedirect}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...draft, loopbackRedirect: checked === true, touched: true })}
          className="mt-0.5"
        />
        <div>
          <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-loopback-redirect">
            Sign in through localhost
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            For servers that refuse this Paperclip's address as a sign-in callback but accept localhost. The
            browser that signs in must be able to reach this Paperclip at localhost on the server's own port,
            for example through an SSH port forward, and must already be signed in to Paperclip at its normal
            address.
          </p>
        </div>
      </div>
      <div>
        <label className="text-sm font-medium text-foreground" htmlFor="generic-mcp-requested-scopes">
          Scopes to request
        </label>
        <Textarea
          id="generic-mcp-requested-scopes"
          value={draft.scopesText}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, scopesText: event.target.value, touched: true })}
          placeholder="Leave empty to request every scope the server offers"
          aria-invalid={error ? true : undefined}
          className="mt-2 min-h-24 font-mono"
        />
        <p className={error ? "mt-2 text-xs text-destructive" : "mt-2 text-xs text-muted-foreground"}>
          {error
            ?? (scopeCount > 0
              ? `The next sign-in asks for ${scopeCount === 1 ? "this scope" : `these ${scopeCount} scopes`} only. Access already granted stays as it is until you sign in again.`
              : "One per line or separated by spaces. Applies to the next sign-in.")}
        </p>
      </div>
    </div>
  );
}
