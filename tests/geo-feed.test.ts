import { describe, expect, it } from "vitest";
import {
  cellCenter,
  childrenOf,
  isScopeCell,
  latLngToCanonicalLocation,
  locationToScopeCell,
  messageVisibleTo,
  parentAt,
  refCells,
  regionCells,
  resolutionOf,
} from "../packages/geo/index.ts";
import { locationHintFor } from "../packages/feed/location-hint.ts";

const london = latLngToCanonicalLocation(51.5074, -0.1278);

describe("feed geography", () => {
  it("accepts a scope cell only at the scope's resolution", () => {
    expect(isScopeCell(locationToScopeCell(london, 10), 10)).toBe(true);
    expect(isScopeCell(locationToScopeCell(london, 10), 9)).toBe(false);
    expect(isScopeCell("not-a-cell", 10)).toBe(false);
    expect(isScopeCell(42, 10)).toBe(false);
  });

  it("derives the seven-cell region and the anchor's parents", () => {
    const scopeCell = locationToScopeCell(london, 9);
    expect(regionCells(scopeCell)).toHaveLength(7);
    expect(regionCells(scopeCell)).toContain(scopeCell);
    const cells = refCells(london);
    expect(cells.cell11).toBe(london);
    expect(cells.cell10).toBe(locationToScopeCell(london, 10));
    expect(cells.cell9).toBe(locationToScopeCell(london, 9));
  });

  it("region membership agrees with the canonical visibility predicate", () => {
    for (let i = 0; i < 300; i += 1) {
      const anchor = latLngToCanonicalLocation(51.5074 + (i % 15 - 7) * 0.0011, -0.1278 + (Math.floor(i / 15) - 10) * 0.0016);
      for (const scope of [9, 10, 11] as const) {
        const region = new Set(regionCells(locationToScopeCell(london, scope)));
        const anchorCell = refCells(anchor)[`cell${scope}`];
        expect(region.has(anchorCell)).toBe(messageVisibleTo(anchor, london, scope));
      }
    }
  });

  it("walks the hierarchy", () => {
    const r7 = parentAt(london, 7);
    expect(resolutionOf(r7)).toBe(7);
    expect(childrenOf(r7).map(resolutionOf)).toEqual(Array(childrenOf(r7).length).fill(8));
    expect(childrenOf(r7)).toContain(parentAt(london, 8));
    const center = cellCenter(r7);
    expect(center.latitude).toBeCloseTo(51.5, 0);
  });

  it("maps cells to Durable Object location hints", () => {
    const hint = (lat: number, lng: number) => locationHintFor(latLngToCanonicalLocation(lat, lng));
    expect(hint(51.5074, -0.1278)).toBe("weur");
    expect(hint(40.7128, -74.006)).toBe("enam");
    expect(hint(37.7749, -122.4194)).toBe("wnam");
    expect(hint(-23.5505, -46.6333)).toBe("sam");
    expect(hint(25.2048, 55.2708)).toBe("me");
    expect(hint(6.5244, 3.3792)).toBe("afr");
    expect(hint(55.7558, 37.6173)).toBe("eeur");
    expect(hint(35.6762, 139.6503)).toBe("apac");
    expect(hint(-33.8688, 151.2093)).toBe("oc");
  });
});
