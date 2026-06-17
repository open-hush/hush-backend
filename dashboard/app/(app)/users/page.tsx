"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { usersApi } from "@/lib/api/endpoints";
import { useAuthStore } from "@/lib/auth/store";

export default function UsersPage() {
  const router = useRouter();
  const { user } = useAuthStore();

  // Client-side guard mirroring the server's admin gate. Hiding the sidebar
  // link is not enough — a non-admin reaching this route directly is bounced
  // away, and the API would return 403 regardless.
  const isAdmin = user?.role === "admin";
  useEffect(() => {
    if (user && !isAdmin) router.replace("/devices");
  }, [user, isAdmin, router]);

  const query = useQuery({
    queryKey: ["users"],
    queryFn: () => usersApi.list(),
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">Accounts that can sign in to the dashboard.</p>
        </div>
        <Button asChild>
          <Link href="/users/new">
            <Plus className="mr-1 h-4 w-4" />
            Add user
          </Link>
        </Button>
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading users…</p>}
      {query.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load users"}
        </p>
      )}
      {query.data && query.data.items.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No users yet</CardTitle>
            <CardDescription>Create the first account with “Add user”.</CardDescription>
          </CardHeader>
        </Card>
      )}
      {query.data && query.data.items.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Display name</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((u) => (
                  <tr key={u.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{u.email}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.displayName ?? "—"}</td>
                    <td className="px-4 py-3">
                      <Badge variant={u.role === "admin" ? "success" : "secondary"}>{u.role}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
