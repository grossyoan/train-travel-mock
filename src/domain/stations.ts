import { STATIONS, type StationRecord } from "./station-data";

/** A station as the API exposes it (coordinates stay internal). */
export interface Station {
  id: string;
  name: string;
  address: string;
  country_code: string;
  timezone: string;
}

export interface StationFilters {
  search?: string;
  country?: string;
  coordinates?: Coordinates;
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

const byId = new Map(STATIONS.map((station) => [station.id, station]));

export function findStation(id: string): StationRecord | undefined {
  return byId.get(id);
}

/** The name of a catalogue station. Trips only reference catalogue stations, so a miss is a bug. */
export function stationName(id: string): string {
  const station = byId.get(id);
  if (!station) throw new Error(`Unknown station ${id}`);
  return station.name;
}

export function toStation({ id, name, address, country_code, timezone }: StationRecord): Station {
  return { id, name, address, country_code, timezone };
}

/** Lowercase without diacritics, so "zurich" matches "Zürich" and "koln" matches "Köln". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Parses "lat,lon" (spaces allowed). Returns undefined when it is not a valid coordinate pair. */
export function parseCoordinates(value: string): Coordinates | undefined {
  const parts = value.split(",").map((part) => Number(part.trim()));
  const [latitude, longitude] = parts;
  if (parts.length !== 2 || latitude === undefined || longitude === undefined) return undefined;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

/** Great-circle distance in kilometres. */
export function distanceKm(from: Coordinates, to: Coordinates): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(to.latitude - from.latitude);
  const dLon = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Common rail abbreviations, so "Berlin Hbf" finds "Berlin Hauptbahnhof" and "Zürich HB". */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  hbf: ["hauptbahnhof", "hb"],
  hauptbahnhof: ["hbf", "hb"],
  centrale: ["central", "centraal"],
  central: ["centrale", "centraal"],
};

/** Every word of the search must appear in the station name or address (accent and case insensitive). */
function matchesSearch(station: StationRecord, search: string): boolean {
  const haystack = fold(`${station.name} ${station.address}`);
  return fold(search)
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => [word, ...(ALIASES[word] ?? [])].some((candidate) => haystack.includes(candidate)));
}

/**
 * Filters the catalogue. `search` matches name or address; `country` is case-insensitive;
 * `coordinates` sorts by proximity (closest first) instead of filtering.
 */
export function searchStations(filters: StationFilters): StationRecord[] {
  const search = filters.search?.trim() ?? "";
  const country = filters.country?.trim().toUpperCase();
  const matches = STATIONS.filter(
    (station) => (!search || matchesSearch(station, search)) && (!country || station.country_code === country),
  );
  const origin = filters.coordinates;
  if (!origin) return matches;
  return matches.toSorted((a, b) => distanceKm(origin, a) - distanceKm(origin, b));
}

/**
 * A station from its id or its name. Names resolve to the first match in catalogue
 * order, which lists each city's main station first ("Paris" is Gare du Nord).
 */
export function resolveStation(value: string): StationRecord | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return findStation(trimmed) ?? searchStations({ search: trimmed })[0];
}
