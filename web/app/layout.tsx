import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

// Deliberately no web fonts: the system font stack loads instantly, works with
// no internet access, and keeps builds reproducible on any machine.

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME || "Nimbus Drive",
  description: "Your files, on your own machine — from anywhere.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
