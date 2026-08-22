import Link from "next/link";
import { Cloud } from "lucide-react";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-accent/10">
          <Cloud className="size-8 text-accent" />
        </div>
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          That page doesn&apos;t exist. It may have moved, or the link was mistyped.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
        >
          Back to My Drive
        </Link>
      </div>
    </div>
  );
}
