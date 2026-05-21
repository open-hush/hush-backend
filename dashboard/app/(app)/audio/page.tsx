"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { audioApi } from "@/lib/api/endpoints";
import type { Audio } from "@/lib/api/types";
import { HttpError } from "@/lib/api/client";

const ACCEPTED_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/x-m4a",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
] as const;

const schema = z.object({
  title: z.string().min(1, "title is required").max(200),
  description: z.string().max(2000).optional().or(z.literal("")),
});

type FormValues = z.infer<typeof schema>;

function stateVariant(state: Audio["state"]): "secondary" | "success" | "warning" | "destructive" {
  if (state === "ready") return "success";
  if (state === "processing") return "warning";
  if (state === "failed") return "destructive";
  return "secondary";
}

export default function AudioPage() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["audio"],
    queryFn: () => audioApi.list(),
    // Auto-refresh while anything is in flight so the user sees state changes.
    refetchInterval: (q) =>
      q.state.data?.items.some((a) => a.state === "uploading" || a.state === "processing")
        ? 3000
        : false,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const upload = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!file) throw new Error("Pick a file");
      if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
        throw new Error(`unsupported content type: ${file.type || "unknown"}`);
      }

      setProgress("Requesting upload URL…");
      const created = await audioApi.create({
        title: values.title,
        sourceContentType: file.type,
        ...(values.description ? { description: values.description } : {}),
      });

      setProgress(`Uploading ${file.name}…`);
      const put = await fetch(created.upload.url, {
        method: "PUT",
        headers: { "Content-Type": file.type, ...(created.upload.headers ?? {}) },
        body: file,
      });
      if (!put.ok) throw new Error(`upload failed: ${put.status}`);

      setProgress("Finalizing…");
      await audioApi.finalize(created.audio.id);
      setProgress(null);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["audio"] });
      reset();
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setError(null);
    },
    onError: (err) => {
      const msg = err instanceof HttpError && err.body?.message ? err.body.message : err instanceof Error ? err.message : "Upload failed";
      setError(msg);
      setProgress(null);
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audio library</h1>
        <p className="text-sm text-muted-foreground">Upload audio files; we transcode them to MP3 for the device.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload new audio</CardTitle>
          <CardDescription>MP3, WAV, FLAC, AAC, M4A, OGG.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit((v) => upload.mutate(v))} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">Title</Label>
              <Input id="title" {...register("title")} />
              {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="description">Description (optional)</Label>
              <Input id="description" {...register("description")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="file">File</Label>
              <Input
                id="file"
                type="file"
                ref={fileInputRef}
                accept="audio/*"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file && <p className="text-xs text-muted-foreground">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
            </div>
            {progress && <p className="text-sm">{progress}</p>}
            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={!file || isSubmitting || upload.isPending}>
              <Upload className="mr-1 h-4 w-4" />
              {upload.isPending ? "Uploading…" : "Upload"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {list.isLoading && <p className="text-sm text-muted-foreground">Loading library…</p>}
        {list.data && list.data.items.length === 0 && (
          <p className="text-sm text-muted-foreground">No audios yet — upload one above.</p>
        )}
        {list.data?.items.map((a) => (
          <Card key={a.id}>
            <CardContent className="flex items-center justify-between p-4">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{a.title}</p>
                  <Badge variant={stateVariant(a.state)}>{a.state}</Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground">{a.id}</p>
                {a.description && <p className="text-xs text-muted-foreground">{a.description}</p>}
                {a.durationMs && (
                  <p className="text-xs text-muted-foreground">
                    {Math.round(a.durationMs / 1000)}s
                    {a.sizeBytes ? ` · ${(a.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ""}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
