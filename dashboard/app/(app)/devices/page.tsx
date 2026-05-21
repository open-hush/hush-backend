"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ChevronRight, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { devicesApi } from "@/lib/api/endpoints";
import type { Device } from "@/lib/api/types";
import { HttpError } from "@/lib/api/client";

const claimSchema = z.object({
  deviceId: z.string().uuid("must be a UUID"),
  claimCode: z.string().min(1, "claim code required"),
  name: z.string().max(120).optional().or(z.literal("")),
});

type ClaimValues = z.infer<typeof claimSchema>;

function stateVariant(state: Device["state"]): "secondary" | "success" | "outline" {
  if (state === "claimed") return "success";
  if (state === "retired") return "outline";
  return "secondary";
}

export default function DevicesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["devices"],
    queryFn: () => devicesApi.list(),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ClaimValues>({ resolver: zodResolver(claimSchema) });

  const claim = useMutation({
    mutationFn: (values: ClaimValues) =>
      devicesApi.claim(values.deviceId, {
        claimCode: values.claimCode,
        ...(values.name ? { name: values.name } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      setOpen(false);
      reset();
      setError(null);
    },
    onError: (err) => {
      const msg = err instanceof HttpError && err.body?.message ? err.body.message : "Claim failed";
      setError(msg);
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Devices</h1>
          <p className="text-sm text-muted-foreground">Boxes you own.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 h-4 w-4" />
              Claim device
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Claim a device</DialogTitle>
              <DialogDescription>
                Enter the device ID (UUID) and the claim code printed on the box / shown after first boot.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit((v) => claim.mutate(v))} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="deviceId">Device ID</Label>
                <Input id="deviceId" placeholder="00000000-0000-0000-0000-000000000000" {...register("deviceId")} />
                {errors.deviceId && (
                  <p className="text-xs text-destructive">{errors.deviceId.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claimCode">Claim code</Label>
                <Input id="claimCode" {...register("claimCode")} />
                {errors.claimCode && (
                  <p className="text-xs text-destructive">{errors.claimCode.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="name">Name (optional)</Label>
                <Input id="name" placeholder="Marta's box" {...register("name")} />
              </div>
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <DialogFooter>
                <Button type="submit" disabled={isSubmitting || claim.isPending}>
                  {claim.isPending ? "Claiming…" : "Claim"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading devices…</p>}
      {query.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {query.error instanceof Error ? query.error.message : "Failed to load devices"}
        </p>
      )}
      {query.data && query.data.items.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No devices yet</CardTitle>
            <CardDescription>
              Power on your Hush, pair it via BLE, and use the claim code shown after first boot.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
      {query.data && query.data.items.length > 0 && (
        <div className="grid gap-3">
          {query.data.items.map((d) => (
            <Link key={d.id} href={`/devices/${d.id}`}>
              <Card className="transition-colors hover:bg-accent/40">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{d.name ?? d.serial}</p>
                      <Badge variant={stateVariant(d.state)}>{d.state}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Serial {d.serial}
                      {d.firmwareVersion ? ` · fw ${d.firmwareVersion}` : ""}
                      {d.lastSeenAt ? ` · last seen ${new Date(d.lastSeenAt).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
