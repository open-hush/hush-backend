import type { Metadata } from "next";

import "./globals.css";

import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Hush — dashboard",
  description: "Manage your Hush devices, audio library and RFID cards.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
