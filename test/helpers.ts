import { exports } from "cloudflare:workers";

export const BASE = "https://mock.test";
export const BERLIN = "efdbb9d1-02c2-4bc3-afb7-6788d8782b1e";
export const PARIS = "b2e783e1-c824-4d63-b37a-d8d698862f1d";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A UTC date-time to the second, as in the spec's examples ("2024-02-01T10:00:00Z"). */
export const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** Always in the future, so trips stay bookable whenever the suite runs. */
export const FUTURE_DAY = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

export interface CallOptions {
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export function call(method: string, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  return exports.default.fetch(new Request(`${BASE}${path}`, { method, headers, body }));
}

export interface Station {
  id: string;
  name: string;
  address: string;
  country_code: string;
  timezone: string;
}

export interface Trip {
  id: string;
  origin: string;
  destination: string;
  origin_name: string;
  destination_name: string;
  departure_time: string;
  arrival_time: string;
  operator: string;
  price: number;
  bicycles_allowed: boolean;
  dogs_allowed: boolean;
  links: { self: string; origin: string; destination: string };
}

export interface Booking {
  id: string;
  trip_id: string;
  passenger_name: string;
  has_bicycle: boolean;
  has_dog: boolean;
  status: "pending_payment" | "confirmed" | "expired";
  price: number;
  currency: string;
  expires_at: string;
  links?: { self: string };
}

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: "pending" | "succeeded" | "failed";
  source: Record<string, unknown>;
  links: { booking: string };
}

export interface Collection<T> {
  data: T[];
  links: { self: string; next?: string; prev?: string };
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  errors?: { pointer: string; detail: string }[];
}

/** Parses a JSON body into the shape the test expects; the contract test checks the real shape. */
export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** A unique token per test keeps each test in its own data space. */
export function freshToken(): string {
  return `test-${crypto.randomUUID()}`;
}

export const CARD = {
  object: "card",
  name: "Francis Bourgeois",
  number: "4242424242424242",
  cvc: "123",
  exp_month: 12,
  exp_year: 2030,
  address_line1: "123 Fake Street",
  address_country: "gb",
};

export const BANK = {
  object: "bank_account",
  name: "J. Doe",
  number: "00012345",
  sort_code: "000123",
  account_type: "individual",
  bank_name: "Starling Bank",
  country: "gb",
};
