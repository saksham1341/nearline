import { describe, expect, it } from "vitest";
import { cellToParent, getPentagons, gridDisk } from "h3-js";
import {
  cellsVisibleFrom,
  isCanonicalLocation,
  latLngToCanonicalLocation,
  locationToScopeCell,
  messageVisibleTo,
} from "../packages/geo/index.ts";

describe("canonical geography", () => {
  const london = latLngToCanonicalLocation(51.5074, -0.1278);

  it("creates only resolution-11 canonical locations", () => {
    expect(isCanonicalLocation(london)).toBe(true);
    expect(isCanonicalLocation(cellToParent(london, 10))).toBe(false);
    expect(() => latLngToCanonicalLocation(91, 0)).toThrow(RangeError);
  });

  it.each([9, 10, 11] as const)("uses the viewer's r%s seven-cell neighborhood", (scope) => {
    const center = locationToScopeCell(london, scope);
    const neighbor = gridDisk(center, 1).find((cell) => cell !== center);
    expect(neighbor).toBeDefined();
    expect(cellsVisibleFrom(london, scope)).toContain(center);
    expect(cellsVisibleFrom(london, scope)).toContain(neighbor);
  });

  it("calculates message visibility relative to each viewer scope", () => {
    const broadCell = gridDisk(cellToParent(london, 9), 1).find((cell) => cell !== cellToParent(london, 9));
    expect(broadCell).toBeDefined();
    const messageLocation = latLngToCanonicalLocation(51.5074, -0.1278);
    expect(messageVisibleTo(messageLocation, london, 9)).toBe(true);
    const distant = latLngToCanonicalLocation(51.52, -0.10);
    expect(messageVisibleTo(distant, london, 11)).toBe(false);
  });

  it("delegates pentagon neighborhoods to H3", () => {
    const pentagonR11 = cellToParent(getPentagons(11)[0]!, 11);
    expect(isCanonicalLocation(pentagonR11)).toBe(true);
    expect(() => cellsVisibleFrom(pentagonR11, 11)).not.toThrow();
  });

});
