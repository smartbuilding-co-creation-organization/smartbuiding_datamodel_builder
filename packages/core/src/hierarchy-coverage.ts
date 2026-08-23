import {
  getHierarchyDropReasons,
  HierarchyDropReason,
  lacksRoomSignal,
  normalizeValue,
  resolveRowId,
} from './row-utils';
import { resolveTreeMode } from './tree';
import { Issue, RowRecord } from './types';

// A dropped row is not one issue -- it is one issue per row, and a real point list can drop
// thousands. Rendering every one of them (IssuesDrawer paints a box per issue) or writing them
// all to stderr buries the summary that actually matters, so per-row issues stop here. The cap
// is never silent: the summary issue always carries the exact totals, and says how many
// per-row issues were withheld.
export const MAX_ROW_ISSUES = 200;

export const ROW_DROPPED = 'row_dropped';
export const BUILDINGOS_ROOM_MISSING = 'buildingos_room_missing';

const DROP_REASON_LABELS: Record<HierarchyDropReason | 'id', string> = {
  site: 'site 未設定',
  building: 'building 未設定',
  level: 'floor/level 未設定',
  device: 'device_id/device_name 未設定',
  id: 'id 未設定',
};

export type UnrepresentedRow = {
  rowId?: string;
  reasons: (HierarchyDropReason | 'id')[];
};

function rowIdForIssue(row: RowRecord): string | undefined {
  const id = resolveRowId(row);
  if (id) return id;
  const fallback = normalizeValue(row['__rowId']);
  return fallback || undefined;
}

/**
 * The input rows that no graph-derived output can contain, with the reason for each.
 *
 * Exported so a caller can reconcile counts directly -- `rows.length - listUnrepresentedRows()`
 * is how many of the input rows actually reach RDF/YAML/DTDL/WoT/Tree JSON. Comparing input
 * rows against the emitted resource count does not work: the graph also synthesizes Site,
 * Building, Level and Room nodes that were never rows of their own.
 */
export function listUnrepresentedRows(rows: RowRecord[]): UnrepresentedRow[] {
  const dropped: UnrepresentedRow[] = [];

  if (resolveTreeMode(rows) === 'explicit-graph') {
    // buildParentChildTree() keys every node by resolveId(); a row that resolves to no id
    // never becomes a node, so it cannot reach any graph-derived output.
    for (const row of rows) {
      if (!resolveRowId(row)) {
        dropped.push({ rowId: rowIdForIssue(row), reasons: ['id'] });
      }
    }
    return dropped;
  }

  for (const row of rows) {
    const reasons = getHierarchyDropReasons(row);
    if (reasons.length > 0) {
      dropped.push({ rowId: rowIdForIssue(row), reasons });
    }
  }
  return dropped;
}

function summarizeReasons(dropped: UnrepresentedRow[]): string {
  const counts = new Map<string, number>();
  for (const row of dropped) {
    for (const reason of row.reasons) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(
      ([reason, count]) => `${DROP_REASON_LABELS[reason as HierarchyDropReason | 'id']} ${count}件`,
    )
    .join(' / ');
}

/**
 * Reconciles the input rows against what a graph-derived output can actually contain.
 *
 * buildTree() drops rows whose Site/Building/Level chain or device link cannot be resolved,
 * and every output built on top of it (RDF, YAML, DTDL, WoT, Tree JSON) inherits that drop
 * without a word. Before this check, a run over a 34,895-row point list produced 31,324
 * PointExt nodes and reported "0 SHACL violations" -- a zero that never looked at the missing
 * 3,571 rows. Emitting these as violations makes the output fail closed instead, so a clean
 * validation result means every input row was actually examined.
 *
 * Also reports rows that DO reach the output but attach Equipment straight to a Level because
 * installation_area is unset. That is legal RDF and the vendored SHACL accepts it, so it is a
 * warning rather than a violation -- but Building OS will not ingest that shape.
 */
export function checkHierarchyCoverage(rows: RowRecord[]): Issue[] {
  const issues: Issue[] = [];
  const dropped = listUnrepresentedRows(rows);

  if (dropped.length > 0) {
    const shown = Math.min(dropped.length, MAX_ROW_ISSUES);
    const withheld = dropped.length - shown;
    issues.push({
      code: ROW_DROPPED,
      severity: 'violation',
      message:
        `入力 ${rows.length.toLocaleString('ja-JP')} 行のうち ${dropped.length.toLocaleString('ja-JP')} 行は` +
        `階層を解決できないため、この形式の出力に含まれません（内訳: ${summarizeReasons(dropped)}）。` +
        `出力に含まれるのは ${(rows.length - dropped.length).toLocaleString('ja-JP')} 行です。` +
        (withheld > 0
          ? `行単位のIssueは先頭 ${shown.toLocaleString('ja-JP')} 件のみ表示しています（残り ${withheld.toLocaleString('ja-JP')} 件は省略）。`
          : ''),
    });

    for (const row of dropped.slice(0, shown)) {
      issues.push({
        code: ROW_DROPPED,
        severity: 'violation',
        message: `階層を解決できないため出力に含まれません（${summarizeReasons([row])}）。`,
        rowId: row.rowId,
        field: row.reasons[0] === 'id' ? 'id' : row.reasons[0],
      });
    }
  }

  if (resolveTreeMode(rows) === 'hierarchy-signal') {
    const roomless = rows.filter(
      (row) => getHierarchyDropReasons(row).length === 0 && lacksRoomSignal(row),
    );
    if (roomless.length > 0) {
      const shown = Math.min(roomless.length, MAX_ROW_ISSUES);
      const withheld = roomless.length - shown;
      issues.push({
        code: BUILDINGOS_ROOM_MISSING,
        severity: 'warning',
        message:
          `${roomless.length.toLocaleString('ja-JP')} 行は installation_area が未設定のため Room が生成されず、` +
          `Equipment が Level に直接ぶら下がります。ビルOS はこの階層を受理しません。` +
          (withheld > 0
            ? `行単位のIssueは先頭 ${shown.toLocaleString('ja-JP')} 件のみ表示しています（残り ${withheld.toLocaleString('ja-JP')} 件は省略）。`
            : ''),
      });

      for (const row of roomless.slice(0, shown)) {
        issues.push({
          code: BUILDINGOS_ROOM_MISSING,
          severity: 'warning',
          message:
            'installation_area が未設定のため Room が生成されません（Site → Building → Level → Equipment → Point）。',
          rowId: rowIdForIssue(row),
          field: 'installationArea',
        });
      }
    }
  }

  return issues;
}
