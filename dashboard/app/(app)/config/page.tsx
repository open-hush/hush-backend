"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { configApi } from "@/lib/api/endpoints";
import { useAuthStore } from "@/lib/auth/store";
import type { ServiceConfig } from "@/lib/api/types";

export default function ConfigPage() {
  const router = useRouter();
  const { user } = useAuthStore();

  // Client-side guard mirroring the server's admin gate. Hiding the sidebar
  // link is convenience; a non-admin reaching this route directly is bounced,
  // and the API returns 403 regardless.
  const isAdmin = user?.role === "admin";
  useEffect(() => {
    if (user && !isAdmin) router.replace("/devices");
  }, [user, isAdmin, router]);

  const query = useQuery({
    queryKey: ["config"],
    queryFn: () => configApi.get(),
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">External services</h1>
        <p className="text-sm text-muted-foreground">
          Status of the integrations the backend can use. Configuration is read-only here: set
          the environment variables below in the backend&apos;s <code>.env</code> and restart it.
          Secret values are never shown.
        </p>
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading configuration…</p>}
      {query.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load configuration"}
        </p>
      )}

      {query.data?.services.map((service) => (
        <ServiceCard key={service.service} service={service} />
      ))}
    </div>
  );
}

function ServiceCard({ service }: { service: ServiceConfig }) {
  const hints = service.hints ?? {};
  const hintEntries = Object.entries(hints);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>{service.label}</CardTitle>
          <CardDescription>
            {service.configured
              ? "Configured and ready to use."
              : "Not configured — set the required variables to enable it."}
          </CardDescription>
        </div>
        <Badge variant={service.configured ? "success" : "secondary"}>
          {service.configured ? "Configured" : "Not configured"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Environment variable</th>
              <th className="py-2 pr-4 font-medium">Required</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {service.variables.map((variable) => (
              <tr key={variable.name} className="border-b last:border-0">
                <td className="py-2 pr-4">
                  <code className="font-mono text-xs">{variable.name}</code>
                  {variable.secret && (
                    <Badge variant="outline" className="ml-2 align-middle">
                      secret
                    </Badge>
                  )}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {variable.required ? "Yes" : "Optional"}
                </td>
                <td className="py-2">
                  {variable.set ? (
                    <Badge variant="success">Set</Badge>
                  ) : (
                    <Badge variant={variable.required ? "warning" : "secondary"}>Not set</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {hintEntries.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {hintEntries.map(([key, value]) => (
              <div key={key} className="flex flex-col">
                <dt className="text-xs uppercase text-muted-foreground">{key}</dt>
                <dd className="font-mono text-xs">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
