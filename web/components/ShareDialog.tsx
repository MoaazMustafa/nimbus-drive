"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Button, Input, Modal, TextField, toast } from "@heroui/react";
import { Check, Copy, Globe2, Link2, Trash2, UserPlus, Users2, X } from "lucide-react";
import { api, enc, fetcher, timeAgo } from "@/lib/api";
import type { Entry, Share } from "@/lib/types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function ShareDialog({
  isOpen,
  onOpenChange,
  entry,
}: {
  isOpen: boolean;
  onOpenChange: (o: boolean) => void;
  entry: Entry | null;
}) {
  const [mode, setMode] = useState<"workspace" | "restricted">("workspace");
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<{ shares: Share[] }>(
    isOpen && entry ? `/api/shares?path=${enc(entry.path)}` : null,
    fetcher
  );
  const shares = data?.shares ?? [];

  useEffect(() => {
    if (isOpen) {
      setMode("workspace");
      setEmails([]);
      setEmailInput("");
    }
  }, [isOpen]);

  function addEmail() {
    const e = emailInput.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL_RE.test(e)) {
      toast.warning("That doesn't look like an email address");
      return;
    }
    if (!emails.includes(e)) setEmails([...emails, e]);
    setEmailInput("");
  }

  async function createShare() {
    if (!entry) return;
    if (mode === "restricted" && emails.length === 0) {
      toast.warning("Add at least one person first");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ share: Share }>("/api/shares", {
        json: { path: entry.path, mode, emails },
      });
      await mutate();
      try {
        await navigator.clipboard.writeText(res.share.url);
        toast.success("Link created and copied to clipboard");
      } catch {
        toast.success("Link created");
      }
      setEmails([]);
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not create link");
    } finally {
      setBusy(false);
    }
  }

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
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} variant="blur">
      <Modal.Container size="md" placement="center">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Share &ldquo;{entry?.name}&rdquo;</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            {/* Mode picker */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                onClick={() => setMode("workspace")}
                className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                  mode === "workspace"
                    ? "border-accent bg-accent/10"
                    : "border-default hover:bg-foreground/5"
                }`}
              >
                <Globe2 className="mt-0.5 size-4.5 shrink-0 text-accent" />
                <span>
                  <span className="block text-sm font-medium">Anyone authorized</span>
                  <span className="block text-xs text-muted">
                    Any signed-in user of this drive with the link can open it
                  </span>
                </span>
              </button>
              <button
                onClick={() => setMode("restricted")}
                className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                  mode === "restricted"
                    ? "border-accent bg-accent/10"
                    : "border-default hover:bg-foreground/5"
                }`}
              >
                <Users2 className="mt-0.5 size-4.5 shrink-0 text-accent" />
                <span>
                  <span className="block text-sm font-medium">Specific people</span>
                  <span className="block text-xs text-muted">
                    Only the people you pick can open it — even with the link
                  </span>
                </span>
              </button>
            </div>

            {mode === "restricted" && (
              <div>
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addEmail();
                  }}
                >
                  <TextField
                    className="flex-1"
                    value={emailInput}
                    onChange={setEmailInput}
                    aria-label="Email address"
                  >
                    <Input placeholder="name@gmail.com" />
                  </TextField>
                  <Button variant="secondary" onPress={addEmail} aria-label="Add person">
                    <UserPlus className="size-4" />
                    Add
                  </Button>
                </form>
                {emails.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {emails.map((e) => (
                      <span
                        key={e}
                        className="inline-flex items-center gap-1 rounded-full bg-foreground/8 py-1 pl-3 pr-1.5 text-xs"
                      >
                        {e}
                        <button
                          aria-label={`Remove ${e}`}
                          onClick={() => setEmails(emails.filter((x) => x !== e))}
                          className="rounded-full p-0.5 hover:bg-foreground/10"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-xs text-muted">
                  People must also be on the allowlist to sign in at all.
                </p>
              </div>
            )}

            <Button variant="primary" isPending={busy} onPress={createShare}>
              <Link2 className="size-4" />
              Create link{mode === "workspace" ? "" : ` for ${emails.length || "…"} people`}
            </Button>

            {/* Existing links */}
            {shares.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                  Active links
                </p>
                <div className="flex flex-col gap-2">
                  {shares.map((s) => (
                    <div
                      key={s.token}
                      className="flex items-center gap-2 rounded-xl border border-default px-3 py-2"
                    >
                      {s.mode === "workspace" ? (
                        <Globe2 className="size-4 shrink-0 text-accent" />
                      ) : (
                        <Users2 className="size-4 shrink-0 text-accent" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs">{s.url}</p>
                        <p className="truncate text-[11px] text-muted">
                          {s.mode === "workspace"
                            ? "Anyone authorized with the link"
                            : `${s.members?.length ?? 0} people: ${(s.members ?? []).join(", ")}`}{" "}
                          · {timeAgo(s.createdAt)}
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
