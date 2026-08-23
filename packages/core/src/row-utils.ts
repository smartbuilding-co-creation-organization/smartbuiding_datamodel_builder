import { RowRecord } from './types';

const INVALID_HIERARCHY_VALUES = new Set(['-', '－']);

const HIERARCHY_SIGNAL_GROUPS = {
  site: ['site', 'siteName', 'siteId'],
  building: ['building', 'buildingName', 'buildingId'],
  level: ['level', 'levelName', 'floor', 'floorName'],
  room: ['installationArea', 'room', 'space', 'targetArea', 'zone'],
  device: ['deviceId', 'deviceName'],
  point: ['pointId', 'pointName'],
} as const;

const ROOM_KIND_MAP: Record<string, string> = {
  installationArea: 'Room',
  room: 'Room',
  space: 'Room',
  targetArea: 'Room',
  zone: 'Zone',
};

export function normalizeValue(value: string | undefined): string {
  return (value ?? '').toString().trim();
}

const TRUTHY_TOKENS = new Set(['y', 'yes', 'true', '1', 'rw', 'w']);

// Point-list CSVs encode booleans (writable, flag, ...) with whatever casing/token the source
// system used (TRUE/FALSE, Y/N, RW, 1/0, ...) -- this is the single place that decides what
// counts as true, shared by anything that both reads it for logic (e.g. wot.ts's read-only
// check) and anything that must emit a spec-valid xsd:boolean lexical form ("true"/"false")
// for RDF/SHACL (rdf.ts).
export function isTruthyValue(value: string | undefined): boolean {
  return TRUTHY_TOKENS.has(normalizeValue(value).toLowerCase());
}

function normalizeHierarchyValue(value: string | undefined): string {
  const trimmed = normalizeValue(value);
  if (!trimmed) return '';
  return INVALID_HIERARCHY_VALUES.has(trimmed) ? '' : trimmed;
}

function pickFirst(row: RowRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = normalizeHierarchyValue(row[key]);
    if (value) return value;
  }
  return '';
}

function pickFirstWithKind(
  row: RowRecord,
  keys: readonly string[],
): { value: string; kind: string } {
  for (const key of keys) {
    const value = normalizeHierarchyValue(row[key]);
    if (value) return { value, kind: ROOM_KIND_MAP[key] ?? 'Room' };
  }
  return { value: '', kind: '' };
}

export function resolveHierarchySignals(row: RowRecord): {
  site: string;
  building: string;
  level: string;
  room: string;
  roomKind: string;
  deviceId: string;
  deviceName: string;
  pointId: string;
  pointName: string;
} {
  const roomSignal = pickFirstWithKind(row, HIERARCHY_SIGNAL_GROUPS.room);

  return {
    site: pickFirst(row, HIERARCHY_SIGNAL_GROUPS.site),
    building: pickFirst(row, HIERARCHY_SIGNAL_GROUPS.building),
    level: pickFirst(row, HIERARCHY_SIGNAL_GROUPS.level),
    room: roomSignal.value,
    roomKind: roomSignal.kind,
    deviceId: normalizeHierarchyValue(row.deviceId),
    deviceName: normalizeHierarchyValue(row.deviceName),
    pointId: normalizeHierarchyValue(row.pointId),
    pointName: normalizeHierarchyValue(row.pointName),
  };
}

export type HierarchyDropReason = 'site' | 'building' | 'level' | 'device';

// The exact condition under which tree.ts's buildHierarchyTree() skips a whole input row --
// not an approximation of it. buildTree() drops such a row entirely (no Site/Building/Level/
// Room/Equipment/Point node at all), and buildOutputRows() only emits rows that made it into
// the graph, so the row silently disappears from RDF/YAML/DTDL/WoT/Tree JSON output. tree.ts
// and hierarchy-coverage.ts both call this so the "which rows are dropped" answer cannot drift
// away from the code that actually drops them.
//
// Note this is about hierarchy SIGNALS, not raw cell values: normalizeHierarchyValue() already
// folded "-" / "－" / blank into "unset", so a floor of "-" reaches here as a missing level.
export function getHierarchyDropReasons(row: RowRecord): HierarchyDropReason[] {
  const signals = resolveHierarchySignals(row);
  const reasons: HierarchyDropReason[] = [];

  if (!signals.site) reasons.push('site');
  if (!signals.building) reasons.push('building');
  if (!signals.level) reasons.push('level');
  if (reasons.length > 0) return reasons;

  if ((signals.pointId || signals.pointName) && !(signals.deviceId || signals.deviceName)) {
    reasons.push('device');
  }
  return reasons;
}

// A row that survives getHierarchyDropReasons() but carries no room signal gets its Equipment
// attached straight to the Level (tree.ts's `if (signals.room)`). That shape is valid RDF and
// the vendored SHACL accepts it, but Building OS does not ingest Equipment hanging directly
// under a Level -- see pointlist.md's installation_area section.
export function lacksRoomSignal(row: RowRecord): boolean {
  const signals = resolveHierarchySignals(row);
  return !signals.room;
}

export function hasHierarchySignals(rows: RowRecord[]): boolean {
  return rows.some((row) => {
    const signals = resolveHierarchySignals(row);
    return Boolean(
      signals.site ||
      signals.building ||
      signals.level ||
      signals.room ||
      signals.deviceId ||
      signals.deviceName ||
      signals.pointId ||
      signals.pointName,
    );
  });
}

export function getHierarchySignature(row: RowRecord): string {
  const signals = resolveHierarchySignals(row);
  return [
    signals.site,
    signals.building,
    signals.level,
    signals.room,
    signals.roomKind,
    signals.deviceId,
    signals.deviceName,
    signals.pointId,
    signals.pointName,
  ].join('|');
}

export function hasHierarchySignalChange(prevRow: RowRecord, nextRow: RowRecord): boolean {
  return getHierarchySignature(prevRow) !== getHierarchySignature(nextRow);
}

export function listMissingHierarchyParents(row: RowRecord): string[] {
  const signals = resolveHierarchySignals(row);
  const hasSite = Boolean(signals.site);
  const hasBuilding = Boolean(signals.building);
  const hasLevel = Boolean(signals.level);
  const hasRoom = Boolean(signals.room);
  const hasDevice = Boolean(signals.deviceId || signals.deviceName);
  const hasPoint = Boolean(signals.pointId || signals.pointName);
  const hasAnySignal = hasSite || hasBuilding || hasLevel || hasRoom || hasDevice || hasPoint;
  if (!hasAnySignal) return [];

  const missing: string[] = [];
  if ((hasBuilding || hasLevel || hasRoom || hasDevice || hasPoint) && !hasSite) {
    missing.push('site');
  }
  if ((hasLevel || hasRoom || hasDevice || hasPoint) && !hasBuilding) {
    missing.push('building');
  }
  if ((hasRoom || hasDevice || hasPoint) && !hasLevel) {
    missing.push('level');
  }
  if (hasPoint && !hasDevice) missing.push('device');
  return missing;
}

export function syncRowIdentifiers(prevRow: RowRecord, nextRow: RowRecord): RowRecord {
  const updated: RowRecord = { ...nextRow };

  const prevPointId = normalizeValue(prevRow.pointId);
  const nextPointId = normalizeValue(nextRow.pointId);
  const prevDeviceId = normalizeValue(prevRow.deviceId);
  const nextDeviceId = normalizeValue(nextRow.deviceId);

  const prevPointName = normalizeValue(prevRow.pointName);
  const nextPointName = normalizeValue(nextRow.pointName);
  const prevDeviceName = normalizeValue(prevRow.deviceName);
  const nextDeviceName = normalizeValue(nextRow.deviceName);

  if (nextPointId && (!normalizeValue(nextRow.id) || normalizeValue(prevRow.id) === prevPointId)) {
    updated.id = nextPointId;
  } else if (
    !nextPointId &&
    nextDeviceId &&
    (!normalizeValue(nextRow.id) || normalizeValue(prevRow.id) === prevDeviceId)
  ) {
    updated.id = nextDeviceId;
  }

  if (
    nextPointName &&
    (!normalizeValue(nextRow.name) || normalizeValue(prevRow.name) === prevPointName)
  ) {
    updated.name = nextPointName;
  } else if (
    !nextPointName &&
    nextDeviceName &&
    (!normalizeValue(nextRow.name) || normalizeValue(prevRow.name) === prevDeviceName)
  ) {
    updated.name = nextDeviceName;
  }

  return updated;
}

export function resolveRowId(row: RowRecord): string {
  return normalizeValue(row.id) || normalizeValue(row.pointId) || normalizeValue(row.deviceId);
}

export function resolveRowName(row: RowRecord, fallbackId: string): string {
  return (
    normalizeValue(row.name) ||
    normalizeValue(row.pointName) ||
    normalizeValue(row.deviceName) ||
    fallbackId
  );
}

export function inferRowKind(row: RowRecord): string | undefined {
  const explicit = normalizeValue(row.kind).toLowerCase();
  if (explicit) return explicit;

  if (
    normalizeValue(row.pointId) ||
    normalizeValue(row.pointName) ||
    normalizeValue(row.pointType) ||
    normalizeValue(row.pointSpecification)
  ) {
    return 'point';
  }

  if (
    normalizeValue(row.deviceId) ||
    normalizeValue(row.deviceName) ||
    normalizeValue(row.deviceType)
  ) {
    return 'device';
  }

  return undefined;
}
