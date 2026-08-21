"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Spinner } from "@heroui/react";
import { ChevronLeft, ChevronRight, Download, ExternalLink } from "lucide-react";
import { formatBytes } from "@/lib/api";
import type { Entry } from "@/lib/types";
import { ItemIcon } from "./ItemIcon";

export interface PreviewTarget {
  entries: Entry[];
  index: number;
}

export function PreviewModal({
  target,
  onClose,
  onNavigate,
  streamFor,
  downloadFor,
  textFor,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
  streamFor: (e: Entry) => string;
  downloadFor: (e: Entry) => string;
  textFor?: (e: Entry) => string | null;
}) {
  const entry = target ? target.entries[target.index] : null;
  const [text, setText] = useState<string | null>(null);
  const [textBusy, setTextBusy] = useState(false);

  const prev = useCallback(() => {
    if (target && target.index > 0) onNavigate(target.index - 1);
  }, [target, onNavigate]);
  const next = useCallback(() => {
    if (target && target.index < target.entries.length - 1) onNavigate(target.index + 1);
  }, [target, onNavigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!target) return;
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, prev, next]);

  useEffect(() => {
    setText(null);
    if (!entry || entry.kind !== "text" || !textFor) return;
    const url = textFor(entry);
    if (!url) return;
    setTextBusy(true);
    fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("preview failed"))))
      .then(setText)
      .catch(() => setText(null))
      .finally(() => setTextBusy(false));
  }, [entry, textFor]);

  if (!entry) return null;
  const src = streamFor(entry);

  return (
    <Modal.Backdrop
      isOpen={!!target}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      variant="blur"
    >
      <Modal.Container size="cover" placement="center" className="p-2 sm:p-6">
        <Modal.Dialog className="flex h-full flex-col" aria-label={`Preview of ${entry.name}`}>
          <Modal.CloseTrigger />
          <Modal.Header className="pr-12">
            <div className="flex min-w-0 items-center gap-2.5">
              <ItemIcon kind={entry.kind} className="size-5" />
              <div className="min-w-0">
                <p className="truncate font-medium">{entry.name}</p>
                <p className="text-xs text-muted">{formatBytes(entry.size)}</p>
              </div>
              <div className="ml-4 flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    const a = document.createElement("a");
                    a.href = downloadFor(entry);
                    a.download = entry.name;
                    a.click();
                  }}
                >
                  <Download className="size-4" />
                  Download
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label="Open in new tab"
                  onPress={() => window.open(src, "_blank")}
                >
                  <ExternalLink className="size-4" />
                </Button>
              </div>
            </div>
          </Modal.Header>
          <Modal.Body className="relative flex flex-1 items-center justify-center overflow-hidden">
            {target && target.index > 0 && (
              <Button
                isIconOnly
                variant="secondary"
                className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full"
                aria-label="Previous"
                onPress={prev}
              >
                <ChevronLeft className="size-5" />
              </Button>
            )}
            {target && target.index < target.entries.length - 1 && (
              <Button
                isIconOnly
                variant="secondary"
                className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full"
                aria-label="Next"
                onPress={next}
              >
                <ChevronRight className="size-5" />
              </Button>
            )}

            {entry.kind === "image" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={src} src={src} alt={entry.name} className="nimbus-preview-media rounded-lg" />
            )}
            {entry.kind === "video" && (
              <video key={src} src={src} controls autoPlay className="nimbus-preview-media rounded-lg" />
            )}
            {entry.kind === "audio" && (
              <div className="flex w-full max-w-lg flex-col items-center gap-6 py-10">
                <ItemIcon kind="audio" className="size-16" />
                <audio key={src} src={src} controls autoPlay className="w-full" />
              </div>
            )}
            {entry.kind === "pdf" && (
              <iframe key={src} src={src} title={entry.name} className="h-full w-full rounded-lg border border-default bg-white" />
            )}
            {entry.kind === "text" &&
              (textBusy ? (
                <Spinner aria-label="Loading preview" />
              ) : text !== null ? (
                <pre className="h-full w-full overflow-auto rounded-lg border border-default bg-surface p-4 text-xs leading-relaxed">
                  {text}
                </pre>
              ) : (
                <NoPreview entry={entry} downloadFor={downloadFor} />
              ))}
            {!["image", "video", "audio", "pdf", "text"].includes(entry.kind) && (
              <NoPreview entry={entry} downloadFor={downloadFor} />
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function NoPreview({ entry, downloadFor }: { entry: Entry; downloadFor: (e: Entry) => string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <ItemIcon kind={entry.kind} className="size-16" />
      <div>
        <p className="font-medium">No preview for this file type</p>
        <p className="text-sm text-muted">You can download it and open it on your device.</p>
      </div>
      <Button
        variant="primary"
        onPress={() => {
          const a = document.createElement("a");
          a.href = downloadFor(entry);
          a.download = entry.name;
          a.click();
        }}
      >
        <Download className="size-4" />
        Download
      </Button>
    </div>
  );
}
