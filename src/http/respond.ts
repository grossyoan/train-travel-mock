import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import type { Context } from "hono";
import { isRecord } from "../domain/validation";
import type { AppEnv } from "./app-env";
import { negotiate } from "./negotiate";
import { type Problem, problem } from "./problem";

const JSON_TYPE = "application/json";
const XML_TYPE = "application/xml";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

const builder = new XMLBuilder({ format: true, ignoreAttributes: false, attributeNamePrefix: "@_" });
const parser = new XMLParser({ parseTagValue: false, ignoreAttributes: true, trimValues: true });

type Headers = Record<string, string>;

/**
 * How a JSON body maps onto the XML the spec describes (`xml.name`, `wrapped`):
 * a single resource gets a named root; a collection becomes `<data><stations><station>…`.
 */
export type XmlShape = { root: string } | { collection: string; item: string };

function toXml(body: unknown, shape: XmlShape): string {
  if ("root" in shape) return XML_DECLARATION + builder.build({ [shape.root]: body });
  const { data, ...rest } = body as { data: unknown[] };
  return XML_DECLARATION + builder.build({ data: { [shape.collection]: { [shape.item]: data }, ...rest } });
}

function wantsXml(c: Context<AppEnv>, offersXml: boolean): boolean {
  return offersXml && negotiate(c.req.header("Accept"), [JSON_TYPE, XML_TYPE]) === XML_TYPE;
}

export interface SendOptions {
  /** Offer XML as well as JSON; omitted for operations the spec documents as JSON only. */
  xml?: XmlShape;
  headers?: Headers;
}

export function send(c: Context<AppEnv>, status: number, body: unknown, options: SendOptions = {}): Response {
  const headers = new Headers(options.headers);
  headers.set("Vary", "Accept");
  if (options.xml && wantsXml(c, true)) {
    headers.set("Content-Type", `${XML_TYPE}; charset=utf-8`);
    return new Response(toXml(body, options.xml), { status, headers });
  }
  headers.set("Content-Type", `${JSON_TYPE}; charset=utf-8`);
  return new Response(JSON.stringify(body), { status, headers });
}

export function sendProblem(c: Context<AppEnv>, body: Problem, headers: Headers = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Vary", "Accept");
  responseHeaders.set("Cache-Control", "no-store");
  if (wantsXml(c, true)) {
    responseHeaders.set("Content-Type", "application/problem+xml; charset=utf-8");
    const xml = XML_DECLARATION + builder.build({ problem: { "@_xmlns": "urn:ietf:rfc:7807", ...body } });
    return new Response(xml, { status: body.status, headers: responseHeaders });
  }
  responseHeaders.set("Content-Type", "application/problem+json; charset=utf-8");
  return new Response(JSON.stringify(body), { status: body.status, headers: responseHeaders });
}

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/**
 * Reads a JSON or XML request body into a plain object. An empty body reads as `{}` so
 * that validation, not parsing, reports the missing required fields.
 */
export async function readBody(c: Context<AppEnv>): Promise<BodyResult> {
  const text = await c.req.text();
  if (text.trim() === "") return { ok: true, value: {} };
  const contentType = c.req.header("Content-Type") ?? "";
  const fail = (detail: string): BodyResult => ({ ok: false, response: sendProblem(c, problem(400, detail)) });

  if (contentType.includes("xml")) {
    const validation = XMLValidator.validate(text);
    if (validation !== true) return fail(`The request body is not valid XML: ${validation.err.msg}`);
    const document: unknown = parser.parse(text);
    const roots = isRecord(document) ? Object.values(document).filter(isRecord) : [];
    return roots.length === 1 && roots[0]
      ? { ok: true, value: roots[0] }
      : fail("The XML body must have a single root element.");
  }

  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { ok: true, value } : fail("The request body must be a JSON object.");
  } catch (error) {
    return fail(`The request body is not valid JSON: ${(error as Error).message}`);
  }
}
