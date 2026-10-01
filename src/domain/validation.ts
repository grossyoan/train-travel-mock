/**
 * Minimal request validation: required fields and types, as declared in the spec.
 * Values are coerced leniently in one direction only (a string "true" becomes a boolean,
 * "12" becomes a number) because XML bodies and query strings carry everything as text.
 */

export interface FieldError {
  /** JSON pointer into the body (`/source/number`) or, for query parameters, the parameter name. */
  pointer: string;
  detail: string;
}

export type FieldType = "string" | "number" | "integer" | "boolean";

export interface FieldRule {
  type: FieldType;
  required?: boolean;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  /** Numbers must be strictly greater than this. */
  exclusiveMinimum?: number;
}

export type Rules = Record<string, FieldRule>;

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off", ""]);

export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE.has(normalized)) return true;
    if (FALSE.has(normalized)) return false;
  }
  return undefined;
}

function coerce(value: unknown, type: FieldType): unknown {
  if (typeof value !== "string" || type === "string") return value;
  if (type === "boolean") return parseBoolean(value) ?? value;
  const number = Number(value.trim());
  return value.trim() !== "" && Number.isFinite(number) ? number : value;
}

function describe(rule: FieldRule): string {
  if (rule.enum) return `one of ${rule.enum.map((item) => `"${item}"`).join(", ")}`;
  return rule.type === "integer" ? "an integer" : `a ${rule.type}`;
}

function check(value: unknown, rule: FieldRule): string | undefined {
  const typeMatches =
    rule.type === "integer"
      ? Number.isInteger(value)
      : rule.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === rule.type;
  if (!typeMatches) return `must be ${describe(rule)}`;
  if (typeof value === "string") {
    if (rule.enum && !rule.enum.includes(value)) return `must be ${describe(rule)}`;
    if (rule.required && value.trim() === "") return "must not be empty";
    if (rule.minLength !== undefined && value.length < rule.minLength)
      return `must be at least ${rule.minLength} characters`;
    if (rule.maxLength !== undefined && value.length > rule.maxLength)
      return `must be at most ${rule.maxLength} characters`;
  }
  if (typeof value === "number" && rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum) {
    return `must be greater than ${rule.exclusiveMinimum}`;
  }
  return undefined;
}

export interface Validated {
  values: Record<string, unknown>;
  errors: FieldError[];
}

/**
 * Validates `input` against `rules`. Unknown fields are ignored (not echoed back),
 * missing optional fields are left undefined.
 */
export function validateFields(input: Record<string, unknown>, rules: Rules, pointerPrefix = "/"): Validated {
  const values: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  for (const [name, rule] of Object.entries(rules)) {
    const pointer = `${pointerPrefix}${name}`;
    const raw = input[name];
    if (raw === undefined || raw === null) {
      if (rule.required) errors.push({ pointer, detail: "is required" });
      continue;
    }
    const value = coerce(raw, rule.type);
    const problem = check(value, rule);
    if (problem) errors.push({ pointer, detail: problem });
    else values[name] = value;
  }
  return { values, errors };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One readable sentence naming every invalid field, for the Problem `detail`. */
export function summarize(errors: readonly FieldError[]): string {
  return `The request is invalid: ${errors.map((error) => `\`${error.pointer.replace(/^\//, "").replaceAll("/", ".")}\` ${error.detail}`).join("; ")}.`;
}
