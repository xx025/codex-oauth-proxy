import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { aggregateModelDistribution, aggregateRequestTrend } from "./charts";
import {
  AppShell,
  Button,
  Empty,
  Icon,
  Logo,
  PageHeader,
  Panel,
  Stat,
  type View,
} from "./components";
import {
  formatDate,
  formatNumber,
  formatPercent,
  I18nProvider,
  parseLanguagePreference,
  resolveLocale,
  translate,
  useI18n,
  type LanguagePreference,
  type TranslationKey,
} from "./i18n";
import {
  formatDuration,
  formatUntilReset,
  groupModels,
  maskIdentity,
  modelVariantId,
  type ModelMetadata,
} from "./helpers";
import "./styles.css";

type UsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  windowSeconds?: number;
  windowMinutes?: number;
  resetsAt?: number;
};
type GeminiModelUsage = {
  modelId: string;
  remainingPercent: number;
  remainingAmount?: string | number;
  resetsAt?: number;
};
type Account = {
  provider?: "codex" | "antigravity";
  id: string;
  name: string;
  enabled: boolean;
  accountId?: string;
  projectId?: string;
  email?: string;
  principalId: string;
  cooldownUntil: number;
  failureCount: number;
  lastStatus?: number;
  lastResetAt?: number;
  resetCount?: number;
  lastResetStatus?: string;
  usage?: {
    primary?: UsageWindow;
    secondary?: UsageWindow;
    geminiModels?: GeminiModelUsage[];
    creditsBalance?: number;
    resetCreditsAvailable?: number;
    capturedAt: number;
    error?: string;
  };
};
type ProxyKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt?: number;
  revokedAt?: number;
  recoverable?: boolean;
};
type Settings = {
  selectionStrategy: string;
  serviceTier: "standard" | "fast";
  maxAccountAttempts: number;
  tokenExpiryBufferMinutes: number;
  rateLimitCooldownSeconds: number;
  authCooldownSeconds: number;
  serverErrorCooldownSeconds: number;
  autoResetExhaustedAccounts: boolean;
};
type Model = ModelMetadata;
type Stats = {
  totals: Record<string, number>;
  models: Array<Record<string, any>>;
  recent: Array<Record<string, any>>;
  retentionLimit?: number;
};
type Toast = { title: string; message: string; error?: boolean };
type Dialog = "import" | "device" | "browser" | "antigravity" | "key" | null;
type AppInfo = { version?: string; author?: string; repository?: string };

const validViews = new Set([
  "home",
  "accounts",
  "keys",
  "models",
  "usage",
  "settings",
]);
const hashView = (): View => {
  const value = location.hash.slice(1);
  return (validViews.has(value) ? value : "home") as View;
};
const browserLanguages = () =>
  navigator.languages?.length ? navigator.languages : [navigator.language];

function Root() {
  const [language, setLanguageState] = useState<LanguagePreference>(() => {
    try {
      return parseLanguagePreference(localStorage.getItem("codex-language"));
    } catch {
      return "system";
    }
  });
  const [languages, setLanguages] =
    useState<readonly string[]>(browserLanguages);
  const locale = resolveLocale(language, languages);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, "documentTitle");
  }, [locale]);
  useEffect(() => {
    const update = () => setLanguages(browserLanguages());
    addEventListener("languagechange", update);
    return () => removeEventListener("languagechange", update);
  }, []);
  const setLanguage = (value: LanguagePreference) => {
    try {
      localStorage.setItem("codex-language", value);
    } catch {}
    setLanguageState(value);
  };
  return (
    <I18nProvider locale={locale}>
      <App language={language} setLanguage={setLanguage} />
    </I18nProvider>
  );
}

function App({
  language,
  setLanguage,
}: {
  language: LanguagePreference;
  setLanguage: (value: LanguagePreference) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<View>(hashView());
  const [theme, setThemeState] = useState(
    document.documentElement.dataset.theme || "system",
  );
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]),
    [keys, setKeys] = useState<ProxyKey[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null),
    [models, setModels] = useState<Model[] | null>(null),
    [stats, setStats] = useState<Stats | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState<Toast | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo>({});
  const notify = (title: string, text: string, error = false) =>
    setToast({ title, message: text, error });
  const loadCore = async () => {
    const [a, k, s, r] = await Promise.all([
      api<{ accounts: Account[] }>("/admin/api/accounts"),
      api<{ keys: ProxyKey[] }>("/admin/api/proxy-keys"),
      api<{ settings: Settings }>("/admin/api/settings"),
      api<Stats>("/admin/api/request-stats"),
    ]);
    setAccounts(a.accounts || []);
    setKeys(k.keys || []);
    setSettings(s.settings);
    setStats(r);
  };
  const loadModels = async (refresh = false) => {
    try {
      const data = await api<{ data: Model[] }>(
        `/admin/api/models${refresh ? "?refresh=1" : ""}`,
      );
      setModels(data.data || []);
      if (refresh)
        notify(
          t("modelsRefreshed"),
          t("modelsReadCount", { count: data.data?.length || 0 }),
        );
    } catch (error) {
      setModels([]);
      notify(t("modelsLoadFailed"), message(error, t("requestFailed")), true);
    }
  };
  useEffect(() => {
    loadCore()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    fetch("/admin/assets/app-info.json")
      .then((response) => (response.ok ? response.json() : {}))
      .then(setAppInfo)
      .catch(() => setAppInfo({}));
  }, []);
  useEffect(() => {
    const update = () => setView(hashView());
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    if (view === "models" && models === null) loadModels();
  }, [view]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  const setTheme = (value: string) => {
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("codex-theme", value);
    } catch {}
    setThemeState(value);
  };
  const refreshUsage = async () => {
    try {
      const data = await api<{ accounts: Account[] }>(
        "/admin/api/accounts/usage",
        { method: "POST", body: "{}" },
      );
      setAccounts(data.accounts || []);
      notify(t("quotaRefreshed"), t("quotaRefreshedText"));
    } catch (error) {
      notify(t("refreshFailed"), message(error, t("requestFailed")), true);
    }
  };
  const logout = async () => {
    await api("/admin/api/session", { method: "DELETE" }).catch(() => {});
    setAccounts([]);
    setKeys([]);
    setModels(null);
    setStats(null);
    setSettings(null);
    setAuthenticated(false);
  };
  if (authenticated === null)
    return <div class="loading">{t("loadingPool")}</div>;
  if (!authenticated)
    return (
      <>
        <Login
          onSuccess={async () => {
            await loadCore();
            setAuthenticated(true);
          }}
          notify={notify}
        />
        {toast && <ToastMessage toast={toast} />}
      </>
    );
  const refreshStats = async () => {
    try {
      const data = await api<Stats>("/admin/api/request-stats");
      setStats(data);
      notify(t("statsRefreshed"), t("statsRefreshedText"));
    } catch (error) {
      notify(t("refreshFailed"), message(error, t("requestFailed")), true);
    }
  };
  return (
    <>
      <AppShell view={view} onLogout={logout}>
        {view === "home" && (
          <Home
            accounts={accounts}
            keys={keys}
            models={models}
            stats={stats}
            settings={settings}
          />
        )}
        {view === "accounts" && (
          <Accounts
            accounts={accounts}
            setAccounts={setAccounts}
            open={setDialog}
            refresh={refreshUsage}
            notify={notify}
          />
        )}
        {view === "keys" && (
          <Keys
            keys={keys}
            setKeys={setKeys}
            open={setDialog}
            notify={notify}
          />
        )}
        {view === "models" && (
          <Models models={models} refresh={() => loadModels(true)} notify={notify} />
        )}
        {view === "usage" && <Usage stats={stats} refresh={refreshStats} />}
        {view === "settings" && settings && (
          <SettingsPage
            settings={settings}
            setSettings={setSettings}
            notify={notify}
            theme={theme}
            language={language}
            appInfo={appInfo}
            onTheme={setTheme}
            onLanguage={setLanguage}
          />
        )}
      </AppShell>
      <Dialogs
        dialog={dialog}
        close={() => setDialog(null)}
        reloadAccounts={async () => {
          const data = await api<{ accounts: Account[] }>(
            "/admin/api/accounts",
          );
          setAccounts(data.accounts || []);
        }}
        reloadKeys={async () => {
          const data = await api<{ keys: ProxyKey[] }>("/admin/api/proxy-keys");
          setKeys(data.keys || []);
        }}
        notify={notify}
      />
      {toast && <ToastMessage toast={toast} />}
    </>
  );
}

function ToastMessage({ toast }: { toast: Toast }) {
  return (
    <div class={`toast ${toast.error ? "error" : ""}`} role="status">
      <strong>{toast.title}</strong>
      <span>{toast.message}</span>
    </div>
  );
}
function Login({
  onSuccess,
  notify,
}: {
  onSuccess: () => Promise<void>;
  notify: Function;
}) {
  const { t } = useI18n();
  const [key, setKey] = useState("");
  const submit = async (event: Event) => {
    event.preventDefault();
    try {
      await api("/admin/api/session", {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      await onSuccess();
    } catch (error) {
      notify(t("loginFailed"), message(error, t("requestFailed")), true);
    }
  };
  return (
    <main class="login">
      <form class="login-card" onSubmit={submit}>
        <Logo large />
        <h1>{t("loginTitle")}</h1>
        <p>{t("loginHelp")}</p>
        <label>
          {t("adminKey")}
          <input
            type="password"
            value={key}
            onInput={(event) => setKey(event.currentTarget.value)}
            autoComplete="current-password"
          />
        </label>
        <Button tone="primary" type="submit">
          {t("login")}
        </Button>
      </form>
    </main>
  );
}

function Home({ accounts, keys, models, stats, settings }: any) {
  const { locale, t } = useI18n();
  const healthy = accounts.filter(
    (a: Account) => a.enabled && a.cooldownUntil <= Date.now(),
  ).length;
  const cards: Array<[View, TranslationKey, string, TranslationKey]> = [
    [
      "accounts",
      "navAccounts",
      t("accountsCount", { total: accounts.length, healthy }),
      "accountsDescription",
    ],
    [
      "keys",
      "navKeys",
      t("validKeysCount", {
        count: keys.filter((k: ProxyKey) => !k.revokedAt).length,
      }),
      "keysDescription",
    ],
    [
      "models",
      "navModels",
      models ? t("modelsCount", { count: models.length }) : t("modelsLoadHint"),
      "modelsDescription",
    ],
    [
      "usage",
      "navUsage",
      t("requestsCount", {
        count: formatNumber(locale, stats?.totals?.requests),
      }),
      "usageDescriptionShort",
    ],
    [
      "settings",
      "navSettings",
      strategyLabel(settings?.selectionStrategy, t),
      "settingsDescriptionShort",
    ],
  ];
  return (
    <>
      <PageHeader
        eyebrow="Cloudflare Durable Objects"
        title={t("homeTitle")}
        description={t("homeDescription")}
      />
      <div class="stats">
        <Stat
          label={t("totalAccounts")}
          value={formatNumber(locale, accounts.length)}
        />
        <Stat
          label={t("availableAccounts")}
          value={formatNumber(locale, healthy)}
        />
        <Stat
          label={t("unavailableAccounts")}
          value={formatNumber(locale, accounts.length - healthy)}
        />
      </div>
      <div class="card-grid">
        {cards.map(([id, title, value, text]) => (
          <Panel class="home-card">
            <h3>{t(title)}</h3>
            <strong class="card-value">{value}</strong>
            <p>{t(text)}</p>
            <a class="button" href={`#${id}`}>
              {t("openSection", { section: t(title) })}
            </a>
          </Panel>
        ))}
      </div>
    </>
  );
}

function Accounts({ accounts, setAccounts, open, refresh, notify }: any) {
  const { locale, t } = useI18n();
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"all" | "antigravity" | "codex">("all");

  const agAccounts = accounts.filter((a: Account) => a.provider === "antigravity");
  const codexAccounts = accounts.filter((a: Account) => a.provider !== "antigravity");

  const toggle = async (account: Account) => {
    try {
      await api(`/admin/api/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !account.enabled }),
      });
      setAccounts(
        accounts.map((a: Account) =>
          a.id === account.id ? { ...a, enabled: !a.enabled } : a,
        ),
      );
    } catch (error) {
      notify(t("operationFailed"), message(error, t("requestFailed")), true);
    }
  };
  const reset = async (account: Account) => {
    if (!confirm(t("resetAccountConfirm", { name: account.name }))) return;
    try {
      const data = await api<{ account: Account }>(
        `/admin/api/accounts/${encodeURIComponent(account.id)}/reset`,
        { method: "POST", body: "{}" },
      );
      setAccounts(
        accounts.map((a: Account) => (a.id === account.id ? data.account : a)),
      );
      notify(t("resetSucceeded"), t("resetSucceededText"));
    } catch (error) {
      notify(t("resetFailed"), message(error, t("requestFailed")), true);
    }
  };
  const rename = async (account: Account) => {
    const name = prompt(t("accountRenamePrompt"), account.name)?.trim();
    if (!name || name === account.name) return;
    try {
      const data = await api<{ account: Account }>(
        `/admin/api/accounts/${encodeURIComponent(account.id)}`,
        { method: "PATCH", body: JSON.stringify({ name }) },
      );
      setAccounts(
        accounts.map((a: Account) => (a.id === account.id ? data.account : a)),
      );
      notify(t("accountRenamed"), t("accountRenamedText"));
    } catch (error) {
      notify(t("renameFailed"), message(error, t("requestFailed")), true);
    }
  };
  const remove = async (account: Account) => {
    if (!confirm(t("deleteAccountConfirm", { name: account.name }))) return;
    try {
      await api(`/admin/api/accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
      });
      setAccounts(accounts.filter((a: Account) => a.id !== account.id));
    } catch (error) {
      notify(t("deleteFailed"), message(error, t("requestFailed")), true);
    }
  };

  const renderRow = (account: Account) => {
    const isAntigravity = account.provider === "antigravity";
    const identity = account.email || account.principalId || "";
    const workspace = isAntigravity ? account.projectId : account.accountId;
    const isRevealed = Boolean(revealed[account.id]);
    return (
      <article key={account.id} class="account-row">
        <div class="identity">
          <span class="avatar">
            {(account.name || "A")[0].toUpperCase()}
          </span>
          <div>
            <h3>
              {account.name}{" "}
              <span class="status disabled">
                {t(isAntigravity ? "providerAntigravity" : "providerCodex")}
              </span>
            </h3>
            <p class="masked-identity identity-line">
              <span>{isRevealed ? identity : maskIdentity(identity)}</span>
              <Button
                class="identity-toggle"
                aria-label={t(
                  isRevealed
                    ? "hideAccountIdentity"
                    : "revealAccountIdentity",
                  { name: account.name },
                )}
                onClick={() =>
                  setRevealed({
                    ...revealed,
                    [account.id]: !isRevealed,
                  })
                }
              >
                <Icon name={isRevealed ? "eyeOff" : "eye"} />
              </Button>
            </p>
            {workspace && (
              <small class="identity-line">
                <span>
                  {t(isAntigravity ? "project" : "workspace")}: {isRevealed
                    ? workspace
                    : maskIdentity(workspace)}
                </span>
              </small>
            )}
            {account.usage && !account.usage.error && (
              <small class="usage-snapshot">
                {t("quotaCaptured", {
                  date: formatDate(locale, account.usage.capturedAt),
                })}
                {account.usage.creditsBalance !== undefined
                  ? ` · ${t("creditsBalance", { balance: formatNumber(locale, account.usage.creditsBalance) })}`
                  : ""}
                {account.usage.resetCreditsAvailable !== undefined
                  ? ` · ${t("resetCredits", { count: formatNumber(locale, account.usage.resetCreditsAvailable) })}`
                  : ""}
              </small>
            )}
          </div>
        </div>
        {isAntigravity ? (
          <>
            <Quota
              label={t("fiveHourLimit")}
              window={account.usage?.primary}
              error={account.usage?.error}
            />
            <AntigravityModelQuota
              models={account.usage?.geminiModels}
              primaryWindow={account.usage?.primary}
              secondaryWindow={account.usage?.secondary}
              error={account.usage?.error}
            />
          </>
        ) : (
          <>
            <Quota
              label={t("primaryQuota")}
              window={account.usage?.primary}
              error={account.usage?.error}
            />
            <Quota
              label={t("secondaryQuota")}
              window={account.usage?.secondary}
              error={account.usage?.error}
            />
          </>
        )}
        <div>
          <span
            class={`status ${account.enabled && account.cooldownUntil <= Date.now() ? "healthy" : "disabled"}`}
          >
            {!account.enabled
              ? t("disabled")
              : account.cooldownUntil > Date.now()
                ? t("coolingDown")
                : t("available")}
          </span>
          <small class="account-health">
            {t("failures", {
              count: formatNumber(locale, account.failureCount),
            })}
            {account.lastStatus
              ? ` · HTTP ${account.lastStatus}`
              : ""}
          </small>
          {!isAntigravity && account.lastResetAt && (
            <small>
              {t("lastReset", {
                date: formatDate(locale, account.lastResetAt),
                status: t(resetStatusKey(account.lastResetStatus)),
              })}
            </small>
          )}
        </div>
        <div class="row-actions">
          <Button onClick={() => rename(account)}>
            {t("rename")}
          </Button>
          {!isAntigravity && (
            <Button onClick={() => reset(account)}>
              {t("resetQuota")}
            </Button>
          )}
          <Button onClick={() => toggle(account)}>
            {account.enabled ? t("disable") : t("enable")}
          </Button>
          <Button tone="danger" onClick={() => remove(account)}>
            {t("delete")}
          </Button>
        </div>
      </article>
    );
  };

  return (
    <>
      <PageHeader
        eyebrow={t("accountEyebrow")}
        title={t("accountTitle")}
        description={t("accountDescription")}
        actions={
          <>
            <Button onClick={refresh}>{t("refreshQuota")}</Button>
            <Button onClick={() => open("import")}>{t("manualImport")}</Button>
            <Button onClick={() => open("browser")}>
              {t("copyLinkLogin")}
            </Button>
            <Button tone="primary" onClick={() => open("device")}>
              {t("chatgptLogin")}
            </Button>
          </>
        }
      />
      {accounts.length ? (
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
          <button
            type="button"
            class={`button ${tab === "all" ? "primary" : ""}`}
            onClick={() => setTab("all")}
          >
            {t("tabAll")} ({accounts.length})
          </button>
          <button
            type="button"
            class={`button ${tab === "antigravity" ? "primary" : ""}`}
            onClick={() => setTab("antigravity")}
          >
            {t("tabAntigravity")} ({agAccounts.length})
          </button>
          <button
            type="button"
            class={`button ${tab === "codex" ? "primary" : ""}`}
            onClick={() => setTab("codex")}
          >
            {t("tabCodex")} ({codexAccounts.length})
          </button>
        </div>
      ) : null}

      {!accounts.length ? (
        <Panel title={t("accountsAndQuota")} subtitle={t("serverOnlyTokens")}>
          <div class="list">
            <Empty
              title={t("noAccounts")}
              text={t("noAccountsText")}
              actions={
                <>
                  <Button onClick={() => open("browser")}>
                    {t("copyLinkLogin")}
                  </Button>
                  <Button tone="primary" onClick={() => open("device")}>
                    {t("chatgptLogin")}
                  </Button>
                </>
              }
            />
          </div>
        </Panel>
      ) : tab === "antigravity" ? (
        <Panel title={t("antigravitySectionTitle")} subtitle={t("serverOnlyTokens")}>
          <div class="list">
            {agAccounts.length ? agAccounts.map(renderRow) : <Empty title={t("noAccounts")} text={t("noAccountsText")} />}
          </div>
        </Panel>
      ) : tab === "codex" ? (
        <Panel title={t("codexSectionTitle")} subtitle={t("serverOnlyTokens")}>
          <div class="list">
            {codexAccounts.length ? codexAccounts.map(renderRow) : <Empty title={t("noAccounts")} text={t("noAccountsText")} />}
          </div>
        </Panel>
      ) : (
        <>
          {agAccounts.length > 0 && (
            <Panel title={t("antigravitySectionTitle")} subtitle={t("serverOnlyTokens")}>
              <div class="list">
                {agAccounts.map(renderRow)}
              </div>
            </Panel>
          )}
          {codexAccounts.length > 0 && (
            <Panel title={t("codexSectionTitle")} subtitle={t("serverOnlyTokens")}>
              <div class="list">
                {codexAccounts.map(renderRow)}
              </div>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
function Quota({
  label,
  window,
  error,
}: {
  label: string;
  window?: UsageWindow;
  error?: string;
}) {
  const { locale, t } = useI18n();
  if (error || !window)
    return (
      <div class="quota">
        <small>{label}</small>
        <span title={error}>{error || t("quotaNotRefreshed")}</span>
      </div>
    );
  const value = Math.max(
    0,
    Math.min(100, Number(window.remainingPercent) || 0),
  );
  const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
  const windowSeconds = window.windowSeconds ??
    (window.windowMinutes !== undefined ? window.windowMinutes * 60 : undefined);
  return (
    <div class="quota">
      <div class="quota-head">
        <small>{label}</small>
        <strong>{formatPercent(locale, value / 100)}</strong>
      </div>
      <div class="quota-track">
        <i style={{ width: `${value}%` }} />
      </div>
      <span class="quota-meta">
        {t("quotaUsed", { percent: formatPercent(locale, used / 100) })}
        {windowSeconds !== undefined
          ? ` / ${t("quotaWindowShort", { duration: formatDuration(locale, windowSeconds) })}`
          : ""}
        {window.resetsAt !== undefined
          ? ` / ${t("resetsIn", { duration: formatUntilReset(locale, window.resetsAt) })}`
          : ""}
      </span>
    </div>
  );
}

function AntigravityModelQuota({
  models,
  primaryWindow,
  secondaryWindow,
  error,
}: {
  models?: GeminiModelUsage[];
  primaryWindow?: UsageWindow;
  secondaryWindow?: UsageWindow;
  error?: string;
}) {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);

  if (error || !models?.length)
    return (
      <div class="quota">
        <small>{t("weeklyLimit")}</small>
        <span title={error}>{error || t("quotaNotRefreshed")}</span>
      </div>
    );

  const secVal = secondaryWindow
    ? Math.max(0, Math.min(100, Number(secondaryWindow.remainingPercent) || 0))
    : undefined;

  return (
    <>
      <div class="quota">
        <div class="quota-head">
          <small>{t("weeklyLimit")}</small>
          <button
            type="button"
            class="button ghost"
            style={{ padding: "0 6px", fontSize: "11px", height: "20px", minHeight: "20px" }}
            onClick={() => setOpen(true)}
          >
            {t("viewGroupQuotas")}
          </button>
        </div>
        {secVal !== undefined ? (
          <>
            <div class="quota-track">
              <i style={{ width: `${secVal}%` }} />
            </div>
            <span class="quota-meta">
              {t("quotaRemainingLabel", { percent: formatPercent(locale, secVal / 100) })}
              {secondaryWindow?.resetsAt !== undefined
                ? ` / ${t("resetsInSuffix", { duration: formatUntilReset(locale, secondaryWindow.resetsAt) })}`
                : ""}
            </span>
          </>
        ) : (
          <>
            <div class="quota-track">
              <i style={{ width: "100%" }} />
            </div>
            <span class="quota-meta">
              {t("quotaAvailable")} · <a href="javascript:void(0)" onClick={() => setOpen(true)} style={{ textDecoration: "underline", color: "var(--brand-text)" }}>{t("viewGroupQuotas")}</a>
            </span>
          </>
        )}
      </div>

      {open && (
        <AntigravityQuotaModal
          models={models}
          primaryWindow={primaryWindow}
          secondaryWindow={secondaryWindow}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

function AntigravityQuotaModal({
  models,
  primaryWindow,
  secondaryWindow,
  close,
}: {
  models: GeminiModelUsage[];
  primaryWindow?: UsageWindow;
  secondaryWindow?: UsageWindow;
  close: () => void;
}) {
  const { locale, t } = useI18n();

  const geminiList = models.filter((m) => m.modelId.toLowerCase().includes("gemini"));
  const claudeGptList = models.filter((m) => {
    const id = m.modelId.toLowerCase();
    return id.includes("claude") || id.includes("gpt") || id.includes("opus") || id.includes("sonnet");
  });
  const otherList = models.filter((m) => !geminiList.includes(m) && !claudeGptList.includes(m));

  const groups = [
    {
      title: t("groupGemini"),
      models: geminiList,
      defaultIncluded: "Gemini 2.5 Pro, Gemini 2.5 Flash, Gemini 3 Pro",
    },
    {
      title: t("groupClaudeGpt"),
      models: claudeGptList,
      defaultIncluded: "Claude Opus, Claude 3.7 Sonnet, Claude 3.5 Sonnet, GPT-OSS",
    },
    ...(otherList.length
      ? [
          {
            title: t("groupOther"),
            models: otherList,
            defaultIncluded: otherList.map((m) => m.modelId).join(", "),
          },
        ]
      : []),
  ];

  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <Modal
      title={t("modelQuotaTitle")}
      subtitle={t("modelQuotaSummary", { count: models.length })}
      close={close}
      footer={
        <Button tone="primary" onClick={close}>
          {t("close")}
        </Button>
      }
    >
      <div
        style={{
          display: "grid",
          gap: "16px",
          maxHeight: "65vh",
          overflowY: "auto",
          padding: "4px 0",
        }}
      >
        {groups.map((group) => {
          const groupModels = group.models;
          const includedText = groupModels.length
            ? groupModels.map((m) => m.modelId).join(", ")
            : group.defaultIncluded;

          const shortTerm = groupModels.filter(
            (m) => m.resetsAt && m.resetsAt - nowSec <= 24 * 3600,
          );
          const longTerm = groupModels.filter(
            (m) => m.resetsAt && m.resetsAt - nowSec > 24 * 3600,
          );

          const fiveHourItem = shortTerm.length
            ? shortTerm.reduce((min, m) =>
                m.remainingPercent < min.remainingPercent ? m : min,
              )
            : groupModels.length
              ? groupModels[0]
              : undefined;

          const weeklyItem = longTerm.length
            ? longTerm.reduce((min, m) =>
                m.remainingPercent < min.remainingPercent ? m : min,
              )
            : undefined;

          const fiveHourVal = fiveHourItem
            ? Math.max(0, Math.min(100, fiveHourItem.remainingPercent))
            : primaryWindow
              ? Math.max(0, Math.min(100, primaryWindow.remainingPercent))
              : 100;
          const fiveHourReset = fiveHourItem?.resetsAt ?? primaryWindow?.resetsAt;

          const weeklyVal = weeklyItem
            ? Math.max(0, Math.min(100, weeklyItem.remainingPercent))
            : secondaryWindow
              ? Math.max(0, Math.min(100, secondaryWindow.remainingPercent))
              : 100;
          const weeklyReset = weeklyItem?.resetsAt ?? secondaryWindow?.resetsAt;

          return (
            <div
              key={group.title}
              style={{
                border: "1px solid var(--line)",
                borderRadius: "8px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "12px 16px",
                  background: "var(--surface-subtle)",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <strong style={{ fontSize: "14px", display: "block" }}>
                  {group.title}
                </strong>
                <small
                  style={{
                    color: "var(--muted)",
                    display: "block",
                    marginTop: "3px",
                  }}
                >
                  {t("groupIncludes", { models: includedText })}
                </small>
              </div>
              <div
                style={{
                  padding: "14px 16px",
                  display: "grid",
                  gap: "14px",
                }}
              >
                <div class="quota">
                  <div class="quota-head">
                    <small style={{ fontWeight: 600 }}>{t("fiveHourLimit")}</small>
                    <strong style={{ fontSize: "12px" }}>
                      {fiveHourVal < 100
                        ? t("quotaRemainingLabel", {
                            percent: formatPercent(locale, fiveHourVal / 100),
                          })
                        : t("quotaAvailable")}
                    </strong>
                  </div>
                  <div class="quota-track">
                    <i style={{ width: `${fiveHourVal}%` }} />
                  </div>
                  <span class="quota-meta">
                    {fiveHourReset
                      ? t("resetsInSuffix", {
                          duration: formatUntilReset(locale, fiveHourReset),
                        })
                      : t("quotaAvailable")}
                  </span>
                </div>

                <div class="quota">
                  <div class="quota-head">
                    <small style={{ fontWeight: 600 }}>{t("weeklyLimit")}</small>
                    <strong style={{ fontSize: "12px" }}>
                      {weeklyVal < 100
                        ? t("quotaRemainingLabel", {
                            percent: formatPercent(locale, weeklyVal / 100),
                          })
                        : t("quotaAvailable")}
                    </strong>
                  </div>
                  <div class="quota-track">
                    <i style={{ width: `${weeklyVal}%` }} />
                  </div>
                  <span class="quota-meta">
                    {weeklyReset
                      ? t("resetsInSuffix", {
                          duration: formatUntilReset(locale, weeklyReset),
                        })
                      : t("quotaAvailable")}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function Keys({ keys, setKeys, open, notify }: any) {
  const { locale, t } = useI18n();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const reveal = async (key: ProxyKey) => {
    if (revealed[key.id]) {
      const copy = { ...revealed };
      delete copy[key.id];
      setRevealed(copy);
      return;
    }
    try {
      const data = await api<{ key: string }>(
        `/admin/api/proxy-keys/${encodeURIComponent(key.id)}/reveal`,
      );
      setRevealed({ ...revealed, [key.id]: data.key });
    } catch (error) {
      notify(t("revealFailed"), message(error, t("requestFailed")), true);
    }
  };
  const revoke = async (key: ProxyKey) => {
    if (!confirm(t("revokeConfirm", { name: key.name }))) return;
    try {
      await api(`/admin/api/proxy-keys/${encodeURIComponent(key.id)}`, {
        method: "DELETE",
      });
      setKeys(keys.filter((item: ProxyKey) => item.id !== key.id));
    } catch (error) {
      notify(t("revokeFailed"), message(error, t("requestFailed")), true);
    }
  };
  const rename = async (key: ProxyKey) => {
    const name = prompt(t("keyRenamePrompt"), key.name)?.trim();
    if (!name || name === key.name) return;
    try {
      const data = await api<{ key: ProxyKey }>(
        `/admin/api/proxy-keys/${encodeURIComponent(key.id)}`,
        { method: "PATCH", body: JSON.stringify({ name }) },
      );
      setKeys(keys.map((item: ProxyKey) => (item.id === key.id ? data.key : item)));
      notify(t("keyRenamed"), t("keyRenamedText"));
    } catch (error) {
      notify(t("keyRenameFailed"), message(error, t("requestFailed")), true);
    }
  };
  const apiUrl = `${location.origin}/v1`;
  const copyApiUrl = () =>
    copyText(apiUrl, notify, t, "apiUrlCopied");
  return (
    <>
      <PageHeader
        eyebrow={t("keysEyebrow")}
        title={t("keysTitle")}
        description={t("keysDescriptionLong")}
        actions={
          <Button tone="primary" onClick={() => open("key")}>
            {t("newKey")}
          </Button>
        }
      />
      <Panel
        title={t("clientKeys")}
        subtitle={t("keysSecurity")}
      >
        <div class="copy-field">
          <label for="api-base-url">{t("apiBaseUrl")}</label>
          <input id="api-base-url" value={apiUrl} readOnly />
          <Button onClick={copyApiUrl}>{t("copy")}</Button>
        </div>
        {keys.length ? (
          <div class="list">
            {keys.map((key: ProxyKey) => (
              <article class="key-row">
                <div>
                  <h3>
                    {key.name}{" "}
                    <span
                      class={`status ${key.revokedAt ? "disabled" : "healthy"}`}
                    >
                      {key.revokedAt
                        ? t("revoked")
                        : key.recoverable
                          ? t("active")
                          : t("hashOnly")}
                    </span>
                  </h3>
                  <code>{key.prefix}</code>
                </div>
                <span>
                  {key.createdAt
                    ? formatDate(locale, key.createdAt)
                    : t("createdBeforeUpgrade")}
                </span>
                <div class="row-actions">
                  {!key.revokedAt && (
                    <Button onClick={() => rename(key)}>
                      {t("rename")}
                    </Button>
                  )}
                  {!key.revokedAt && key.recoverable && (
                    <Button onClick={() => reveal(key)}>
                      {revealed[key.id] ? t("hide") : t("reveal")}
                    </Button>
                  )}
                  {!key.revokedAt && (
                    <Button tone="danger" onClick={() => revoke(key)}>
                      {t("revoke")}
                    </Button>
                  )}
                </div>
                {revealed[key.id] && (
                  <div class="revealed">
                    <code>{revealed[key.id]}</code>
                    <Button
                      onClick={() =>
                        navigator.clipboard.writeText(revealed[key.id])
                      }
                    >
                      {t("copy")}
                    </Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title={t("noKeys")}
            text={t("noKeysText")}
            actions={
              <Button tone="primary" onClick={() => open("key")}>
                {t("newKey")}
              </Button>
            }
          />
        )}
      </Panel>
    </>
  );
}

function Models({
  models,
  refresh,
  notify,
}: {
  models: Model[] | null;
  refresh: () => void;
  notify: (title: string, text: string, error?: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const groups = groupModels(models || []);
  return (
    <>
      <PageHeader
        eyebrow={t("modelsEyebrow")}
        title={t("modelsTitle")}
        description={t("modelsDescriptionLong")}
        actions={<Button onClick={refresh}>{t("refreshCatalog")}</Button>}
      />
      <Panel
        title={t("modelCatalog")}
        subtitle={
          models === null
            ? t("loading")
            : t("currentModels", {
                count: formatNumber(
                  locale,
                  groups.reduce(
                    (count, group) => count + group.models.length,
                    0,
                  ),
                ),
              })
        }
      >
        {models?.length ? (
          <div class="model-families">
            {groups.map((group) => (
              <section class="model-family">
                <h2>
                  {t(
                    `modelFamily${group.family[0].toUpperCase()}${group.family.slice(1)}` as TranslationKey,
                  )}
                </h2>
                <div class="model-grid">
                  {group.models.map((model) => (
                    <article class="model-card">
                      <div>
                        <div>
                          <h3>{model.name || model.id}</h3>
                        </div>
                      </div>
                      <div class="badges">
                        <span>
                          {tokenLimit(
                            locale,
                            model.capabilities?.limits
                              ?.max_context_window_tokens,
                            t("unknown"),
                          )}{" "}
                          {t("context")}
                        </span>
                        {typeof model.capabilities?.limits?.max_output_tokens === "number" && (
                          <span>
                            {tokenLimit(
                              locale,
                              model.capabilities.limits.max_output_tokens,
                              t("unknown"),
                            )}{" "}
                            {t("output")}
                          </span>
                        )}
                        {typeof model.capabilities?.limits?.max_prompt_tokens === "number" && (
                          <span>
                            {tokenLimit(
                              locale,
                              model.capabilities.limits.max_prompt_tokens,
                              t("unknown"),
                            )}{" "}
                            {t("prompt")}
                          </span>
                        )}
                        {model.supported_endpoints?.map((endpoint) => (
                          <span>{t("endpointMetadata", { endpoint })}</span>
                        ))}
                        {Object.entries(model.capabilities?.supports || {}).map(
                          ([name, enabled]) => (
                            <span>
                              {t("capabilityMetadata", {
                                capability: name,
                                support: t(
                                  enabled ? "supported" : "unsupported",
                                ),
                              })}
                            </span>
                          ),
                        )}
                        {model.vendor && (
                          <span>
                            {t("vendorMetadata", { vendor: model.vendor })}
                          </span>
                        )}
                        {model.version && (
                          <span>
                            {t("versionMetadata", { version: model.version })}
                          </span>
                        )}
                        {model.category && (
                          <span>
                            {t("categoryMetadata", {
                              category: model.category,
                            })}
                          </span>
                        )}
                        {model.preview === true && <span>{t("preview")}</span>}
                      </div>
                      <div class="copy-chips" aria-label={t("copyOptions")}>
                        <button
                          type="button"
                          onClick={() => copyText(model.id, notify, t, "modelNameCopied")}
                        >
                          {model.id}
                        </button>
                        {model.reasoning_efforts.map((effort) => (
                          <button
                            type="button"
                            onClick={() => copyText(modelVariantId(model, effort), notify, t, "modelReasoningCopied")}
                          >
                            {modelVariantId(model, effort)}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <Empty
            title={models === null ? t("loadingModels") : t("noModels")}
            text={t("noModelsText")}
          />
        )}
      </Panel>
    </>
  );
}

function Usage({
  stats,
  refresh,
}: {
  stats: Stats | null;
  refresh: () => void;
}) {
  const { locale, t } = useI18n();
  const totals = stats?.totals || {};
  return (
    <>
      <PageHeader
        eyebrow={t("usageEyebrow")}
        title={t("usageTitle")}
        description={t("usageDescription")}
        actions={<Button onClick={refresh}>{t("refreshStats")}</Button>}
      />
      <div class="stats four">
        <Stat
          label={t("totalRequests")}
          value={formatNumber(locale, totals.requests)}
        />
        <Stat
          label={t("inputTokens")}
          value={formatNumber(locale, totals.inputTokens)}
        />
        <Stat
          label={t("outputTokens")}
          value={formatNumber(locale, totals.outputTokens)}
        />
        <Stat
          label={t("totalTokens")}
          value={formatNumber(locale, totals.totalTokens)}
        />
      </div>
      <div class="chart-grid">
        <Panel title={t("requestTrend")} subtitle={t("requestTrendSubtitle")}>
          <TrendChart records={stats?.recent || []} />
        </Panel>
        <Panel
          title={t("modelDistribution")}
          subtitle={t("modelDistributionSubtitle")}
        >
          <ModelChart models={stats?.models || []} />
        </Panel>
      </div>
      <Panel title={t("byModel")}>
        <Table
          headers={[
            t("model"),
            t("requests"),
            t("success"),
            t("inputTokens"),
            t("outputTokens"),
            t("totalTokens"),
            t("recentRequest"),
          ]}
          rows={(stats?.models || []).map((item) => [
            item.model,
            formatNumber(locale, item.requests),
            formatNumber(locale, item.successfulRequests),
            formatNumber(locale, item.inputTokens),
            formatNumber(locale, item.outputTokens),
            formatNumber(locale, item.totalTokens),
            formatDate(locale, item.lastRequestedAt),
          ])}
        />
      </Panel>
      <Panel
        title={t("recentRequests")}
        subtitle={t("recentRetention", { count: stats?.retentionLimit || 200 })}
      >
        <Table
          headers={[
            t("time"),
            t("model"),
            t("endpoint"),
            t("status"),
            t("duration"),
            t("tokens"),
            t("mode"),
          ]}
          rows={(stats?.recent || []).map((item) => [
            formatDate(locale, item.createdAt),
            item.model,
            item.endpoint,
            item.status,
            `${formatNumber(locale, item.durationMs)} ms`,
            item.usage?.available
              ? formatNumber(locale, item.usage.totalTokens)
              : "—",
            item.streaming ? t("streaming") : t("standard"),
          ])}
        />
      </Panel>
    </>
  );
}

function TrendChart({ records }: { records: Array<Record<string, any>> }) {
  const { locale, t } = useI18n();
  const buckets = aggregateRequestTrend(
    records,
    records.length > 120 ? 24 : 12,
  );
  if (!buckets.length) return <ChartEmpty />;
  const max = Math.max(1, ...buckets.map((b) => b.requests));
  const points = buckets
    .map(
      (b, index) =>
        `${16 + index * (568 / Math.max(1, buckets.length - 1))},${144 - (b.requests / max) * 112}`,
    )
    .join(" ");
  return (
    <div class="chart">
      <svg viewBox="0 0 600 170" role="img" aria-label={t("requestTrendAria")}>
        <g class="chart-grid-lines">
          <path d="M16 32H584M16 88H584M16 144H584" />
        </g>
        <polyline class="trend-area" points={`16,144 ${points} 584,144`} />
        <polyline class="trend-line" points={points} />
        {buckets.map((bucket, index) => {
          const x = 16 + index * (568 / Math.max(1, buckets.length - 1)),
            y = 144 - (bucket.requests / max) * 112;
          const label = t("chartBucket", {
            time: formatDate(locale, bucket.start),
            requests: formatNumber(locale, bucket.requests),
            successful: formatNumber(locale, bucket.successful),
            tokens: formatNumber(locale, bucket.tokens),
          });
          return (
            <circle cx={x} cy={y} r="4" tabIndex={0} aria-label={label}>
              <title>{label}</title>
            </circle>
          );
        })}
      </svg>
      <div class="chart-legend">
        <span class="legend-request">{t("requests")}</span>
        <span>
          {formatDate(locale, buckets[0].start)} –{" "}
          {formatDate(locale, buckets[buckets.length - 1].end)}
        </span>
      </div>
    </div>
  );
}
function ModelChart({ models }: { models: Array<Record<string, any>> }) {
  const { locale, t } = useI18n();
  const items = aggregateModelDistribution(models, 5, t("other"));
  const total = items.reduce((sum, item) => sum + item.requests, 0);
  if (!total) return <ChartEmpty />;
  const colors = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "var(--chart-other)",
  ];
  let offset = 0;
  return (
    <div class="model-chart">
      <svg
        viewBox="0 0 160 160"
        role="img"
        aria-label={t("modelDistributionAria")}
      >
        <circle class="donut-track" cx="80" cy="80" r="54" />
        <g transform="rotate(-90 80 80)">
          {items.map((item, index) => {
            const fraction = item.requests / total,
              dash = fraction * 339.292,
              label = t("modelChartItem", {
                model: item.model,
                count: formatNumber(locale, item.requests),
                percent: formatPercent(locale, fraction),
              });
            const circle = (
              <circle
                class="donut-segment"
                cx="80"
                cy="80"
                r="54"
                stroke={colors[index]}
                stroke-dasharray={`${dash} ${339.292 - dash}`}
                stroke-dashoffset={-offset}
                tabIndex={0}
                aria-label={label}
              >
                <title>{label}</title>
              </circle>
            );
            offset += dash;
            return circle;
          })}
        </g>
        <text x="80" y="76" text-anchor="middle">
          {formatNumber(locale, total)}
        </text>
        <text class="donut-label" x="80" y="96" text-anchor="middle">
          {t("requests")}
        </text>
      </svg>
      <ul class="model-legend">
        {items.map((item, index) => (
          <li>
            <i style={{ background: colors[index] }} />
            <span title={item.model}>{item.model}</span>
            <strong>{formatNumber(locale, item.requests)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
function ChartEmpty() {
  const { t } = useI18n();
  return <div class="chart-empty">{t("noChartData")}</div>;
}
function Table({ headers, rows }: { headers: string[]; rows: any[][] }) {
  const { t } = useI18n();
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr>
                {row.map((cell) => (
                  <td>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length}>{t("noRecords")}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

type NumericSettingKey = Exclude<
  keyof Settings,
  "selectionStrategy" | "serviceTier" | "autoResetExhaustedAccounts"
>;
const settingRows: Array<
  [NumericSettingKey, TranslationKey, TranslationKey, number, number]
> = [
  ["maxAccountAttempts", "maxAttempts", "maxAttemptsHelp", 1, 10],
  ["tokenExpiryBufferMinutes", "tokenRefresh", "tokenRefreshHelp", 5, 120],
  ["rateLimitCooldownSeconds", "rateCooldown", "rateCooldownHelp", 5, 900],
  ["authCooldownSeconds", "authCooldown", "authCooldownHelp", 30, 1800],
  [
    "serverErrorCooldownSeconds",
    "serverCooldown",
    "serverCooldownHelp",
    5,
    300,
  ],
];
function SettingsPage({
  settings,
  setSettings,
  notify,
  theme,
  language,
  appInfo,
  onTheme,
  onLanguage,
}: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  notify: Function;
  theme: string;
  language: LanguagePreference;
  appInfo: AppInfo;
  onTheme: (value: string) => void;
  onLanguage: (value: LanguagePreference) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const update = (key: keyof Settings, value: string | number | boolean) =>
    setDraft({ ...draft, [key]: value });
  const save = async () => {
    try {
      const data = await api<{ settings: Settings }>("/admin/api/settings", {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setSettings(data.settings);
      notify(t("settingsSaved"), t("settingsSavedText"));
    } catch (error) {
      notify(t("saveFailed"), message(error, t("requestFailed")), true);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow={t("settingsEyebrow")}
        title={t("settingsTitle")}
        description={t("settingsDescription")}
        actions={
          <Button tone="primary" onClick={save}>
            {t("saveChanges")}
          </Button>
        }
      />
      <Panel
        title={t("appearancePreferences")}
        subtitle={t("appearancePreferencesHelp")}
      >
        <div class="settings preferences">
          <label>
            <span>
              <strong>{t("theme")}</strong>
              <small>{t("themePreferenceHelp")}</small>
            </span>
            <select
              aria-label={t("theme")}
              value={theme}
              onChange={(event) => onTheme(event.currentTarget.value)}
            >
              <option value="system">{t("themeSystem")}</option>
              <option value="light">{t("themeLight")}</option>
              <option value="dark">{t("themeDark")}</option>
            </select>
          </label>
          <label>
            <span>
              <strong>{t("language")}</strong>
              <small>{t("languagePreferenceHelp")}</small>
            </span>
            <select
              aria-label={t("language")}
              value={language}
              onChange={(event) =>
                onLanguage(event.currentTarget.value as LanguagePreference)
              }
            >
              <option value="system">{t("languageSystem")}</option>
              <option value="zh-CN">{t("languageChinese")}</option>
              <option value="en">{t("languageEnglish")}</option>
            </select>
          </label>
        </div>
      </Panel>
      <Panel title={t("runtimeSettings")} subtitle={t("settingsPersist")}>
        <div class="settings">
          <label>
            <span>
              <strong>{t("selectionStrategy")}</strong>
              <small>{t("selectionStrategyHelp")}</small>
            </span>
            <select
              value={draft.selectionStrategy}
              onChange={(e) =>
                update("selectionStrategy", e.currentTarget.value)
              }
            >
              <option value="round_robin">{t("strategyRoundRobin")}</option>
              <option value="least_failures">{t("strategyHealthy")}</option>
              <option value="quota_weighted">{t("strategyQuotaWeighted")}</option>
            </select>
          </label>
          <label>
            <span>
              <strong>{t("autoResetExhausted")}</strong>
              <small>{t("autoResetExhaustedHelp")}</small>
            </span>
            <select
              value={draft.autoResetExhaustedAccounts ? "enabled" : "disabled"}
              onChange={(e) =>
                update(
                  "autoResetExhaustedAccounts",
                  e.currentTarget.value === "enabled",
                )
              }
            >
              <option value="disabled">{t("autoResetDisabled")}</option>
              <option value="enabled">{t("autoResetEnabled")}</option>
            </select>
          </label>
          <label>
            <span>
              <strong>{t("serviceTier")}</strong>
              <small>{t("serviceTierHelp")}</small>
            </span>
            <select
              value={draft.serviceTier}
              onChange={(e) => update("serviceTier", e.currentTarget.value)}
            >
              <option value="standard">{t("serviceTierStandard")}</option>
              <option value="fast">{t("serviceTierFast")}</option>
            </select>
          </label>
          {settingRows.map(([key, title, text, min, max]) => (
            <label>
              <span>
                <strong>{t(title)}</strong>
                <small>{t(text)}</small>
              </span>
              <input
                type="number"
                min={min}
                max={max}
                value={draft[key]}
                onInput={(e) => update(key, Number(e.currentTarget.value))}
              />
            </label>
          ))}
        </div>
      </Panel>
      <Panel
        title={t("projectInfo")}
        subtitle={t("projectInfoHelp")}
        class="compact-panel"
      >
        <div class="settings compact-settings">
          <label>
            <span>
              <strong>{t("projectVersion")}</strong>
              <small>{appInfo.version || t("unknown")}</small>
            </span>
          </label>
          <label>
            <span>
              <strong>{t("projectAuthor")}</strong>
              <small>{appInfo.author || t("unknown")}</small>
            </span>
          </label>
          <label>
            <span>
              <strong>{t("projectRepository")}</strong>
              <small>
                {appInfo.repository ? (
                  <a href={appInfo.repository} target="_blank" rel="noreferrer">
                    {appInfo.repository}
                  </a>
                ) : (
                  t("unknown")
                )}
              </small>
            </span>
          </label>
          <div class="project-images">
            {[
              [
                "projectDonationQr",
                "https://st2.ai55.cc/mywechat/DonationQRCode.png",
              ],
              [
                "projectWechat",
                "https://st2.ai55.cc/mywechat/WeChatIDCode.png",
              ],
              [
                "projectOfficialAccount",
                "https://st2.ai55.cc/mywechat/WeChatOfficialAccount.jpg",
              ],
            ].map(([label, src]) => (
              <details class="project-image" key={label} open>
                <summary>{t(label as TranslationKey)}</summary>
                <img src={src} alt={t(label as TranslationKey)} loading="lazy" />
              </details>
            ))}
          </div>
        </div>
      </Panel>
    </>
  );
}

function Dialogs({ dialog, close, reloadAccounts, reloadKeys, notify }: any) {
  if (!dialog) return null;
  if (dialog === "import")
    return (
      <ImportDialog close={close} reload={reloadAccounts} notify={notify} />
    );
  if (dialog === "key")
    return <KeyDialog close={close} reload={reloadKeys} notify={notify} />;
  return (
    <OAuthDialog
      mode={dialog === "device" ? "device" : "browser"}
      close={close}
      reload={reloadAccounts}
      notify={notify}
    />
  );
}
function Modal({ title, subtitle, close, children, footer }: any) {
  const { t } = useI18n();
  return (
    <div
      class="veil"
      onMouseDown={(e) => e.currentTarget === e.target && close()}
    >
      <section
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header>
          <div>
            <h2 id="dialog-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          <Button class="icon-button" onClick={close} aria-label={t("close")}>
            <Icon name="close" />
          </Button>
        </header>
        <div class="dialog-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}
function ImportDialog({ close, reload, notify }: any) {
  const { t } = useI18n();
  const [name, setName] = useState(""),
    [provider, setProvider] = useState<"codex" | "antigravity">("codex"),
    [payload, setPayload] = useState("");
  const submit = async () => {
    try {
      const body = JSON.parse(payload);
      if (name.trim()) body.name = name.trim();
      if (provider !== "codex") body.provider = provider;
      await api("/admin/api/accounts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await reload();
      close();
      notify(t("accountImported"), t("accountImportedText"));
    } catch (error) {
      notify(
        t("importFailed"),
        error instanceof SyntaxError
          ? t("invalidJson")
          : message(error, t("requestFailed")),
        true,
      );
    }
  };
  return (
    <Modal
      title={t("importTitle")}
      subtitle={t("importSubtitle")}
      close={close}
      footer={
        <>
          <Button onClick={close}>{t("cancel")}</Button>
          <Button tone="primary" onClick={submit}>
            {t("safeImport")}
          </Button>
        </>
      }
    >
      <label>
        {t("accountProvider")}
        <select
          value={provider}
          onChange={(e) =>
            setProvider(e.currentTarget.value as "codex" | "antigravity")
          }
        >
          <option value="codex">{t("providerCodex")}</option>
          <option value="antigravity">{t("providerAntigravity")}</option>
        </select>
      </label>
      <label>
        {t("displayName")}
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        {t("credentialsJson")}
        <textarea
          value={payload}
          onInput={(e) => setPayload(e.currentTarget.value)}
          placeholder={t(
            provider === "antigravity"
              ? "antigravityCredentialsPlaceholder"
              : "codexCredentialsPlaceholder",
          )}
        />
      </label>
    </Modal>
  );
}
function KeyDialog({ close, reload, notify }: any) {
  const { t } = useI18n();
  const [name, setName] = useState(""),
    [key, setKey] = useState("");
  const submit = async () => {
    if (!name.trim()) return notify(t("enterName"), t("keyNameHelp"), true);
    try {
      const data = await api<{ key: string }>("/admin/api/proxy-keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setKey(data.key);
      await reload();
    } catch (error) {
      notify(t("generationFailed"), message(error, t("requestFailed")), true);
    }
  };
  return (
    <Modal
      title={t("newKeyTitle")}
      subtitle={t("newKeySubtitle")}
      close={close}
      footer={
        key ? (
          <Button
            tone="primary"
            onClick={() => navigator.clipboard.writeText(key)}
          >
            {t("copyKey")}
          </Button>
        ) : (
          <Button tone="primary" onClick={submit}>
            {t("generateKey")}
          </Button>
        )
      }
    >
      <label>
        {t("keyName")}
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      {key && (
        <div class="revealed">
          <code>{key}</code>
        </div>
      )}
    </Modal>
  );
}
function OAuthDialog({ mode, close, reload, notify }: any) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<"antigravity" | "codex">("antigravity");
  const [name, setName] = useState(""),
    [login, setLogin] = useState<any>(null),
    [callback, setCallback] = useState("");

  const start = async () => {
    const popup = window.open("about:blank", "oauthLogin");
    if (popup) popup.opener = null;
    const endpoint =
      mode === "device"
        ? "/admin/api/oauth/device/start"
        : provider === "antigravity"
          ? "/admin/api/oauth/antigravity/start"
          : "/admin/api/oauth/browser/start";
    try {
      const data = await api<any>(endpoint, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setLogin(data.login);
      if (popup)
        popup.location.href =
          mode === "device"
            ? data.login.verificationUrl
            : data.login.authorizationUrl;
    } catch (error) {
      popup?.close();
      notify(t("loginStartFailed"), message(error, t("requestFailed")), true);
    }
  };

  useEffect(() => {
    if (mode !== "device" || !login) return;
    const timer = setInterval(
      async () => {
        try {
          const data = await api<any>(
            `/admin/api/oauth/device/${encodeURIComponent(login.id)}`,
            { method: "POST", body: "{}" },
          );
          if (data.status === "complete") {
            clearInterval(timer);
            await reload();
            close();
            notify(t("accountAdded"), t("accountAddedDevice"));
          }
        } catch (error) {
          clearInterval(timer);
          notify(
            t("loginIncomplete"),
            message(error, t("requestFailed")),
            true,
          );
        }
      },
      Math.max(3000, Math.min(30000, (login.intervalSeconds || 5) * 1000)),
    );
    return () => clearInterval(timer);
  }, [login]);

  const cancel = () => {
    if (login) {
      const endpoint =
        mode === "device"
          ? `/admin/api/oauth/device/${encodeURIComponent(login.id)}`
          : provider === "antigravity"
            ? `/admin/api/oauth/antigravity/${encodeURIComponent(login.id)}`
            : `/admin/api/oauth/browser/${encodeURIComponent(login.id)}`;
      api(endpoint, { method: "DELETE" }).catch(() => {});
    }
    close();
  };

  const finish = async () => {
    if (!login || !callback.trim())
      return notify(
        provider === "antigravity" ? t("antigravityCallbackRequired") : t("callbackUrl"),
        provider === "antigravity" ? t("antigravityCallbackHelp") : t("callbackHelp"),
        true,
      );
    const isAntigravity = provider === "antigravity" || callback.includes("51121");
    const endpoint = isAntigravity
      ? `/admin/api/oauth/antigravity/${encodeURIComponent(login.id)}`
      : `/admin/api/oauth/browser/${encodeURIComponent(login.id)}`;
    try {
      await api(endpoint, {
        method: "POST",
        body: JSON.stringify({ callbackUrl: callback.trim() }),
      });
      await reload();
      close();
      if (isAntigravity) {
        notify(t("antigravityAccountAdded"), t("antigravityAccountAddedText"));
      } else {
        notify(t("accountAdded"), t("accountAddedBrowser"));
      }
    } catch (error) {
      notify(t("loginIncomplete"), message(error, t("requestFailed")), true);
    }
  };

  return (
    <Modal
      title={mode === "device" ? t("oauthDeviceTitle") : t("oauthBrowserTitle")}
      subtitle={
        mode === "device" ? t("oauthDeviceSubtitle") : t("oauthBrowserSubtitle")
      }
      close={cancel}
      footer={
        !login ? (
          <Button tone="primary" onClick={start}>
            {t("continueLogin")}
          </Button>
        ) : mode === "browser" ? (
          <>
            <Button onClick={cancel}>{t("cancel")}</Button>
            <Button tone="primary" onClick={finish}>
              {t("finishImport")}
            </Button>
          </>
        ) : (
          <span>{t("waitingAuthorization")}</span>
        )
      }
    >
      {mode === "browser" && !login && (
        <label>
          {t("accountProvider")}
          <select
            value={provider}
            onChange={(e) => setProvider(e.currentTarget.value as "antigravity" | "codex")}
          >
            <option value="antigravity">{t("providerAntigravity")}</option>
            <option value="codex">{t("providerCodex")}</option>
          </select>
        </label>
      )}
      <label>
        {t("displayName")}
        <small>{t("oauthNameHelp")}</small>
        <input
          value={name}
          disabled={!!login}
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>
      {login && mode === "device" && (
        <>
          <label>
            {t("deviceCode")}
            <div class="revealed">
              <code>{login.userCode}</code>
              <Button
                onClick={() => navigator.clipboard.writeText(login.userCode)}
              >
                {t("copy")}
              </Button>
            </div>
          </label>
          <label>
            {t("verificationLink")}
            <a
              class="button"
              href={login.verificationUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("openVerification")}
            </a>
          </label>
        </>
      )}
      {login && mode === "browser" && (
        <>
          <label>
            {t("verificationLink")}
            <a
              class="button"
              href={login.authorizationUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("openVerification")}
            </a>
          </label>
          <label>
            {t("callbackUrl")}
            <small>
              {provider === "antigravity"
                ? t("antigravityCallbackHelp")
                : t("callbackHelp")}
            </small>
            <textarea
              value={callback}
              onInput={(e) => setCallback(e.currentTarget.value)}
              placeholder={
                provider === "antigravity"
                  ? t("antigravityCallbackPlaceholder")
                  : t("callbackPlaceholder")
              }
            />
          </label>
        </>
      )}
    </Modal>
  );
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
const copyText = async (
  value: string,
  notify: (title: string, text: string, error?: boolean) => void,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  successKey: TranslationKey,
) => {
  try {
    await navigator.clipboard.writeText(value);
    notify(t(successKey), value);
  } catch (error) {
    notify(t("copyFailed"), message(error, t("requestFailed")), true);
  }
};
const resetStatusKey = (status: string | undefined): TranslationKey => {
  switch (status) {
    case "reset":
      return "resetStatusreset";
    case "nothingToReset":
      return "resetStatusnothingToReset";
    case "noCredit":
      return "resetStatusnoCredit";
    case "alreadyRedeemed":
      return "resetStatusalreadyRedeemed";
    default:
      return "resetStatusfailed";
  }
};
const strategyLabel = (
  strategy: string | undefined,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
) => {
  if (strategy === "least_failures") return t("strategyHealthy");
  if (strategy === "quota_weighted") return t("strategyQuotaWeighted");
  return t("strategyRoundRobin");
};
const tokenLimit = (
  locale: "zh-CN" | "en",
  value: number | undefined,
  unknown: string,
) => (!value ? unknown : formatNumber(locale, value));
render(<Root />, document.getElementById("app")!);
