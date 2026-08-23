import { exportRdf } from './rdf';
import { SchemaRoot } from './schema-mapping';
import { Issue, RowRecord } from './types';
import { exportYaml } from './yaml';
import { exportDtdlInterfaces, exportDtdlTwinGraph } from './dtdl';
import { buildWotThings } from './wot';
import { validateWotThings } from './wot-validate';
import { buildOutputRows, mergeOutputRows } from './output-aggregation';
import { validateRowsWithShacl } from './shacl';
import { exportCsv } from './csv';
import { buildTree } from './tree';
import { checkHierarchyCoverage } from './hierarchy-coverage';

export type OutputPluginResult = {
  content: string;
  extension: string;
  mimeType: string;
  issues?: Issue[];
};

export type OutputPluginRunOptions = {
  rows: RowRecord[];
  modelRows?: RowRecord[];
  schema?: SchemaRoot;
  shacl?: {
    shapeText: string;
  };
};

export type OutputPlugin = {
  id: string;
  label: string;
  format: string;
  serializer: string;
  run: (options: OutputPluginRunOptions) => Promise<OutputPluginResult>;
};

const OUTPUT_PLUGINS: OutputPlugin[] = [
  {
    id: 'csv',
    label: 'CSV',
    format: 'CSV',
    serializer: 'CSV',
    run: async ({ rows }) => ({
      content: exportCsv(rows),
      extension: 'csv',
      mimeType: 'text/csv;charset=utf-8;',
    }),
  },
  {
    id: 'tree-json',
    label: 'Tree (JSON)',
    format: 'JSON',
    serializer: 'Tree',
    run: async ({ rows }) => ({
      content: JSON.stringify(buildTree(rows), null, 2),
      extension: 'json',
      mimeType: 'application/json;charset=utf-8;',
    }),
  },
  {
    id: 'json-ld',
    label: 'JSON-LD',
    format: 'JSON-LD',
    serializer: 'JSON-LD',
    run: async ({ rows }) => ({
      content: JSON.stringify(
        {
          '@context': {
            sbco: 'https://www.sbco.or.jp/ont/',
            '@vocab': 'https://www.sbco.or.jp/ont/',
          },
          '@graph': rows.map((row) => ({
            '@id': row.id,
            '@type': row.kind,
            ...row,
          })),
        },
        null,
        2,
      ),
      extension: 'jsonld',
      mimeType: 'application/ld+json;charset=utf-8;',
    }),
  },
  {
    id: 'rdf-turtle',
    label: 'RDF (Turtle)',
    format: 'RDF',
    serializer: 'Turtle',
    run: async ({ rows, schema, shacl }) => {
      const outputRows = buildOutputRows(rows);
      const content = exportRdf(outputRows, { schema, autoFill: false });
      const validation = shacl
        ? await validateRowsWithShacl(outputRows, shacl.shapeText, { schema })
        : undefined;
      return {
        content,
        extension: 'ttl',
        mimeType: 'text/turtle;charset=utf-8;',
        issues: validation?.issues,
      };
    },
  },
  {
    id: 'yaml',
    label: 'YAML',
    format: 'YAML',
    serializer: 'YAML',
    run: async ({ rows, schema, shacl }) => {
      const outputRows = buildOutputRows(rows);
      const content = exportYaml(outputRows, { schema, autoFill: false });
      const validation = shacl
        ? await validateRowsWithShacl(outputRows, shacl.shapeText, { schema })
        : undefined;
      return {
        content,
        extension: 'yaml',
        mimeType: 'text/yaml;charset=utf-8;',
        issues: validation?.issues,
      };
    },
  },
  {
    id: 'dtdl-interfaces',
    label: 'DTDL (Interfaces)',
    format: 'DTDL',
    serializer: 'Interfaces',
    run: async ({ rows }) => {
      const outputRows = buildOutputRows(rows);
      return {
        content: exportDtdlInterfaces(outputRows),
        extension: 'dtdl.json',
        mimeType: 'application/json;charset=utf-8;',
      };
    },
  },
  {
    id: 'dtdl-twin-graph',
    label: 'DTDL (Twin Graph)',
    format: 'DTDL',
    serializer: 'Twin Graph',
    run: async ({ rows }) => {
      const outputRows = buildOutputRows(rows);
      return {
        content: exportDtdlTwinGraph(outputRows),
        extension: 'json',
        mimeType: 'application/json;charset=utf-8;',
      };
    },
  },
  {
    id: 'wot-td',
    label: 'WoT (Thing Description)',
    format: 'WoT',
    serializer: 'Thing Description',
    run: async ({ rows }) => {
      const outputRows = buildOutputRows(rows);
      const things = buildWotThings(outputRows, { asThingModel: false });
      return {
        content: JSON.stringify(things, null, 2),
        extension: 'td.json',
        mimeType: 'application/td+json;charset=utf-8;',
        issues: validateWotThings(things, 'td'),
      };
    },
  },
  {
    id: 'wot-tm',
    label: 'WoT (Thing Model)',
    format: 'WoT',
    serializer: 'Thing Model',
    run: async ({ rows }) => {
      const outputRows = buildOutputRows(rows);
      const things = buildWotThings(outputRows, { asThingModel: true });
      return {
        content: JSON.stringify(things, null, 2),
        extension: 'tm.json',
        mimeType: 'application/tm+json;charset=utf-8;',
        issues: validateWotThings(things, 'tm'),
      };
    },
  },
];

// Plugins that serialize the resource graph rather than the rows. Everything here inherits
// buildTree()'s row drops -- a row whose Site/Building/Level chain or device link cannot be
// resolved contributes nothing at all -- so each has to answer for the rows it left out.
// 'csv' writes the rows verbatim and 'json-ld' maps them one-to-one, so both carry every row.
const GRAPH_DERIVED_PLUGIN_IDS = new Set([
  'tree-json',
  'rdf-turtle',
  'yaml',
  'dtdl-interfaces',
  'dtdl-twin-graph',
  'wot-td',
  'wot-tm',
]);

export function getOutputPlugins(): OutputPlugin[] {
  return [...OUTPUT_PLUGINS];
}

export function findOutputPlugin(format: string, serializer: string): OutputPlugin | undefined {
  return OUTPUT_PLUGINS.find(
    (plugin) => plugin.format === format && plugin.serializer === serializer,
  );
}

export async function runOutputPlugin(
  format: string,
  serializer: string,
  options: OutputPluginRunOptions,
): Promise<OutputPluginResult> {
  const plugin = findOutputPlugin(format, serializer);
  if (!plugin) {
    throw new Error(`Output plugin not found for ${format}/${serializer}`);
  }
  const merged = mergeOutputRows(options.rows, options.modelRows ?? []);
  const result = await plugin.run({ ...options, rows: merged });

  if (!GRAPH_DERIVED_PLUGIN_IDS.has(plugin.id)) return result;

  // Reconcile against options.rows -- the actual input -- not `merged`. mergeOutputRows() folds
  // in the resource model, which contributes synthesized Site/Building/Level/Room rows that were
  // never input rows of their own and carry none of the hierarchy columns; measuring those would
  // report every one of them as an unresolvable row.
  //
  // Coverage goes FIRST in the list: "these rows were never examined" has to be read before any
  // conclusion drawn from the SHACL results underneath it.
  const coverage = checkHierarchyCoverage(options.rows);
  if (coverage.length === 0) return result;
  return {
    ...result,
    issues: result.issues && result.issues.length > 0 ? [...coverage, ...result.issues] : coverage,
  };
}
