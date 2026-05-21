"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { CassetteTape, LayoutDashboard, LogOut, Speaker } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { authApi } from "@/lib/api/endpoints";
import { useAuthStore } from "@/lib/auth/store";

const NAV = [
  { href: "/devices", label: "Devices", icon: Speaker },
  { href: "/audio", label: "Audio library", icon: CassetteTape },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { accessToken, user, setAccessToken, setUser, reset } = useAuthStore();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (accessToken) {
      setReady(true);
      return;
    }
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/v1/users/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (tokens) => {
        if (!tokens) {
          router.replace("/login");
          return;
        }
        setAccessToken(tokens.accessToken);
        try {
          setUser(await authApi.me());
        } catch {
          /* ignore */
        }
        setReady(true);
      })
      .catch(() => router.replace("/login"));
  }, [accessToken, router, setAccessToken, setUser]);

  async function logout() {
    reset();
    // No explicit logout endpoint yet; rely on access-token expiry + cookie clearing.
    router.replace("/login");
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 flex-col border-r bg-card sm:flex">
        <div className="flex h-14 items-center border-b px-6">
          <Link href="/devices" className="flex items-center gap-2 font-semibold">
            <LayoutDashboard className="h-5 w-5" />
            Hush
          </Link>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                  active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-2 border-t p-3">
          <p className="px-3 text-xs text-muted-foreground">
            {user?.email ?? "Signed in"}
          </p>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
