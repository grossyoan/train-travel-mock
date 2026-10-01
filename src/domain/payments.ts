import { type FieldError, isRecord, type Rules, validateFields } from "./validation";

export const CURRENCIES = ["bam", "bgn", "chf", "eur", "gbp", "nok", "sek", "try"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Stripe-style test numbers. Any other card number succeeds. */
export const DECLINED_CARDS: Readonly<Record<string, string>> = {
  "4000000000000002": "card declined",
  "4000000000009995": "insufficient funds",
};

const CURRENCY_BY_COUNTRY: Readonly<Record<string, Currency>> = {
  BA: "bam",
  BG: "bgn",
  CH: "chf",
  GB: "gbp",
  NO: "nok",
  SE: "sek",
  TR: "try",
};

export function currencyForCountry(countryCode: string | undefined): Currency {
  return (countryCode && CURRENCY_BY_COUNTRY[countryCode]) || "eur";
}

export type PaymentSource =
  | {
      object: "card";
      name: string;
      number: string;
      exp_month: number;
      exp_year: number;
      address_city?: string;
      address_country: string;
      address_post_code?: string;
    }
  | {
      object: "bank_account";
      name: string;
      number: string;
      sort_code?: string;
      account_type: "individual" | "company";
      bank_name: string;
      country: string;
    };

export interface Payment {
  id: string;
  amount: number;
  currency: Currency;
  source: PaymentSource;
  status: "succeeded" | "failed";
}

export interface PaymentInput {
  amount?: number;
  currency?: Currency;
  source: PaymentSource;
}

// Only fields readable in responses are kept: cvc and address_line1/2 are writeOnly
// in the spec, so they are validated but never stored or echoed.
const CARD_RULES: Rules = {
  name: { type: "string", required: true },
  number: { type: "string", required: true },
  // Required by the spec, but optional here on purpose: the Bump.sh API Explorer hides
  // writeOnly fields from request forms, so a card paid from the Explorer has no cvc.
  // A cvc that is sent is still validated.
  cvc: { type: "string", minLength: 3, maxLength: 4 },
  exp_month: { type: "integer", required: true },
  exp_year: { type: "integer", required: true },
  address_line1: { type: "string" },
  address_line2: { type: "string" },
  address_city: { type: "string" },
  address_country: { type: "string", required: true },
  address_post_code: { type: "string" },
};

const BANK_RULES: Rules = {
  name: { type: "string", required: true },
  number: { type: "string", required: true },
  sort_code: { type: "string" },
  account_type: { type: "string", required: true, enum: ["individual", "company"] },
  bank_name: { type: "string", required: true },
  country: { type: "string", required: true },
};

const PAYMENT_RULES: Rules = {
  amount: { type: "number", exclusiveMinimum: 0 },
  currency: { type: "string", enum: CURRENCIES },
};

/** Card numbers are commonly typed with spaces or dashes; the spec wants digits only. */
function normalizeNumber(value: string): string {
  return value.replace(/[\s-]/g, "");
}

/**
 * `object` is optional in practice: when it is missing, the shape of the source tells
 * a card (cvc, expiry) from a bank account (sort code, account type, bank name).
 */
function sourceKind(source: Record<string, unknown>): "card" | "bank_account" | undefined {
  if (source.object === "card" || source.object === "bank_account") return source.object;
  if (source.object !== undefined) return undefined;
  if ("cvc" in source || "exp_month" in source || "exp_year" in source) return "card";
  if ("account_type" in source || "bank_name" in source || "sort_code" in source) return "bank_account";
  return undefined;
}

function pick<T extends object>(values: Record<string, unknown>, keys: readonly string[]): T {
  return Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]])) as T;
}

export function validatePayment(body: Record<string, unknown>): { input?: PaymentInput; errors: FieldError[] } {
  const { values, errors } = validateFields(body, PAYMENT_RULES);
  const source = body.source;
  if (!isRecord(source)) {
    errors.push({ pointer: "/source", detail: source === undefined ? "is required" : "must be an object" });
    return { errors };
  }
  const kind = sourceKind(source);
  if (!kind) {
    errors.push({ pointer: "/source/object", detail: 'must be "card" or "bank_account"' });
    return { errors };
  }
  const normalized = typeof source.number === "string" ? { ...source, number: normalizeNumber(source.number) } : source;
  const checked = validateFields(normalized, kind === "card" ? CARD_RULES : BANK_RULES, "/source/");
  errors.push(...checked.errors);
  if (errors.length > 0) return { errors };

  const readable =
    kind === "card"
      ? ["name", "number", "exp_month", "exp_year", "address_city", "address_country", "address_post_code"]
      : ["name", "number", "sort_code", "account_type", "bank_name", "country"];
  return {
    errors,
    input: {
      amount: values.amount as number | undefined,
      currency: values.currency as Currency | undefined,
      source: { object: kind, ...pick<Omit<PaymentSource, "object">>(checked.values, readable) } as PaymentSource,
    },
  };
}

/** All but the last four characters are masked: "4242424242424242" → "************4242". */
export function maskNumber(number: string): string {
  const visible = number.slice(-4);
  return "*".repeat(Math.max(0, number.length - visible.length)) + visible;
}

export function settle(id: string, input: PaymentInput, defaults: { amount: number; currency: Currency }): Payment {
  const declined = input.source.object === "card" && input.source.number in DECLINED_CARDS;
  return {
    id,
    amount: input.amount ?? defaults.amount,
    currency: input.currency ?? defaults.currency,
    source: { ...input.source, number: maskNumber(input.source.number) },
    status: declined ? "failed" : "succeeded",
  };
}
