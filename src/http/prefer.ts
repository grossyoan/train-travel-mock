import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./app-env";
import { OPERATIONS, type OperationId } from "./operations";
import { problem, specProblem } from "./problem";
import { sendProblem } from "./respond";

const PREFER_CODE = /(?:^|[,;])\s*code=([^,;\s]*)/i;

/** The status a client asks for, via `Prefer: code=404` (as Prism does) or `?__code=404`. */
function requestedCode(header: string | undefined, query: string | undefined): string | undefined {
  return query ?? header?.match(PREFER_CODE)?.[1];
}

/**
 * Errors on demand. Any status the spec documents for the operation can be forced, and
 * the spec's example error is returned. `__code` exists because browser tools behind a
 * CORS proxy cannot always send a `Prefer` header.
 */
export function operation(id: OperationId) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const requested = requestedCode(c.req.header("Prefer"), c.req.query("__code"));
    if (requested === undefined) return next();
    const statuses: readonly number[] = OPERATIONS[id].statuses;
    const status = Number(requested);
    if (!statuses.includes(status)) {
      return sendProblem(
        c,
        problem(
          400,
          `Cannot force status "${requested}" on ${id}: the spec documents ${statuses.join(", ")}. Use Prefer: code=<status> or ?__code=<status>.`,
        ),
      );
    }
    if (status < 400) return next();
    return sendProblem(c, specProblem(status), {
      "Preference-Applied": `code=${status}`,
      ...(status === 429 ? { "Retry-After": "30" } : {}),
    });
  });
}
