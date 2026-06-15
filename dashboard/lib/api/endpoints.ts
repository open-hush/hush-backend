"use client";

import { apiFetch } from "./client";
import type {
  Audio,
  AudioCreateRequest,
  AudioCreateResponse,
  AudioList,
  AuthTokens,
  CardBinding,
  CardBindingList,
  CardBindingRequest,
  Device,
  DeviceClaimRequest,
  DeviceList,
  DeviceUpdateRequest,
  User,
  UserLoginRequest,
  UserRegisterRequest,
} from "./types";

export const authApi = {
  // Authenticated: an existing user creates another. Returns the new user's
  // profile (no tokens) and the caller stays signed in as themselves.
  register: (body: UserRegisterRequest) =>
    apiFetch<User>("/v1/users/register", { method: "POST", body }),
  login: (body: UserLoginRequest) =>
    apiFetch<AuthTokens>("/v1/users/login", { method: "POST", body, skipAuth: true }),
  me: () => apiFetch<User>("/v1/users/me"),
};

export const devicesApi = {
  list: (cursor?: string) =>
    apiFetch<DeviceList>(`/v1/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  get: (id: string) => apiFetch<Device>(`/v1/devices/${id}`),
  claim: (id: string, body: DeviceClaimRequest) =>
    apiFetch<Device>(`/v1/devices/${id}/claim`, { method: "POST", body }),
  update: (id: string, body: DeviceUpdateRequest) =>
    apiFetch<Device>(`/v1/devices/${id}`, { method: "PATCH", body }),
  // Retire (soft-delete): the device leaves the user's list and stops syncing.
  remove: (id: string) => apiFetch<void>(`/v1/devices/${id}`, { method: "DELETE" }),
  listCards: (id: string) => apiFetch<CardBindingList>(`/v1/devices/${id}/cards`),
  bindCard: (id: string, body: CardBindingRequest) =>
    apiFetch<CardBinding>(`/v1/devices/${id}/cards`, { method: "POST", body }),
  unbindCard: (id: string, uid: string) =>
    apiFetch<void>(`/v1/devices/${id}/cards/${uid}`, { method: "DELETE" }),
};

export const audioApi = {
  list: (cursor?: string) =>
    apiFetch<AudioList>(`/v1/audio${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  get: (id: string) => apiFetch<Audio>(`/v1/audio/${id}`),
  create: (body: AudioCreateRequest) =>
    apiFetch<AudioCreateResponse>("/v1/audio", { method: "POST", body }),
  finalize: (id: string) =>
    apiFetch<Audio>(`/v1/audio/${id}/finalize`, { method: "POST" }),
  remove: (id: string) =>
    apiFetch<void>(`/v1/audio/${id}`, { method: "DELETE" }),
};
