"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button, Spinner, toast } from "@heroui/react";
import { Check, Copy, Globe2, Link2, Trash2, Users2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ItemIcon } from "@/components/ItemIcon";
import { api, fetcher, timeAgo } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { Share } from "@/lib/types";

function Row({ s, onRevoke }: { s: Share; onRevoke: (token: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 border-b border-default/60 px-4 py-3 last:border-b-0">
      <ItemIcon kind={s.kind} className="size-5" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          {s.name}
          {!s.exists && (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
              file missing
            </span>
          )}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
          {s.mode === "workspace" ? <Globe2 className="size-3" /> : <Users2 className="size-3" />}
          {s.mode === "workspace"
            ? "Anyone authorized with the link"
            : `Only: ${(s.members ?? []).join(", ")}`}
          <span>· /{s.path}</span>
          <span>· {timeAgo(s.createdAt)}</span>
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label="Copy link"
        onPress={async () => {
          try {
            await navigator.clipboard.writeText(s.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            toast.danger("Could not copy — copy it from the share dialog instead");
          }
        }}
      >
        {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
      </Button>
      <Button size="sm" variant="ghost" isIconOnly aria-label="Revoke" onPress={() => onRevoke(s.token)}>
        <Trash2 className="size-4 text-danger" />
      </Button>
    </div>
  );
}

export default function MyLinksPage() {
  const { me } = useMe();
  const { data, isLoading, mutate } = useSWR<{ shares: Share[] }>(
    me?.canBrowse ? "/api/shares/mine" : null,
    fetcher
  );
  const shares = data?.shares ?? [];

  async function revoke(token: string) {
    try {
      await api(`/api/shares/${token}`, { method: "DELETE" });
      await mutate();
      toast.success("Link revoked");
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not revoke");
    }
  }

  return (
    <AppShell>
      <div className="px-4 py-6 sm:px-6">
        <h1 className="text-lg font-semibold">My links</h1>
        <p className="mt-0.5 text-sm text-muted">
          Every share link you have created. Revoking a link cuts off access immediately.
        </p>

        {isLoading ? (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        ) : shares.length === 0 ? (
          <div className="grid place-items-center py-24 text-center">
            <div>
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-accent/10">
                <Link2 className="size-8 text-accent" />
              </div>
              <p className="font-medium">No links yet</p>
              <p className="mt-1 text-sm text-muted">
                Share any file or folder from My Drive and the link will be listed here.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-default">
            {shares.map((s) => (
              <Row key={s.token} s={s} onRevoke={revoke} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
