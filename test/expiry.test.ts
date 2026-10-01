import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Space } from "../src/store/space";
import {
  type Booking,
  CARD,
  type Collection,
  call,
  FUTURE_DAY,
  freshToken,
  json,
  type Problem,
  type Trip,
} from "./helpers";

async function spaceOf(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`Bearer ${token}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return env.SPACES.getByName(`token:${hex}`);
}

describe("booking hold", () => {
  it("expires an unpaid booking after its hold and refuses to take payment", async () => {
    const token = freshToken();
    const trips = await json<Collection<Trip>>(
      await call("GET", `/trips?origin=Paris&destination=Berlin&date=${FUTURE_DAY}`, { token }),
    );
    const booking = await json<Booking>(
      await call("POST", "/bookings", { token, body: { trip_id: trips.data[0]?.id, passenger_name: "Slow" } }),
    );

    await runInDurableObject(await spaceOf(token), (_instance: Space, state) => {
      state.storage.sql.exec(
        "UPDATE bookings_v2 SET data = json_set(data, '$.expires_at', ?) WHERE id = ?",
        "2020-01-01T00:00:00Z",
        booking.id,
      );
    });

    const read = await json<Booking>(await call("GET", `/bookings/${booking.id}`, { token }));
    expect(read.status).toBe("expired");
    const paid = await call("POST", `/bookings/${booking.id}/payment`, { token, body: { source: CARD } });
    expect(paid.status).toBe(409);
    expect((await json<Problem>(paid)).detail).toContain("expired");
  });
});
