"use client";

import { useEffect } from "react";
import { Button } from "@heroui/react";
import { AlertTriangle } from "lucide-react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <div className="grid min-h-dvh place-items-center px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-danger/10">
          <AlertTriangle className="size-8 text-danger" />
        </div>
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          The page hit an unexpected error. Trying again usually fixes it.
        </p>
        <Button className="mt-5" variant="primary" onPress={() => reset()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
