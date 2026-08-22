import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

// Deliberately no web fonts: the system font stack loads instantly, works with
// no internet access, and keeps builds reproducible on any machine.

const appName = process.env.NEXT_PUBLIC_APP_NAME || "Nimbus Drive";

export const metadata: Metadata = {
  applicationName: appName,
  title: { default: appName, template: `%s · ${appName}` },
  description: "Your files, on your own machine — from anywhere.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: appName },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f17" },
  ],
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
