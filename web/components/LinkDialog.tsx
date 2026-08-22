"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button, Modal, toast } from "@heroui/react";
import { Check, Copy, Globe2, Link2, Trash2 } from "lucide-react";
import { api, enc, fetcher, timeAgo } from "@/lib/api";
import type { Entry, Link } from "@/lib/types";

const EXPIRY_OPTIONS = [
  { label: "No expiry", value: 0 },
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
];

function CopyButton({ text, small = false }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant={small ? "ghost" : "secondary"}
      isIconOnly={small}
      aria-label="Copy link"
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
      {!small && (copied ? "Copied" : "Copy link")}
    </Button>
  );
}

export function LinkDialog({
  isOpen,
  onOpenChange,
  entry,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  entry: Entry | null;
}) {
  const [expiry, setExpiry] = useState(0);
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<{ links: Link[] }>(
    isOpen && entry ? `/api/links?path=${enc(entry.path)}` : null,
    fetcher
  );
  const links = data?.links ?? [];

  async function createLink() {
    if (!entry) return;
    setBusy(true);
    try {
      const res = await api<{ link: Link }>("/api/links", {
        json: { path: entry.path, expiresDays: expiry || undefined },
      });
      await mutate();
      try {
        await navigator.clipboard.writeText(res.link.url);
        toast.success("Public link created and copied to clipboard");
      } catch {
        toast.success("Public link created");
      }
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not create link");
    } finally {
      setBusy(false);
    }
  }

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
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} variant="blur">
      <Modal.Container size="md" placement="center">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Share &ldquo;{entry?.name}&rdquo;</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-xl border border-default bg-surface p-3">
              <Globe2 className="mt-0.5 size-5 shrink-0 text-accent" />
              <div className="text-sm">
                <p className="font-medium">Anyone with the link</p>
                <p className="text-xs leading-relaxed text-muted">
                  Creates a public, read-only link. Anyone who has it can open and download this{" "}
                  {entry?.isDir ? "folder" : "file"} — <span className="font-medium">no sign-in required</span>.
                  Everything else on your drive stays private.
                </p>
              </div>
            </div>

            {/* Expiry picker */}
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">Link expires</p>
              <div className="flex flex-wrap gap-1.5">
                {EXPIRY_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => setExpiry(o.value)}
                    className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      expiry === o.value
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-default hover:bg-foreground/5"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <Button variant="primary" isPending={busy} onPress={createLink}>
              <Link2 className="size-4" />
              Create public link
            </Button>

            {/* Existing links */}
            {links.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Active links</p>
                <div className="flex flex-col gap-2">
                  {links.map((s) => (
                    <div
                      key={s.token}
                      className="flex items-center gap-2 rounded-xl border border-default px-3 py-2"
                    >
                      <Globe2 className="size-4 shrink-0 text-accent" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs">{s.url}</p>
                        <p className="truncate text-[11px] text-muted">
                          {s.expiresAt ? `Expires ${timeAgo(s.expiresAt)}` : "No expiry"} ·{" "}
                          {timeAgo(s.createdAt)}
                        </p>
                      </div>
                      <CopyButton text={s.url} small />
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        aria-label="Revoke link"
                        onPress={() => revoke(s.token)}
                      >
                        <Trash2 className="size-4 text-danger" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
