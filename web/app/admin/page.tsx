"use client";

import { useCallback, useEffect, useState } from "react";
import useSWR from "swr";
import { Avatar, Button, Input, Spinner, TextField, toast } from "@heroui/react";
import { Activity as ActivityIcon, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api, fetcher, timeAgo } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { Activity, AllowlistRow, UserRow } from "@/lib/types";

interface Overview {
  adminEmail: string;
  allowlist: AllowlistRow[];
  users: UserRow[];
}

const ACTION_LABELS: Record<string, string> = {
  login: "Signed in",
  logout: "Signed out",
  login_denied: "Sign-in denied",
  upload: "Uploaded",
  download: "Downloaded",
  preview: "Previewed",
  delete: "Deleted",
  rename: "Renamed",
  move: "Moved",
  mkdir: "New folder",
  restore: "Restored",
  purge: "Purged",
  empty_trash: "Emptied trash",
  link_create: "Created link",
  link_delete: "Revoked link",
  link_open: "Opened link",
  link_download: "Downloaded via link",
};

const ACTION_TONE: Record<string, string> = {
  login: "text-emerald-600",
  login_denied: "text-danger",
  delete: "text-danger",
  purge: "text-danger",
  empty_trash: "text-danger",
  upload: "text-accent",
  link_open: "text-violet-600",
  link_download: "text-violet-600",
  link_create: "text-violet-600",
};

function ActivityLog({ users }: { users: UserRow[] }) {
  const [rows, setRows] = useState<Activity[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [email, setEmail] = useState("");

  const PAGE = 100;

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      const offset = reset ? 0 : rows.length;
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (action) params.set("action", action);
      if (email) params.set("email", email);
      try {
        const res = await api<{ activity: Activity[]; total: number }>(`/api/admin/activity?${params}`);
        setRows((prev) => (reset ? res.activity : [...prev, ...res.activity]));
        setTotal(res.total);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action, email, rows.length]
  );

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, email]);

  const selectCls =
    "rounded-xl border border-default bg-background px-3 py-2 text-sm outline-none focus:border-accent/60";

  return (
    <section className="rounded-2xl border border-default bg-surface p-5">
      <div className="flex items-center gap-2">
        <ActivityIcon className="size-4.5 text-accent" />
        <h2 className="font-medium">Activity</h2>
      </div>
      <p className="mt-1 text-sm text-muted">
        Every sign-in, upload, download, preview and change — who did what, and when.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <select className={selectCls} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className={selectCls} value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Filter by user">
          <option value="">Everyone</option>
          {users.map((u) => (
            <option key={u.email} value={u.email}>
              {u.email}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-default">
        {loading && rows.length === 0 ? (
          <div className="grid place-items-center py-12">
            <Spinner aria-label="Loading" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted">No activity recorded yet.</p>
        ) : (
          <>
            <div className="hidden grid-cols-[150px_1fr_1.4fr_120px] gap-3 border-b border-default bg-background/50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
              <span>When</span>
              <span>Who</span>
              <span>What</span>
              <span>From</span>
            </div>
            {rows.map((a) => (
              <div
                key={a.id}
                className="grid grid-cols-1 gap-0.5 border-b border-default/60 px-4 py-2.5 text-sm last:border-b-0 sm:grid-cols-[150px_1fr_1.4fr_120px] sm:gap-3"
              >
                <span className="text-muted" title={new Date(a.ts).toLocaleString()}>
                  {timeAgo(a.ts)}
                </span>
                <span className="truncate">{a.email || <span className="text-muted">guest</span>}</span>
                <span className="min-w-0 truncate">
                  <span className={`font-medium ${ACTION_TONE[a.action] || ""}`}>
                    {ACTION_LABELS[a.action] || a.action}
                  </span>
                  {a.path && a.path !== "(selection)" ? (
                    <span className="text-muted"> · /{a.path}</span>
                  ) : a.detail ? (
                    <span className="text-muted"> · {a.detail}</span>
                  ) : null}
                </span>
                <span className="truncate text-xs text-muted">{a.ip || "—"}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {rows.length < total && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" isPending={loading} onPress={() => load(false)}>
            Load more ({total - rows.length} older)
          </Button>
        </div>
      )}
    </section>
  );
}

export default function AdminPage() {
  const { me } = useMe();
  const { data, isLoading, mutate } = useSWR<Overview>(me?.isAdmin ? "/api/admin/overview" : null, fetcher);
  const [email, setEmail] = useState("");
  const [asAdmin, setAsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await api("/api/admin/allowlist", { json: { email: email.trim(), role: asAdmin ? "admin" : "user" } });
      setEmail("");
      setAsAdmin(false);
      await mutate();
      toast.success("Added to allowlist");
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not add");
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string) {
    try {
      await api(`/api/admin/allowlist/${encodeURIComponent(target)}`, { method: "DELETE" });
      await mutate();
      toast.success(`${target} removed — their sessions are revoked`);
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not remove");
    }
  }

  if (me && !me.isAdmin) {
    return (
      <AppShell>
        <div className="grid min-h-[60dvh] place-items-center text-center">
          <div>
            <ShieldCheck className="mx-auto mb-3 size-8 text-danger" />
            <p className="font-medium">Admins only</p>
            <p className="mt-1 text-sm text-muted">Ask the drive owner if you think you should have access.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <h1 className="text-lg font-semibold">Admin</h1>
        <p className="mt-0.5 text-sm text-muted">Who can sign in, and everything they do.</p>

        {isLoading || !data ? (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            {/* Allowlist */}
            <section className="rounded-2xl border border-default bg-surface p-5">
              <h2 className="font-medium">Allowlist</h2>
              <p className="mt-1 text-sm text-muted">
                Google accounts allowed to sign in. Everyone here has full access to the drive. Removing someone
                signs them out everywhere, immediately.
              </p>

              <form
                className="mt-4 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <TextField className="min-w-56 flex-1" value={email} onChange={setEmail} aria-label="Email to allow" type="email">
                  <Input placeholder="name@gmail.com" />
                </TextField>
                <label className="flex cursor-pointer select-none items-center gap-2 rounded-xl border border-default px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={asAdmin}
                    onChange={(e) => setAsAdmin(e.target.checked)}
                    className="size-4 accent-[var(--accent,#2563eb)]"
                  />
                  Admin
                </label>
                <Button variant="primary" isPending={busy} onPress={add}>
                  <UserPlus className="size-4" />
                  Add
                </Button>
              </form>

              <div className="mt-4 overflow-hidden rounded-xl border border-default">
                <div className="flex items-center gap-3 border-b border-default/60 bg-background/50 px-4 py-2.5">
                  <span className="text-sm font-medium">{data.adminEmail}</span>
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                    Owner
                  </span>
                </div>
                {data.allowlist.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">Nobody else yet — add a Gmail address above.</p>
                ) : (
                  data.allowlist.map((r) => (
                    <div key={r.email} className="flex items-center gap-3 border-b border-default/60 px-4 py-2.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate text-sm">{r.email}</span>
                      {r.role === "admin" && (
                        <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                          Admin
                        </span>
                      )}
                      <Button size="sm" variant="ghost" isIconOnly aria-label={`Remove ${r.email}`} onPress={() => remove(r.email)}>
                        <Trash2 className="size-4 text-danger" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Activity log */}
            <ActivityLog users={data.users} />

            {/* Sign-ins */}
            <section className="rounded-2xl border border-default bg-surface p-5">
              <h2 className="font-medium">Sign-ins</h2>
              <p className="mt-1 text-sm text-muted">Accounts that have signed in at least once.</p>
              <div className="mt-4 overflow-hidden rounded-xl border border-default">
                {data.users.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">No sign-ins yet.</p>
                ) : (
                  data.users.map((u) => (
                    <div key={u.email} className="flex items-center gap-3 border-b border-default/60 px-4 py-2.5 last:border-b-0">
                      <Avatar className="size-7">
                        {u.picture ? <Avatar.Image src={u.picture} alt="" /> : null}
                        <Avatar.Fallback>{(u.name || u.email).slice(0, 1).toUpperCase()}</Avatar.Fallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{u.name || u.email}</p>
                        <p className="truncate text-xs text-muted">{u.email}</p>
                      </div>
                      <span className="text-xs text-muted">last seen {timeAgo(u.last_login_at)}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </AppShell>
  );
}
