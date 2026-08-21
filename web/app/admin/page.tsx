"use client";

import { useState } from "react";
import useSWR from "swr";
import { Avatar, Button, Input, Spinner, Switch, TextField, toast } from "@heroui/react";
import { ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api, fetcher, timeAgo } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { AllowlistRow, UserRow } from "@/lib/types";

interface Overview {
  adminEmail: string;
  visibility: "admin_only" | "everyone";
  allowlist: AllowlistRow[];
  users: UserRow[];
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

  async function setVisibility(everyone: boolean) {
    try {
      await api("/api/admin/visibility", { json: { visibility: everyone ? "everyone" : "admin_only" } });
      await mutate();
      toast.success(everyone ? "Everyone on the allowlist can now browse the whole drive" : "Only admins can browse the drive now");
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not change visibility");
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
        <p className="mt-0.5 text-sm text-muted">Who can sign in, and what they can see.</p>

        {isLoading || !data ? (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            {/* Visibility */}
            <section className="rounded-2xl border border-default bg-surface p-5">
              <h2 className="font-medium">Drive visibility</h2>
              <div className="mt-3 flex items-start justify-between gap-6">
                <p className="text-sm leading-relaxed text-muted">
                  {data.visibility === "everyone"
                    ? "Everyone on the allowlist can browse, upload and manage the whole drive."
                    : "Only admins browse the drive. Everyone else sees just what is shared with them (like Google Photos)."}
                </p>
                <Switch
                  isSelected={data.visibility === "everyone"}
                  onChange={(v: boolean) => setVisibility(v)}
                  aria-label="Everyone can browse the whole drive"
                >
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch>
              </div>
            </section>

            {/* Allowlist */}
            <section className="rounded-2xl border border-default bg-surface p-5">
              <h2 className="font-medium">Allowlist</h2>
              <p className="mt-1 text-sm text-muted">
                Google accounts that are allowed to sign in. Removing someone signs them out everywhere,
                immediately.
              </p>

              <form
                className="mt-4 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <TextField
                  className="min-w-56 flex-1"
                  value={email}
                  onChange={setEmail}
                  aria-label="Email to allow"
                  type="email"
                >
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
                {/* Owner row */}
                <div className="flex items-center gap-3 border-b border-default/60 bg-background/50 px-4 py-2.5">
                  <span className="text-sm font-medium">{data.adminEmail}</span>
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                    Owner
                  </span>
                </div>
                {data.allowlist.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">
                    Nobody else yet — add a Gmail address above.
                  </p>
                ) : (
                  data.allowlist.map((r) => (
                    <div key={r.email} className="flex items-center gap-3 border-b border-default/60 px-4 py-2.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate text-sm">{r.email}</span>
                      {r.role === "admin" && (
                        <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                          Admin
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        aria-label={`Remove ${r.email}`}
                        onPress={() => remove(r.email)}
                      >
                        <Trash2 className="size-4 text-danger" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Users */}
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
