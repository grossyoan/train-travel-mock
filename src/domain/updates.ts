import { seededRandom } from "./random";
import { formatUtc } from "./time";
import type { Trip } from "./trips";

/** A `TripUpdate` of the spec. */
export interface TripUpdate {
  type: "delay" | "platform" | "departed" | "arrived" | "cancelled";
  trip_id: string;
  occurred_at: string;
  minutes?: number;
  reason?: string;
  platform?: string;
}

const DELAY_REASONS = [
  "Signal failure",
  "Late arrival of the incoming train",
  "Crew change",
  "Track maintenance",
  "Waiting for a connecting service",
  "Heavy passenger traffic",
] as const;

const MINUTE = 60_000;

/**
 * The life of a trip as live updates: platform announcement, an optional delay, departure,
 * arrival. Seeded by the trip id, so a trip always tells the same story.
 */
export function tripUpdates(trip: Trip): TripUpdate[] {
  const random = seededRandom(`updates|${trip.id}`);
  const at = (base: string, offsetMinutes: number) => formatUtc(new Date(Date.parse(base) + offsetMinutes * MINUTE));
  const updates: TripUpdate[] = [
    {
      type: "platform",
      trip_id: trip.id,
      occurred_at: at(trip.departure_time, -20),
      platform: String(random.int(1, 24)),
    },
  ];
  let delay = 0;
  if (random.chance(0.6)) {
    delay = random.int(3, 25);
    updates.push({
      type: "delay",
      trip_id: trip.id,
      occurred_at: at(trip.departure_time, -10),
      minutes: delay,
      reason: random.pick(DELAY_REASONS),
    });
  }
  updates.push({ type: "departed", trip_id: trip.id, occurred_at: at(trip.departure_time, delay) });
  // Trains usually recover part of a delay on the way.
  updates.push({
    type: "arrived",
    trip_id: trip.id,
    occurred_at: at(trip.arrival_time, Math.floor(delay / 2)),
  });
  return updates;
}
