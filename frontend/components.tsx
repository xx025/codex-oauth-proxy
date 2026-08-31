import type { ComponentChildren, JSX } from "preact";
import { useI18n, type TranslationKey } from "./i18n";

export type View =
  | "home"
  | "accounts"
  | "keys"
  | "models"
  | "usage"
  | "settings";
export type IconName =
  | View
  | "logout"
  | "cloud"
  | "close";

const nav: Array<{ id: View; label: TranslationKey; icon: IconName }> = [
  { id: "home", label: "navHome", icon: "home" },
  { id: "accounts", label: "navAccounts", icon: "accounts" },
  { id: "keys", label: "navKeys", icon: "keys" },
  { id: "models", label: "navModels", icon: "models" },
  { id: "usage", label: "navUsage", icon: "usage" },
  { id: "settings", label: "navSettings", icon: "settings" },
];

const iconPaths: Record<IconName, ComponentChildren> = {
  home: <path d="m4 11 8-7 8 7v9h-6v-6h-4v6H4z" />,
  accounts: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 7h5m-2.5-2.5v5M16 15h5m-5 4h5" />
    </>
  ),
  keys: (
    <>
      <circle cx="8" cy="15" r="3" />
      <path d="m10.5 13.5 7-7m-2 2 2 2m-4 0 2 2" />
    </>
  ),
  models: (
    <path d="M4 6.5 12 3l8 3.5-8 3.5zM4 11.5l8 3.5 8-3.5M4 16.5l8 3.5 8-3.5" />
  ),
  usage: <path d="M4 19V9m6 10V5m6 14v-7m4 7H2" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6l-.3-2.5h-4L10.5 6A7 7 0 0 0 9 7.1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.5 1.1l.3 2.5h4L15 18a7 7 0 0 0 1.5-1.1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z" />
    </>
  ),
  logout: <path d="M14 8V5H5v14h9v-3M10 12h10m-3-3 3 3-3 3" />,
  cloud: (
    <path d="M6.5 18.5h11a4 4 0 0 0 .4-8 6 6 0 0 0-11.5-1.2 4.6 4.6 0 0 0 .1 9.2z" />
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      {iconPaths[name]}
    </svg>
  );
}
export function Logo({ large = false }: { large?: boolean }) {
  return (
    <span class={`logo${large ? " large" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M23.5 9.2A10 10 0 1 0 24 22.3"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
        />
        <circle cx="23.5" cy="9.2" r="2.2" fill="currentColor" />
        <circle cx="24" cy="22.3" r="2.2" fill="currentColor" />
        <path
          d="M12.2 12.5h7.2M12.2 19.5h7.2"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
        />
      </svg>
    </span>
  );
}

export function AppShell({
  view,
  onLogout,
  children,
}: {
  view: View;
  onLogout: () => void;
  children: ComponentChildren;
}) {
  const { t } = useI18n();
  const current = nav.find((item) => item.id === view)!;
  return (
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="#home">
          <Logo />
          <span class="brand-copy">
            <strong>Codex Pool</strong>
            <small>OAuth gateway</small>
          </span>
        </a>
        <nav aria-label={t("mainNavigation")}>
          <span class="nav-label">{t("management")}</span>
          {nav.map(({ id, label, icon }) => (
            <a
              href={`#${id}`}
              class={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon name={icon} />
              <span>{t(label)}</span>
            </a>
          ))}
        </nav>
        <div class="sidebar-foot">
          <div class="service-state">
            <i />
            <span>
              <strong>{t("serviceRunning")}</strong>
              <small>Cloudflare Edge</small>
            </span>
          </div>
          <button class="button ghost logout" onClick={onLogout}>
            <Icon name="logout" />
            <span>{t("logout")}</span>
          </button>
        </div>
      </aside>
      <section class="workspace">
        <header class="commandbar">
          <span class="command-title">{t(current.label)}</span>
          <span class="command-context">
            <Icon name="cloud" />
            Cloudflare Edge
          </span>
        </header>
        <header class="mobile-bar">
          <a class="brand" href="#home">
            <Logo />
            <span>Codex Pool</span>
          </a>
          <div class="mobile-controls">
            <select
              aria-label={t("page")}
              value={view}
              onChange={(event) => (location.hash = event.currentTarget.value)}
            >
              {nav.map(({ id, label }) => (
                <option value={id}>{t(label)}</option>
              ))}
            </select>
          </div>
        </header>
        <main>{children}</main>
      </section>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ComponentChildren;
}) {
  return (
    <header class="page-header">
      <div>
        <span class="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div class="page-actions">{actions}</div>}
    </header>
  );
}
export function Panel({
  title,
  subtitle,
  actions,
  children,
  class: className = "",
}: {
  title?: string;
  subtitle?: string;
  actions?: ComponentChildren;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section class={`panel ${className}`}>
      {(title || actions) && (
        <header class="panel-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div class="page-actions">{actions}</div>}
        </header>
      )}
      <div class="panel-body">{children}</div>
    </section>
  );
}
export function Stat({
  label,
  value,
}: {
  label: string;
  value: ComponentChildren;
}) {
  return (
    <div class="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
export function Empty({
  title,
  text,
  actions,
}: {
  title: string;
  text: string;
  actions?: ComponentChildren;
}) {
  return (
    <div class="empty">
      <span class="empty-icon">
        <Icon name="models" />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {actions && <div class="page-actions">{actions}</div>}
    </div>
  );
}
export function Button({
  children,
  tone = "default",
  class: className = "",
  ...props
}: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "primary" | "danger";
}) {
  return (
    <button class={`button ${tone} ${className}`} {...props}>
      {children}
    </button>
  );
}
