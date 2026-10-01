import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_BOOKINGS, type Space } from "../../src/store/space";

const booking = (index: number) => ({
  booking: { id: `b${index}`, trip_id: "t", passenger_name: `P${index}`, has_bicycle: false, has_dog: false },
  price: 10,
  currency: "eur" as const,
  expires_at: "2026-11-01T11:00:00Z",
  departure_time: "2026-11-02T09:00:00Z",
});

describe("Space", () => {
  it("schedules expiry and wipes everything when it fires, staying usable", async () => {
    const stub = env.SPACES.getByName(`expiry-${crypto.randomUUID()}`);
    await stub.createBooking(booking(1));
    const alarm = await runInDurableObject(stub, (_instance: Space, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getBooking("b1")).toBeUndefined();
    await stub.createBooking(booking(2));
    expect((await stub.getBooking("b2"))?.booking.passenger_name).toBe("P2");
  });

  it(`keeps at most ${MAX_BOOKINGS} bookings, evicting the oldest`, async () => {
    const stub = env.SPACES.getByName(`cap-${crypto.randomUUID()}`);
    for (let index = 1; index <= MAX_BOOKINGS; index++) {
      expect((await stub.createBooking(booking(index))).evicted).toBe(false);
    }
    expect((await stub.createBooking(booking(MAX_BOOKINGS + 1))).evicted).toBe(true);
    expect(await stub.getBooking("b1")).toBeUndefined();
    const { bookings, total } = await stub.listBookings(0, 1);
    expect(total).toBe(MAX_BOOKINGS);
    expect(bookings[0]?.booking.id).toBe(`b${MAX_BOOKINGS + 1}`);
  });

  it("reports whether a delete removed something", async () => {
    const stub = env.SPACES.getByName(`delete-${crypto.randomUUID()}`);
    await stub.createBooking(booking(1));
    expect(await stub.deleteBooking("b1")).toBe(true);
    expect(await stub.deleteBooking("b1")).toBe(false);
  });
});
