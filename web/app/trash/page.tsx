"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Button, Modal, Spinner, toast } from "@heroui/react";
import { RotateCcw, Trash2, Check, X, AlertTriangle } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ItemIcon } from "@/components/ItemIcon";
import { api, fetcher, formatBytes, timeAgo } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { TrashItem } from "@/lib/types";

function SelectBox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`grid size-5 shrink-0 place-items-center rounded-md border transition-colors ${
        checked ? "border-accent bg-accent text-accent-foreground" : "border-default text-transparent hover:border-accent"
      }`}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
  );
}

export default function TrashPage() {
  const { me } = useMe();
  const { data, isLoading, mutate } = useSWR<{ items: TrashItem[]; enabled: boolean }>(
    me ? "/api/fs/trash" : null,
    fetcher
  );
  const items = useMemo(() => data?.items ?? [], [data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | "selected" | "all">(null);
  const [busy, setBusy] = useState(false);

  const allSelected = items.length > 0 && selected.size === items.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))));

  async function restore() {
    const ids = [...selected];
    if (ids.length === 0) return;
    try {
      await api("/api/fs/trash/restore", { json: { ids } });
      setSelected(new Set());
      await mutate();
      toast.success(ids.length > 1 ? `Restored ${ids.length} items` : "Restored");
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not restore");
    }
  }

  async function purge(which: "selected" | "all") {
    setBusy(true);
    try {
      if (which === "all") {
        await api("/api/fs/trash/empty", { json: {} });
        toast.success("Trash emptied");
      } else {
        await api("/api/fs/trash/delete", { json: { ids: [...selected] } });
        toast.success("Deleted permanently");
      }
      setSelected(new Set());
      setConfirm(null);
      await mutate();
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h1 className="text-lg font-semibold">Trash</h1>
            <p className="mt-0.5 text-sm text-muted">
              Deleted items are kept here so you can restore them. Emptying the trash is permanent.
            </p>
          </div>
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onPress={() => setConfirm("all")}>
              <Trash2 className="size-4 text-danger" />
              Empty trash
            </Button>
          )}
        </div>

        {selected.size > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-default bg-surface px-3 py-2">
            <Button isIconOnly size="sm" variant="ghost" aria-label="Clear" onPress={() => setSelected(new Set())}>
              <X className="size-4" />
            </Button>
            <span className="text-sm font-medium">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="secondary" size="sm" onPress={restore}>
                <RotateCcw className="size-4" />
                Restore
              </Button>
              <Button variant="danger" size="sm" onPress={() => setConfirm("selected")}>
                <Trash2 className="size-4" />
                Delete forever
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        ) : items.length === 0 ? (
          <div className="grid place-items-center py-24 text-center">
            <div>
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-accent/10">
                <Trash2 className="size-8 text-accent" />
              </div>
              <p className="font-medium">Trash is empty</p>
              <p className="mt-1 text-sm text-muted">Deleted files and folders will show up here.</p>
            </div>
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-default">
            <div className="hidden grid-cols-[28px_1fr_110px_150px] items-center gap-3 border-b border-default bg-surface px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted sm:grid">
              <SelectBox checked={allSelected} onChange={toggleAll} label="Select all" />
              <span>Name</span>
              <span className="text-right">Size</span>
              <span className="text-right">Deleted</span>
            </div>
            {items.map((t) => {
              const isSel = selected.has(t.id);
              return (
                <div
                  key={t.id}
                  className={`grid grid-cols-[28px_1fr] items-center gap-3 border-b border-default/60 px-4 py-2.5 last:border-b-0 sm:grid-cols-[28px_1fr_110px_150px] ${
                    isSel ? "bg-accent/10" : ""
                  }`}
                >
                  <SelectBox checked={isSel} onChange={() => toggle(t.id)} label={`Select ${t.name}`} />
                  <div className="flex min-w-0 items-center gap-3">
                    <ItemIcon kind={t.kind} className="size-4.5" />
                    <div className="min-w-0">
                      <p className="truncate text-sm">{t.name}</p>
                      <p className="truncate text-xs text-muted">was in /{t.origPath.replace(/\/[^/]*$/, "") || "My Drive"}</p>
                    </div>
                  </div>
                  <span className="hidden text-right text-sm text-muted sm:block">
                    {t.isDir ? "—" : formatBytes(t.size)}
                  </span>
                  <span className="hidden text-right text-sm text-muted sm:block">{timeAgo(t.deletedAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal.Backdrop isOpen={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} variant="blur">
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{confirm === "all" ? "Empty the trash?" : "Delete permanently?"}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
                <p className="text-sm text-muted">
                  {confirm === "all"
                    ? "Everything in the trash will be permanently deleted. This cannot be undone."
                    : `The selected ${selected.size > 1 ? `${selected.size} items` : "item"} will be permanently deleted. This cannot be undone.`}
                </p>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" onPress={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant="danger" isPending={busy} onPress={() => purge(confirm!)}>
                {confirm === "all" ? "Empty trash" : "Delete forever"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </AppShell>
  );
}
