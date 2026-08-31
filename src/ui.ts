import { ADMIN_CSS, ADMIN_JS } from "./ui.generated";

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="8" y1="6" x2="56" y2="60" gradientUnits="userSpaceOnUse"><stop stop-color="#2899f5"/><stop offset=".55" stop-color="#0f6cbd"/><stop offset="1" stop-color="#08477d"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M47 18.5A21 21 0 1 0 48 45" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="47" cy="18.5" r="4.5" fill="#fff"/><circle cx="48" cy="45" r="4.5" fill="#fff"/><path d="M24 25h15M24 39h15" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/></svg>`;

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0f6cbd"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Codex 账户池</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('codex-theme')||'system'}catch{document.documentElement.dataset.theme='system'}</script>
<link rel="stylesheet" href="/admin/assets/app.css"></head><body><div id="app"><div class="loading">正在载入账户池...</div></div><script type="module" src="/admin/assets/app.js"></script></body></html>`;

export const ADMIN_ASSETS: Record<string, { body: string; contentType: string }> = {
  "/admin/assets/app.js": { body: ADMIN_JS, contentType: "text/javascript; charset=utf-8" },
  "/admin/assets/app.css": { body: ADMIN_CSS, contentType: "text/css; charset=utf-8" },
};
