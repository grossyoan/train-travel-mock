import { type Context, Hono } from "hono";
import { resolveStation } from "../domain/stations";
import { parseDateInZone } from "../domain/time";
import { searchTrips, type Trip } from "../domain/trips";
import { tripUpdates } from "../domain/updates";
import { type FieldError, summarize, validateFields } from "../domain/validation";
import type { AppEnv } from "../http/app-env";
import { baseUrl } from "../http/links";
import { negotiate } from "../http/negotiate";
import { paginate, readPage } from "../http/pagination";
import { operation } from "../http/prefer";
import { problem } from "../http/problem";
import { send, sendProblem } from "../http/respond";
import { spaceFor } from "../http/space";

export const trips = new Hono<AppEnv>({ strict: false });

const DEFAULT_INTERVAL_SECONDS = 2;
const MAX_INTERVAL_SECONDS = 10;

function withLinks(c: Context<AppEnv>, trip: Trip) {
  const base = baseUrl(c);
  return {
    ...trip,
    links: {
      self: `${base}/trips/${trip.id}`,
      origin: `${base}/stations/${trip.origin}`,
      destination: `${base}/stations/${trip.destination}`,
    },
  };
}

function stationNotFound(pointer: string, value: string): FieldError {
  return {
    pointer,
    detail: `matches no station ("${value}"); find one with GET /stations?search=${encodeURIComponent(value)}`,
  };
}

function tripNotFound(c: Context<AppEnv>, id: string) {
  return sendProblem(
    c,
    problem(
      404,
      `Trip ${id} was not found. Search trips with GET /trips first: trips are remembered per Authorization header.`,
    ),
  );
}

trips.get("/trips", operation("get-trips"), async (c) => {
  const { values, errors } = validateFields(
    c.req.query(),
    {
      origin: { type: "string", required: true },
      destination: { type: "string", required: true },
      date: { type: "string" },
      bicycles: { type: "boolean" },
      dogs: { type: "boolean" },
    },
    "",
  );
  const resolve = (name: "origin" | "destination") => {
    const value = values[name];
    if (typeof value !== "string") return undefined;
    const station = resolveStation(value);
    if (!station) errors.push(stationNotFound(name, value));
    return station;
  };
  const origin = resolve("origin");
  const destination = resolve("destination");
  // A date without offset is read in the origin station's timezone; no date means now.
  const from =
    typeof values.date !== "string" ? new Date() : origin ? parseDateInZone(values.date, origin.timezone) : undefined;
  if (typeof values.date === "string" && origin && !from) {
    errors.push({ pointer: "date", detail: 'must be an ISO 8601 date or date-time, e.g. "2026-11-02T09:00"' });
  }
  if (errors.length > 0 || !origin || !destination || !from) {
    return sendProblem(c, problem(400, summarize(errors), errors));
  }

  const found = await searchTrips({
    origin,
    destination,
    from,
    bicycles: values.bicycles === true,
    dogs: values.dogs === true,
  });
  const body = paginate(c, found, readPage(c));
  // Only trips the caller has seen become bookable, as with a real search session.
  await (await spaceFor(c)).saveTrips(body.data);
  return send(
    c,
    200,
    { ...body, data: body.data.map((trip) => withLinks(c, trip)) },
    { xml: { collection: "trips", item: "trip" }, headers: { "Cache-Control": "no-cache" } },
  );
});

/** Not in the spec, but `links.self` of a trip points here, so following it works. */
trips.get("/trips/:id", async (c) => {
  const trip = await (await spaceFor(c)).getTrip(c.req.param("id"));
  if (!trip) return tripNotFound(c, c.req.param("id"));
  return send(c, 200, withLinks(c, trip), { xml: { root: "trip" }, headers: { "Cache-Control": "no-cache" } });
});

trips.on("SUBSCRIBE", "/trips/:id", operation("subscribe-trip"), async (c) => {
  const trip = await (await spaceFor(c)).getTrip(c.req.param("id"));
  if (!trip) return tripNotFound(c, c.req.param("id"));

  const requested = Number(c.req.query("interval") ?? DEFAULT_INTERVAL_SECONDS);
  const interval = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 0), MAX_INTERVAL_SECONDS)
    : DEFAULT_INTERVAL_SECONDS;
  const sse = negotiate(c.req.header("Accept"), ["application/jsonl", "text/event-stream"]) === "text/event-stream";
  const encoder = new TextEncoder();
  const updates = tripUpdates(trip);
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, update] of updates.entries()) {
        // Pacing between events, so the stream feels live; ?interval=0 replays instantly.
        if (index > 0 && interval > 0) await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        if (cancelled) return;
        const line = JSON.stringify(update);
        controller.enqueue(encoder.encode(sse ? `event: ${update.type}\ndata: ${line}\n\n` : `${line}\n`));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": sse ? "text/event-stream; charset=utf-8" : "application/jsonl; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
});
