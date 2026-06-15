"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ChevronLeft, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { audioApi, devicesApi } from "@/lib/api/endpoints";
import { HttpError } from "@/lib/api/client";

const bindSchema = z.object({
  uid: z.string().regex(/^[0-9a-f]{8,20}$/, "lowercase hex, 8-20 chars"),
  audioId: z.string().uuid("must be a UUID"),
});

type BindValues = z.infer<typeof bindSchema>;

const renameSchema = z.object({
  name: z.string().max(120, "120 characters max"),
});

type RenameValues = z.infer<typeof renameSchema>;

export default function DeviceDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const qc = useQueryClient();
  const router = useRouter();
  const [bindError, setBindError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameOk, setRenameOk] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

  const device = useQuery({
    queryKey: ["device", id],
    queryFn: () => devicesApi.get(id),
  });

  const cards = useQuery({
    queryKey: ["device", id, "cards"],
    queryFn: () => devicesApi.listCards(id),
  });

  const audios = useQuery({
    queryKey: ["audio"],
    queryFn: () => audioApi.list(),
  });

  const bind = useMutation({
    mutationFn: (v: BindValues) => devicesApi.bindCard(id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device", id, "cards"] });
      reset();
      setBindError(null);
    },
    onError: (err) => {
      const msg = err instanceof HttpError && err.body?.message ? err.body.message : "Bind failed";
      setBindError(msg);
    },
  });

  const unbind = useMutation({
    mutationFn: (uid: string) => devicesApi.unbindCard(id, uid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["device", id, "cards"] }),
  });

  const rename = useMutation({
    // Empty input clears the name (sent as null); otherwise set the new name.
    mutationFn: (v: RenameValues) =>
      devicesApi.update(id, { name: v.name.trim() === "" ? null : v.name.trim() }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["device", id] });
      qc.invalidateQueries({ queryKey: ["devices"] });
      renameForm.reset({ name: updated.name ?? "" });
      setRenameError(null);
      setRenameOk(true);
    },
    onError: (err) => {
      setRenameOk(false);
      setRenameError(err instanceof HttpError && err.body?.message ? err.body.message : "Rename failed");
    },
  });

  const retire = useMutation({
    mutationFn: () => devicesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["devices"] });
      setRetireOpen(false);
      router.push("/devices");
    },
    onError: (err) => {
      setRetireError(err instanceof HttpError && err.body?.message ? err.body.message : "Could not retire device");
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<BindValues>({ resolver: zodResolver(bindSchema) });

  const renameForm = useForm<RenameValues>({
    resolver: zodResolver(renameSchema),
    defaultValues: { name: "" },
  });

  // Seed the rename field once the device loads (and after external refetches).
  useEffect(() => {
    if (device.data) renameForm.reset({ name: device.data.name ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.data?.name]);

  const audioTitleById: Record<string, string> = {};
  for (const a of audios.data?.items ?? []) audioTitleById[a.id] = a.title;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/devices" className="flex items-center text-sm text-muted-foreground hover:underline">
          <ChevronLeft className="mr-1 h-4 w-4" />
          All devices
        </Link>
      </div>

      {device.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {device.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {device.error instanceof HttpError && device.error.status === 404
            ? "Device not found"
            : "Failed to load device"}
        </p>
      )}
      {device.data && (
        <>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{device.data.name ?? device.data.serial}</h1>
              <Badge variant={device.data.state === "claimed" ? "success" : "secondary"}>
                {device.data.state}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Serial {device.data.serial}
              {device.data.firmwareVersion ? ` · fw ${device.data.firmwareVersion}` : ""}
              {device.data.lastSeenAt ? ` · last seen ${new Date(device.data.lastSeenAt).toLocaleString()}` : ""}
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Card bindings</CardTitle>
              <CardDescription>Map an RFID card UID to an audio item.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {cards.isLoading && <p className="text-sm text-muted-foreground">Loading bindings…</p>}
              {cards.data && cards.data.items.length === 0 && (
                <p className="text-sm text-muted-foreground">No bindings yet.</p>
              )}
              {cards.data && cards.data.items.length > 0 && (
                <ul className="divide-y rounded-md border">
                  {cards.data.items.map((c) => (
                    <li key={c.uid} className="flex items-center justify-between p-3">
                      <div className="space-y-1">
                        <p className="font-mono text-sm">{c.uid}</p>
                        <p className="text-xs text-muted-foreground">
                          → {audioTitleById[c.audioId] ?? c.audioId}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => unbind.mutate(c.uid)}
                        disabled={unbind.isPending}
                        aria-label="Unbind"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={handleSubmit((v) => bind.mutate(v))} className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="uid">Card UID (hex)</Label>
                  <Input id="uid" placeholder="04a1b2c3" {...register("uid")} />
                  {errors.uid && <p className="text-xs text-destructive">{errors.uid.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="audioId">Audio ID</Label>
                  <Input id="audioId" placeholder="UUID of a ready audio" {...register("audioId")} />
                  {errors.audioId && <p className="text-xs text-destructive">{errors.audioId.message}</p>}
                </div>
                <div className="sm:col-span-2 flex items-center justify-between gap-3">
                  {bindError ? (
                    <p className="text-xs text-destructive">{bindError}</p>
                  ) : (
                    <span />
                  )}
                  <Button type="submit" disabled={bind.isPending}>
                    {bind.isPending ? "Binding…" : "Bind card"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Device settings</CardTitle>
              <CardDescription>Rename this device. Leave the field empty to fall back to the serial.</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={renameForm.handleSubmit((v) => rename.mutate(v))}
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
              >
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    placeholder={device.data.serial}
                    {...renameForm.register("name", {
                      onChange: () => {
                        setRenameOk(false);
                        setRenameError(null);
                      },
                    })}
                  />
                  {renameForm.formState.errors.name && (
                    <p className="text-xs text-destructive">{renameForm.formState.errors.name.message}</p>
                  )}
                  {renameError && <p className="text-xs text-destructive">{renameError}</p>}
                  {renameOk && <p className="text-xs text-muted-foreground">Saved.</p>}
                </div>
                <Button type="submit" disabled={rename.isPending || !renameForm.formState.isDirty}>
                  {rename.isPending ? "Saving…" : "Save name"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle>Danger zone</CardTitle>
              <CardDescription>
                Retiring removes the device from your dashboard and stops it syncing. Contact support to recover it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="destructive"
                onClick={() => {
                  setRetireError(null);
                  setRetireOpen(true);
                }}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                Retire device
              </Button>
            </CardContent>
          </Card>

          <Dialog open={retireOpen} onOpenChange={(o) => !retire.isPending && setRetireOpen(o)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Retire {device.data.name ?? device.data.serial}?</DialogTitle>
                <DialogDescription>
                  The device will stop working and leave your dashboard. This can only be undone by support.
                </DialogDescription>
              </DialogHeader>
              {retireError && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{retireError}</p>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setRetireOpen(false)} disabled={retire.isPending}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => retire.mutate()} disabled={retire.isPending}>
                  {retire.isPending ? "Retiring…" : "Retire device"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
