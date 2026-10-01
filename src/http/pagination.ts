import type { Context } from "hono";
import type { AppEnv } from "./app-env";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export interface Page {
  page: number;
  limit: number;
  offset: number;
}

function positiveInteger(value: string | undefined): number | undefined {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number >= 1 ? number : undefined;
}

/** `page` and `limit` are clamped to valid values rather than rejected. */
export function readPage(c: Context<AppEnv>): Page {
  const page = positiveInteger(c.req.query("page")) ?? 1;
  const limit = Math.min(positiveInteger(c.req.query("limit")) ?? DEFAULT_LIMIT, MAX_LIMIT);
  return { page, limit, offset: (page - 1) * limit };
}

/** HATEOAS links of the `Links-Self` and `Links-Pagination` schemas. */
export function pageLinks(c: Context<AppEnv>, { page, limit }: Page, total: number) {
  const at = (target: number) => {
    const url = new URL(c.req.url);
    url.searchParams.delete("__code");
    url.searchParams.set("page", String(target));
    return url.toString();
  };
  return {
    self: c.req.url,
    ...(page * limit < total ? { next: at(page + 1) } : {}),
    ...(page > 1 ? { prev: at(page - 1) } : {}),
  };
}

/** A `Wrapper-Collection` body for one page out of `total` items. */
export function collection<T>(c: Context<AppEnv>, data: readonly T[], pageInfo: Page, total: number) {
  return { data, links: pageLinks(c, pageInfo, total) };
}

/** Paginates a list held in memory. */
export function paginate<T>(c: Context<AppEnv>, items: readonly T[], pageInfo: Page) {
  return collection(c, items.slice(pageInfo.offset, pageInfo.offset + pageInfo.limit), pageInfo, items.length);
}
