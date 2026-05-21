"use client";

import { getAccessToken, setAccessToken } from "@/lib/auth/store";

import type { ApiError, AuthTokens } from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: ApiError | null,
    message?: string,
  ) {
    super(message ?? body?.message ?? `HTTP ${status}`);
    this.name = "HttpError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  skipAuth?: boolean;
}

let inflightRefresh: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      const res = await fetch(`${API_URL}/v1/users/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        setAccessToken(null);
        return false;
      }
      const tokens = (await res.json()) as AuthTokens;
      setAccessToken(tokens.accessToken);
      return true;
    } catch {
      setAccessToken(null);
      return false;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const doFetch = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (token && !opts.skipAuth) headers.Authorization = `Bearer ${token}`;
    return fetch(`${API_URL}${path}`, {
      method: opts.method ?? "GET",
      credentials: "include",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  };

  let res = await doFetch(getAccessToken());
  if (res.status === 401 && !opts.skipAuth) {
    const ok = await tryRefresh();
    if (ok) {
      res = await doFetch(getAccessToken());
    }
  }

  if (!res.ok) {
    let body: ApiError | null = null;
    try {
      body = (await res.json()) as ApiError;
    } catch {
      /* ignore */
    }
    throw new HttpError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
