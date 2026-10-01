import { describe, expect, it } from "vitest";
import { type BookingRecord, bookingStatus, HOLD_MINUTES, holdUntil } from "../../src/domain/bookings";
import { maskNumber, settle, validatePayment } from "../../src/domain/payments";
import { seededRandom } from "../../src/domain/random";
import type { StationRecord } from "../../src/domain/station-data";
import { STATIONS } from "../../src/domain/station-data";
import { findStation, parseCoordinates, resolveStation, searchStations } from "../../src/domain/stations";
import { addDays, atLocalTime, formatUtc, localDay, parseDateInZone } from "../../src/domain/time";
import { timetable } from "../../src/domain/trips";
import { tripUpdates } from "../../src/domain/updates";
import { isUuid } from "../../src/domain/uuid";
import { validateFields } from "../../src/domain/validation";
import { negotiate } from "../../src/http/negotiate";

describe("seededRandom", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = seededRandom("x");
    const b = seededRandom("x");
    const c = seededRandom("y");
    const first = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(first);
    expect(c.next()).not.toBe(first[0]);
  });

  it("keeps int() within bounds", () => {
    const random = seededRandom("bounds");
    const values = Array.from({ length: 1000 }, () => random.int(3, 5));
    expect(new Set(values)).toEqual(new Set([3, 4, 5]));
  });
});

describe("stations", () => {
  it("has unique uuid ids", () => {
    const ids = STATIONS.map((station) => station.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(isUuid)).toBe(true);
  });

  it("parses coordinates and rejects garbage", () => {
    expect(parseCoordinates("52.52, 13.405")).toEqual({ latitude: 52.52, longitude: 13.405 });
    expect(parseCoordinates("north")).toBeUndefined();
    expect(parseCoordinates("91,0")).toBeUndefined();
  });

  it("matches accents and case", () => {
    expect(searchStations({ search: "KOLN" }).map((station) => station.name)).toEqual(["Köln Hauptbahnhof"]);
  });
});

const PARIS_NORD = findStation("b2e783e1-c824-4d63-b37a-d8d698862f1d") as StationRecord;
const BERLIN_HBF = findStation("efdbb9d1-02c2-4bc3-afb7-6788d8782b1e") as StationRecord;

describe("trips", () => {
  it("builds a stable, chronological timetable on station time, shown in UTC", async () => {
    const first = await timetable(BERLIN_HBF, PARIS_NORD, "2026-11-02");
    expect(await timetable(BERLIN_HBF, PARIS_NORD, "2026-11-02")).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(8);
    const departures = first.map((trip) => Date.parse(trip.departure_time));
    expect(departures).toEqual(departures.toSorted((x, y) => x - y));
    expect(first.every((trip) => isUuid(trip.id) && trip.price > 0)).toBe(true);
    // Berlin is UTC+1 in November: the first train leaves after 05:00 local, 04:00 UTC.
    expect(first[0]?.departure_time).toMatch(/^2026-11-02T0[4-5]:\d{2}:00Z$/);
    expect(first.every((trip) => trip.arrival_time.endsWith("Z"))).toBe(true);
  });

  it("tells a trip story that starts with the platform and ends on arrival", async () => {
    const [trip] = await timetable(BERLIN_HBF, PARIS_NORD, "2026-11-02");
    if (!trip) throw new Error("empty timetable");
    const updates = tripUpdates(trip);
    expect(updates[0]?.type).toBe("platform");
    expect(updates.at(-1)?.type).toBe("arrived");
    expect(updates.every((update) => update.trip_id === trip.id)).toBe(true);
    expect(updates.every((update) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(update.occurred_at))).toBe(true);
  });
});

describe("time zones", () => {
  it("reads naive dates in the given zone, across daylight saving time", () => {
    expect(parseDateInZone("2026-01-15T09:00", "Europe/Paris")?.toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(parseDateInZone("2026-07-15T09:00", "Europe/Paris")?.toISOString()).toBe("2026-07-15T07:00:00.000Z");
    expect(parseDateInZone("2026-07-15", "Europe/London")?.toISOString()).toBe("2026-07-14T23:00:00.000Z");
    expect(parseDateInZone("2026-07-15T09:00:00Z", "Europe/Paris")?.toISOString()).toBe("2026-07-15T09:00:00.000Z");
    expect(parseDateInZone("2026-07-15T09:00:00+02:00", "Europe/London")?.toISOString()).toBe(
      "2026-07-15T07:00:00.000Z",
    );
    expect(parseDateInZone("soon", "Europe/Paris")).toBeUndefined();
  });

  it("formats an instant in UTC to the second", () => {
    expect(formatUtc(new Date("2026-07-15T07:00:00.250Z"))).toBe("2026-07-15T07:00:00Z");
    expect(formatUtc(parseDateInZone("2026-07-15T09:00", "Europe/Paris") as Date)).toBe("2026-07-15T07:00:00Z");
  });

  it("gives the local day and builds local times", () => {
    expect(localDay(new Date("2026-07-14T23:30:00Z"), "Europe/Paris")).toBe("2026-07-15");
    expect(atLocalTime("2026-03-29", 5 * 60, "Europe/Paris").toISOString()).toBe("2026-03-29T03:00:00.000Z");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("station resolution", () => {
  it("resolves ids, names, abbreviations and picks the main station of a city", () => {
    expect(resolveStation(PARIS_NORD.id)?.name).toBe("Paris Gare du Nord");
    expect(resolveStation("paris")?.name).toBe("Paris Gare du Nord");
    expect(resolveStation("Berlin Hbf")?.id).toBe(BERLIN_HBF.id);
    expect(resolveStation("  münchen  ")?.name).toBe("München Hauptbahnhof");
    expect(resolveStation("London")?.name).toBe("London St Pancras International");
    expect(resolveStation("Atlantis")).toBeUndefined();
  });
});

describe("bookings", () => {
  const record = (overrides: Partial<BookingRecord> = {}): BookingRecord => ({
    booking: { id: "b", trip_id: "t", passenger_name: "P", has_bicycle: false, has_dog: false },
    price: 10,
    currency: "eur",
    expires_at: "2026-11-01T11:00:00Z",
    departure_time: "2026-11-02T09:00:00Z",
    ...overrides,
  });

  it("is pending, then expired after the hold, and confirmed once paid", () => {
    expect(bookingStatus(record(), new Date("2026-11-01T10:59:00Z"))).toBe("pending_payment");
    expect(bookingStatus(record(), new Date("2026-11-01T11:00:01Z"))).toBe("expired");
    expect(bookingStatus(record({ paid_at: "2026-11-01T10:30:00Z" }), new Date("2026-11-05T00:00:00Z"))).toBe(
      "confirmed",
    );
  });

  it("holds a booking for an hour", () => {
    expect(holdUntil(new Date("2026-11-01T10:00:00Z"))).toBe("2026-11-01T11:00:00Z");
    expect(HOLD_MINUTES).toBe(60);
  });
});

describe("payments", () => {
  it("accepts a card without cvc but still checks one that is given", () => {
    const card = { name: "A", number: "4242424242424242", exp_month: 1, exp_year: 2030, address_country: "fr" };
    expect(validatePayment({ source: card }).errors).toEqual([]);
    expect(validatePayment({ source: { ...card, cvc: "1" } }).errors).toEqual([
      { pointer: "/source/cvc", detail: "must be at least 3 characters" },
    ]);
  });

  it("masks all but the last four characters", () => {
    expect(maskNumber("4242424242424242")).toBe("************4242");
    expect(maskNumber("00012345")).toBe("****2345");
    expect(maskNumber("123")).toBe("123");
    expect(maskNumber("12345678901234567890")).toBe("****************7890");
  });

  it("strips writeOnly fields and normalizes the card number", () => {
    const { input, errors } = validatePayment({
      source: {
        name: "A",
        number: "4242 4242-4242 4242",
        cvc: "123",
        exp_month: "12",
        exp_year: 2030,
        address_line1: "secret",
        address_country: "gb",
      },
    });
    expect(errors).toEqual([]);
    expect(input?.source).toEqual({
      object: "card",
      name: "A",
      number: "4242424242424242",
      exp_month: 12,
      exp_year: 2030,
      address_country: "gb",
    });
  });

  it("infers a bank account from its shape", () => {
    const { input } = validatePayment({
      source: { name: "B", number: "1", account_type: "company", bank_name: "Bank", country: "fr" },
    });
    expect(input?.source.object).toBe("bank_account");
  });

  it("fails declined test cards", () => {
    const { input } = validatePayment({
      source: {
        object: "card",
        name: "C",
        number: "4000000000009995",
        cvc: "999",
        exp_month: 1,
        exp_year: 2030,
        address_country: "fr",
      },
    });
    if (!input) throw new Error("invalid input");
    expect(settle("id", input, { amount: 5, currency: "eur" }).status).toBe("failed");
  });
});

describe("validation", () => {
  it("coerces strings from XML/query but never numbers into strings", () => {
    const rules = {
      flag: { type: "boolean" as const },
      count: { type: "integer" as const },
      name: { type: "string" as const },
    };
    expect(validateFields({ flag: "yes", count: "3" }, rules).values).toEqual({ flag: true, count: 3 });
    expect(validateFields({ name: 3 }, rules).errors).toEqual([{ pointer: "/name", detail: "must be a string" }]);
    expect(validateFields({ count: "3.5" }, rules).errors[0]?.detail).toBe("must be an integer");
  });

  it("rejects blank required strings", () => {
    const result = validateFields({ name: "  " }, { name: { type: "string", required: true } });
    expect(result.errors).toEqual([{ pointer: "/name", detail: "must not be empty" }]);
  });
});

describe("negotiate", () => {
  const offered = ["application/json", "application/xml"] as const;
  it("prefers the highest quality, then the first offered", () => {
    expect(negotiate(undefined, offered)).toBe("application/json");
    expect(negotiate("*/*", offered)).toBe("application/json");
    expect(negotiate("application/xml", offered)).toBe("application/xml");
    expect(negotiate("application/json;q=0.5, application/xml", offered)).toBe("application/xml");
    expect(negotiate("text/html", offered)).toBe("application/json");
  });
});
