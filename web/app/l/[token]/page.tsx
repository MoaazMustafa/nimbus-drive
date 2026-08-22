"use client";

import { use, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Breadcrumbs, Button, Spinner } from "@heroui/react";
import { Cloud, Download, Eye, Lock } from "lucide-react";
import { ApiError, enc, fetcher, formatBytes, formatDate, triggerDownload } from "@/lib/api";
import type { Entry, Link as PublicLink, Listing } from "@/lib/types";
import { ItemIcon } from "@/components/ItemIcon";
import { PreviewModal, type PreviewTarget } from "@/components/PreviewModal";

const PREVIEWABLE = new Set(["image", "video", "audio", "pdf", "text"]);

export default function PublicLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [sub, setSub] = useState("");
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  const { data: meta, error: metaError } = useSWR<PublicLink>(`/api/public/links/${token}/meta`, fetcher, {
    shouldRetryOnError: false,
  });
  const isDir = meta?.isDir;
  const { data: listing } = useSWR<Listing>(
    isDir ? `/api/public/links/${token}/list?sub=${enc(sub)}` : null,
    fetcher,
    { keepPreviousData: true }
  );

  const streamFor = (e: Entry) => `/api/public/links/${token}/stream?sub=${enc(e.path)}`;
  const downloadFor = (e: Entry) => `/api/public/links/${token}/download?sub=${enc(e.path)}`;

  const entries = useMemo(() => listing?.entries ?? [], [listing]);
  const previewables = useMemo(() => entries.filter((e) => !e.isDir && PREVIEWABLE.has(e.kind)), [entries]);

  const crumbs = useMemo(() => {
    const parts = sub ? sub.split("/") : [];
    return [
      { name: meta?.name ?? "…", path: "" },
      ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") })),
    ];
  }, [sub, meta]);

  const selfEntry: Entry | null = meta
    ? {
        name: meta.name,
        path: "",
        isDir: !!meta.isDir,
        size: meta.size ?? null,
        mtime: meta.mtime ?? 0,
        kind: meta.kind,
      }
    : null;

  return (
    <div className="min-h-dvh bg-background">
      <header className="flex items-center gap-3 border-b border-default bg-surface/60 px-4 py-3 backdrop-blur-md sm:px-6">
        <span className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground">
          <Cloud className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{meta?.name ?? "Shared item"}</p>
          <p className="truncate text-xs text-muted">{meta ? `Shared by ${meta.createdBy}` : "Opening…"}</p>
        </div>
        {meta && (
          <Button
            size="sm"
            variant="primary"
            onPress={() =>
              triggerDownload(`/api/public/links/${token}/download${isDir && sub ? `?sub=${enc(sub)}` : ""}`)
            }
          >
            <Download className="size-4" />
            <span className="hidden sm:inline">Download{isDir ? " .zip" : ""}</span>
          </Button>
        )}
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        {!meta && !metaError && (
          <div className="grid place-items-center py-24">
            <Spinner aria-label="Loading" size="lg" />
          </div>
        )}

        {metaError && (
          <div className="grid place-items-center py-24 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-danger/10">
                <Lock className="size-8 text-danger" />
              </div>
              <p className="text-lg font-medium">This link isn&apos;t available</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {metaError instanceof ApiError && metaError.status === 404
                  ? "The link is invalid, has expired, or the item was removed."
                  : "Something went wrong opening this link. Please try again."}
              </p>
            </div>
          </div>
        )}

        {/* Single shared file */}
        {meta && !isDir && selfEntry && (
          <div className="flex flex-col items-center gap-6 py-6">
            <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-default bg-surface">
              <div className="grid min-h-[50vh] place-items-center p-4">
                {PREVIEWABLE.has(meta.kind) ? (
                  <InlineFilePreview
                    entry={selfEntry}
                    src={`/api/public/links/${token}/stream`}
                    textUrl={meta.kind === "text" ? `/api/public/links/${token}/stream` : null}
                  />
                ) : (
                  <div className="flex flex-col items-center gap-4 py-10 text-center">
                    <ItemIcon kind={meta.kind} className="size-16" />
                    <p className="text-sm text-muted">No preview — use Download above.</p>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3 border-t border-default px-5 py-3 text-sm text-muted">
                <ItemIcon kind={meta.kind} className="size-4" />
                <span className="truncate">{meta.name}</span>
                <span className="ml-auto">{formatBytes(meta.size)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Shared folder */}
        {meta && isDir && (
          <>
            <Breadcrumbs className="mb-4">
              {crumbs.map((c, i) =>
                i === crumbs.length - 1 ? (
                  <Breadcrumbs.Item key={c.path || "root"}>{c.name}</Breadcrumbs.Item>
                ) : (
                  <Breadcrumbs.Item key={c.path || "root"} onPress={() => setSub(c.path)}>
                    {c.name}
                  </Breadcrumbs.Item>
                )
              )}
            </Breadcrumbs>
            <div className="overflow-hidden rounded-xl border border-default">
              {entries.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted">This folder is empty.</p>
              ) : (
                entries.map((e) => (
                  <div
                    key={e.path}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (e.isDir) setSub(e.path);
                      else if (PREVIEWABLE.has(e.kind)) {
                        const idx = previewables.findIndex((p) => p.path === e.path);
                        if (idx >= 0) setPreview({ entries: previewables, index: idx });
                      } else {
                        triggerDownload(downloadFor(e));
                      }
                    }}
                    className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 border-b border-default/60 px-4 py-2.5 last:border-b-0 hover:bg-foreground/5 sm:grid-cols-[1fr_110px_130px_auto]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <ItemIcon kind={e.kind} className="size-4.5" />
                      <span className="truncate text-sm">{e.name}</span>
                    </div>
                    <span className="hidden text-right text-sm text-muted sm:block">
                      {e.isDir ? "—" : formatBytes(e.size)}
                    </span>
                    <span className="hidden text-right text-sm text-muted sm:block">{formatDate(e.mtime)}</span>
                    <div className="flex items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
                      {!e.isDir && PREVIEWABLE.has(e.kind) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          isIconOnly
                          aria-label="Preview"
                          onPress={() => {
                            const idx = previewables.findIndex((p) => p.path === e.path);
                            if (idx >= 0) setPreview({ entries: previewables, index: idx });
                          }}
                        >
                          <Eye className="size-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        isIconOnly
                        aria-label="Download"
                        onPress={() => triggerDownload(downloadFor(e))}
                      >
                        <Download className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </main>

      <PreviewModal
        target={preview}
        onClose={() => setPreview(null)}
        onNavigate={(i) => setPreview((p) => (p ? { ...p, index: i } : p))}
        streamFor={streamFor}
        downloadFor={downloadFor}
        textFor={(e) => streamFor(e)}
      />
    </div>
  );
}

function InlineFilePreview({ entry, src, textUrl }: { entry: Entry; src: string; textUrl: string | null }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (entry.kind !== "text" || !textUrl) return;
    let cancelled = false;
    fetch(textUrl, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => !cancelled && setText(t))
      .catch(() => !cancelled && setText(""));
    return () => {
      cancelled = true;
    };
  }, [entry.kind, textUrl]);
  switch (entry.kind) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={src} alt={entry.name} className="nimbus-preview-media rounded-lg" />;
    case "video":
      return <video src={src} controls className="nimbus-preview-media rounded-lg" />;
    case "audio":
      return <audio src={src} controls className="w-full max-w-lg" />;
    case "pdf":
      return <iframe src={src} title={entry.name} className="h-[70vh] w-full rounded-lg border border-default bg-white" />;
    case "text":
      return (
        <pre className="max-h-[60vh] w-full overflow-auto rounded-lg border border-default bg-background p-4 text-left text-xs leading-relaxed">
          {text ?? "Loading…"}
        </pre>
      );
    default:
      return null;
  }
}
