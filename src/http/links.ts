import type { Context } from "hono";
import type { AppEnv } from "./app-env";

/** Links always point back at this server, whatever host it is deployed on. */
export function baseUrl(c: Context<AppEnv>): string {
  return new URL(c.req.url).origin;
}
