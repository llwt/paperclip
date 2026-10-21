import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import type { AiManagedConnectionSummary } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Reconnect a Claude subscription with a token from `claude setup-token`, next to the sign-in flow. */
export function AiConnectionSetupTokenPaste({ companyId, connectionId, onComplete }: {
  companyId: string;
  connectionId: string;
  onComplete: (result: { connectionId: string; grantId: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () => aiConnectionsApi.reconnectWithSetupToken(companyId, connectionId, token.trim()),
    onSuccess: (result) => { void client.invalidateQueries({ queryKey: ["ai-connections", companyId] }); onComplete(result); },
    onSettled: () => setToken(""),
  });
  if (!open)
    return <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>Paste a setup-token</Button>;
  return <form className="space-y-2 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); if (token.trim() && !save.isPending) save.mutate(); }}>
    <label className="block space-y-1 text-sm">
      Setup-token
      <Input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} disabled={save.isPending} placeholder="sk-ant-oat01-…" autoFocus />
    </label>
    <p className="text-xs text-muted-foreground">Run <code>claude setup-token</code> in a terminal and paste the token it prints. Paperclip checks it with Anthropic before it saves it on this account.</p>
    {save.error && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={() => { setToken(""); save.reset(); setOpen(false); }}>Cancel</Button>
      <Button type="submit" size="sm" disabled={!token.trim() || save.isPending}>{save.isPending ? "Checking…" : "Save token"}</Button>
    </div>
  </form>;
}

/** "Check again": test the saved credential without a run, for an account that needs reconnect. */
export function AiConnectionCheckAgain({ account, showFailure = true }: {
  account: Pick<AiManagedConnectionSummary, "id" | "grantId" | "companyId" | "revalidationSupported">;
  /** Off where the host already shows the saved reason (the account's health message). */
  showFailure?: boolean;
}) {
  const client = useQueryClient();
  const check = useMutation({
    mutationFn: () => aiConnectionsApi.revalidate(account.companyId, account.id, account.grantId),
    onSettled: () => client.invalidateQueries({ queryKey: ["ai-connections", account.companyId] }),
  });
  if (!account.revalidationSupported) return null;
  const failed = check.data?.result === "failed";
  return <>
    <Button type="button" variant="outline" size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
      <RotateCw className="size-4" aria-hidden />{check.isPending ? "Checking…" : "Check again"}
    </Button>
    {check.error && <p role="alert" className="basis-full text-sm text-destructive">{check.error.message}</p>}
    {check.data && (!failed || showFailure) && <p role={failed ? "alert" : "status"} className={failed ? "basis-full text-sm text-destructive" : "basis-full text-sm text-muted-foreground"}>{check.data.message}</p>}
  </>;
}
