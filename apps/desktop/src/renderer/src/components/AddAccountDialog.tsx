import { useAtom, useAtomValue } from "@effect/atom-react";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ChevronLeft, ExternalLink, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { Account, ImapConnectInput } from "../../../shared/api";
import { type AppError, causeText, resultError } from "../errors";
import { connectAtom, saveClientAtom } from "../state/mutations";
import { clientSetupAtom, imapPresetsAtom } from "../state/queries";
import { ProviderIcon, type ProviderIconName } from "./ProviderIcon";

type OAuthProvider = "gmail" | "outlook";
/** IMAP preset keys in core, plus "custom" for any other server. */
type ImapChoice = "icloud" | "yahoo" | "qq" | "163" | "fastmail" | "custom";
type Choice = OAuthProvider | ImapChoice;

const TILES: { id: Choice; icon: ProviderIconName; label: string }[] = [
  { id: "gmail", icon: "gmail", label: "Gmail" },
  { id: "outlook", icon: "outlook", label: "Outlook" },
  { id: "icloud", icon: "icloud", label: "iCloud" },
  { id: "yahoo", icon: "yahoo", label: "Yahoo" },
  { id: "qq", icon: "qq", label: "QQ 邮箱" },
  { id: "163", icon: "163", label: "163 邮箱" },
  { id: "fastmail", icon: "fastmail", label: "Fastmail" },
  { id: "custom", icon: "imap", label: "其他 IMAP" },
];

const isOAuth = (c: Choice): c is OAuthProvider => c === "gmail" || c === "outlook";

interface Props {
  /** Omit on first run: there is nothing to go back to, so the dialog cannot be dismissed. */
  onClose?: () => void;
  onAdded: (account: Account) => void;
}

/**
 * Adds a mail account. Step one picks the provider; step two signs in through
 * the browser (Gmail, Outlook) or with an app password (IMAP providers).
 */
export function AddAccountDialog({ onClose, onAdded }: Props) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const tile = TILES.find((t) => t.id === choice);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = tile ? `添加 ${tile.label}` : onClose ? "添加邮箱" : "添加第一个邮箱";

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <dialog
        open
        aria-modal="true"
        aria-label={title}
        className="relative m-0 w-[460px] rounded-2xl border-0 bg-white p-6 text-[13px] text-neutral-900 shadow-2xl ring-1 ring-black/5 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-white/10"
      >
        <header className="flex h-7 items-center gap-2">
          {tile && (
            <button
              type="button"
              aria-label="返回"
              onClick={() => setChoice(null)}
              className="-ml-1.5 flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          {tile && <ProviderIcon provider={tile.icon} className="size-5 shrink-0" />}
          <h2 className="flex-1 text-[15px] font-semibold">{title}</h2>
          {onClose && (
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="-mr-1.5 flex size-7 items-center justify-center rounded-md text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <X className="size-4" />
            </button>
          )}
        </header>

        {choice === null && (
          <>
            <p className="mt-1.5 text-neutral-500">
              {onClose
                ? "选择邮箱服务商。"
                : "欢迎使用 openmail。选择你的邮箱服务商，凭证只存在这台电脑上。"}
            </p>
            <div className="mt-5 grid grid-cols-4 gap-2">
              {TILES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setChoice(t.id)}
                  className="flex flex-col items-center gap-2 rounded-xl px-1 py-4 ring-1 ring-black/[0.06] transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:ring-white/10 dark:hover:bg-white/5"
                >
                  <ProviderIcon provider={t.icon} className="size-8" />
                  <span className="text-[12px] text-neutral-700 dark:text-neutral-300">
                    {t.label}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {choice !== null && isOAuth(choice) && (
          <OAuthStep key={choice} provider={choice} onAdded={onAdded} />
        )}
        {choice !== null && !isOAuth(choice) && (
          <ImapStep key={choice} preset={choice} onAdded={onAdded} />
        )}
      </dialog>
    </div>
  );
}

/** An IMAP server that rejects the login almost always got the web password. */
function imapErrorText(result: AsyncResult.AsyncResult<Account, AppError>): string | null {
  if (result._tag !== "Failure") return null;
  const error = Cause.findErrorOption(result.cause);
  if (error._tag === "Some" && error.value._tag === "AuthError") {
    return "服务器拒绝了登录。请检查邮箱地址，并确认填的是应用专用密码或授权码，不是网页登录密码。";
  }
  return causeText(result.cause);
}

// Gmail and Outlook

const OAUTH_COPY: Record<OAuthProvider, { name: string; note: string; doc: string }> = {
  gmail: {
    name: "Google",
    note: "Google Cloud 里创建的 OAuth 客户端，类型选桌面应用。",
    doc: "docs/setup-google.md",
  },
  outlook: {
    name: "Microsoft",
    note: "Azure 里注册的应用，类型选移动和桌面应用。只支持个人 outlook.com 和 hotmail 账户。",
    doc: "docs/setup-microsoft.md",
  },
};

function OAuthStep({
  provider,
  onAdded,
}: {
  provider: OAuthProvider;
  onAdded: (account: Account) => void;
}) {
  const setup = AsyncResult.getOrElse(useAtomValue(clientSetupAtom), () => null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const copy = OAUTH_COPY[provider];

  const [saveClient, runSaveClient] = useAtom(saveClientAtom);
  const [signIn, runSignIn] = useAtom(connectAtom(provider), { mode: "promiseExit" });
  const saveError = resultError(saveClient);
  const signInError = resultError(signIn);

  const signInNow = async () => {
    const exit = await runSignIn({ provider });
    if (Exit.isSuccess(exit)) onAdded(exit.value);
  };

  if (!setup) return <p className="mt-5 text-neutral-500">读取设置…</p>;
  const configured = provider === "gmail" ? setup.googleConfigured : setup.microsoftConfigured;

  if (!configured) {
    const ready = clientId.trim() && (provider === "outlook" || clientSecret.trim());
    return (
      <form
        aria-label={`${copy.name} 客户端`}
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          runSaveClient(
            provider === "gmail"
              ? { provider, clientId: clientId.trim(), clientSecret: clientSecret.trim() }
              : { provider, clientId: clientId.trim() },
          );
        }}
      >
        <p className="text-neutral-500">
          openmail 用你自己注册的 OAuth 客户端登录。先填入{copy.note}步骤见仓库里的 {copy.doc}。
        </p>
        <Field
          label={provider === "gmail" ? "Client ID" : "Application (client) ID"}
          value={clientId}
          onChange={setClientId}
          autoFocus
        />
        {provider === "gmail" && (
          <Field label="Client secret" value={clientSecret} onChange={setClientSecret} password />
        )}
        {saveError && <ErrorLine text={saveError} />}
        <Actions>
          <PrimaryButton disabled={!ready || saveClient.waiting}>
            {saveClient.waiting ? "保存中…" : "保存"}
          </PrimaryButton>
        </Actions>
      </form>
    );
  }

  return (
    <div className="mt-4">
      <p className="text-neutral-500">
        {signIn.waiting
          ? "请在浏览器里完成授权。完成后回到这里。"
          : `点下面的按钮会打开 ${copy.name} 的登录页。openmail 只读取邮件，令牌存在系统钥匙串里。`}
      </p>
      {signInError && <ErrorLine text={signInError} />}
      <Actions>
        <PrimaryButton disabled={signIn.waiting} onClick={() => void signInNow()}>
          {signIn.waiting ? "等待授权…" : "在浏览器中登录"}
        </PrimaryButton>
      </Actions>
    </div>
  );
}

// IMAP

function ImapStep({
  preset,
  onAdded,
}: {
  preset: ImapChoice;
  onAdded: (account: Account) => void;
}) {
  const presets = AsyncResult.getOrElse(useAtomValue(imapPresetsAtom), () => null);
  const info = preset === "custom" ? undefined : presets?.[preset];
  const custom = preset === "custom";
  const authCode = preset === "qq" || preset === "163";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);

  const [add, runAdd] = useAtom(connectAtom(preset), { mode: "promiseExit" });
  const addError = imapErrorText(add);

  const submit = async () => {
    const base = { preset, email: email.trim(), password };
    // Optional fields are left out, not sent as undefined: the main process
    // decodes the input strictly.
    const input: ImapConnectInput = custom
      ? {
          ...base,
          imapHost: imapHost.trim(),
          imapPort: Number(imapPort),
          smtpHost: smtpHost.trim(),
          smtpPort: Number(smtpPort),
          smtpSecure,
          ...(username.trim() ? { username: username.trim() } : {}),
        }
      : base;
    const exit = await runAdd({ provider: "imap", input });
    if (Exit.isSuccess(exit)) onAdded(exit.value);
  };

  const ready =
    email.includes("@") && password && (!custom || (imapHost.trim() && smtpHost.trim()));
  const secretLabel = custom ? "密码" : authCode ? "授权码" : "应用专用密码";

  return (
    <form
      aria-label="IMAP 账户"
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !add.waiting) void submit();
      }}
    >
      {info?.note && <p className="text-neutral-500">{info.note}</p>}
      {custom && <p className="text-neutral-500">填入邮箱服务商提供的 IMAP 和 SMTP 服务器地址。</p>}

      <Field label="邮箱地址" value={email} onChange={setEmail} type="email" autoFocus />
      <Field label={secretLabel} value={password} onChange={setPassword} password />
      {info?.appPasswordUrl && (
        <a
          href={info.appPasswordUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-blue-600 hover:underline dark:text-blue-400"
        >
          {authCode ? "生成授权码" : "生成应用专用密码"}
          <ExternalLink className="size-3" />
        </a>
      )}

      {custom && (
        <>
          <Field label="用户名（不填就用邮箱地址）" value={username} onChange={setUsername} />
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="IMAP 服务器" value={imapHost} onChange={setImapHost} />
            </div>
            <div className="w-20">
              <Field label="端口" value={imapPort} onChange={setImapPort} inputMode="numeric" />
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="SMTP 服务器" value={smtpHost} onChange={setSmtpHost} />
            </div>
            <div className="w-20">
              <Field
                label="端口"
                value={smtpPort}
                onChange={(v) => {
                  setSmtpPort(v);
                  if (v === "465") setSmtpSecure(true);
                  else if (v === "587") setSmtpSecure(false);
                }}
                inputMode="numeric"
              />
            </div>
          </div>
          <label className="mt-3 block text-[12px] font-medium text-neutral-500">
            SMTP 加密
            <select
              value={smtpSecure ? "tls" : "starttls"}
              onChange={(e) => setSmtpSecure(e.target.value === "tls")}
              className="mt-1 h-8 w-full rounded-md border border-black/10 bg-transparent px-2 text-[13px] text-neutral-900 outline-none focus:border-blue-500 dark:border-white/15 dark:text-neutral-100"
            >
              <option value="tls">SSL/TLS（通常是 465）</option>
              <option value="starttls">STARTTLS（通常是 587）</option>
            </select>
          </label>
        </>
      )}

      {addError && <ErrorLine text={addError} />}
      <Actions>
        <PrimaryButton disabled={!ready || add.waiting}>
          {add.waiting ? "正在验证…" : "添加"}
        </PrimaryButton>
      </Actions>
    </form>
  );
}

// Shared bits

function Field({
  label,
  value,
  onChange,
  password,
  type,
  autoFocus,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  password?: boolean;
  type?: "text" | "email";
  autoFocus?: boolean;
  inputMode?: "numeric";
}) {
  return (
    <label className="mt-3 block text-[12px] font-medium text-neutral-500">
      {label}
      <input
        type={password ? "password" : (type ?? "text")}
        value={value}
        autoFocus={autoFocus}
        inputMode={inputMode}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => onChange(e.target.value)}
        className="selectable mt-1 h-8 w-full rounded-md border border-black/10 bg-transparent px-2.5 text-[13px] text-neutral-900 outline-none focus:border-blue-500 dark:border-white/15 dark:text-neutral-100"
      />
    </label>
  );
}

function ErrorLine({ text }: { text: string }) {
  return <p className="mt-3 text-[12px] text-red-500">{text}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end">{children}</div>;
}

function PrimaryButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type={onClick ? "button" : "submit"}
      disabled={disabled}
      onClick={onClick}
      className="h-8 rounded-md bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
