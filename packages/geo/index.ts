import {
  cellToLatLng,
  cellToParent,
  getResolution,
  gridDisk,
  isValidCell,
  latLngToCell,
} from "h3-js";
import {
  LOCATION_RESOLUTION,
  SHARD_RESOLUTION,
  type ProximityScope,
} from "../shared/constants.ts";

export function isCanonicalLocation(value: unknown): value is string {
  return typeof value === "string" && isValidCell(value) && getResolution(value) === LOCATION_RESOLUTION;
}

export function latLngToCanonicalLocation(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new RangeError("Invalid latitude");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new RangeError("Invalid longitude");
  return latLngToCell(latitude, longitude, LOCATION_RESOLUTION);
}

export function locationToShard(location: string): string {
  assertCanonicalLocation(location);
  return cellToParent(location, SHARD_RESOLUTION);
}

export function locationToScopeCell(location: string, scope: ProximityScope): string {
  assertCanonicalLocation(location);
  return cellToParent(location, scope);
}

export function cellsVisibleFrom(location: string, scope: ProximityScope): string[] {
  return gridDisk(locationToScopeCell(location, scope), 1);
}

export type MessageReach = Readonly<Record<ProximityScope, ReadonlySet<string>>>;

/**
 * The scope cells whose viewers can see a message, for every scope.
 * Neighbourhoods are symmetric: a viewer's scope cell lies in the message cell's
 * one-ring exactly when the message cell lies in the viewer's one-ring.
 */
export function messageReach(messageLocation: string): MessageReach {
  assertCanonicalLocation(messageLocation);
  return {
    9: scopeReach(messageLocation, 9),
    10: scopeReach(messageLocation, 10),
    11: scopeReach(messageLocation, 11),
  };
}

/** Viewer locations must already be canonical; callers validate them when they are stored. */
export function reachIncludes(reach: MessageReach, viewerLocation: string, scope: ProximityScope): boolean {
  return reach[scope].has(cellToParent(viewerLocation, scope));
}

export function messageVisibleTo(messageLocation: string, viewerLocation: string, scope: ProximityScope): boolean {
  assertCanonicalLocation(messageLocation);
  assertCanonicalLocation(viewerLocation);
  return scopeReach(messageLocation, scope).has(cellToParent(viewerLocation, scope));
}

function scopeReach(location: string, scope: ProximityScope): Set<string> {
  return new Set(gridDisk(cellToParent(location, scope), 1));
}

export function candidateShardsForMessage(location: string): Set<string> {
  assertCanonicalLocation(location);
  const result = new Set<string>();
  for (const scope of [9, 10, 11] as const) {
    for (const cell of gridDisk(cellToParent(location, scope), 1)) {
      result.add(cellToParent(cell, SHARD_RESOLUTION));
    }
  }
  return result;
}

export function canonicalLocationCenter(location: string): { latitude: number; longitude: number } {
  assertCanonicalLocation(location);
  const [latitude, longitude] = cellToLatLng(location);
  return { latitude, longitude };
}

function assertCanonicalLocation(location: string): void {
  if (!isCanonicalLocation(location)) throw new RangeError("Location must be a valid H3 resolution 11 cell");
}
