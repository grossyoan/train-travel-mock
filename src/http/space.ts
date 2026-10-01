import type { Context } from "hono";
import type { AppEnv } from "./app-env";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The data space of the caller. No token is issued or verified: whatever is in the
 * Authorization header names a private space (hashed, never stored in clear), and
 * requests without one share the public space.
 */
export async function spaceFor(c: Context<AppEnv>) {
  const authorization = c.req.header("Authorization")?.trim();
  const name = authorization ? `token:${await sha256(authorization)}` : "public";
  return c.env.SPACES.getByName(name);
}
