"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Loader2, X } from "lucide-react";
import type { UploadItem } from "@/lib/upload";
import { formatBytes } from "@/lib/api";

export function UploadPanel({
  items,
  onClear,
}: {
  items: UploadItem[];
  onClear: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (items.length === 0) return null;
  const active = items.filter((i) => i.status === "uploading").length;
  const failed = items.filter((i) => i.status === "error").length;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 overflow-hidden rounded-2xl border border-default bg-background shadow-2xl">
      <div className="flex items-center gap-2 border-b border-default bg-surface px-4 py-2.5">
        <p className="text-sm font-medium">
          {active > 0
            ? `Uploading ${active} ${active === 1 ? "file" : "files"}…`
            : failed > 0
              ? `Done, ${failed} failed`
              : "Uploads complete"}
        </p>
        <div className="ml-auto flex items-center gap-1">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={collapsed ? "Expand" : "Collapse"}
            onPress={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
          {active === 0 && (
            <Button isIconOnly size="sm" variant="ghost" aria-label="Close" onPress={onClear}>
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {!collapsed && (
        <ul className="max-h-64 overflow-auto p-2">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 rounded-xl px-2 py-2">
              {it.status === "uploading" && <Loader2 className="size-4 shrink-0 animate-spin text-accent" />}
              {it.status === "done" && <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />}
              {it.status === "error" && <CircleAlert className="size-4 shrink-0 text-danger" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{it.name}</p>
                {it.status === "uploading" ? (
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-200"
                      style={{ width: `${Math.round(it.progress * 100)}%` }}
                    />
                  </div>
                ) : (
                  <p className="truncate text-xs text-muted">
                    {it.status === "error" ? it.error || "Failed" : formatBytes(it.size)}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
