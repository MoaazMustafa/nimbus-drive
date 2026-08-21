"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@heroui/react";
import { AppShell } from "@/components/AppShell";
import { FileBrowser } from "@/components/FileBrowser";
import { useMe } from "@/lib/hooks";
import { enc } from "@/lib/api";
import Link from "next/link";

function DrivePage() {
  const { me, isLoading } = useMe();
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

  if (isLoading || !me) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner aria-label="Loading" size="lg" />
      </div>
    );
  }

  return (
    <AppShell>
      {me.canBrowse ? (
        <FileBrowser
          path={path}
          onNavigate={navigate}
          initialPreviewName={previewName}
          onConsumedPreview={() => router.replace(path ? `/?p=${enc(path)}` : "/")}
        />
      ) : (
        <div className="grid min-h-[60dvh] place-items-center px-6 text-center">
          <div className="max-w-md">
            <h1 className="text-xl font-semibold">Welcome!</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Your account has guest access: you can open anything that has been shared with you.
              Check{" "}
              <Link href="/shared" className="text-accent underline underline-offset-2">
                Shared with me
              </Link>{" "}
              to see your files.
            </p>
          </div>
        </div>
      )}
    </AppShell>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-dvh place-items-center">
          <Spinner aria-label="Loading" size="lg" />
        </div>
      }
    >
      <DrivePage />
    </Suspense>
  );
}
