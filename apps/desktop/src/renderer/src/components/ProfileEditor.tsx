import { useAtom } from "@effect/atom-react";
import { Exit } from "effect";
import { useEffect, useState } from "react";

import type { Account, Profile, ProfileColor } from "../../../shared/api";
import { resultError } from "../errors";
import { avatarColor, firstGrapheme, PROFILE_BG } from "../format";
import { Keys } from "../state/keys";
import { deleteProfileAtom, saveProfileAtom } from "../state/mutations";

const ICONS = ["💼", "🏠", "🏭", "🧪", "🎓", "✈️", "💰", "⭐"];
const COLORS: ProfileColor[] = [
  "blue",
  "violet",
  "rose",
  "orange",
  "amber",
  "emerald",
  "teal",
  "slate",
];

interface Props {
  /** Edit this profile; omit to create one. */
  profile?: Profile;
  accounts: readonly Account[];
  profiles: readonly Profile[];
  onClose: () => void;
  onSaved?: (profile: Profile) => void;
  onDeleted?: () => void;
}

/**
 * Create or edit a profile and pick its accounts. An account sits in at most
 * one profile, so checking it here moves it out of its current one.
 */
export function ProfileEditor({ profile, accounts, profiles, onClose, onSaved, onDeleted }: Props) {
  const [name, setName] = useState(profile?.name ?? "");
  const [icon, setIcon] = useState(profile?.icon ?? ICONS[0]!);
  const [color, setColor] = useState<ProfileColor>(profile?.color ?? "blue");
  const [members, setMembers] = useState(
    () => new Set(accounts.filter((a) => profile && a.profileId === profile.id).map((a) => a.id)),
  );

  const [save, runSave] = useAtom(saveProfileAtom, { mode: "promiseExit" });
  const [remove, runRemove] = useAtom(deleteProfileAtom, { mode: "promiseExit" });

  const submit = async () => {
    const input = { name: name.trim(), icon, color };
    const exit = await runSave({ profile, input, members, accounts });
    if (Exit.isSuccess(exit)) {
      onSaved?.(exit.value);
      onClose();
    }
  };

  const deleteProfile = async (id: string) => {
    const exit = await runRemove({
      payload: { id },
      reactivityKeys: [Keys.profiles, Keys.accounts],
    });
    if (Exit.isSuccess(exit)) {
      onDeleted?.();
      onClose();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const error = resultError(save) ?? resultError(remove);
  const profileName = (id: string | null) => profiles.find((p) => p.id === id)?.name;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        aria-label={profile ? "编辑空间" : "新建空间"}
        className="w-[400px] rounded-xl bg-white p-5 text-[13px] shadow-2xl dark:bg-neutral-800"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <h2 className="text-[15px] font-semibold">{profile ? "编辑空间" : "新建空间"}</h2>

        <div className="mt-4 flex items-center gap-3">
          <span
            className={`flex size-10 shrink-0 items-center justify-center rounded-full text-[20px] ${PROFILE_BG[color]}`}
          >
            {icon}
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="名称，比如 工作"
            className="h-8 min-w-0 flex-1 rounded-md border border-black/10 bg-transparent px-2.5 text-[14px] outline-none focus:border-blue-500 dark:border-white/15"
          />
        </div>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-neutral-500">图标</legend>
          <div className="flex items-center gap-1">
            {ICONS.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIcon(i)}
                className={`flex size-8 items-center justify-center rounded-md text-[17px] ${
                  icon === i ? "bg-black/10 dark:bg-white/15" : "hover:bg-black/5"
                }`}
              >
                {i}
              </button>
            ))}
            <input
              aria-label="自定义图标"
              placeholder="其他"
              onChange={(e) => {
                const g = firstGrapheme(e.target.value);
                if (g) setIcon(g);
              }}
              className="ml-1 h-8 w-14 rounded-md border border-black/10 bg-transparent px-2 text-center outline-none dark:border-white/15"
            />
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-neutral-500">颜色</legend>
          <div className="flex gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => setColor(c)}
                className={`size-6 rounded-full ${PROFILE_BG[c]} ${
                  color === c
                    ? "ring-2 ring-offset-2 ring-neutral-400 dark:ring-offset-neutral-800"
                    : ""
                }`}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-neutral-500">账户</legend>
          <div className="max-h-48 space-y-px overflow-y-auto">
            {accounts.map((a) => {
              const elsewhere =
                a.profileId && a.profileId !== profile?.id ? profileName(a.profileId) : undefined;
              return (
                <label
                  key={a.id}
                  className="flex h-8 items-center gap-2.5 rounded-md px-2 hover:bg-black/[0.04] dark:hover:bg-white/5"
                >
                  <input
                    type="checkbox"
                    checked={members.has(a.id)}
                    onChange={(e) =>
                      setMembers((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(a.id);
                        else next.delete(a.id);
                        return next;
                      })
                    }
                  />
                  <span className={`size-2 rounded-full ${avatarColor(a.email)}`} />
                  <span className="min-w-0 flex-1 truncate">{a.email}</span>
                  {elsewhere && (
                    <span className="shrink-0 text-[12px] text-neutral-400">
                      {members.has(a.id) ? `从「${elsewhere}」移过来` : `在「${elsewhere}」`}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        {error && <p className="mt-3 text-[12px] text-red-500">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          {profile && (
            <button
              type="button"
              onClick={() => void deleteProfile(profile.id)}
              className="h-8 rounded-md px-3 text-red-600 hover:bg-red-500/10"
            >
              删除空间
            </button>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 hover:bg-black/5 dark:hover:bg-white/10"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!name.trim() || save.waiting}
            className="h-8 rounded-md bg-blue-600 px-4 font-medium text-white disabled:opacity-40"
          >
            {profile ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}
