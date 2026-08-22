"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@heroui/react";
import { AppShell } from "@/components/AppShell";
import { FileBrowser } from "@/components/FileBrowser";
import { useMe } from "@/lib/hooks";
import { enc } from "@/lib/api";

function FileBrowserContainer() {
  const router = useRouter();
  const params = useSearchParams();
  const path = params.get("p") ?? "";
  const previewName = params.get("preview");

  const navigate = useCallback(
    (p: string) => {
      router.push(p ? `/?p=${enc(p)}` : "/");
    },
    [router]
  );

  return (
    <FileBrowser
      path={path}
      onNavigate={navigate}
      initialPreviewName={previewName}
      onConsumedPreview={() => router.replace(path ? `/?p=${enc(path)}` : "/")}
    />
  );
}

export default function Page() {
  const { me, isLoading, error } = useMe(true);

  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner aria-label="Loading drive..." size="lg" />
      </div>
    );
  }

  if (!me) {
    if (error && (error as { status?: number })?.status !== 401 && !String(error?.message).includes("401")) {
      return (
        <div className="grid min-h-dvh place-items-center px-4 text-center">
          <div className="max-w-md space-y-4">
            <div className="rounded-2xl border border-danger/30 bg-danger/10 p-6">
              <h2 className="text-lg font-semibold text-danger">Connection Issue</h2>
              <p className="mt-2 text-sm text-foreground/80">
                Could not connect to the drive server ({error?.message || "Server unreachable"}).
              </p>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground shadow-sm transition hover:opacity-90"
            >
              Retry Connection
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner aria-label="Redirecting to login..." size="lg" />
      </div>
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<div className="p-8 text-center"><Spinner size="lg" /></div>}>
        <FileBrowserContainer />
      </Suspense>
    </AppShell>
  );
}
