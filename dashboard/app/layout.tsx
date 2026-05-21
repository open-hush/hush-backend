import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hush — dashboard",
  description: "Manage your Hush devices, audio library and RFID cards.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-50">
        {children}
      </body>
    </html>
  );
}
