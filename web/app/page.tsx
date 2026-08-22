"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Spinner } from "@heroui/react";
import { AppShell } from "@/components/AppShell";
import { FileBrowser } from "@/components/FileBrowser";
import { useMe } from "@/lib/hooks";
import { enc } from "@/lib/api";

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
      <FileBrowser
        path={path}
        onNavigate={navigate}
        initialPreviewName={previewName}
        onConsumedPreview={() => router.replace(path ? `/?p=${enc(path)}` : "/")}
      />
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
