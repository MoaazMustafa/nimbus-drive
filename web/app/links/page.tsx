"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button, Spinner, toast } from "@heroui/react";
import { Check, Copy, Globe2, Link2, Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ItemIcon } from "@/components/ItemIcon";
import { api, fetcher, timeAgo } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { Link as PublicLink } from "@/lib/types";

function Row({ s, onRevoke, showOwner }: { s: PublicLink; onRevoke: (token: string) => void; showOwner: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 border-b border-default/60 px-4 py-3 last:border-b-0">
      <ItemIcon kind={s.kind} className="size-5" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          {s.name}
          {s.exists === false && (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
              file missing
            </span>
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 truncate text-xs text-muted">
          <Globe2 className="size-3" />
          Anyone with the link
          <span>· /{s.path}</span>
          <span>· {s.expiresAt ? `expires ${timeAgo(s.expiresAt)}` : "no expiry"}</span>
          {showOwner && <span>· by {s.createdBy}</span>}
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
            toast.danger("Could not copy — open the item and copy from the share dialog instead");
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
  const { data, isLoading, mutate } = useSWR<{ links: PublicLink[] }>(me ? "/api/links/mine" : null, fetcher);
  const links = data?.links ?? [];

  async function revoke(token: string) {
    try {
      await api(`/api/links/${token}`, { method: "DELETE" });
      await mutate();
      toast.success("Link revoked");
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not revoke");
    }
  }

  return (
    <AppShell>
      <div className="px-4 py-6 sm:px-6">
        <h1 className="text-lg font-semibold">{me?.isAdmin ? "All public links" : "My links"}</h1>
        <p className="mt-0.5 text-sm text-muted">
          Public links open with no sign-in required. Revoking a link cuts off access immediately.
        </p>

        {isLoading ? (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        ) : links.length === 0 ? (
          <div className="grid place-items-center py-24 text-center">
            <div>
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-accent/10">
                <Link2 className="size-8 text-accent" />
              </div>
              <p className="font-medium">No links yet</p>
              <p className="mt-1 text-sm text-muted">
                Open any file or folder&apos;s menu and choose <span className="font-medium">Get link</span> to
                create a public link.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-default">
            {links.map((s) => (
              <Row key={s.token} s={s} onRevoke={revoke} showOwner={!!me?.isAdmin} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
