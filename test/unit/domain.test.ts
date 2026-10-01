import { describe, expect, it } from "vitest";
import { maskNumber, settle, validatePayment } from "../../src/domain/payments";
import { seededRandom } from "../../src/domain/random";
import { STATIONS } from "../../src/domain/station-data";
import { parseCoordinates, searchStations } from "../../src/domain/stations";
import { parseTripDate, timetable } from "../../src/domain/trips";
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

describe("trips", () => {
  it("builds a stable, chronological timetable", async () => {
    const day = new Date("2026-11-02T00:00:00Z");
    const first = await timetable("a", "b", day);
    expect(await timetable("a", "b", day)).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(8);
    const departures = first.map((trip) => Date.parse(trip.departure_time));
    expect(departures).toEqual(departures.toSorted((x, y) => x - y));
    expect(first.every((trip) => isUuid(trip.id) && trip.price > 0)).toBe(true);
  });

  it("treats a bare day as midnight UTC and rejects nonsense", () => {
    expect(parseTripDate("2026-11-02")?.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(parseTripDate("2026-11-02T09:30:00+01:00")?.toISOString()).toBe("2026-11-02T08:30:00.000Z");
    expect(parseTripDate("soon")).toBeUndefined();
  });

  it("tells a trip story that starts with the platform and ends on arrival", async () => {
    const [trip] = await timetable("a", "b", new Date("2026-11-02T00:00:00Z"));
    if (!trip) throw new Error("empty timetable");
    const updates = tripUpdates(trip);
    expect(updates[0]?.type).toBe("platform");
    expect(updates.at(-1)?.type).toBe("arrived");
    expect(updates.every((update) => update.trip_id === trip.id)).toBe(true);
  });
});

describe("payments", () => {
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
