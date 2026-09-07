/**
 * The house style, in one place.
 *
 * These pages are part of transbay.dev, and they should not look like a debug endpoint that
 * wandered in. The tokens below are copied from `transbay.dev/shared/style.css` -- the same
 * stylesheet the marketing sites use -- so a change there can be mirrored here by editing
 * one block rather than hunting through three files that each grew their own palette.
 *
 * The accent is the BayTransit one (`body.bay` in the shared sheet), because that is the
 * product these pages belong to.
 */

export function esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

/** Embedded as a JS literal, so `</script>` inside a string cannot end the block early. */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

export interface PageOptions {
  /** Rendered under the h1, quietly. */
  subtitle?: string
  /** Right-hand side of the header bar: links, filters, a live clock. */
  headerRight?: string
  /** Injected before `</body>`. */
  script?: string
  /** Extra CSS appended after the shared sheet. */
  style?: string
  /** Constrains the content column. Wide pages (a heatmap) want the full width. */
  wide?: boolean
}

const SHARED_CSS = `
:root {
  --page-bg:#0A0B0E; --panel-bg:#121419;
  --ink:#F3F4F7; --ink-dim:#9BA2AE; --ink-faint:#6B7280;
  --edge:rgba(255,255,255,.12); --edge-strong:rgba(255,255,255,.22);
  --accent:#38BDF8; --accent-soft:#7DD3FC;
  --good:#4ADE80; --warn:#FBBF24; --bad:#F87171;
  --font-display:"Space Grotesk",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-body:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --radius:16px; --gap:1.5rem;
}
*,*::before,*::after { box-sizing:border-box; }
body {
  margin:0; background:var(--page-bg); color:var(--ink);
  font-family:var(--font-body); font-size:15px; line-height:1.6;
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(1200px 600px at 50% -260px,
    color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%);
  background-repeat:no-repeat;
}
.wrap { max-width:1120px; margin:0 auto; padding:2rem 1.25rem 4rem; }
.wrap.wide { max-width:1680px; }
h1 { font-family:var(--font-display); font-weight:600; letter-spacing:-.02em;
     font-size:1.7rem; margin:0; line-height:1.15; }
h2 { font-family:var(--font-display); font-weight:600; letter-spacing:-.02em;
     font-size:1.05rem; margin:0 0 .75rem; }
.sub { color:var(--ink-dim); font-size:.9rem; margin:.3rem 0 0; }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }

header.bar { display:flex; flex-wrap:wrap; gap:1rem; align-items:flex-end;
             justify-content:space-between; margin-bottom:2rem; }
header.bar .right { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }

.panel { background:var(--panel-bg); border:1px solid var(--edge);
         border-radius:var(--radius); padding:1.15rem 1.25rem; }
.grid { display:grid; gap:1rem; }
.cols { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }

.stat .k { color:var(--ink-faint); font-size:.72rem; text-transform:uppercase;
           letter-spacing:.09em; font-weight:600; }
.stat .v { font-family:var(--font-display); font-weight:600; font-size:1.5rem;
           line-height:1.2; margin-top:.15rem; font-variant-numeric:tabular-nums; }
.stat .n { color:var(--ink-faint); font-size:.78rem; margin-top:.1rem; }
.v.good { color:var(--good); } .v.warn { color:var(--warn); } .v.bad { color:var(--bad); }

.pill { display:inline-flex; align-items:center; gap:.4rem; padding:.28rem .7rem;
        border:1px solid var(--edge); border-radius:999px; font-size:.8rem;
        color:var(--ink-dim); background:var(--panel-bg); }
.pill.on { border-color:var(--accent); color:var(--accent); }
.dot { width:7px; height:7px; border-radius:50%; background:var(--good); }
.dot.bad { background:var(--bad); } .dot.warn { background:var(--warn); }

select, input, button {
  font:inherit; font-size:.85rem; color:var(--ink); background:var(--panel-bg);
  border:1px solid var(--edge); border-radius:9px; padding:.4rem .6rem;
}
select:focus, input:focus, button:focus { outline:2px solid var(--accent); outline-offset:1px; }
button { cursor:pointer; }
button:hover { border-color:var(--edge-strong); }

.scroll { overflow-x:auto; border:1px solid var(--edge); border-radius:var(--radius);
          background:var(--panel-bg); }
table { border-collapse:separate; border-spacing:0; font-variant-numeric:tabular-nums; }
th, td { padding:5px 8px; white-space:nowrap; font-size:12.5px; text-align:left;
         border-bottom:1px solid var(--edge); }
thead th { color:var(--ink-faint); font-weight:600; font-size:10.5px;
           text-transform:uppercase; letter-spacing:.08em;
           position:sticky; top:0; background:var(--panel-bg); z-index:2; }
tbody tr:last-child td { border-bottom:none; }
.muted { color:var(--ink-dim); } .faint { color:var(--ink-faint); }
.mono { font-family:var(--font-mono); }
.empty { color:var(--ink-dim); padding:2.5rem 0; text-align:center; }
.foot { color:var(--ink-faint); font-size:.78rem; margin-top:2rem; line-height:1.75; }
@media (max-width:640px) { .wrap { padding:1.25rem .9rem 3rem; } h1 { font-size:1.35rem; } }
`

export function page(title: string, body: string, opts: PageOptions = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0A0B0E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${SHARED_CSS}${opts.style ?? ''}</style>
</head><body>
<div class="wrap${opts.wide ? ' wide' : ''}">
<header class="bar">
  <div>
    <h1>${esc(title)}</h1>
    ${opts.subtitle ? `<p class="sub">${opts.subtitle}</p>` : ''}
  </div>
  <div class="right">${opts.headerRight ?? ''}</div>
</header>
${body}
</div>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body></html>`
}
