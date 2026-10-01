import { Hono } from "hono";
import { findStation, parseCoordinates, type StationFilters, searchStations, toStation } from "../domain/stations";
import { type FieldError, summarize, validateFields } from "../domain/validation";
import type { AppEnv } from "../http/app-env";
import { paginate, readPage } from "../http/pagination";
import { operation } from "../http/prefer";
import { problem } from "../http/problem";
import { readBody, send, sendProblem, type XmlShape } from "../http/respond";

export const stations = new Hono<AppEnv>({ strict: false });

const HEADERS = { "Cache-Control": "max-age=3600, public", "Accept-Query": "application/json" };
const XML: XmlShape = { collection: "stations", item: "station" };

function readFilters(
  input: Record<string, unknown>,
  pointerPrefix: string,
): { filters: StationFilters; errors: FieldError[] } {
  const { values, errors } = validateFields(
    input,
    { search: { type: "string" }, country: { type: "string" }, coordinates: { type: "string" } },
    pointerPrefix,
  );
  const filters: StationFilters = {};
  if (typeof values.search === "string") filters.search = values.search;
  if (typeof values.country === "string") filters.country = values.country;
  if (typeof values.coordinates === "string") {
    const coordinates = parseCoordinates(values.coordinates);
    if (coordinates) filters.coordinates = coordinates;
    else
      errors.push({
        pointer: `${pointerPrefix}coordinates`,
        detail: 'must be "latitude,longitude", e.g. "52.5200,13.4050"',
      });
  }
  return { filters, errors };
}

stations.get("/stations", operation("get-stations"), (c) => {
  const { filters, errors } = readFilters(c.req.query(), "");
  if (errors.length > 0) return sendProblem(c, problem(400, summarize(errors), errors));
  const body = paginate(c, searchStations(filters).map(toStation), readPage(c));
  return send(c, 200, body, { xml: XML, headers: HEADERS });
});

stations.on("QUERY", "/stations", operation("query-stations"), async (c) => {
  const body = await readBody(c);
  if (!body.ok) return body.response;
  const { filters, errors } = readFilters(body.value, "/");
  if (errors.length > 0) return sendProblem(c, problem(400, summarize(errors), errors));
  const result = paginate(c, searchStations(filters).map(toStation), readPage(c));
  return send(c, 200, result, { xml: XML, headers: HEADERS });
});

/** Not in the spec, but trip links point here, so following them works. */
stations.get("/stations/:id", (c) => {
  const station = findStation(c.req.param("id"));
  if (!station)
    return sendProblem(
      c,
      problem(404, `Station ${c.req.param("id")} was not found. List stations with GET /stations.`),
    );
  return send(c, 200, toStation(station), {
    xml: { root: "station" },
    headers: { "Cache-Control": HEADERS["Cache-Control"] },
  });
});
