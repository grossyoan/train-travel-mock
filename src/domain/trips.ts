import { type Random, seededRandom } from "./random";
import type { StationRecord } from "./station-data";
import { distanceKm, findStation } from "./stations";
import { uuidV5 } from "./uuid";

export interface Trip {
  id: string;
  origin: string;
  destination: string;
  departure_time: string;
  arrival_time: string;
  operator: string;
  price: number;
  bicycles_allowed: boolean;
  dogs_allowed: boolean;
}

export interface TripSearch {
  origin: string;
  destination: string;
  /** Earliest acceptable departure. */
  from: Date;
  bicycles: boolean;
  dogs: boolean;
}

const NATIONAL_OPERATORS: Record<string, string> = {
  AT: "ÖBB",
  BE: "SNCB",
  CH: "SBB CFF FFS",
  CZ: "České dráhy",
  DE: "Deutsche Bahn",
  DK: "DSB",
  ES: "Renfe",
  FR: "SNCF",
  GB: "LNER",
  IT: "Trenitalia",
  NL: "NS",
  NO: "Vy",
  PL: "PKP Intercity",
  SE: "SJ",
};
const FALLBACK_OPERATORS = ["EuroCity", "Nightjet", "European Sleeper"] as const;

/** Rail lines are longer than the great circle. */
const RAIL_DETOUR = 1.25;
const FIRST_DEPARTURE_MINUTES = 5 * 60;
const LAST_DEPARTURE_MINUTES = 22 * 60;
const MINIMUM_RESULTS = 3;
const MINUTE = 60_000;

function operatorFor(
  origin: StationRecord | undefined,
  destination: StationRecord | undefined,
  random: Random,
): string {
  const countries = [origin?.country_code, destination?.country_code];
  if (countries.includes("GB") && countries[0] !== countries[1]) return "Eurostar";
  const operators = countries.flatMap((country) => (country && NATIONAL_OPERATORS[country]) || []);
  return random.pick(operators.length > 0 ? operators : FALLBACK_OPERATORS);
}

/** Distance by rail. Unknown stations get a plausible, stable distance derived from the pair. */
function railDistanceKm(origin: string, destination: string): number {
  const from = findStation(origin);
  const to = findStation(destination);
  if (from && to) return Math.max(30, distanceKm(from, to) * RAIL_DETOUR);
  return seededRandom(`distance|${origin}|${destination}`).int(250, 950);
}

function roundToFiveMinutes(minutes: number): number {
  return Math.round(minutes / 5) * 5;
}

/** Prices look like fares: 49.9, 89.9… */
function fare(distance: number, random: Random): number {
  const base = (9.9 + distance * 0.11) * (0.7 + random.next() * 0.9);
  return Math.max(9.9, Math.round(base) - 0.1);
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function startOfDayUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The full timetable for one origin/destination pair on one UTC day. It is a pure
 * function of its inputs, so trip ids are stable: the same search always returns the
 * same trips, whoever asks.
 */
export async function timetable(origin: string, destination: string, day: Date): Promise<Trip[]> {
  const midnight = startOfDayUtc(day);
  const dayKey = iso(midnight).slice(0, 10);
  const random = seededRandom(`timetable|${origin}|${destination}|${dayKey}`);
  const distance = railDistanceKm(origin, destination);
  const speed = distance > 400 ? 165 : 115;
  const baseDuration = (distance / speed) * 60 + 15;
  const operator = operatorFor(findStation(origin), findStation(destination), random);

  const trips: Trip[] = [];
  let minutes = FIRST_DEPARTURE_MINUTES + random.int(0, 40);
  while (minutes <= LAST_DEPARTURE_MINUTES) {
    const departure = new Date(midnight.getTime() + minutes * MINUTE);
    const duration = roundToFiveMinutes(baseDuration + random.int(-10, 25));
    const arrival = new Date(departure.getTime() + duration * MINUTE);
    const departureTime = iso(departure);
    trips.push({
      id: await uuidV5(`https://train-travel-mock/trips/${origin}|${destination}|${departureTime}`),
      origin,
      destination,
      departure_time: departureTime,
      arrival_time: iso(arrival),
      operator: random.chance(0.8) ? operator : operatorFor(findStation(destination), findStation(origin), random),
      price: fare(distance, random),
      bicycles_allowed: random.chance(0.6),
      dogs_allowed: random.chance(0.5),
    });
    minutes += random.int(50, 120);
  }
  return trips;
}

/**
 * Trips departing at or after `search.from`. When the day is nearly over, the next
 * morning's trains are added so a late search still returns something to book.
 */
export async function searchTrips(search: TripSearch): Promise<Trip[]> {
  const matches = (trip: Trip) =>
    Date.parse(trip.departure_time) >= search.from.getTime() &&
    (!search.bicycles || trip.bicycles_allowed) &&
    (!search.dogs || trip.dogs_allowed);

  const today = (await timetable(search.origin, search.destination, search.from)).filter(matches);
  if (today.length >= MINIMUM_RESULTS) return today;
  const nextDay = new Date(startOfDayUtc(search.from).getTime() + 24 * 60 * MINUTE);
  const tomorrow = (await timetable(search.origin, search.destination, nextDay)).filter(matches);
  return [...today, ...tomorrow];
}

/**
 * Accepts any date Date.parse understands. A bare day ("2026-11-02") means the whole
 * day, from midnight UTC.
 */
export function parseTripDate(value: string): Date | undefined {
  const trimmed = value.trim();
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}
