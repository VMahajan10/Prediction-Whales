/** Default compression headers for outbound Polymarket / external REST calls. */
export const OUTBOUND_COMPRESSION_HEADERS = {
  "Accept-Encoding": "gzip, deflate, br",
} as const;

export function mergeOutboundHeaders(
  headers?: RequestInit["headers"]
): Record<string, string> {
  const merged: Record<string, string> = { ...OUTBOUND_COMPRESSION_HEADERS };

  if (!headers) return merged;

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      merged[key] = value;
    });
    return merged;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      merged[key] = value;
    }
    return merged;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      merged[key] = value;
    } else if (Array.isArray(value)) {
      merged[key] = value.join(", ");
    }
  }

  return merged;
}
