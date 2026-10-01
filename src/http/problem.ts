import type { FieldError } from "../domain/validation";

/** RFC 9457 problem details, matching the `Problem` schema of the spec. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  /** RFC 9457 extension member listing each invalid field. */
  errors?: FieldError[];
}

const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

/** The `detail` of each error example in `components/responses` of the spec. */
const SPEC_DETAILS: Readonly<Record<number, string>> = {
  400: "The request is invalid or missing required parameters.",
  401: "You do not have the necessary permissions.",
  403: "Access is forbidden with the provided credentials.",
  404: "The requested resource was not found.",
  409: "There is a conflict with an existing resource.",
  429: "You have exceeded the rate limit.",
  500: "An unexpected error occurred.",
};

export function problem(status: number, detail: string, errors?: FieldError[]): Problem {
  const title = TITLES[status] ?? "Error";
  return {
    type: `https://example.com/errors/${title.toLowerCase().replaceAll(" ", "-")}`,
    title,
    status,
    detail,
    ...(errors && errors.length > 0 ? { errors } : {}),
  };
}

/** The exact error example the spec documents for `status`, used for forced errors. */
export function specProblem(status: number): Problem {
  return problem(status, SPEC_DETAILS[status] ?? "Forced error.");
}
