"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { authApi } from "@/lib/api/endpoints";
import { useAuthStore } from "@/lib/auth/store";

export default function RootPage() {
  const router = useRouter();
  const { accessToken, setAccessToken, setUser } = useAuthStore();

  useEffect(() => {
    if (accessToken) {
      router.replace("/devices");
      return;
    }
    // Try the refresh cookie. If we get tokens back, we're logged in.
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
          const me = await authApi.me();
          setUser(me);
        } catch {
          /* ignore — token still valid for navigation */
        }
        router.replace("/devices");
      })
      .catch(() => router.replace("/login"));
  }, [accessToken, router, setAccessToken, setUser]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </main>
  );
}
