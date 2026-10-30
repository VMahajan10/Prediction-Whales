import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import { mergeOutboundHeaders } from "@/lib/outboundHttp";
import { categoryLabelFromEventTags } from "@/lib/polymarketDataApi/categoryFromTags";

const BATCH = 40;

export async function resolveCategoryLabelsByEventId(
  eventIds: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(eventIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;

  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const params = chunk.map((id) => `id=${encodeURIComponent(id)}`).join("&");
    try {
      const res = await fetchWithTimeout(
        `https://gamma-api.polymarket.com/events?${params}`,
        { headers: mergeOutboundHeaders({ Accept: "application/json" }) }
      );
      if (!res.ok) continue;
      const events = (await res.json()) as { id?: string | number; tags?: unknown }[];
      if (!Array.isArray(events)) continue;
      for (const ev of events) {
        const id = ev.id != null ? String(ev.id) : "";
        if (!id) continue;
        const label = categoryLabelFromEventTags(ev.tags);
        if (label) out.set(id, label);
      }
    } catch {
      // skip batch
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  return out;
}
