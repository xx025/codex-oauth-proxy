import type { ComponentChildren, JSX } from "preact";

export type View = "home" | "accounts" | "keys" | "models" | "usage" | "settings";

const nav: Array<[View, string]> = [["home", "首页"], ["accounts", "账户池"], ["keys", "密钥"], ["models", "模型"], ["usage", "请求统计"], ["settings", "其他设置"]];

export function AppShell({ view, theme, onTheme, onLogout, children }: { view: View; theme: string; onTheme: (value: string) => void; onLogout: () => void; children: ComponentChildren }) {
  return <div class="app-shell"><aside class="sidebar"><a class="brand" href="#home"><span class="logo">C</span><span>Codex Pool<small>OAuth gateway</small></span></a><nav aria-label="主导航">{nav.map(([id, label]) => <a href={`#${id}`} class={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined}>{label}</a>)}</nav><div class="sidebar-foot"><label>外观<select value={theme} onChange={(event) => onTheme(event.currentTarget.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><button class="button ghost" onClick={onLogout}>退出登录</button></div></aside><section class="workspace"><header class="mobile-bar"><a class="brand" href="#home"><span class="logo">C</span>Codex Pool</a><select aria-label="页面" value={view} onChange={(event) => location.hash = event.currentTarget.value}>{nav.map(([id, label]) => <option value={id}>{label}</option>)}</select></header><main>{children}</main></section></div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ComponentChildren }) {
  return <header class="page-header"><div><span class="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions && <div class="page-actions">{actions}</div>}</header>;
}

export function Panel({ title, subtitle, actions, children, class: className = "" }: { title?: string; subtitle?: string; actions?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return <section class={`panel ${className}`}>{(title || actions) && <header class="panel-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{actions && <div class="page-actions">{actions}</div>}</header>}<div class="panel-body">{children}</div></section>;
}

export function Stat({ label, value }: { label: string; value: ComponentChildren }) { return <div class="stat"><span>{label}</span><strong>{value}</strong></div>; }
export function Empty({ title, text, actions }: { title: string; text: string; actions?: ComponentChildren }) { return <div class="empty"><h3>{title}</h3><p>{text}</p>{actions && <div class="page-actions">{actions}</div>}</div>; }
export function Button({ children, tone = "default", ...props }: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "danger" }) { return <button class={`button ${tone}`} {...props}>{children}</button>; }
