import { describe, expect, it } from "vitest";
import {
  BANK,
  BASE,
  BERLIN,
  type Booking,
  CARD,
  type Collection,
  call,
  freshToken,
  json,
  PARIS,
  type Payment,
  type Problem,
  type Station,
  type Trip,
  UUID,
} from "./helpers";

async function searchTrips(token: string, query = `origin=${BERLIN}&destination=${PARIS}&date=2026-11-02T08:00:00Z`) {
  const response = await call("GET", `/trips?${query}`, { token });
  expect(response.status).toBe(200);
  return json<Collection<Trip>>(response);
}

async function book(token: string, body: Record<string, unknown>) {
  return call("POST", "/bookings", { token, body });
}

describe("booking flow", () => {
  it("chains stations → trips → booking → payment → read → delete with consistent ids", async () => {
    const token = freshToken();

    const stations = await json<Collection<Station>>(await call("GET", "/stations?search=berlin", { token }));
    const berlin = stations.data.find((station) => station.id === BERLIN);
    expect(berlin?.name).toBe("Berlin Hauptbahnhof");

    const trips = await searchTrips(token);
    expect(trips.data.length).toBeGreaterThanOrEqual(3);
    for (const trip of trips.data) {
      expect(trip.id).toMatch(UUID);
      expect(trip.origin).toBe(BERLIN);
      expect(trip.destination).toBe(PARIS);
      expect(Date.parse(trip.departure_time)).toBeGreaterThanOrEqual(Date.parse("2026-11-02T08:00:00Z"));
      expect(Date.parse(trip.arrival_time)).toBeGreaterThan(Date.parse(trip.departure_time));
      expect(trip.links.self).toBe(`${BASE}/trips/${trip.id}`);
      expect(trip.links.origin).toBe(`${BASE}/stations/${BERLIN}`);
    }
    const trip = trips.data[0] as Trip;

    const created = await book(token, { trip_id: trip.id, passenger_name: "Ada Lovelace" });
    expect(created.status).toBe(201);
    const booking = await json<Booking>(created);
    expect(booking.id).toMatch(UUID);
    expect(booking).toMatchObject({
      trip_id: trip.id,
      passenger_name: "Ada Lovelace",
      has_bicycle: false,
      has_dog: false,
    });
    expect(booking.links.self).toBe(`${BASE}/bookings/${booking.id}`);
    expect(created.headers.get("Location")).toBe(booking.links.self);

    const paid = await call("POST", `/bookings/${booking.id}/payment`, {
      token,
      body: { amount: trip.price, currency: "eur", source: CARD },
    });
    expect(paid.status).toBe(200);
    const payment = await json<Payment>(paid);
    expect(payment.id).toMatch(UUID);
    expect(payment.status).toBe("succeeded");
    expect(payment.amount).toBe(trip.price);
    expect(payment.source.number).toBe("************4242");
    expect(payment.source).not.toHaveProperty("cvc");
    expect(payment.source).not.toHaveProperty("address_line1");
    expect(payment.links.booking).toBe(booking.links.self);

    const read = await call("GET", `/bookings/${booking.id}`, { token });
    expect(read.status).toBe(200);
    expect(await json<Booking>(read)).toEqual(booking);

    const list = await json<Collection<Booking>>(await call("GET", "/bookings", { token }));
    expect(list.data.map((item) => item.id)).toContain(booking.id);

    const deleted = await call("DELETE", `/bookings/${booking.id}`, { token });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect((await call("GET", `/bookings/${booking.id}`, { token })).status).toBe(404);
  });

  it("returns the same trips for the same search (deterministic timetable)", async () => {
    const first = await searchTrips(freshToken());
    const second = await searchTrips(freshToken());
    expect(second.data).toEqual(first.data);
  });

  it("accepts a plain date and lenient booleans", async () => {
    const token = freshToken();
    const trips = await searchTrips(token, `origin=${BERLIN}&destination=${PARIS}&date=2026-11-02&bicycles=yes&dogs=1`);
    expect(trips.data.length).toBeGreaterThan(0);
    for (const trip of trips.data) {
      expect(trip.departure_time.startsWith("2026-11-0")).toBe(true);
      expect(trip.bicycles_allowed).toBe(true);
      expect(trip.dogs_allowed).toBe(true);
    }
  });

  it("still generates trips between unknown stations", async () => {
    const trips = await searchTrips(freshToken(), "origin=my-home&destination=the-beach&date=2026-11-02T08:00:00Z");
    expect(trips.data.length).toBeGreaterThanOrEqual(3);
    expect(trips.data[0]?.origin).toBe("my-home");
  });

  it("marks the Stripe-style decline card as failed and accepts bank accounts", async () => {
    const token = freshToken();
    const trip = (await searchTrips(token)).data[0] as Trip;

    const declined = await json<Booking>(await book(token, { trip_id: trip.id, passenger_name: "Declined" }));
    const failed = await call("POST", `/bookings/${declined.id}/payment`, {
      token,
      body: { amount: 10, currency: "eur", source: { ...CARD, number: "4000 0000 0000 0002" } },
    });
    expect(failed.status).toBe(200);
    const failedPayment = await json<Payment>(failed);
    expect(failedPayment.status).toBe("failed");
    expect(failedPayment.source.number).toBe("************0002");

    const viaBank = await json<Booking>(await book(token, { trip_id: trip.id, passenger_name: "Bank" }));
    const bank = await json<Payment>(
      await call("POST", `/bookings/${viaBank.id}/payment`, {
        token,
        body: { amount: 10, currency: "gbp", source: BANK },
      }),
    );
    expect(bank.status).toBe("succeeded");
    expect(bank.source.number).toBe("****2345");
  });

  it("replays a successful payment instead of charging twice", async () => {
    const token = freshToken();
    const trip = (await searchTrips(token)).data[0] as Trip;
    const booking = await json<Booking>(await book(token, { trip_id: trip.id, passenger_name: "Twice" }));
    const pay = () =>
      call("POST", `/bookings/${booking.id}/payment`, { token, body: { amount: 10, currency: "eur", source: CARD } });
    const first = await json<Payment>(await pay());
    const second = await json<Payment>(await pay());
    expect(second).toEqual(first);
  });

  it("defaults the payment amount to the trip price", async () => {
    const token = freshToken();
    const trip = (await searchTrips(token)).data[0] as Trip;
    const booking = await json<Booking>(await book(token, { trip_id: trip.id, passenger_name: "Default" }));
    const payment = await json<Payment>(
      await call("POST", `/bookings/${booking.id}/payment`, { token, body: { source: CARD } }),
    );
    expect(payment.amount).toBe(trip.price);
    expect(payment.currency).toBe("eur");
  });
});

describe("explicit errors", () => {
  it("names every missing required booking field", async () => {
    const response = await book(freshToken(), {});
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    const problem = await json<Problem>(response);
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("trip_id");
    expect(problem.detail).toContain("passenger_name");
    expect(problem.errors?.map((error) => error.pointer)).toEqual(["/trip_id", "/passenger_name"]);
  });

  it("rejects a wrongly typed field", async () => {
    const response = await book(freshToken(), { trip_id: "x", passenger_name: 42 });
    expect(response.status).toBe(400);
    expect((await json<Problem>(response)).errors?.[0]?.pointer).toBe("/passenger_name");
  });

  it("rejects invalid JSON with a helpful message", async () => {
    const response = await call("POST", "/bookings", { token: freshToken(), body: "{not json" });
    expect(response.status).toBe(400);
    expect((await json<Problem>(response)).detail).toMatch(/JSON/);
  });

  it("requires origin, destination and date on /trips", async () => {
    const response = await call("GET", "/trips", { token: freshToken() });
    expect(response.status).toBe(400);
    const problem = await json<Problem>(response);
    expect(problem.errors?.map((error) => error.pointer)).toEqual(["origin", "destination", "date"]);
  });

  it("rejects an unparseable date", async () => {
    const response = await call("GET", `/trips?origin=${BERLIN}&destination=${PARIS}&date=tomorrowish`);
    expect(response.status).toBe(400);
    expect((await json<Problem>(response)).detail).toContain("date");
  });

  it("returns 404 for a trip the user never searched", async () => {
    const response = await book(freshToken(), { trip_id: crypto.randomUUID(), passenger_name: "Ghost" });
    expect(response.status).toBe(404);
    expect((await json<Problem>(response)).detail).toContain("/trips");
  });

  it("returns 409 when booking a bicycle on a trip that does not allow them", async () => {
    const token = freshToken();
    const trips = await searchTrips(token, `origin=${BERLIN}&destination=${PARIS}&date=2026-11-02T00:00:00Z&limit=100`);
    const noBikes = trips.data.find((trip) => !trip.bicycles_allowed);
    expect(noBikes, "timetable should contain a trip without bicycles").toBeDefined();
    const response = await book(token, { trip_id: noBikes?.id, passenger_name: "Cyclist", has_bicycle: true });
    expect(response.status).toBe(409);
    expect((await json<Problem>(response)).detail).toContain("bicycle");
  });

  it("validates required payment source fields", async () => {
    const token = freshToken();
    const trip = (await searchTrips(token)).data[0] as Trip;
    const booking = await json<Booking>(await book(token, { trip_id: trip.id, passenger_name: "Card" }));
    const response = await call("POST", `/bookings/${booking.id}/payment`, {
      token,
      body: { amount: 10, currency: "eur", source: { object: "card", name: "No Number" } },
    });
    expect(response.status).toBe(400);
    const pointers = (await json<Problem>(response)).errors?.map((error) => error.pointer);
    expect(pointers).toEqual([
      "/source/number",
      "/source/cvc",
      "/source/exp_month",
      "/source/exp_year",
      "/source/address_country",
    ]);
  });

  it("rejects an unsupported currency", async () => {
    const token = freshToken();
    const trip = (await searchTrips(token)).data[0] as Trip;
    const booking = await json<Booking>(await book(token, { trip_id: trip.id, passenger_name: "Dollar" }));
    const response = await call("POST", `/bookings/${booking.id}/payment`, {
      token,
      body: { amount: 10, currency: "usd", source: CARD },
    });
    expect(response.status).toBe(400);
    expect((await json<Problem>(response)).errors?.[0]?.pointer).toBe("/currency");
  });

  it("returns 404 for an unknown booking", async () => {
    const response = await call("GET", `/bookings/${crypto.randomUUID()}`, { token: freshToken() });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  });

  it("returns 405 with Allow for a known path and unsupported method", async () => {
    const response = await call("PUT", "/bookings");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
  });

  it("returns 404 Problem for an unknown path", async () => {
    const response = await call("GET", "/nope");
    expect(response.status).toBe(404);
    expect((await json<Problem>(response)).status).toBe(404);
  });
});

describe("errors on demand", () => {
  it("forces a documented error with Prefer: code", async () => {
    const response = await call("GET", "/stations", { headers: { Prefer: "code=401" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("Preference-Applied")).toBe("code=401");
    expect((await json<Problem>(response)).title).toBe("Unauthorized");
  });

  it("forces an error with the __code query parameter and adds Retry-After on 429", async () => {
    const response = await call("GET", "/bookings?__code=429");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  it("refuses a code the operation does not document", async () => {
    const response = await call("GET", "/stations?__code=418");
    expect(response.status).toBe(400);
    expect((await json<Problem>(response)).detail).toContain("401");
  });
});

describe("isolation", () => {
  it("scopes bookings to the Authorization token, and falls back to a public space", async () => {
    const alice = freshToken();
    const bob = freshToken();
    const trip = (await searchTrips(alice)).data[0] as Trip;
    const booking = await json<Booking>(await book(alice, { trip_id: trip.id, passenger_name: "Alice" }));

    expect((await call("GET", `/bookings/${booking.id}`, { token: alice })).status).toBe(200);
    expect((await call("GET", `/bookings/${booking.id}`, { token: bob })).status).toBe(404);
    expect((await call("GET", `/bookings/${booking.id}`)).status).toBe(404);

    const publicTrips = await json<Collection<Trip>>(
      await call("GET", `/trips?origin=${BERLIN}&destination=${PARIS}&date=2026-11-02T08:00:00Z`),
    );
    const anonymous = await call("POST", "/bookings", {
      body: { trip_id: publicTrips.data[0]?.id, passenger_name: "Anonymous" },
    });
    expect(anonymous.status).toBe(201);
    const anonymousId = (await json<Booking>(anonymous)).id;
    expect((await call("GET", `/bookings/${anonymousId}`)).status).toBe(200);
  });
});

describe("stations", () => {
  it("filters by country and search, ignoring case and accents", async () => {
    const french = await json<Collection<Station>>(await call("GET", "/stations?country=fr&limit=100"));
    expect(french.data.length).toBeGreaterThan(3);
    expect(french.data.every((station) => station.country_code === "FR")).toBe(true);

    const zurich = await json<Collection<Station>>(await call("GET", "/stations?search=zurich"));
    expect(zurich.data[0]?.name).toBe("Zürich HB");
  });

  it("sorts by distance to coordinates", async () => {
    const near = await json<Collection<Station>>(await call("GET", "/stations?coordinates=48.8809,2.3553&limit=1"));
    expect(near.data[0]?.id).toBe(PARIS);
  });

  it("paginates with working next/prev links", async () => {
    const first = await json<Collection<Station>>(await call("GET", "/stations?limit=5"));
    expect(first.data).toHaveLength(5);
    expect(first.links.prev).toBeUndefined();
    expect(first.links.next).toBe(`${BASE}/stations?limit=5&page=2`);
    const second = await json<Collection<Station>>(await call("GET", "/stations?limit=5&page=2"));
    expect(second.links.prev).toBe(`${BASE}/stations?limit=5&page=1`);
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
  });

  it("supports the QUERY method with filters in the body", async () => {
    const response = await call("QUERY", "/stations", { body: { search: "Milano Centrale", country: "IT" } });
    expect(response.status).toBe(200);
    const result = await json<Collection<Station>>(response);
    expect(result.data.map((station) => station.name)).toEqual(["Milano Centrale"]);
  });

  it("advertises Accept-Query and caches the station catalogue", async () => {
    const response = await call("GET", "/stations");
    expect(response.headers.get("Accept-Query")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("max-age=3600, public");
    expect(response.headers.get("RateLimit")).toMatch(/^limit=\d+, remaining=\d+, reset=\d+$/);
  });
});

describe("content negotiation", () => {
  it("serves XML when asked", async () => {
    const response = await call("GET", "/stations?limit=1", { headers: { Accept: "application/xml" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/xml");
    const body = await response.text();
    expect(body).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\s*<data>\s*<stations>\s*<station>/);
  });

  it("accepts an XML booking body", async () => {
    const token = freshToken();
    const trip = (await searchTrips(token, `origin=${BERLIN}&destination=${PARIS}&date=2026-11-02&dogs=true`))
      .data[0] as Trip;
    const response = await call("POST", "/bookings", {
      token,
      headers: { "Content-Type": "application/xml" },
      body: `<booking><trip_id>${trip.id}</trip_id><passenger_name>Xavier</passenger_name><has_dog>true</has_dog></booking>`,
    });
    expect(response.status).toBe(201);
    expect(await json<Booking>(response)).toMatchObject({ passenger_name: "Xavier", has_dog: true });
  });

  it("serves problem+xml errors to XML clients", async () => {
    const response = await call("GET", `/bookings/${crypto.randomUUID()}`, { headers: { Accept: "application/xml" } });
    expect(response.headers.get("Content-Type")).toContain("application/problem+xml");
  });
});

describe("live trip updates", () => {
  async function bookedTrip(token: string) {
    return (await searchTrips(token)).data[0] as Trip;
  }

  it("streams Server-Sent Events ending with arrival", async () => {
    const token = freshToken();
    const trip = await bookedTrip(token);
    const response = await call("SUBSCRIBE", `/trips/${trip.id}?interval=0`, {
      token,
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const events = (await response.text()).trim().split("\n\n");
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)).toMatch(/^event: arrived\ndata: \{.*"trip_id":"[^"]+".*\}$/);
  });

  it("streams JSON Lines by default", async () => {
    const token = freshToken();
    const trip = await bookedTrip(token);
    const response = await call("SUBSCRIBE", `/trips/${trip.id}?interval=0`, { token });
    expect(response.headers.get("Content-Type")).toContain("application/jsonl");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.every((line) => line.trip_id === trip.id)).toBe(true);
    expect(lines.at(-1).type).toBe("arrived");
  });

  it("returns 404 for an unknown trip", async () => {
    const response = await call("SUBSCRIBE", `/trips/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
  });
});

describe("http plumbing", () => {
  it("answers CORS preflight for custom methods and headers", async () => {
    const response = await call("OPTIONS", "/bookings/123", {
      headers: {
        Origin: "https://bump.sh",
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "authorization,prefer,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("QUERY");
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("prefer");
  });

  it("exposes useful headers to browsers", async () => {
    const response = await call("GET", "/stations", { headers: { Origin: "https://bump.sh" } });
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Location");
  });

  it("serves a discoverable index at /", async () => {
    const response = await call("GET", "/");
    expect(response.status).toBe(200);
    const index = await json<{ endpoints: string[]; test_cards: Record<string, string> }>(response);
    expect(index.endpoints).toContain("POST /bookings");
    expect(index.test_cards).toHaveProperty("4000000000000002");
  });
});
