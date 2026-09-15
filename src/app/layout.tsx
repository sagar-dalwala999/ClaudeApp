import type { Metadata, Viewport } from "next";
import { ServiceWorker } from "@/components/ServiceWorker";
import "./globals.css";
import "./ui.css";

export const metadata: Metadata = {
  title: "Looks",
  description: "A personal link archive: paste a link and it is fetched, summarised and filed.",
  // Served by app/manifest.webmanifest/route.ts, which keeps the share target.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Looks", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0b",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
