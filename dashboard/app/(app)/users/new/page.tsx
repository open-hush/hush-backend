"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { authApi } from "@/lib/api/endpoints";
import { HttpError } from "@/lib/api/client";
import type { User } from "@/lib/api/types";

const schema = z.object({
  email: z.string().email("invalid email"),
  password: z.string().min(12, "password must be at least 12 characters"),
  displayName: z.string().max(120).optional().or(z.literal("")),
});

type FormValues = z.infer<typeof schema>;

export default function NewUserPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState<User | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      // Created within the current admin's session. The new user is NOT logged
      // in and the caller's session is untouched.
      const user = await authApi.register({
        email: values.email,
        password: values.password,
        ...(values.displayName ? { displayName: values.displayName } : {}),
      });
      setCreated(user);
      reset();
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        setServerError("That email already exists.");
        return;
      }
      const msg =
        err instanceof HttpError && err.body?.message ? err.body.message : "Could not create user";
      setServerError(msg);
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>User created</CardTitle>
            <CardDescription>
              {created.email} can now sign in with the password you set.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              {created.displayName ? `${created.displayName} · ` : ""}
              {created.email}
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setCreated(null)}>Create another</Button>
              <Button variant="ghost" onClick={() => router.push("/devices")}>
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Create a user</CardTitle>
          <CardDescription>
            Add a new account. They sign in afterwards with the email and password you set here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="off" {...register("email")} />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="displayName">Display name (optional)</Label>
              <Input id="displayName" type="text" autoComplete="off" {...register("displayName")} />
              {errors.displayName && (
                <p className="text-xs text-destructive">{errors.displayName.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...register("password")}
              />
              <p className="text-xs text-muted-foreground">At least 12 characters.</p>
              {errors.password && (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              )}
            </div>
            {serverError && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {serverError}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Creating…" : "Create user"}
              </Button>
              <Button type="button" variant="ghost" asChild>
                <Link href="/devices">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
