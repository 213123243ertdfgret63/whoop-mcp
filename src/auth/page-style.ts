/**
 * The look shared by every page the local login server returns: one palette with WCAG AA contrast in light and
 * dark mode, visible keyboard focus, and no motion for people who ask for less. Text only: no WHOOP logo or
 * brand marks (this is an unofficial tool).
 */
export const BASE_CSS = `
:root { color-scheme: light dark; --fg: #111; --muted: #555; --bg: #fff; --card: #f4f4f3; --line: #d6d6d3;
  --accent: #00805a; --on-accent: #fff; --ok: #00805a; --err: #b00020; --focus: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --fg: #eee; --muted: #aaa; --bg: #111; --card: #1c1c1c; --line: #333;
  --accent: #3c9; --on-accent: #04140d; --ok: #3c9; --err: #ff6b6b; --focus: #93c5fd; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { font: 16px/1.5 system-ui, -apple-system, sans-serif; color: var(--fg); background: var(--bg); margin: 0; }
main { max-width: 34rem; margin: 2.5rem auto; padding: 0 1rem; }
h1 { font-size: 1.45rem; margin: 0 0 .25rem; } h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
p { margin: .5rem 0; } .muted { color: var(--muted); } .small { font-size: .9rem; }
.ok { color: var(--ok); font-weight: 600; } .err { color: var(--err); font-weight: 600; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.button, button { display: inline-block; font: inherit; font-weight: 600; padding: .55rem 1rem; border-radius: 8px;
  border: 0; background: var(--accent); color: var(--on-accent); cursor: pointer; text-decoration: none; }
button.quiet, .button.quiet { background: transparent; color: var(--fg); border: 1px solid var(--line); }
code { background: var(--card); padding: .1rem .35rem; border-radius: 4px; font-size: .9em; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/** A complete page. `title` and plain-text pieces must already be escaped; `body` is trusted HTML. */
export function htmlPage(opts: { title: string; body: string; css?: string; script?: string; nonce: string }): string {
  const nonce = `nonce="${opts.nonce}"`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<style ${nonce}>${BASE_CSS}${opts.css ?? ""}</style></head>
<body><main>${opts.body}</main>${opts.script ? `<script ${nonce}>${opts.script}</script>` : ""}</body></html>`;
}

/** A fresh nonce for one response's CSP. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

/** CSP allowing only this response's own inline style and script, and requests back to this server. */
export function cspFor(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    // No form-action: Chrome applies it to every redirect after the POST, and WHOOP's consent flow redirects
    // across its own pages. The form's target is fixed in the HTML, so the directive would add little.
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}
