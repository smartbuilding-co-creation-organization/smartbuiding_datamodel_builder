import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CsvInputLimitError,
  CsvParseError,
  CsvInputLimits,
  DEFAULT_CSV_INPUT_LIMITS,
  Issue,
  RowRecord,
  SchemaRoot,
  buildOutputRows,
  getOutputPlugins,
  listUnrepresentedRows,
  parseCsv,
  runOutputPlugin,
  validate,
} from '@repo/core';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'schema/building_model.schema.json');
const SHACL_PATH = resolve(REPO_ROOT, 'schema/building_model.shacl.ttl');

const USAGE = `Usage: pnpm cli -- --input <csv> --format <format> [--serializer <name>] [--out <path>] [--allow-issues]
       pnpm cli -- --list-formats

Options:
  --input <path>          Input CSV file (required unless --list-formats)
  --format <name>         Output format, e.g. CSV, JSON, JSON-LD, RDF, YAML, DTDL, WoT
  --serializer <name>     Serializer name, required only when a format has more than one
  --out <path>            Write output to this file (default: stdout)
  --allow-issues          Write output even when blocking validation issues are found
  --list-formats          List available format/serializer combinations and exit
  --help                  Show this message

Input limits (positive integers; the web UI always uses the defaults):
  --max-rows <n>          Data rows (default: ${DEFAULT_CSV_INPUT_LIMITS.maxRows})
  --max-bytes <n>         Whole file, in bytes (default: ${DEFAULT_CSV_INPUT_LIMITS.maxBytes})
  --max-columns <n>       Columns (default: ${DEFAULT_CSV_INPUT_LIMITS.maxColumns})
  --max-cell-bytes <n>    One cell, in UTF-8 bytes (default: ${DEFAULT_CSV_INPUT_LIMITS.maxCellBytes})`;

function formatIssue(issue: Issue): string {
  const severity = issue.severity ?? 'violation';
  const location = [issue.rowId, issue.field].filter(Boolean).join(' / ');
  return `[${severity}] ${issue.code}: ${issue.message}${location ? ` (${location})` : ''}`;
}

function isBlockingIssue(issue: Issue): boolean {
  return issue.severity === undefined || issue.severity === 'violation';
}

const LIMIT_OPTIONS = {
  'max-bytes': 'maxBytes',
  'max-rows': 'maxRows',
  'max-columns': 'maxColumns',
  'max-cell-bytes': 'maxCellBytes',
} as const satisfies Record<string, keyof CsvInputLimits>;

// The defaults exist to keep the browser responsive -- the web app parses, builds the tree,
// validates and runs SHACL on the main thread with no worker. The CLI has none of those
// constraints, so it is the way to run a point list that a gateway-by-gateway split would
// otherwise be needed for. parseCsv() already accepts a partial override; this only exposes it.
function resolveLimits(values: Record<string, unknown>): Partial<CsvInputLimits> | Error {
  const limits: Partial<CsvInputLimits> = {};
  for (const [flag, key] of Object.entries(LIMIT_OPTIONS)) {
    const raw = values[flag];
    if (raw === undefined) continue;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return new Error(`--${flag} must be a positive integer, got "${String(raw)}"`);
    }
    limits[key] = parsed;
  }
  return limits;
}

function loadSchema(): SchemaRoot {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as SchemaRoot;
}

export type Writer = {
  write(chunk: string): void;
};

function listFormats(stdout: Writer): void {
  const plugins = getOutputPlugins();
  stdout.write('Available format/serializer combinations:\n');
  for (const plugin of plugins) {
    stdout.write(`  --format ${plugin.format} --serializer ${plugin.serializer}\n`);
  }
}

// How many of the input rows the chosen format actually carries. CSV and JSON-LD serialize the
// rows directly so every row survives; everything else goes through buildTree()/buildOutputRows()
// and carries only the rows the resource graph could place. Counted in rows, not resources --
// the graph also synthesizes Site/Building/Level/Room nodes that were never rows of their own,
// so a resource count is not comparable with the input row count.
function describeCoverage(rows: RowRecord[], format: string): string {
  if (format === 'CSV' || format === 'JSON-LD') {
    return `Rows read: ${rows.length} -> rows in output: ${rows.length}`;
  }
  const dropped = listUnrepresentedRows(rows).length;
  const resources = buildOutputRows(rows).length;
  return (
    `Rows read: ${rows.length} -> rows in output: ${rows.length - dropped}` +
    ` (dropped: ${dropped}); resources emitted: ${resources}`
  );
}

export type CliIO = {
  stdout: Writer;
  stderr: Writer;
};

export async function runCli(
  argv: string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  // pnpm forwards a literal "--" separator unchanged (e.g. `pnpm cli -- --format ...` or
  // `pnpm --filter @repo/cli start -- --format ...`), but node:util's parseArgs treats a
  // leading "--" as "everything after this is positional" rather than stripping it. Drop it
  // so both invocation styles behave the same as a direct `tsx src/index.ts --format ...`.
  const args = argv.filter((token) => token !== '--');

  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        input: { type: 'string' },
        format: { type: 'string' },
        serializer: { type: 'string' },
        out: { type: 'string' },
        'allow-issues': { type: 'boolean', default: false },
        'list-formats': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        'max-bytes': { type: 'string' },
        'max-rows': { type: 'string' },
        'max-columns': { type: 'string' },
        'max-cell-bytes': { type: 'string' },
      },
    }));
  } catch (error) {
    io.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (values.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (values['list-formats']) {
    listFormats(io.stdout);
    return 0;
  }

  if (!values.input) {
    io.stderr.write(`--input is required\n\n${USAGE}\n`);
    return 2;
  }
  if (!values.format) {
    io.stderr.write(`--format is required\n\n${USAGE}\n`);
    return 2;
  }

  const limits = resolveLimits(values);
  if (limits instanceof Error) {
    io.stderr.write(`${limits.message}\n\n${USAGE}\n`);
    return 2;
  }

  const plugins = getOutputPlugins();
  const format = values.format;
  const candidates = plugins.filter((p) => p.format.toLowerCase() === format.toLowerCase());
  if (candidates.length === 0) {
    const known = [...new Set(plugins.map((p) => p.format))].join(', ');
    io.stderr.write(`Unknown format "${format}". Available formats: ${known}\n`);
    return 2;
  }

  let plugin = candidates[0];
  if (candidates.length > 1) {
    if (!values.serializer) {
      const choices = candidates.map((p) => p.serializer).join(', ');
      io.stderr.write(
        `Format "${format}" has multiple serializers, pass --serializer. Choices: ${choices}\n`,
      );
      return 2;
    }
    const match = candidates.find(
      (p) => p.serializer.toLowerCase() === values.serializer!.toLowerCase(),
    );
    if (!match) {
      const choices = candidates.map((p) => p.serializer).join(', ');
      io.stderr.write(
        `Unknown serializer "${values.serializer}" for format "${format}". Choices: ${choices}\n`,
      );
      return 2;
    }
    plugin = match;
  }

  let csvText: string;
  try {
    csvText = readFileSync(values.input, 'utf-8');
  } catch (error) {
    io.stderr.write(`Failed to read "${values.input}": ${(error as Error).message}\n`);
    return 2;
  }

  const schema = loadSchema();

  let rows;
  try {
    rows = parseCsv(csvText, { schema, limits });
  } catch (error) {
    if (error instanceof CsvParseError || error instanceof CsvInputLimitError) {
      io.stderr.write(`Failed to parse CSV: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const { issues: structuralIssues } = validate(rows, { schema });
  if (structuralIssues.length > 0) {
    io.stderr.write('Validation warnings:\n');
    for (const issue of structuralIssues) {
      io.stderr.write(`  ${formatIssue(issue)}\n`);
    }
  }

  const shacl =
    plugin.format === 'RDF' || plugin.format === 'YAML'
      ? { shapeText: readFileSync(SHACL_PATH, 'utf-8') }
      : undefined;

  const result = await runOutputPlugin(plugin.format, plugin.serializer, { rows, schema, shacl });

  // Print the reconciliation unconditionally, before the issues. A run that ends "0 blocking
  // issues" tells you nothing about how many rows it looked at; this line does, so a silent
  // drop cannot be mistaken for a clean conversion.
  io.stderr.write(`${describeCoverage(rows, plugin.format)}\n`);

  const blockingIssues = (result.issues ?? []).filter(isBlockingIssue);
  if (blockingIssues.length > 0 && !values['allow-issues']) {
    io.stderr.write('Blocking validation issues (use --allow-issues to write anyway):\n');
    for (const issue of blockingIssues) {
      io.stderr.write(`  ${formatIssue(issue)}\n`);
    }
    return 1;
  }
  if (result.issues && result.issues.length > 0) {
    io.stderr.write('Output validation issues:\n');
    for (const issue of result.issues) {
      io.stderr.write(`  ${formatIssue(issue)}\n`);
    }
  }

  if (values.out) {
    writeFileSync(values.out, result.content, 'utf-8');
  } else {
    io.stdout.write(result.content);
  }

  return 0;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
