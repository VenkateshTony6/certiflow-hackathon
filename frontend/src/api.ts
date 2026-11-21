import type { Batch, DemoUser, VerifyResult } from "./types";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: { error?: string; errors?: { row: number; message: string }[] },
  ) {
    super(message);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok) throw new ApiError(payload.error ?? "Request failed", response.status, payload);
  return payload as T;
}

export async function getUsers(): Promise<DemoUser[]> {
  return parse(await fetch(`${API_URL}/api/users`));
}

export async function api<T>(path: string, userId: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-user-id", userId);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  return parse(await fetch(`${API_URL}${path}`, { ...init, headers }));
}

export const getBatches = (userId: string) => api<Batch[]>("/api/batches", userId);
export const getBatch = (userId: string, id: string) => api<Batch>(`/api/batches/${id}`, userId);

export async function verifyCertificate(certNumber: string): Promise<VerifyResult> {
  return parse(await fetch(`${API_URL}/api/verify/${encodeURIComponent(certNumber)}`));
}

