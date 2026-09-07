/**
 * The page shell.
 *
 * These pages load transbay.dev's own stylesheets rather than restating them. The previous
 * version copied the palette into a local block, which looked right on the day it was
 * written and would have drifted the first time the real sheet changed. Linking them means
 * the tokens, type, buttons, cards and glass panels are the site's, not an imitation.
 *
 * Only what the shared sheet has no opinion about lives here: tables, heatmap cells,
 * countdowns, the map container.
 */

const SHARED = 'https://transbay.dev/shared'

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
  subtitle?: string
  /** Right of the title. */
  headerRight?: string
  script?: string
  style?: string
  wide?: boolean
}

/**
 * Enough of the palette to survive the shared sheet being unreachable.
 *
 * Not a copy of the design -- a floor. Without it a failed stylesheet fetch leaves black
 * text on a white page that the theme colour says should be near-black.
 */
const FALLBACK = `
:root { --page-bg:#0A0B0E; --panel-bg:#121419; --ink:#F3F4F7; --ink-dim:#9BA2AE;
        --ink-faint:#6B7280; --edge:rgba(255,255,255,.12); --edge-strong:rgba(255,255,255,.22);
        --accent:#38BDF8; --accent-soft:#7DD3FC; --radius:16px; }
body { background:var(--page-bg); color:var(--ink); }
`

const PAGE_CSS = `
.page-title { display:flex; flex-wrap:wrap; gap:1rem; align-items:baseline;
              justify-content:space-between; margin:2rem 0 1.5rem; }
.page-title h1 { margin:0; font-size:clamp(1.5rem,3vw,2rem); }
.page-title .sub { color:var(--ink-dim); margin:.25rem 0 0; font-size:.95rem; }
.page-title .right { display:flex; gap:.5rem; align-items:center; }
.wrap.wide { max-width:1680px; }

.figs { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); }
.fig .k { color:var(--ink-faint); font-size:.72rem; text-transform:uppercase;
          letter-spacing:.09em; font-weight:600; }
.fig .v { font-family:var(--font-display); font-weight:600; font-size:1.5rem;
          line-height:1.2; margin-top:.15rem; font-variant-numeric:tabular-nums; }
.fig .n { color:var(--ink-faint); font-size:.78rem; }
.v.good { color:#4ADE80; } .v.warn { color:#FBBF24; } .v.bad { color:#F87171; }

.chip { display:inline-flex; align-items:center; gap:.4rem; padding:.25rem .65rem;
        border:1px solid var(--edge); border-radius:999px; font-size:.78rem;
        color:var(--ink-dim); }
.chip.on { border-color:var(--accent); color:var(--accent); }
.dot { width:7px; height:7px; border-radius:50%; background:#4ADE80; }

/* The native control is styled away rather than replaced.
   A hand-built listbox would have to reimplement keyboard navigation, type-ahead, the
   focus ring and the whole mobile picker, and would get some of it wrong. Removing the
   appearance and drawing a chevron keeps all of that and only changes the paint. */
select {
  font:inherit; font-size:.85rem; font-weight:500; color:var(--ink);
  appearance:none; -webkit-appearance:none;
  background-color:rgba(255,255,255,.04);
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239BA2AE' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;
  background-position:right .6rem center;
  border:1px solid var(--edge); border-radius:10px;
  padding:.42rem 1.8rem .42rem .7rem;
  cursor:pointer; transition:border-color .15s ease, background-color .15s ease;
}
select:hover { border-color:var(--edge-strong); background-color:rgba(255,255,255,.07); }
select:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
/* The open menu is drawn by the OS; these are the only two properties it honours. */
select option { background:#15181E; color:var(--ink); }

.scroll { overflow-x:auto; border:1px solid var(--edge); border-radius:var(--radius);
          background:var(--panel-bg); }
table { border-collapse:separate; border-spacing:0; font-variant-numeric:tabular-nums;
        font-size:12.5px; }
th, td { padding:5px 8px; white-space:nowrap; text-align:left;
         border-bottom:1px solid var(--edge); }
thead th { color:var(--ink-faint); font-weight:600; font-size:10.5px; text-transform:uppercase;
           letter-spacing:.08em; position:sticky; top:0; background:var(--panel-bg); z-index:2; }
tbody tr:last-child td { border-bottom:none; }
.faint { color:var(--ink-faint); }
.empty { color:var(--ink-dim); padding:2.5rem 0; text-align:center; }
`

export function page(title: string, body: string, opts: PageOptions = {}): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Transbay API</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0A0B0E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${FALLBACK}</style>
<link rel="stylesheet" href="${SHARED}/style.css">
<link rel="stylesheet" href="${SHARED}/glass.css">
<link rel="icon" href="${SHARED}/assets/baywidgets/icon.png">
<style>${PAGE_CSS}${opts.style ?? ''}</style>
</head>
<body class="bay">
<a class="skip-link" href="#main">Skip to the page</a>
<header class="site-header">
  <div class="wrap">
    <a class="wordmark" href="/dash">
      <img src="${SHARED}/assets/baywidgets/icon.png" alt="">
      Transbay&nbsp;API
    </a>
    <nav class="nav">
      <a href="/dash">Profiles</a>
      <a href="/how">How?</a>
      <a href="/health">Health</a>
      <a href="https://transbay.dev">transbay.dev</a>
    </nav>
  </div>
</header>

<main id="main" class="wrap${opts.wide ? ' wide' : ''}">
  <div class="page-title">
    <div>
      <h1>${esc(title)}</h1>
      ${opts.subtitle ? `<p class="sub">${opts.subtitle}</p>` : ''}
    </div>
    <div class="right">${opts.headerRight ?? ''}</div>
  </div>
${body}
</main>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body></html>`
}
