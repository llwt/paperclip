// The host loads only the plugin's JS module, so the stylesheet ships inside it and is rendered
// as a <style> element. Colors, spacing, radii and fonts come from host variables only; the
// host switches them on the root `.dark` class, so a theme change while mounted needs no code here.
export const STYLE_ID = "execution-flow-styles";

export const STYLES = `
.ef-root { display: grid; gap: calc(var(--spacing, 0.25rem) * 4); min-width: 0; color: var(--foreground); font-family: var(--font-sans); font-size: 0.875rem; line-height: 1.45; }
.ef-root *, .ef-root *::before, .ef-root *::after { box-sizing: border-box; }
.ef-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: calc(var(--spacing, 0.25rem) * 2); }
.ef-title { margin: 0; font-size: 1rem; font-weight: 600; }
.ef-h3 { margin: 0; font-size: 0.875rem; font-weight: 600; }
.ef-tools { display: flex; flex-wrap: wrap; align-items: center; gap: calc(var(--spacing, 0.25rem) * 2); }
.ef-muted { color: var(--muted-foreground); }
.ef-small { font-size: 0.75rem; }
.ef-section { display: grid; gap: calc(var(--spacing, 0.25rem) * 2); min-width: 0; }
.ef-list { display: grid; gap: calc(var(--spacing, 0.25rem) * 2); margin: 0; padding: 0; list-style: none; min-width: 0; }
.ef-item { display: grid; gap: calc(var(--spacing, 0.25rem) * 1.5); min-width: 0; padding: calc(var(--spacing, 0.25rem) * 3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); color: var(--card-foreground); }
.ef-item[data-current="true"] { border-color: var(--ring); }
.ef-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: calc(var(--spacing, 0.25rem) * 1) calc(var(--spacing, 0.25rem) * 2); min-width: 0; }
.ef-grow { flex: 1 1 12rem; min-width: 0; }
.ef-wrap { overflow-wrap: anywhere; word-break: break-word; }
.ef-mono { font-family: var(--font-mono); font-size: 0.75rem; }
.ef-btn { appearance: none; display: inline-flex; align-items: center; min-height: calc(var(--spacing, 0.25rem) * 8); padding: 0 calc(var(--spacing, 0.25rem) * 3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--background); color: var(--foreground); font: inherit; font-size: 0.8125rem; cursor: pointer; }
.ef-btn:hover:not(:disabled) { background: var(--accent); color: var(--accent-foreground); }
.ef-btn:disabled { opacity: 0.6; cursor: default; }
.ef-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.ef-link { appearance: none; padding: 0; border: 0; background: none; color: var(--foreground); font: inherit; font-size: 0.8125rem; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.ef-link:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: var(--radius-sm); }
.ef-chip { --ef-tone: var(--muted-foreground); display: inline-flex; align-items: center; padding: 0 calc(var(--spacing, 0.25rem) * 2); border: 1px solid color-mix(in oklab, var(--ef-tone) 55%, var(--border)); border-radius: 999px; background: color-mix(in oklab, var(--ef-tone) 12%, transparent); color: color-mix(in oklab, var(--ef-tone) 55%, var(--foreground)); font-size: 0.75rem; font-weight: 500; white-space: nowrap; }
.ef-chip[data-tone="done"] { --ef-tone: var(--status-task-icon-done); }
.ef-chip[data-tone="active"] { --ef-tone: var(--status-task-icon-in_progress); }
.ef-chip[data-tone="attention"] { --ef-tone: var(--status-task-icon-todo); }
.ef-chip[data-tone="blocked"] { --ef-tone: var(--status-task-icon-blocked); }
.ef-note { padding: calc(var(--spacing, 0.25rem) * 2) calc(var(--spacing, 0.25rem) * 3); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--muted); color: var(--muted-foreground); }
.ef-alert { padding: calc(var(--spacing, 0.25rem) * 2) calc(var(--spacing, 0.25rem) * 3); border: 1px solid color-mix(in oklab, var(--destructive) 55%, var(--border)); border-radius: var(--radius-md); background: color-mix(in oklab, var(--destructive) 10%, transparent); color: var(--foreground); }
.ef-body { padding: calc(var(--spacing, 0.25rem) * 2) calc(var(--spacing, 0.25rem) * 3); border-left: 2px solid var(--border); background: var(--muted); border-radius: var(--radius-sm); min-width: 0; overflow-wrap: anywhere; }
.ef-body > :first-child { margin-top: 0; }
.ef-body > :last-child { margin-bottom: 0; }
.ef-body img { max-width: 100%; height: auto; }
.ef-body pre { overflow-x: auto; }
.ef-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: calc(var(--spacing, 0.25rem) * 1) calc(var(--spacing, 0.25rem) * 3); margin: 0; }
.ef-kv dt { color: var(--muted-foreground); }
.ef-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 30rem) { .ef-kv { grid-template-columns: minmax(0, 1fr); } .ef-kv dd { margin-bottom: calc(var(--spacing, 0.25rem) * 1); } }
`;
