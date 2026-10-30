import assert from "node:assert/strict";
import { categoryLabelFromEventTags } from "@/lib/polymarketDataApi/categoryFromTags";

function tags(slugs: string[], labels?: string[]) {
  return [
    ...slugs.map((slug) => ({ slug, label: slug })),
    ...(labels ?? []).map((label) => ({ slug: label.toLowerCase().replace(/\s+/g, "-"), label })),
  ];
}

assert.equal(
  categoryLabelFromEventTags(tags(["nfl", "sports"], ["NFL", "Sports"])),
  "NFL"
);
assert.equal(
  categoryLabelFromEventTags(tags(["nfl", "games"], ["NFL"])),
  "NFL"
);
assert.equal(
  categoryLabelFromEventTags(tags(["nfl", "pop-culture"], ["NFL", "Halftime"])),
  "CULTURE"
);
assert.equal(
  categoryLabelFromEventTags(tags(["nfl"], ["Super Bowl halftime show"])),
  "CULTURE"
);
assert.equal(
  categoryLabelFromEventTags(tags(["nfl", "economics"], ["NFL", "Inflation"])),
  "ECONOMICS"
);
assert.equal(
  categoryLabelFromEventTags(tags(["politics"], ["Politics"])),
  "POLITICS"
);

console.log("categoryFromTags tests passed");
