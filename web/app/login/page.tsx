"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { Button, Card, Spinner } from "@heroui/react";
import { Cloud, FolderLock, MonitorSmartphone, RefreshCw } from "lucide-react";
import { fetcher } from "@/lib/api";
import type { Me } from "@/lib/types";

const ERRORS: Record<string, string> = {
  not_authorized: "This Google account isn't on the allowlist for this drive.",
  not_configured: "Google sign-in isn't configured yet — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the .env file (see SETUP.md).",
  state_mismatch: "The sign-in attempt expired or was tampered with. Please try again.",
  token_exchange: "Google rejected the sign-in attempt. Please try again.",
  google_unreachable: "Could not reach Google. Check the server's internet connection and try again.",
  userinfo: "Could not read your Google profile. Please try again.",
  no_email: "Google did not return an email address for that account.",
  unverified_email: "That Google account's email address is not verified.",
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function LoginInner() {
  const params = useSearchParams();
  const router = useRouter();
  const error = params.get("error");
  const email = params.get("email");

  // Already signed in? Straight to the drive.
  const { data: me } = useSWR<Me>("/api/me", fetcher, { shouldRetryOnError: false });
  useEffect(() => {
    if (me) router.replace("/");
  }, [me, router]);

  const appName = process.env.NEXT_PUBLIC_APP_NAME || "Nimbus Drive";

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-accent text-accent-foreground shadow-lg">
            <Cloud className="size-7" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{appName}</h1>
            <p className="mt-1 text-sm text-muted">Your files, on your own machine — from anywhere.</p>
          </div>
        </div>

        <Card className="w-full">
          <Card.Content className="flex flex-col gap-4 p-6">
            {error && (
              <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3">
                <p className="text-sm font-medium text-danger">Sign-in failed</p>
                <p className="mt-0.5 text-xs leading-relaxed text-foreground/80">
                  {ERRORS[error] || "Something went wrong. Please try again."}
                  {error === "not_authorized" && email ? ` (${email})` : ""}
                </p>
              </div>
            )}
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onPress={() => {
                window.location.href = "/api/auth/google";
              }}
            >
              <GoogleMark />
              Continue with Google
            </Button>
            <p className="text-center text-xs leading-relaxed text-muted">
              Only Google accounts on this drive&apos;s allowlist can get in. Nothing here is public.
            </p>
          </Card.Content>
        </Card>

        <div className="mt-8 grid grid-cols-3 gap-3 text-center">
          {[
            { icon: FolderLock, label: "Private by default" },
            { icon: MonitorSmartphone, label: "Any device" },
            { icon: RefreshCw, label: "Live folder sync" },
          ].map((f) => (
            <div key={f.label} className="flex flex-col items-center gap-1.5 text-muted">
              <f.icon className="size-4.5" />
              <span className="text-[11px] leading-tight">{f.label}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-dvh place-items-center">
          <Spinner aria-label="Loading" size="lg" />
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
