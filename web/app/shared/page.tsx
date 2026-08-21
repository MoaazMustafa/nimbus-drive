"use client";

import Link from "next/link";
import useSWR from "swr";
import { Spinner } from "@heroui/react";
import { Inbox } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ItemIcon } from "@/components/ItemIcon";
import { fetcher, timeAgo } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { Share } from "@/lib/types";

export default function SharedWithMePage() {
  const { me } = useMe();
  const { data, isLoading } = useSWR<{ shares: Share[] }>(me ? "/api/shares/shared-with-me" : null, fetcher);
  const shares = data?.shares ?? [];

  return (
    <AppShell>
      <div className="px-4 py-6 sm:px-6">
        <h1 className="text-lg font-semibold">Shared with me</h1>
        <p className="mt-0.5 text-sm text-muted">Files and folders other people gave you access to.</p>

        {isLoading ? (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        ) : shares.length === 0 ? (
          <div className="grid place-items-center py-24 text-center">
            <div>
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-accent/10">
                <Inbox className="size-8 text-accent" />
              </div>
              <p className="font-medium">Nothing shared with you yet</p>
              <p className="mt-1 text-sm text-muted">
                When someone shares a file or folder with you, it will show up here.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shares.map((s) => (
              <Link
                key={s.token}
                href={`/s/${s.token}`}
                className="nimbus-tile flex items-center gap-3 rounded-xl border border-default bg-surface p-4 hover:bg-foreground/5"
              >
                <ItemIcon kind={s.kind} className="size-8" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{s.name}</span>
                  <span className="block truncate text-xs text-muted">
                    by {s.createdBy} · {timeAgo(s.createdAt)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
