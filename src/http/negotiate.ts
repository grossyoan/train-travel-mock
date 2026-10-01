interface MediaRange {
  type: string;
  quality: number;
}

function parseAccept(header: string): MediaRange[] {
  return header
    .split(",")
    .map((part) => {
      const [type = "", ...parameters] = part.trim().split(";");
      const q = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { type: type.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((range) => range.type !== "");
}

function specificity(range: string, offered: string): number {
  if (range === offered) return 3;
  const [rangeType, rangeSubtype] = range.split("/");
  const [offeredType] = offered.split("/");
  if (rangeSubtype === "*" && rangeType === offeredType) return 2;
  if (range === "*/*") return 1;
  return 0;
}

/**
 * Picks the offered media type the client prefers (RFC 9110 §12.5.1). Lenient by design:
 * a missing header, or one matching nothing, falls back to the first offered type
 * instead of a 406, so curl and browsers always get something readable.
 */
export function negotiate(accept: string | undefined, offered: readonly [string, ...string[]]): string {
  if (!accept) return offered[0];
  const ranges = parseAccept(accept);
  let best = offered[0];
  let bestQuality = 0;
  for (const type of offered) {
    let quality = 0;
    let matched = 0;
    for (const range of ranges) {
      const score = specificity(range.type, type);
      if (score > matched) {
        matched = score;
        quality = range.quality;
      }
    }
    if (quality > bestQuality) {
      best = type;
      bestQuality = quality;
    }
  }
  return best;
}
