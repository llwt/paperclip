import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MarkdownBlock, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import type { ConfirmationView, DecisionView, ExecutionFlowResponse, HeadShaEvidence, PrincipalView, StageView } from "../model.js";
import { applyResponse, cardTone, describePrincipal, formatTimestamp, groupDecisions, stageTone, titleCase } from "./state.js";
import type { Snapshot, Tone } from "./state.js";
import { STYLES, STYLE_ID } from "./styles.js";

const DATA_KEY = "execution-flow";
const FOCUS_RELOAD_MIN_MS = 1000;
const KIND_LABELS: Record<ConfirmationView["kind"], string> = {
  request_confirmation: "Confirmation",
  request_checkbox_confirmation: "Checkbox confirmation",
  request_item_verdicts: "Item verdicts",
};

export function ExecutionFlow({ context }: { context: PluginHostContext }) {
  const { companyId, entityId } = context;
  if (!companyId || !entityId) return <Styled><p className="ef-note" role="status">Open a task to see its execution flow.</p></Styled>;
  // Keying by company and task discards all state, so nothing from the previous task can render.
  return <Panel key={`${companyId}:${entityId}`} companyId={companyId} issueId={entityId} />;
}

function Styled({ children }: { children: ReactNode }) {
  return <div className="ef-root"><style id={STYLE_ID}>{STYLES}</style>{children}</div>;
}

function Panel({ companyId, issueId }: { companyId: string; issueId: string }) {
  const uid = useId();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const params = useMemo(() => ({ companyId, issueId, ...(cursor ? { cursor } : {}) }), [companyId, issueId, cursor]);
  const { data, loading, error, refresh } = usePluginData<ExecutionFlowResponse>(DATA_KEY, params);
  const lastLoadAt = useRef(Date.now());

  useEffect(() => {
    if (!data || data.subject?.companyId !== companyId || data.subject?.issueId !== issueId) return;
    lastLoadAt.current = Date.now();
    setSnapshot((previous) => applyResponse(previous, data, new Date()));
  }, [data, companyId, issueId]);

  const reload = useCallback(() => {
    lastLoadAt.current = Date.now();
    setCursor(undefined);
    refresh();
  }, [refresh]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "hidden" || loadingRef.current) return;
      if (Date.now() - lastLoadAt.current < FOCUS_RELOAD_MIN_MS) return;
      reloadRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  const toggle = useCallback((key: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const disclosure = (key: string) => ({
    open: expanded.has(key),
    toggle: () => toggle(key),
    panelId: `${uid}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
  });

  const showError = error && !loading;
  return (
    <Styled>
      <div className="ef-head">
        <h2 className="ef-title">Execution flow</h2>
        <div className="ef-tools">
          <span className="ef-muted ef-small" role="status">
            {loading ? "Refreshing…" : snapshot ? <>Last refreshed <time dateTime={snapshot.refreshedAt.toISOString()}>{formatTimestamp(snapshot.refreshedAt.toISOString())}</time></> : null}
          </span>
          <button type="button" className="ef-btn" onClick={reload} disabled={loading}>Refresh</button>
          <button type="button" className="ef-btn" onClick={() => setExpanded(new Set())} disabled={expanded.size === 0}>Collapse all</button>
        </div>
      </div>
      {showError ? (
        <div className="ef-alert" role="alert">
          <div className="ef-row">
            <span className="ef-grow">Execution flow could not be loaded: {error.message}{snapshot ? " The details below are from the last successful load." : ""}</span>
            <button type="button" className="ef-btn" onClick={refresh}>Retry</button>
          </div>
        </div>
      ) : null}
      {!snapshot && loading ? <p className="ef-note" role="status">Loading execution flow…</p> : null}
      {snapshot ? <Body snapshot={snapshot} loading={loading} disclosure={disclosure} onLoadMore={() => snapshot.nextCursor && setCursor(snapshot.nextCursor)} /> : null}
    </Styled>
  );
}

type Disclosure = (key: string) => { open: boolean; toggle: () => void; panelId: string };

function Body({ snapshot, loading, disclosure, onLoadMore }: { snapshot: Snapshot; loading: boolean; disclosure: Disclosure; onLoadMore: () => void }) {
  const { view } = snapshot;
  const headingId = useId();
  const grouped = useMemo(() => groupDecisions(view, snapshot.decisions), [view, snapshot.decisions]);
  const listed = [...grouped.current, ...grouped.unclassified];
  const history = view.history;
  return (
    <>
      <ExecutionSection view={view} grouped={grouped.byStage} />
      <section className="ef-section" aria-labelledby={headingId}>
        <h3 className="ef-h3" id={headingId}>{history.label}</h3>
        <p className="ef-muted ef-small">{history.notice}</p>
        {history.status === "unavailable" ? <p className="ef-alert" role="alert">{history.message}</p> : null}
        {history.status === "available" && snapshot.decisions.length === 0 ? <p className="ef-note">No decisions are recorded for this task.</p> : null}
        {view.execution.policyKnown ? null : snapshot.decisions.length > 0 ? <p className="ef-note">The stage policy is unavailable, so these decisions are not matched to stages.</p> : null}
        {listed.length > 0 ? <ol className="ef-list" aria-label="Recorded decisions">{listed.map((decision) => <DecisionRow key={decision.id} decision={decision} disclosure={disclosure(`decision:${decision.id}`)} />)}</ol> : null}
        {grouped.formerStages.length > 0 ? (
          <div className="ef-section">
            <h4 className="ef-h3">{history.formerStagesLabel}</h4>
            <p className="ef-muted ef-small">Recorded stage type and ID are shown. Their former order and participants are not available.</p>
            {grouped.formerStages.map((group) => (
              <div className="ef-section" key={group.id}>
                <p className="ef-small">Stage ID <span className="ef-mono ef-wrap">{group.id}</span></p>
                <ol className="ef-list" aria-label={`Decisions for former stage ${group.id}`}>{group.decisions.map((decision) => <DecisionRow key={decision.id} decision={decision} disclosure={disclosure(`decision:${decision.id}`)} />)}</ol>
              </div>
            ))}
          </div>
        ) : null}
        <div className="ef-row">
          <span className="ef-muted ef-small">{snapshot.decisions.length} {snapshot.decisions.length === 1 ? "decision" : "decisions"} loaded{snapshot.nextCursor ? "; more are available" : ""}.</span>
          {snapshot.nextCursor ? <button type="button" className="ef-btn" onClick={onLoadMore} disabled={loading}>{loading ? "Loading…" : "Load more"}</button> : null}
        </div>
      </section>
      <ConfirmationsSection view={view} disclosure={disclosure} />
    </>
  );
}

function ExecutionSection({ view, grouped }: { view: ExecutionFlowResponse; grouped: Map<string, DecisionView[]> }) {
  const { execution } = view;
  const headingId = useId();
  return (
    <section className="ef-section" aria-labelledby={headingId}>
      <h3 className="ef-h3" id={headingId}>Stages</h3>
      {execution.message ? <p className={execution.status === "unavailable" ? "ef-alert" : "ef-note"} role={execution.status === "unavailable" ? "alert" : undefined}>{execution.message}</p> : null}
      {execution.stateStatus ? (
        <p className="ef-small">
          Execution state: <strong>{titleCase(execution.stateStatus)}</strong>
          {execution.workReturned ? <>. Work was returned to <PrincipalText principal={execution.returnAssignee} fallback="an unrecorded assignee" /></> : null}
        </p>
      ) : null}
      {execution.warnings.length > 0 ? (
        <div className="ef-alert" role="alert">
          <strong>Inconsistent execution state (shown as recorded, not repaired)</strong>
          <ul>{execution.warnings.map((warning) => <li key={warning} className="ef-wrap">{warning}</li>)}</ul>
        </div>
      ) : null}
      {execution.stages.length > 0 ? (
        <ol className="ef-list" aria-label="Execution stages">
          {execution.stages.map((stage, index) => <StageRow key={stage.id} stage={stage} index={index} view={view} count={grouped.get(stage.id)?.length ?? 0} />)}
        </ol>
      ) : null}
    </section>
  );
}

function StageRow({ stage, index, view, count }: { stage: StageView; index: number; view: ExecutionFlowResponse; count: number }) {
  const { execution } = view;
  const isCurrent = execution.currentStageId === stage.id;
  return (
    <li className="ef-item" data-current={isCurrent ? "true" : "false"}>
      <div className="ef-row">
        <strong>{index + 1}. {titleCase(stage.type)}</strong>
        <span className="ef-mono ef-wrap">{stage.id}</span>
        <Chip tone={stageTone(stage.status)}>{stage.status}</Chip>
      </div>
      <dl className="ef-kv">
        <dt>Configured participants</dt>
        <dd>{stage.participants.length === 0 ? "None configured" : <ul className="ef-list">{stage.participants.map((participant) => <li key={participant.id}><PrincipalText principal={participant.principal} /></li>)}</ul>}</dd>
        {isCurrent && !execution.workReturned ? <><dt>Current holder</dt><dd><PrincipalText principal={execution.currentHolder} fallback="None recorded" /></dd></> : null}
        {isCurrent && execution.workReturned ? (
          <>
            <dt>Returned to</dt><dd><PrincipalText principal={execution.returnAssignee} fallback="None recorded" /></dd>
            {execution.recordedCurrentParticipant ? <><dt>Reviewer of record</dt><dd><PrincipalText principal={execution.recordedCurrentParticipant} /> (does not hold the task now)</dd></> : null}
          </>
        ) : null}
        <dt>Decisions loaded</dt>
        <dd>{count}</dd>
      </dl>
    </li>
  );
}

function DecisionRow({ decision, disclosure }: { decision: DecisionView; disclosure: ReturnType<Disclosure> }) {
  return (
    <li className="ef-item">
      <div className="ef-row">
        <Chip tone={decision.outcome === "approved" ? "done" : "attention"}>{decision.label}</Chip>
        <span>{titleCase(decision.stageType)} stage</span>
        <span className="ef-mono ef-wrap">{decision.stageId}</span>
      </div>
      <dl className="ef-kv">
        <dt>Decided by</dt>
        <dd>{decision.actors.length === 0 ? "Actor not recorded" : <ul className="ef-list">{decision.actors.map((actor) => <li key={`${actor.type}:${actor.id}`}><PrincipalText principal={actor} /></li>)}</ul>}</dd>
        <dt>Recorded at</dt>
        <dd><time dateTime={decision.createdAt}>{formatTimestamp(decision.createdAt)}</time></dd>
        <dt>Head SHA</dt>
        <dd><ShaText evidence={decision.headSha} /></dd>
        <dt>Decision ID</dt>
        <dd className="ef-mono">{decision.id}</dd>
      </dl>
      <DisclosureButton disclosure={disclosure} label="decision text" />
      {disclosure.open ? (
        <div id={disclosure.panelId} className="ef-body">
          {decision.body.trim() ? <MarkdownBlock content={decision.body} /> : <p className="ef-muted">No text was recorded with this decision.</p>}
          <SourceExcerpts evidence={decision.headSha} />
        </div>
      ) : null}
    </li>
  );
}

function ConfirmationsSection({ view, disclosure }: { view: ExecutionFlowResponse; disclosure: Disclosure }) {
  const { confirmations } = view;
  const headingId = useId();
  return (
    <section className="ef-section" aria-labelledby={headingId}>
      <h3 className="ef-h3" id={headingId}>{confirmations.label}</h3>
      <p className="ef-muted ef-small">Cards are listed on their own. A card response is not a stage decision and does not complete a stage.</p>
      {confirmations.status === "unavailable" ? <p className="ef-alert" role="alert">{confirmations.message}</p> : null}
      {confirmations.status === "available" && confirmations.items.length === 0 ? <p className="ef-note">No task confirmations.</p> : null}
      {confirmations.items.length > 0 ? <ol className="ef-list" aria-label="Task confirmations">{confirmations.items.map((card) => <ConfirmationRow key={card.id} card={card} disclosure={disclosure(`card:${card.id}`)} />)}</ol> : null}
    </section>
  );
}

function ConfirmationRow({ card, disclosure }: { card: ConfirmationView; disclosure: ReturnType<Disclosure> }) {
  return (
    <li className="ef-item">
      <div className="ef-row">
        <Chip tone={cardTone(card.status)}>{titleCase(card.status)}</Chip>
        <span>{KIND_LABELS[card.kind]}</span>
      </div>
      <p className="ef-wrap">{card.prompt}</p>
      <dl className="ef-kv">
        <dt>Created</dt>
        <dd><time dateTime={card.createdAt}>{formatTimestamp(card.createdAt)}</time></dd>
        <dt>Resolved</dt>
        <dd>{card.resolvedAt ? <time dateTime={card.resolvedAt}>{formatTimestamp(card.resolvedAt)}</time> : "Not resolved"}</dd>
        <dt>Resolved by</dt>
        <dd>{card.resolvers.length === 0 ? (card.resolvedAt ? "Resolver not recorded" : "Not resolved") : <ul className="ef-list">{card.resolvers.map((actor) => <li key={`${actor.type}:${actor.id}`}><PrincipalText principal={actor} /></li>)}</ul>}</dd>
        {card.outcome ? <><dt>Outcome</dt><dd>{titleCase(card.outcome)}</dd></> : null}
        {card.target ? <><dt>Target</dt><dd className="ef-wrap">{card.target.label ?? card.target.key} ({card.target.type}{card.target.revisionId ? `, revision ${card.target.revisionId}` : ""})</dd></> : null}
        <dt>Head SHA</dt>
        <dd><ShaText evidence={card.headSha} /></dd>
        <dt>Card ID</dt>
        <dd className="ef-mono">{card.id}</dd>
      </dl>
      <DisclosureButton disclosure={disclosure} label="card details" />
      {disclosure.open ? (
        <div id={disclosure.panelId} className="ef-body">
          {card.details ? <MarkdownBlock content={card.details} /> : <p className="ef-muted">No further details were recorded with this card.</p>}
          {card.reason ? <p><strong>Reason:</strong> <span className="ef-wrap">{card.reason}</span></p> : null}
          {card.options.length > 0 ? (
            <ul>{card.options.map((option) => <li key={option.id} className="ef-wrap">{card.selectedOptionIds.includes(option.id) ? "Selected" : "Not selected"}: {option.label}</li>)}</ul>
          ) : null}
          {card.items.length > 0 ? (
            <ul>
              {card.items.map((item) => (
                <li key={item.id} className="ef-wrap">
                  {item.label}: <strong>{item.verdict ? titleCase(item.verdict) : "No verdict"}</strong>
                  {item.resolvers.length > 0 ? <> by {item.resolvers.map((actor, index) => <span key={`${actor.type}:${actor.id}`}>{index > 0 ? ", " : ""}<PrincipalText principal={actor} /></span>)}</> : null}
                  {item.resolvedAt ? <> at <time dateTime={item.resolvedAt}>{formatTimestamp(item.resolvedAt)}</time></> : null}
                  {item.reason ? <> ({item.reason})</> : null}
                </li>
              ))}
              {card.complete === false ? <li>Not every item has a verdict yet.</li> : null}
            </ul>
          ) : null}
          <SourceExcerpts evidence={card.headSha} />
        </div>
      ) : null}
    </li>
  );
}

function DisclosureButton({ disclosure, label }: { disclosure: ReturnType<Disclosure>; label: string }) {
  return (
    <div>
      <button type="button" className="ef-link" aria-expanded={disclosure.open} aria-controls={disclosure.panelId} onClick={disclosure.toggle}>
        {disclosure.open ? `Hide ${label}` : `Show ${label}`}
      </button>
    </div>
  );
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className="ef-chip" data-tone={tone}>{children}</span>;
}

function PrincipalText({ principal, fallback = "Unknown" }: { principal: PrincipalView | null; fallback?: string }) {
  if (!principal) return <>{fallback}</>;
  return (
    <span className="ef-wrap" title={describePrincipal(principal)}>
      {principal.type === "agent" ? "Agent" : "Human"} <strong>{principal.name ?? "(name unavailable)"}</strong> <span className="ef-mono">{principal.id ?? "ID unavailable"}</span>
    </span>
  );
}

function ShaText({ evidence }: { evidence: HeadShaEvidence }) {
  if (evidence.status === "reported") return <><span className="ef-mono ef-wrap">{evidence.sha}</span> <span className="ef-muted">({evidence.label}: written in the record text, not verified)</span></>;
  if (evidence.status === "ambiguous") return <>Ambiguous: the record text names more than one head SHA</>;
  return <>Not recorded</>;
}

function SourceExcerpts({ evidence }: { evidence: HeadShaEvidence }) {
  if (evidence.status === "not_recorded") return null;
  return <p className="ef-small ef-muted ef-wrap">Source text: {evidence.excerpts.map((excerpt, index) => <span key={index}>{index > 0 ? "; " : ""}<span className="ef-mono">{excerpt}</span></span>)}</p>;
}
