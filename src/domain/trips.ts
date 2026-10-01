import { type Random, seededRandom } from "./random";
import type { StationRecord } from "./station-data";
import { distanceKm } from "./stations";
import { addDays, atLocalTime, formatUtc, localDay } from "./time";
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
  origin: StationRecord;
  destination: StationRecord;
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

/** The national operator of either end; Eurostar across the Channel. */
function operatorFor(origin: StationRecord, destination: StationRecord, random: Random): string {
  const countries = [origin.country_code, destination.country_code];
  if (countries.includes("GB") && countries[0] !== countries[1]) return "Eurostar";
  // A country without a known national operator gets an international brand.
  const operators = countries.flatMap((country) => NATIONAL_OPERATORS[country] ?? []);
  return random.pick(operators.length > 0 ? operators : FALLBACK_OPERATORS);
}

function railDistanceKm(origin: StationRecord, destination: StationRecord): number {
  return Math.max(30, distanceKm(origin, destination) * RAIL_DETOUR);
}

function roundToFiveMinutes(minutes: number): number {
  return Math.round(minutes / 5) * 5;
}

/** Prices look like fares: 49.9, 89.9… */
function fare(distance: number, random: Random): number {
  const base = (9.9 + distance * 0.11) * (0.7 + random.next() * 0.9);
  return Math.max(9.9, Math.round(base) - 0.1);
}

/**
 * The full timetable for one origin/destination pair on one local day of the origin
 * station ("2026-11-02"), from 05:00 to 22:00 station time. It is a pure function of its
 * inputs, so trip ids are stable: the same search always returns the same trips, whoever
 * asks. Departures follow the origin's clock; times are shown in UTC.
 */
export async function timetable(origin: StationRecord, destination: StationRecord, day: string): Promise<Trip[]> {
  const random = seededRandom(`timetable|${origin.id}|${destination.id}|${day}`);
  const distance = railDistanceKm(origin, destination);
  const speed = distance > 400 ? 165 : 115;
  const baseDuration = (distance / speed) * 60 + 15;
  const operator = operatorFor(origin, destination, random);

  const trips: Trip[] = [];
  let minutes = FIRST_DEPARTURE_MINUTES + random.int(0, 40);
  while (minutes <= LAST_DEPARTURE_MINUTES) {
    const departure = atLocalTime(day, minutes, origin.timezone);
    const duration = roundToFiveMinutes(baseDuration + random.int(-10, 25));
    const arrival = new Date(departure.getTime() + duration * MINUTE);
    trips.push({
      // Named after the UTC instant, so the id does not depend on how the time is displayed.
      id: await uuidV5(`https://train-travel-mock/trips/${origin.id}|${destination.id}|${departure.toISOString()}`),
      origin: origin.id,
      destination: destination.id,
      departure_time: formatUtc(departure),
      arrival_time: formatUtc(arrival),
      operator: random.chance(0.8) ? operator : operatorFor(destination, origin, random),
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

  const day = localDay(search.from, search.origin.timezone);
  const today = (await timetable(search.origin, search.destination, day)).filter(matches);
  if (today.length >= MINIMUM_RESULTS) return today;
  const tomorrow = (await timetable(search.origin, search.destination, addDays(day, 1))).filter(matches);
  return [...today, ...tomorrow];
}
