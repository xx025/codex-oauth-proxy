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
type CustomApi = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  fallback: boolean;
  priority: number;
  models: Array<{ id: string; name?: string; ownedBy?: string }>;
  enabledModelIds: string[];
  validatedAt: number;
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
type Dialog = "key" | "add-antigravity" | "add-codex" | "add-custom-api" | null;
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
    [keys, setKeys] = useState<ProxyKey[]>([]),
    [customApis, setCustomApis] = useState<CustomApi[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null),
    [models, setModels] = useState<Model[] | null>(null),
    [stats, setStats] = useState<Stats | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null),
    [toast, setToast] = useState<Toast | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo>({});
  const notify = (title: string, text: string, error = false) =>
    setToast({ title, message: text, error });
  const loadCore = async () => {
    const [a, k, c, s, r] = await Promise.all([
      api<{ accounts: Account[] }>("/admin/api/accounts"),
      api<{ keys: ProxyKey[] }>("/admin/api/proxy-keys"),
      api<{ customApis: CustomApi[] }>("/admin/api/custom-apis"),
      api<{ settings: Settings }>("/admin/api/settings"),
      api<Stats>("/admin/api/request-stats"),
    ]);
    setAccounts(a.accounts || []);
    setKeys(k.keys || []);
    setCustomApis(c.customApis || []);
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
            customApis={customApis}
            setCustomApis={setCustomApis}
            invalidateModels={() => setModels(null)}
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
        reloadCustomApis={async () => {
          const data = await api<{ customApis: CustomApi[] }>("/admin/api/custom-apis");
          setCustomApis(data.customApis || []);
          setModels(null);
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

function Accounts({ accounts, setAccounts, customApis, setCustomApis, invalidateModels, open, refresh, notify }: any) {
  const { locale, t } = useI18n();
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<"all" | "antigravity" | "codex" | "custom">("all");
  const [modelApi, setModelApi] = useState<CustomApi | null>(null);

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
  const updateCustomApi = async (customApi: CustomApi, patch: Partial<CustomApi>) => {
    try {
      const data = await api<{ customApi: CustomApi }>(
        `/admin/api/custom-apis/${encodeURIComponent(customApi.id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      setCustomApis(customApis.map((item: CustomApi) => item.id === customApi.id ? data.customApi : item));
      invalidateModels();
      return data.customApi;
    } catch (error) {
      notify(t("operationFailed"), message(error, t("requestFailed")), true);
    }
  };
  const removeCustomApi = async (customApi: CustomApi) => {
    if (!confirm(t("customApiDeleteConfirm", { name: customApi.name }))) return;
    try {
      await api(`/admin/api/custom-apis/${encodeURIComponent(customApi.id)}`, { method: "DELETE" });
      setCustomApis(customApis.filter((item: CustomApi) => item.id !== customApi.id));
      invalidateModels();
      notify(t("customApiDeleted"), customApi.name);
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
            <Button tone="primary" onClick={() => open("add-antigravity")}>
              {t("addAntigravityAccount")}
            </Button>
            <Button tone="primary" onClick={() => open("add-codex")}>
              {t("addCodexAccount")}
            </Button>
            <Button tone="primary" onClick={() => open("add-custom-api")}>
              {t("addCustomApi")}
            </Button>
          </>
        }
      />
      {accounts.length || customApis.length ? (
        <div class="account-filters">
          <button
            type="button"
            class={`button ${tab === "all" ? "primary" : ""}`}
            onClick={() => setTab("all")}
          >
            {t("tabAll")} ({accounts.length + customApis.length})
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
          <button
            type="button"
            class={`button ${tab === "custom" ? "primary" : ""}`}
            onClick={() => setTab("custom")}
          >
            {t("tabCustomApi")} ({customApis.length})
          </button>
        </div>
      ) : null}

      {tab !== "custom" && (!accounts.length ? (
        <Panel title={t("accountsAndQuota")} subtitle={t("serverOnlyTokens")}>
          <div class="list">
            <Empty
              title={t("noAccounts")}
              text={t("noAccountsText")}
              actions={
                <>
                  <Button tone="primary" onClick={() => open("add-antigravity")}>
                    {t("addAntigravityAccount")}
                  </Button>
                  <Button tone="primary" onClick={() => open("add-codex")}>
                    {t("addCodexAccount")}
                  </Button>
                </>
              }
            />
          </div>
        </Panel>
      ) : tab === "antigravity" ? (
        <Panel title={t("antigravitySectionTitle")} subtitle={t("serverOnlyTokens")}>
          <div class="list">
            {agAccounts.length ? (
              agAccounts.map(renderRow)
            ) : (
              <Empty
                title={t("noAccounts")}
                text={t("noAccountsText")}
                actions={
                  <Button tone="primary" onClick={() => open("add-antigravity")}>
                    {t("addAntigravityAccount")}
                  </Button>
                }
              />
            )}
          </div>
        </Panel>
      ) : tab === "codex" ? (
        <Panel title={t("codexSectionTitle")} subtitle={t("serverOnlyTokens")}>
          <div class="list">
            {codexAccounts.length ? (
              codexAccounts.map(renderRow)
            ) : (
              <Empty
                title={t("noAccounts")}
                text={t("noAccountsText")}
                actions={
                  <Button tone="primary" onClick={() => open("add-codex")}>
                    {t("addCodexAccount")}
                  </Button>
                }
              />
            )}
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
      ))}
      {(tab === "all" || tab === "custom") && <Panel
        title={t("customApis")}
        subtitle={t("customApisHelp")}
      >
        <div class="list">
          {customApis.length ? customApis.map((customApi: CustomApi) => (
            <article key={customApi.id} class={`custom-api-card${customApi.enabled ? "" : " is-disabled"}`}>
              <div class="custom-api-card-main">
                <span class="custom-api-mark" aria-hidden="true">{customApi.name.slice(0, 1).toUpperCase()}</span>
                <div class="custom-api-identity">
                  <div class="custom-api-title-line">
                    <h3>{customApi.name}</h3>
                    <span class={`status ${customApi.enabled ? "healthy" : "disabled"}`}>
                      {customApi.enabled ? t("active") : t("disabled")}
                    </span>
                  </div>
                  <code>{customApi.baseUrl}</code>
                  <div class="custom-api-meta">
                    <span>{t("customApiModelsEnabled", { enabled: customApi.enabledModelIds.length, total: customApi.models.length })}</span>
                    <span>{t("customApiPriority")} {customApi.priority}</span>
                  </div>
                </div>
              </div>
              <div class="custom-api-controls">
                <label class="toggle-control">
                  <input
                    type="checkbox"
                    checked={customApi.fallback}
                    onChange={(event) => updateCustomApi(customApi, { fallback: event.currentTarget.checked })}
                  />
                  <span class="toggle-track" aria-hidden="true"><i /></span>
                  <span>{t("customApiFallback")}</span>
                </label>
                <label class="compact-field">
                  <span>{t("customApiPriority")}</span>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    value={customApi.priority}
                    onChange={(event) => updateCustomApi(customApi, { priority: Number(event.currentTarget.value) })}
                  />
                </label>
                <div class="custom-api-buttons">
                  <Button onClick={() => setModelApi(customApi)}>{t("manageModels")}</Button>
                  <Button onClick={() => updateCustomApi(customApi, { enabled: !customApi.enabled })}>
                    {customApi.enabled ? t("disable") : t("enable")}
                  </Button>
                  <Button tone="danger" onClick={() => removeCustomApi(customApi)}>{t("delete")}</Button>
                </div>
              </div>
            </article>
          )) : <Empty title={t("noCustomApis")} text={t("customApiEgressHelp")} />}
        </div>
      </Panel>}
      {modelApi && <CustomApiModelsDialog
        customApi={customApis.find((item: CustomApi) => item.id === modelApi.id) || modelApi}
        close={() => setModelApi(null)}
        save={async (enabledModelIds: string[]) => {
          const updated = await updateCustomApi(modelApi, { enabledModelIds });
          if (updated) setModelApi(null);
        }}
      />}
    </>
  );
}
function CustomApiModelsDialog({ customApi, close, save }: {
  customApi: CustomApi;
  close: () => void;
  save: (enabledModelIds: string[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>(customApi.enabledModelIds);
  const [saving, setSaving] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = customApi.models.filter((model) =>
    !normalizedQuery || model.id.toLowerCase().includes(normalizedQuery) || model.name?.toLowerCase().includes(normalizedQuery),
  );
  const selectedIds = new Set(selected);
  const submit = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await save(selected);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={t("manageModelsTitle", { name: customApi.name })}
      subtitle={t("manageModelsSubtitle")}
      close={close}
      style={{ maxWidth: "720px" }}
    >
      <form class="custom-model-form" onSubmit={submit}>
        <div class="custom-model-toolbar">
          <input
            type="search"
            placeholder={t("searchModels")}
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <span>{t("customApiModelsEnabled", { enabled: selected.length, total: customApi.models.length })}</span>
          <Button type="button" onClick={() => setSelected(customApi.models.map((model) => model.id))}>{t("selectAllModels")}</Button>
          <Button type="button" onClick={() => setSelected([])}>{t("clearAllModels")}</Button>
        </div>
        <div class="custom-model-list">
          {visible.map((model) => (
            <label key={model.id} class="custom-model-option">
              <input
                type="checkbox"
                checked={selectedIds.has(model.id)}
                onChange={(event) => setSelected(event.currentTarget.checked
                  ? [...selected, model.id]
                  : selected.filter((id) => id !== model.id))}
              />
              <span><strong>{model.name || model.id}</strong>{model.name && model.name !== model.id ? <small>{model.id}</small> : null}</span>
              {model.ownedBy ? <small>{model.ownedBy}</small> : null}
            </label>
          ))}
          {!visible.length && <p class="custom-model-empty">{t("noMatchingModels")}</p>}
        </div>
        <div class="custom-api-form-actions">
          <Button type="button" onClick={close}>{t("cancel")}</Button>
          <Button type="submit" tone="primary" disabled={saving}>{saving ? t("savingModels") : t("saveModels")}</Button>
        </div>
      </form>
    </Modal>
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
          <a
            href="javascript:void(0)"
            onClick={() => setOpen(true)}
            style={{ fontSize: "11px", color: "var(--brand-text)", textDecoration: "underline" }}
          >
            {t("viewGroupQuotas")}
          </a>
        </div>
        {secVal !== undefined ? (
          <>
            <div class="quota-track">
              <i style={{ width: `${secVal}%` }} />
            </div>
            <span class="quota-meta">
              {Math.round(secVal)}%{secondaryWindow?.resetsAt !== undefined ? ` · ${formatUntilReset(locale, secondaryWindow.resetsAt)}` : ""}
            </span>
          </>
        ) : (
          <>
            <div class="quota-track">
              <i style={{ width: "100%" }} />
            </div>
            <span class="quota-meta">
              {t("available")}
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
      defaultIncluded: "Claude Opus, Claude Sonnet, GPT-OSS",
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
      style={{ width: "min(92vw, 620px)" }}
      footer={
        <Button tone="primary" onClick={close}>
          {t("close")}
        </Button>
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "24px",
          maxHeight: "68vh",
          overflowY: "auto",
          padding: "4px 8px 12px 2px",
        }}
      >
        {groups.map((group, index) => {
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
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                borderBottom: index < groups.length - 1 ? "1px solid var(--line)" : "none",
                paddingBottom: index < groups.length - 1 ? "24px" : "8px",
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>
                  {group.title}
                </h3>
                <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "13px" }}>
                  {t("groupIncludes", { models: includedText })}
                </p>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: "12px", color: "var(--text)", fontWeight: 500 }}>
                    Five Hour Limit Remaining
                  </span>
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                    {fiveHourVal < 100
                      ? `${Math.round(fiveHourVal)}%${fiveHourReset ? ` · ${formatUntilReset(locale, fiveHourReset)}` : ""}`
                      : (fiveHourReset ? `${formatUntilReset(locale, fiveHourReset)} · ${t("available")}` : t("available"))}
                  </span>
                </div>
                <div style={{ height: "3px", borderRadius: "2px", background: "var(--neutral-bg)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      borderRadius: "2px",
                      width: `${fiveHourVal}%`,
                      background: fiveHourVal <= 15 ? "var(--danger)" : "var(--brand)",
                    }}
                  />
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span style={{ fontSize: "12px", color: "var(--text)", fontWeight: 500 }}>
                    Weekly Limit Remaining
                  </span>
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                    {weeklyVal < 100
                      ? `${Math.round(weeklyVal)}%${weeklyReset ? ` · ${formatUntilReset(locale, weeklyReset)}` : ""}`
                      : (weeklyReset ? `${formatUntilReset(locale, weeklyReset)} · ${t("available")}` : t("available"))}
                  </span>
                </div>
                <div style={{ height: "3px", borderRadius: "2px", background: "var(--neutral-bg)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      borderRadius: "2px",
                      width: `${weeklyVal}%`,
                      background: weeklyVal <= 15 ? "var(--danger)" : "var(--brand)",
                    }}
                  />
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
  const [testingAll, setTestingAll] = useState(false);
  const [testRunTotal, setTestRunTotal] = useState(0);
  const [tests, setTests] = useState<Record<string, {
    running?: boolean;
    ok?: boolean;
    status?: number;
    latencyMs?: number;
    text?: string;
  }>>({});
  const testModel = async (model: Model) => {
    setTests((current) => ({ ...current, [model.id]: { running: true } }));
    try {
      const result = await api<{ ok: boolean; status: number; latencyMs: number; text: string }>(
        "/admin/api/models/test",
        { method: "POST", body: JSON.stringify({ model: model.id }) },
      );
      setTests((current) => ({ ...current, [model.id]: result }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [model.id]: { ok: false, status: 0, latencyMs: 0, text: message(error, t("requestFailed")) },
      }));
    }
  };
  const testAllModels = async () => {
    const queue = models || [];
    if (!queue.length || testingAll) return;
    setTestingAll(true);
    setTestRunTotal(queue.length);
    setTests(Object.fromEntries(queue.map((model) => [model.id, { running: true }])));
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const model = queue[next++];
        await testModel(model);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    setTestingAll(false);
  };
  const completedTests = Object.values(tests).filter((result) => !result.running).length;
  const passedTests = Object.values(tests).filter((result) => result.ok).length;
  return (
    <>
      <PageHeader
        eyebrow={t("modelsEyebrow")}
        title={t("modelsTitle")}
        description={t("modelsDescriptionLong")}
        actions={
          <>
            <Button onClick={refresh}>{t("refreshCatalog")}</Button>
            <Button tone="primary" disabled={!models?.length || testingAll} onClick={testAllModels}>
              {testingAll
                ? t("testingAllModels", { completed: completedTests, total: testRunTotal })
                : t("testAllModels")}
            </Button>
          </>
        }
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
        {testRunTotal > 0 && !testingAll && (
          <div class={`model-test-summary${passedTests === testRunTotal ? " all-passed" : " has-failures"}`}>
            <strong>{t("modelTestSummary", { passed: passedTests, total: testRunTotal })}</strong>
            <span>{t("modelTestSummaryHelp")}</span>
          </div>
        )}
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
                      <div class="model-card-header">
                        <h3>{model.name || model.id}</h3>
                        <Button
                          class="model-test-button"
                          disabled={testingAll || tests[model.id]?.running}
                          onClick={() => testModel(model)}
                        >
                          {tests[model.id]?.running ? t("testingModel") : t("testModel")}
                        </Button>
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
                      {tests[model.id] && !tests[model.id].running && (
                        <div class={`model-test-result ${tests[model.id].ok ? "passed" : "failed"}`}>
                          <div>
                            <strong>{t(tests[model.id].ok ? "modelTestPassed" : "modelTestFailed")}</strong>
                            <span>{t("modelTestHttp", {
                              status: tests[model.id].status || "-",
                              latency: formatNumber(locale, tests[model.id].latencyMs),
                            })}</span>
                          </div>
                          <code>{tests[model.id].text || t("modelTestNoOutput")}</code>
                        </div>
                      )}
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

function Dialogs({ dialog, close, reloadAccounts, reloadKeys, reloadCustomApis, notify }: any) {
  if (!dialog) return null;
  if (dialog === "key")
    return <KeyDialog close={close} reload={reloadKeys} notify={notify} />;
  if (dialog === "add-antigravity")
    return (
      <AddAntigravityDialog
        close={close}
        reload={reloadAccounts}
        notify={notify}
      />
    );
  if (dialog === "add-codex")
    return (
      <AddCodexDialog
        close={close}
        reload={reloadAccounts}
        notify={notify}
      />
    );
  if (dialog === "add-custom-api")
    return <AddCustomApiDialog close={close} reload={reloadCustomApis} notify={notify} />;
  return null;
}
function Modal({ title, subtitle, close, children, footer, style }: any) {
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
        style={style}
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

function AddCustomApiDialog({ close, reload, notify }: any) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState(100);
  const [fallback, setFallback] = useState(true);
  const [saving, setSaving] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/admin/api/custom-apis", {
        method: "POST",
        body: JSON.stringify({ name, baseUrl, apiKey, priority, fallback }),
      });
      await reload();
      close();
      notify(t("customApiAdded"), t("customApiAddedText"));
    } catch (error) {
      notify(t("operationFailed"), message(error, t("requestFailed")), true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={t("addCustomApi")} subtitle={t("customApisHelp")} close={close} style={{ maxWidth: "640px" }}>
      <form class="custom-api-form" onSubmit={submit}>
        <div class="custom-api-vpc-note">
          <span class="custom-api-vpc-icon"><Icon name="cloud" /></span>
          <p>{t("customApiEgressHelp")}</p>
        </div>
        <div class="custom-api-form-grid">
          <label class="custom-api-field">
            <span>{t("displayName")}</span>
            <input required maxlength={80} placeholder="AMD Radeon API" value={name} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <label class="custom-api-field custom-api-priority-field">
            <span>{t("customApiPriority")}</span>
            <input required type="number" min="0" max="1000" value={priority} onInput={(event) => setPriority(Number(event.currentTarget.value))} />
          </label>
          <label class="custom-api-field custom-api-field-wide">
            <span>{t("customApiBaseUrl")}</span>
            <input required type="url" placeholder="https://api.example.com/v1" value={baseUrl} onInput={(event) => setBaseUrl(event.currentTarget.value)} />
          </label>
          <label class="custom-api-field custom-api-field-wide">
            <span>{t("customApiKey")}</span>
            <input required type="password" autocomplete="off" placeholder="sk-..." value={apiKey} onInput={(event) => setApiKey(event.currentTarget.value)} />
          </label>
        </div>
        <label class="custom-api-fallback-card">
          <span>
            <strong>{t("customApiFallback")}</strong>
            <small>{t("customApisHelp")}</small>
          </span>
          <span class="toggle-control toggle-only">
            <input type="checkbox" checked={fallback} onChange={(event) => setFallback(event.currentTarget.checked)} />
            <span class="toggle-track" aria-hidden="true"><i /></span>
          </span>
        </label>
        <div class="custom-api-form-actions">
          <Button type="button" onClick={close}>{t("cancel")}</Button>
          <Button type="submit" tone="primary" disabled={saving}>{saving ? t("validatingCustomApi") : t("addCustomApi")}</Button>
        </div>
      </form>
    </Modal>
  );
}
function AddAntigravityDialog({ close, reload, notify }: any) {
  const { t } = useI18n();
  const [method, setMethod] = useState<"oauth" | "json">("oauth");
  const [name, setName] = useState(""),
    [login, setLogin] = useState<any>(null),
    [callback, setCallback] = useState(""),
    [jsonPayload, setJsonPayload] = useState("");

  const startOAuth = async () => {
    try {
      const data = await api<any>("/admin/api/oauth/antigravity/start", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setLogin(data.login);
      window.open(data.login.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      notify(t("loginStartFailed"), message(error, t("requestFailed")), true);
    }
  };

  const cancelOAuth = () => {
    if (login) {
      api(`/admin/api/oauth/antigravity/${encodeURIComponent(login.id)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    close();
  };

  const finishOAuth = async () => {
    if (!login || !callback.trim())
      return notify(
        t("antigravityCallbackRequired"),
        t("antigravityCallbackHelp"),
        true,
      );
    try {
      await api(`/admin/api/oauth/antigravity/${encodeURIComponent(login.id)}`, {
        method: "POST",
        body: JSON.stringify({ callbackUrl: callback.trim() }),
      });
      await reload();
      close();
      notify(t("antigravityAccountAdded"), t("antigravityAccountAddedText"));
    } catch (error) {
      notify(t("loginIncomplete"), message(error, t("requestFailed")), true);
    }
  };

  const submitJson = async () => {
    try {
      const body = JSON.parse(jsonPayload);
      if (name.trim()) body.name = name.trim();
      body.provider = "antigravity";
      await api("/admin/api/accounts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await reload();
      close();
      notify(t("antigravityAccountAdded"), t("antigravityAccountAddedText"));
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
      title={t("addAntigravityTitle")}
      subtitle={t("addAntigravitySubtitle")}
      close={login ? cancelOAuth : close}
      footer={
        method === "oauth" ? (
          !login ? (
            <Button tone="primary" onClick={startOAuth}>
              {t("continueLogin")}
            </Button>
          ) : (
            <>
              <Button onClick={cancelOAuth}>{t("cancel")}</Button>
              <Button tone="primary" onClick={finishOAuth}>
                {t("finishImport")}
              </Button>
            </>
          )
        ) : (
          <>
            <Button onClick={close}>{t("cancel")}</Button>
            <Button tone="primary" onClick={submitJson}>
              {t("safeImport")}
            </Button>
          </>
        )
      }
    >
      {!login && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
          <button
            type="button"
            class={`button ${method === "oauth" ? "primary" : ""}`}
            onClick={() => setMethod("oauth")}
          >
            {t("methodOAuthBrowser")}
          </button>
          <button
            type="button"
            class={`button ${method === "json" ? "primary" : ""}`}
            onClick={() => setMethod("json")}
          >
            {t("methodManualJson")}
          </button>
        </div>
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

      {method === "oauth" && login && (
        <>
          <label>
            {t("openVerification")}
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
            {t("antigravityCallbackUrl")}
            <small>{t("antigravityCallbackHelp")}</small>
            <textarea
              value={callback}
              onInput={(e) => setCallback(e.currentTarget.value)}
              placeholder={t("antigravityCallbackPlaceholder")}
            />
          </label>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "6px",
              background: "var(--surface-subtle)",
              border: "1px solid var(--line)",
              fontSize: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            <span style={{ color: "var(--muted)" }}>{t("localServerTipAntigravity")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <code
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  borderRadius: "4px",
                  userSelect: "all",
                }}
              >
                python -m http.server 51121
              </code>
              <Button
                onClick={() =>
                  copyText("python -m http.server 51121", notify, t, "commandCopied")
                }
              >
                {t("copy")}
              </Button>
            </div>
          </div>
        </>
      )}

      {method === "json" && (
        <label>
          {t("credentialsJson")}
          <textarea
            value={jsonPayload}
            onInput={(e) => setJsonPayload(e.currentTarget.value)}
            placeholder={t("antigravityCredentialsPlaceholder")}
          />
        </label>
      )}
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
function AddCodexDialog({ close, reload, notify }: any) {
  const { t } = useI18n();
  const [method, setMethod] = useState<"device" | "browser" | "json">("device");
  const [name, setName] = useState(""),
    [login, setLogin] = useState<any>(null),
    [callback, setCallback] = useState(""),
    [jsonPayload, setJsonPayload] = useState("");

  const start = async () => {
    const endpoint =
      method === "device"
        ? "/admin/api/oauth/device/start"
        : "/admin/api/oauth/browser/start";
    try {
      const data = await api<any>(endpoint, {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setLogin(data.login);
      window.open(
        method === "device"
          ? data.login.verificationUrl
          : data.login.authorizationUrl,
        "_blank",
        "noopener,noreferrer",
      );
    } catch (error) {
      notify(t("loginStartFailed"), message(error, t("requestFailed")), true);
    }
  };

  useEffect(() => {
    if (method !== "device" || !login) return;
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
        method === "device"
          ? `/admin/api/oauth/device/${encodeURIComponent(login.id)}`
          : `/admin/api/oauth/browser/${encodeURIComponent(login.id)}`;
      api(endpoint, { method: "DELETE" }).catch(() => {});
    }
    close();
  };

  const finishBrowser = async () => {
    if (!login || !callback.trim())
      return notify(t("callbackUrl"), t("callbackHelp"), true);
    try {
      await api(`/admin/api/oauth/browser/${encodeURIComponent(login.id)}`, {
        method: "POST",
        body: JSON.stringify({ callbackUrl: callback.trim() }),
      });
      await reload();
      close();
      notify(t("accountAdded"), t("accountAddedBrowser"));
    } catch (error) {
      notify(t("loginIncomplete"), message(error, t("requestFailed")), true);
    }
  };

  const submitJson = async () => {
    try {
      const body = JSON.parse(jsonPayload);
      if (name.trim()) body.name = name.trim();
      body.provider = "codex";
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
      title={t("addCodexTitle")}
      subtitle={t("addCodexSubtitle")}
      close={login ? cancel : close}
      footer={
        method === "device" ? (
          !login ? (
            <Button tone="primary" onClick={start}>
              {t("continueLogin")}
            </Button>
          ) : (
            <span>{t("waitingAuthorization")}</span>
          )
        ) : method === "browser" ? (
          !login ? (
            <Button tone="primary" onClick={start}>
              {t("continueLogin")}
            </Button>
          ) : (
            <>
              <Button onClick={cancel}>{t("cancel")}</Button>
              <Button tone="primary" onClick={finishBrowser}>
                {t("finishImport")}
              </Button>
            </>
          )
        ) : (
          <>
            <Button onClick={close}>{t("cancel")}</Button>
            <Button tone="primary" onClick={submitJson}>
              {t("safeImport")}
            </Button>
          </>
        )
      }
    >
      {!login && (
        <div
          style={{
            display: "flex",
            gap: "6px",
            flexWrap: "wrap",
            marginBottom: "12px",
          }}
        >
          <button
            type="button"
            class={`button ${method === "device" ? "primary" : ""}`}
            onClick={() => setMethod("device")}
          >
            {t("methodOAuthDevice")}
          </button>
          <button
            type="button"
            class={`button ${method === "browser" ? "primary" : ""}`}
            onClick={() => setMethod("browser")}
          >
            {t("methodOAuthBrowserCodex")}
          </button>
          <button
            type="button"
            class={`button ${method === "json" ? "primary" : ""}`}
            onClick={() => setMethod("json")}
          >
            {t("methodManualJson")}
          </button>
        </div>
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

      {method === "device" && login && (
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

      {method === "browser" && login && (
        <>
          <label>
            {t("openVerification")}
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
            <small>{t("callbackHelp")}</small>
            <textarea
              value={callback}
              onInput={(e) => setCallback(e.currentTarget.value)}
              placeholder={t("callbackPlaceholder")}
            />
          </label>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "6px",
              background: "var(--surface-subtle)",
              border: "1px solid var(--line)",
              fontSize: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            <span style={{ color: "var(--muted)" }}>{t("localServerTipCodex")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <code
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  borderRadius: "4px",
                  userSelect: "all",
                }}
              >
                python -m http.server 1455
              </code>
              <Button
                onClick={() =>
                  copyText("python -m http.server 1455", notify, t, "commandCopied")
                }
              >
                {t("copy")}
              </Button>
            </div>
          </div>
        </>
      )}

      {method === "json" && (
        <label>
          {t("credentialsJson")}
          <textarea
            value={jsonPayload}
            onInput={(e) => setJsonPayload(e.currentTarget.value)}
            placeholder={t("codexCredentialsPlaceholder")}
          />
        </label>
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
