import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyTemplateToRows,
  buildTree,
  buildBaseTemplatesFromRows,
  buildTemplatesZip,
  buildDeviceTemplatesFromCsv,
  buildResourceModelMap,
  BUILDINGOS_ROOM_MISSING,
  checkHierarchyCoverage,
  CsvInputLimitError,
  DEFAULT_CSV_INPUT_LIMITS,
  diffDeviceTemplate,
  exportCsv,
  exportDtdlInterfaces,
  exportDtdlTwinGraph,
  exportRdf,
  exportWotTd,
  exportWotThingModel,
  validateWotThings,
  exportYaml,
  getOutputPlugins,
  getLastHeader,
  getSchemaPropertyDescription,
  getHierarchyDropReasons,
  hasHierarchySignalChange,
  KIND_TO_CLASS,
  listUnrepresentedRows,
  MAX_ROW_ISSUES,
  resolveTreeMode,
  ROW_DROPPED,
  parseCsv,
  parseDeviceTemplateYaml,
  resetHeaderFromRows,
  resolveDeviceTemplateInheritance,
  resolveHierarchySignals,
  runOutputPlugin,
  validateRdfWithShacl,
  validateRowsWithShacl,
  serializeDeviceTemplate,
  validate,
} from '../src/index';
import schema from '../../../schema/building_model.schema.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../../fixtures');
const samplePath = path.resolve(__dirname, '../../../sample/debug-sample.csv');

function loadCsv(name: string) {
  return readFileSync(path.join(fixturesDir, name), 'utf-8');
}

function loadSampleCsv() {
  return readFileSync(samplePath, 'utf-8');
}

describe('buildTree', () => {
  it('creates hierarchy from pointlist rows', () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const tree = buildTree(rows);

    const site = tree.find((node) => node.name === 'site-1');
    expect(site?.kind).toBe('Site');

    const building = site?.children.find((node) => node.name === 'bldg-1');
    expect(building?.kind).toBe('Building');

    const level = building?.children.find((node) => node.name === 'floor-1');
    expect(level?.kind).toBe('Level');
  });
});

describe('buildTree (hierarchy csv)', () => {
  it('builds site-building-level-equipment-point structure', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const tree = buildTree(rows);

    const site = tree.find((node) => node.name === 'TokyoSite1');
    expect(site?.kind).toBe('Site');

    const building = site?.children.find((node) => node.name === 'MainBldg');
    expect(building?.kind).toBe('Building');

    const level = building?.children.find((node) => node.name === '3F');
    expect(level?.kind).toBe('Level');

    const room = level?.children.find((node) => node.name === 'Room101');
    expect(room?.kind).toBe('Room');

    const equipment = room?.children.find((node) => node.name === 'Temperature Sensor 01');
    expect(equipment?.kind).toBe('EquipmentExt');

    const point = equipment?.children.find((node) => node.id === 'PT001');
    expect(point?.kind).toBe('PointExt');
  });

  it('skips rows with missing hierarchy parents', () => {
    const rows = [
      {
        building: 'Building X',
        level: 'Level X',
        deviceName: 'Device X',
        pointName: 'Point X',
      },
    ];
    const tree = buildTree(rows);
    expect(tree).toHaveLength(0);
  });

  it('omits point node when point signals are missing', () => {
    const rows = [
      {
        site: 'Site X',
        building: 'Building X',
        level: 'Level X',
        deviceName: 'Device X',
      },
    ];
    const tree = buildTree(rows);
    const equipment = tree[0]?.children[0]?.children[0]?.children[0];
    expect(equipment?.kind).toBe('EquipmentExt');
    expect(equipment?.children).toHaveLength(0);
  });

  it('gives distinct, meaningful node ids to differently-named non-ASCII sites/buildings/rooms', () => {
    // makeSlug() used to strip all non-ASCII characters, so every
    // Japanese-only name collapsed to the empty string and fell back to
    // "unnamed" — colliding across genuinely different entities and
    // leaking into RDF/YAML subject ids with no semantic meaning.
    const rows = [
      {
        site: '本社キャンパス',
        building: '本館',
        level: '1F',
        installationArea: '会議室',
        deviceId: 'AC-1',
        deviceName: 'エアコン',
        pointId: 'PT-1',
        pointName: '室温',
      },
      {
        site: '大阪サイト',
        building: '別館',
        level: '2F',
        installationArea: 'オフィス',
        deviceId: 'AC-2',
        deviceName: 'エアコン2',
        pointId: 'PT-2',
        pointName: '室温2',
      },
    ];
    const tree = buildTree(rows);

    const site1 = tree.find((node) => node.name === '本社キャンパス');
    const site2 = tree.find((node) => node.name === '大阪サイト');
    expect(site1?.id).not.toBe('site:unnamed');
    expect(site2?.id).not.toBe('site:unnamed');
    expect(site1?.id).not.toBe(site2?.id);

    const building1 = site1?.children.find((node) => node.name === '本館');
    expect(building1?.id).not.toContain('unnamed');
  });
});

describe('validate', () => {
  it('returns no issues for valid rows', () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const { issues } = validate(rows);
    expect(issues).toHaveLength(0);
  });

  it('returns issues for invalid rows', () => {
    const rows = parseCsv(loadCsv('invalid.csv'), { schema });
    const { issues } = validate(rows);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.code === 'id_duplicate')).toBe(true);
  });

  it('returns hierarchy issues when parent signals are missing', () => {
    const rows = [
      {
        building: 'Building X',
        level: 'Level X',
        deviceName: 'Device X',
        pointName: 'Point X',
      },
    ];
    const { issues } = validate(rows);
    expect(issues.some((issue) => issue.code === 'hierarchy_missing')).toBe(true);
    expect(issues.some((issue) => issue.field === 'site')).toBe(true);
  });

  it('keeps the literal id/parentId graph authoritative when pointId/deviceId differ from id', () => {
    // Rows that carry both an explicit id/parentId hierarchy and separate
    // business identifiers (pointId/deviceId) must be linked and reported
    // using the literal id, since that is what the tree and UI navigation
    // key on. Preferring pointId/deviceId here previously produced false
    // "parent not found" errors and issue.rowId values the UI could not
    // navigate to.
    const rows = [
      { id: 'room-1', kind: 'space', name: 'Room 1', parentId: '', deviceId: '', pointId: '' },
      {
        id: 'dev-1',
        kind: 'device',
        name: 'Device 1',
        deviceId: 'DEV-BUSINESS-1',
        parentId: 'room-1',
        pointId: '',
      },
      {
        id: 'pt-1',
        kind: 'point',
        name: 'Point 1',
        pointId: 'PT-BUSINESS-1',
        parentId: 'dev-1',
        deviceId: '',
      },
    ];
    const { issues } = validate(rows);

    expect(issues.some((issue) => issue.code === 'parent_missing')).toBe(false);
    for (const issue of issues) {
      expect(issue.rowId).not.toBe('DEV-BUSINESS-1');
      expect(issue.rowId).not.toBe('PT-BUSINESS-1');
    }
  });

  it('accepts every kind alias that tree.ts/resource-graph.ts resolve to a class', () => {
    // KIND_TO_CLASS (constants.ts) accepts aliases like "room" and "level"
    // that the canonical schema/mapping.md names ("space", "floor") don't
    // cover. The kind validator must accept the same set, or rows the rest
    // of the app treats as valid get a false "invalid kind" error.
    const rows = Object.keys(KIND_TO_CLASS).map((kind, index) => ({
      id: `row-${index}`,
      kind,
      name: `Row ${index}`,
    }));
    const { issues } = validate(rows);
    expect(issues.some((issue) => issue.field === 'kind')).toBe(false);
  });

  it('still rejects a kind value with no known class mapping', () => {
    const rows = [{ id: 'row-1', kind: 'not-a-real-kind', name: 'Row 1' }];
    const { issues } = validate(rows);
    expect(issues.some((issue) => issue.field === 'kind')).toBe(true);
  });

  it('flags a row with no resolvable kind in an explicit id/parentId graph (#34)', () => {
    // An explicit id/kind/parentId graph CSV (e.g. re-imported from an external system) with a
    // blank kind for a spatial node. Unlike the Site/Building/Level/Room-column hierarchy-signal
    // format, there is no structural way to infer what a kind-less row in this mode should be:
    // resource-graph.ts's resolveClassName() silently falls back to generic sbco:Resource, and
    // every relation touching it silently degrades to rec:hasPart instead of hasPoint/locatedIn.
    const rows = [
      { id: 'bldg-1', name: 'Building One', kind: '', parentId: '' },
      { id: 'room-1', name: 'Room 101', kind: '', parentId: 'bldg-1' },
      { id: 'dev-1', name: 'Device One', kind: 'device', parentId: 'room-1' },
      { id: 'pt-1', name: 'Point One', kind: 'point', parentId: 'dev-1' },
    ];
    const { issues } = validate(rows);

    expect(
      issues.some((issue) => issue.code === 'kind_unresolved' && issue.rowId === 'bldg-1'),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.code === 'kind_unresolved' && issue.rowId === 'room-1'),
    ).toBe(true);
    // Device/Point rows infer cleanly from their own kind, or via inferRowKind's
    // deviceId/pointId-style signals — no false positive for them.
    expect(
      issues.some((issue) => issue.code === 'kind_unresolved' && issue.rowId === 'dev-1'),
    ).toBe(false);
    expect(issues.some((issue) => issue.code === 'kind_unresolved' && issue.rowId === 'pt-1')).toBe(
      false,
    );
  });

  it('does not flag kind-less rows in the hierarchy-signal (pointlist.md) format', () => {
    // The standard point-list CSV format never has a kind column at all -- Building/Level/Room
    // are synthesized from Site/Building/Floor columns (tree.ts's buildHierarchyTree). None of
    // these rows carry an explicit parentId, so explicitGraphMode must stay false here.
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const { issues } = validate(rows);
    expect(issues.some((issue) => issue.code === 'kind_unresolved')).toBe(false);
  });
});

describe('validation fixtures', () => {
  it('keeps edge-case valid input usable and preserves unknown columns', () => {
    const rows = parseCsv(loadCsv('validation-valid-edge.csv'), { schema });
    const { issues } = validate(rows);

    expect(rows).toHaveLength(4);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.commissioningNote).toBe('checked, calibrated');
    expect(rows[0]?.externalRef).toBe('EXT-001');
  });

  it('covers required pointlist field failures', () => {
    const rows = parseCsv(loadCsv('validation-required-missing.csv'), { schema });
    const { issues } = validate(rows);
    const fields = new Set(issues.map((issue) => issue.field));

    expect(issues.some((issue) => issue.code === 'schema')).toBe(true);
    expect(Array.from(fields)).toEqual(
      expect.arrayContaining([
        'gatewayId',
        'deviceId',
        'deviceName',
        'pointId',
        'pointName',
        'writable',
        'localId',
      ]),
    );
  });

  it('covers hierarchy parent signal failures', () => {
    const rows = parseCsv(loadCsv('validation-hierarchy-missing.csv'), { schema });
    const { issues } = validate(rows);
    const hierarchyFields = new Set(
      issues.filter((issue) => issue.code === 'hierarchy_missing').map((issue) => issue.field),
    );

    expect(Array.from(hierarchyFields)).toEqual(
      expect.arrayContaining(['site', 'building', 'level', 'device']),
    );
  });

  it('covers parent id reference, duplicate id, and cycle failures', () => {
    const rows = parseCsv(loadCsv('validation-parent-links.csv'), { schema });
    const { issues } = validate(rows);

    expect(issues.some((issue) => issue.code === 'parent_missing')).toBe(true);
    expect(issues.some((issue) => issue.code === 'id_duplicate')).toBe(true);
    expect(issues.some((issue) => issue.code === 'cycle')).toBe(true);
  });

  it('keeps semantic edge input available for future stricter validation rules', () => {
    const rows = parseCsv(loadCsv('validation-semantic-edge.csv'), { schema });
    const { issues } = validate(rows);

    expect(rows).toHaveLength(4);
    expect(rows[0]?.writable).toBe('maybe');
    expect(rows[1]?.interval).toBe('abc');
    expect(issues).toHaveLength(0);
  });
});

describe('exportCsv', () => {
  it('preserves unknown columns and header order from the last parse', () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const csv = exportCsv(rows);
    const [headerLine, firstRowLine] = csv.split(/\r?\n/);

    expect(headerLine).toBe(
      'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,target_area,panel,point_type,point_specification,point_id,point_name,writable,interval,unit,max_pres_value,min_pres_value,labels,scale,tags,supplier,owner,description,local_id,device_id_bacnet,instance_no_bacnet,object_type_bacnet,extra',
    );
    expect(firstRowLine).toContain(
      'GW001,DEV001,Temperature Sensor 01,Sensor,site-1,bldg-1,floor-1,Room 101',
    );
  });

  it('neutralizes spreadsheet formulas without changing safe cells', () => {
    const rows = parseCsv('id,name,extra\n1,=SUM(A1:A2),safe\n2,+1,@cmd\n3,-2,"\tformula"\n');
    const csv = exportCsv(rows);
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'@cmd");
    expect(csv).toContain("'\tformula");
    expect(csv).toContain('safe');
  });

  it('does not export a hardcoded/sample dataset using a previously parsed CSV header', () => {
    // Loading a real CSV populates the header state used by exportCsv().
    // Switching to a differently-shaped dataset that never goes through
    // parseCsv() (e.g. the web app's built-in sample data) must not keep
    // exporting the stale header, or every non-matching cell silently
    // exports empty.
    parseCsv(loadCsv('valid.csv'), { schema });
    const sampleRows = [{ id: 'site-1', kind: 'site', name: 'Sample Site', parentId: '' }];
    resetHeaderFromRows(sampleRows);
    const csv = exportCsv(sampleRows);
    const [headerLine, firstRowLine] = csv.split(/\r?\n/);

    expect(headerLine.split(',')).toEqual(expect.arrayContaining(['id', 'kind', 'name']));
    expect(headerLine).not.toContain('gateway_id');
    expect(firstRowLine).toContain('Sample Site');
  });

  it('excludes internal bookkeeping keys (e.g. __rowId) from the no-header fallback', () => {
    resetHeaderFromRows([]);
    const rows = [{ id: 'pt-1', name: 'Point 1', __rowId: 'pt-1__0' }];
    const csv = exportCsv(rows);
    const [headerLine] = csv.split(/\r?\n/);

    expect(headerLine.split(',')).not.toContain('__rowId');
  });
});

describe('CSV input limits', () => {
  it('accepts configured boundary values', () => {
    const rows = parseCsv('id,value\n1,abcd\n', {
      limits: { maxBytes: 16, maxRows: 1, maxColumns: 2, maxCellBytes: 4 },
    });
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['bytes', 'id\n12345\n', { maxBytes: 4 }],
    ['rows', 'id\n1\n2\n', { maxRows: 1 }],
    ['columns', 'a,b\n1,2\n', { maxColumns: 1 }],
    ['cellBytes', 'id\nああ\n', { maxCellBytes: 5 }],
  ] as const)('rejects %s overages with a typed error', (kind, text, limits) => {
    expect(() => parseCsv(text, { limits })).toThrowError(CsvInputLimitError);
    try {
      parseCsv(text, { limits });
    } catch (error) {
      expect(error).toMatchObject({ kind });
    }
  });

  it('does not replace header state when a parse fails atomically', () => {
    parseCsv('stable_header\nok\n');
    expect(() => parseCsv('other_header\na\nb\n', { limits: { maxRows: 1 } })).toThrowError(
      CsvInputLimitError,
    );
    expect(getLastHeader()).toEqual(['stable_header']);
    expect(DEFAULT_CSV_INPUT_LIMITS).toEqual({
      maxBytes: 5 * 1024 * 1024,
      maxRows: 20_000,
      maxColumns: 100,
      maxCellBytes: 32 * 1024,
    });
  });
});

describe('exportRdf', () => {
  it('maps the point-list building column to the SBCO building predicate (#30)', () => {
    const rows = parseCsv(
      [
        'site,building,floor,installation_area,device_id,device_name,point_id,point_name,extra',
        'Tokyo,THX,3F,Room 301,DEV-001,AHU-1,PT-001,Supply Air Temperature,kept-as-unknown',
      ].join('\n'),
    );

    const rdf = exportRdf(rows);

    expect(rdf).toContain('sbr:PT-001 a sbco:PointExt ;');
    expect(rdf).toContain('sbco:building "THX"');
    expect(rdf).not.toContain('<https://www.sbco.or.jp/ont/property/building>');
    expect(rdf).toContain('<https://www.sbco.or.jp/ont/property/extra> "kept-as-unknown"');
  });

  it('emits RDF with class and parent relationships', () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const rdf = exportRdf(rows, { schema });

    expect(rdf).toContain('@prefix sbco: <https://www.sbco.or.jp/ont/> .');
    expect(rdf).toContain('@prefix sbr: <https://www.sbco.or.jp/ont/resource/> .');
    // Subjects/objects use the sbr: prefix instead of the full bracketed IRI
    // whenever the percent-encoded local name is valid Turtle PN_LOCAL.
    expect(rdf).toContain('sbr:DEV001 a sbco:EquipmentExt ;');
    expect(rdf).toContain('sbr:PT001 a sbco:PointExt ;');
    expect(rdf).toContain('sbco:pointType "Temperature"');
    expect(rdf).toContain('rec:hasPoint sbr:PT001');
    expect(rdf).toContain('rec:locatedIn sbr:room%3A');
    expect(rdf).not.toContain('<https://www.sbco.or.jp/ont/resource/DEV001>');

    // SBCO-specific point/device fields (valid.csv carries all of these) emit clean sbco:
    // predicates instead of falling back to a full <.../property/...> IRI.
    expect(rdf).toContain('sbco:gatewayId "GW001"');
    expect(rdf).toContain('sbco:localId "LOCAL001"');
    expect(rdf).toContain('sbco:writable "false"^^xsd:boolean');
    expect(rdf).toContain('sbco:interval "60"^^xsd:integer');
    expect(rdf).toContain('sbco:deviceIdBacnet "BAC001"');
    expect(rdf).toContain('sbco:objectTypeBacnet "Analog-Input"');
    expect(rdf).toContain('sbco:instanceNoBacnet "1001"');
    const unknownPropertyBase = 'https://www.sbco.or.jp/ont/property/';
    for (const field of [
      'gatewayId',
      'localId',
      'writable',
      'interval',
      'deviceIdBacnet',
      'objectTypeBacnet',
      'instanceNoBacnet',
    ]) {
      expect(rdf).not.toContain(`${unknownPropertyBase}${field}`);
    }
  });

  it('serializes writable/interval/size as spec-valid xsd:boolean/xsd:integer literals (#27)', () => {
    // Raw point-list CSVs carry casing/tokens like "TRUE"/"FALSE" for booleans -- valid Turtle
    // syntax with a bare string literal, but not a valid xsd:boolean *value* (whose lexical
    // space is only true/false/1/0), so SHACL's sh:datatype check on the current datamodels
    // schema flagged every point as a violation until this normalized through isTruthyValue
    // instead of echoing the raw CSV token.
    const rows = [
      {
        id: 'PT-BOOL',
        kind: 'PointExt',
        name: 'Bool Point',
        writable: 'TRUE',
        interval: '300',
        size: '42',
      },
    ];
    const rdf = exportRdf(rows);
    expect(rdf).toContain('sbco:writable "true"^^xsd:boolean');
    expect(rdf).toContain('sbco:interval "300"^^xsd:integer');
    expect(rdf).toContain('rec:size "42"^^xsd:integer');
  });

  it('falls back to a full bracketed IRI when the local name is not valid Turtle PN_LOCAL', () => {
    const rows = [{ id: "weird'id.", name: 'Weird' }];
    const rdf = exportRdf(rows);
    expect(rdf).toContain(
      `<https://www.sbco.or.jp/ont/resource/${encodeURIComponent("weird'id.")}>`,
    );
    expect(rdf).not.toContain(`sbr:${encodeURIComponent("weird'id.")}`);
  });

  it('never emits sbr: prefixed names when prefixes are not declared', () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const rdf = exportRdf(rows, { schema, includePrefixes: false });
    expect(rdf).not.toContain('sbr:');
    expect(rdf).toContain('<https://www.sbco.or.jp/ont/resource/DEV001>');
  });

  it('percent-encodes unsafe and Unicode unknown headers in property IRIs', () => {
    const rows = parseCsv('id,name,悪意>ある 列\nA1,Example,value\n');
    const rdf = exportRdf(rows);
    expect(rdf).toContain(
      '<https://www.sbco.or.jp/ont/property/%E6%82%AA%E6%84%8F%3E%E3%81%82%E3%82%8B%20%E5%88%97>',
    );
    expect(rdf).not.toContain('悪意>ある 列');
  });

  it('keeps non-ASCII site/building names distinguishable in subject IRIs instead of "unnamed"', () => {
    const rows = [
      {
        site: '本社キャンパス',
        building: '本館',
        level: '1F',
        installationArea: '会議室',
        deviceId: 'AC-1',
        deviceName: 'エアコン',
        pointId: 'PT-1',
        pointName: '室温',
      },
      {
        site: '大阪サイト',
        building: '別館',
        level: '2F',
        installationArea: 'オフィス',
        deviceId: 'AC-2',
        deviceName: 'エアコン2',
        pointId: 'PT-2',
        pointName: '室温2',
      },
    ];
    const rdf = exportRdf(rows);

    expect(rdf).not.toContain('unnamed');
    expect(rdf).toContain(encodeURIComponent('site:本社キャンパス'));
    expect(rdf).toContain(encodeURIComponent('site:大阪サイト'));
  });
});

describe('exportYaml', () => {
  it('emits YAML resources aligned to the RDF mapping', () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const yaml = exportYaml(rows, { schema });

    expect(yaml).toContain('"resources":');
    expect(yaml).toContain('"id": "DEV001"');
    expect(yaml).toContain('"class": "sbco:EquipmentExt"');
    expect(yaml).toContain('"id": "PT001"');
    expect(yaml).toContain('"class": "sbco:PointExt"');
    expect(yaml).toContain('"hasPoint":');
    expect(yaml).toContain('"https://www.sbco.or.jp/ont/resource/PT001"');
    expect(yaml).toContain('"locatedIn": "https://www.sbco.or.jp/ont/resource/room%3A');
  });

  it('quotes keys and values containing YAML-significant characters', () => {
    const rows = parseCsv('id,name,bad:key,unicode\nA1,"line\n""quote""",value,日本語\n');
    const yaml = exportYaml(rows);
    expect(yaml).toContain('"bad:key": "value"');
    expect(yaml).toContain('"unicode": "日本語"');
    expect(yaml).toContain('"name":');
  });
});

describe('output plugins', () => {
  it('lists available output plugins', () => {
    const plugins = getOutputPlugins();
    expect(plugins.some((plugin) => plugin.format === 'RDF')).toBe(true);
    expect(plugins.some((plugin) => plugin.format === 'YAML')).toBe(true);
  });

  it('runs selected plugin with expected extension', async () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const result = await runOutputPlugin('RDF', 'Turtle', { rows, schema });
    expect(result.extension).toBe('ttl');
    expect(result.content).toContain('sbco:EquipmentExt');
  });

  it('maps the point-list building column to sbco:building through the RDF plugin (#30)', async () => {
    const rows = parseCsv(
      [
        'site,building,floor,installation_area,device_id,device_name,point_id,point_name',
        'Tokyo,THX,3F,Room 301,DEV-001,AHU-1,PT-001,Supply Air Temperature',
      ].join('\n'),
    );

    const result = await runOutputPlugin('RDF', 'Turtle', { rows });

    expect(result.content).toContain('sbr:PT-001 a sbco:PointExt ;');
    expect(result.content).toContain('sbco:building "THX"');
    expect(result.content).not.toContain('<https://www.sbco.or.jp/ont/property/building>');
  });

  it('preserves the synthesized parent link through the RDF output plugin (#25)', async () => {
    // valid.csv has no explicit parentId column — the Equipment->Point relationship is
    // synthesized by buildResourceGraph from the Site/Building/Floor columns. Going through
    // runOutputPlugin (buildOutputRows -> exportRdf), unlike calling exportRdf(rows) directly
    // on the freshly parsed rows, used to drop that computed parentId and silently orphan
    // every point (rec:hasPoint count of 0).
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const pointCount = rows.filter((row) => Boolean(row.pointType)).length;
    expect(pointCount).toBeGreaterThan(0);

    const result = await runOutputPlugin('RDF', 'Turtle', { rows, schema });
    const hasPointCount = (result.content.match(/rec:hasPoint/g) ?? []).length;
    expect(hasPointCount).toBe(pointCount);
    expect(result.content).toContain('rec:hasPoint sbr:PT001');
  });

  it('guarantees the Building OS hierarchy path A shape for a point-list CSV (#34)', async () => {
    // Building OS's REC-to-SBCO materializer requires exactly this spatial path:
    // rec:Building -rec:hasPart-> rec:Level -rec:hasPart-> rec:Room
    //   <-rec:locatedIn- sbco:EquipmentExt -rec:hasPoint-> sbco:PointExt
    // A point-list CSV (Site/Building/Floor/installation_area columns, no explicit kind or
    // parentId) is the documented, canonical input shape -- this locks in that it never
    // degrades to the generic sbco:Resource + rec:hasPart fallback (#34).
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const result = await runOutputPlugin('RDF', 'Turtle', { rows, schema });
    const content = result.content;

    expect(content).not.toContain('sbco:Resource');
    expect(content).toMatch(/a rec:Building/);
    expect(content).toMatch(/a rec:Level/);
    expect(content).toMatch(/a rec:Room/);
    expect(content).toMatch(/a sbco:EquipmentExt/);
    expect(content).toMatch(/a sbco:PointExt/);

    const hasPointCount = (content.match(/rec:hasPoint/g) ?? []).length;
    const pointCount = rows.filter((row) => Boolean(row.pointType)).length;
    expect(hasPointCount).toBe(pointCount);
    // Every Equipment->Point edge must be hasPoint, never the generic hasPart fallback --
    // count hasPart occurrences and confirm none of them sit on an EquipmentExt subject.
    const equipmentBlocks = content
      .split(/\n\n/)
      .filter((block) => block.includes('a sbco:EquipmentExt'));
    for (const block of equipmentBlocks) {
      expect(block).not.toContain('rec:hasPart');
      expect(block).toContain('rec:locatedIn');
    }
  });

  it('preserves a resource-graph-resolved kind through the output-row round trip (#34)', async () => {
    // An explicit id/kind/parentId graph CSV (not the hierarchy-signal format) where every row
    // *does* carry a resolvable kind. Before #34's fix, buildOutputRows() restored parentId onto
    // merged rows but not kind -- so exportRdf()'s own internal buildResourceGraph() call (a
    // second pass over buildOutputRows' output, now carrying parentId on every row) had to
    // re-derive each row's class via inferRowKind()'s point/device-only heuristic instead of
    // trusting what buildResourceGraph already resolved once. This fixture's Room row has none of
    // those signals, so it's a case that heuristic genuinely cannot rescue.
    const rows = [
      { id: 'bldg-1', name: 'Building One', kind: 'building', parentId: '' },
      { id: 'room-1', name: 'Room 101', kind: 'room', parentId: 'bldg-1' },
      { id: 'dev-1', name: 'Device One', kind: 'device', parentId: 'room-1' },
      { id: 'pt-1', name: 'Point One', kind: 'point', parentId: 'dev-1' },
    ];
    const result = await runOutputPlugin('RDF', 'Turtle', { rows });
    const content = result.content;

    expect(content).not.toContain('sbco:Resource');
    expect(content).toContain('sbr:room-1 a rec:Room');
    expect(content).toContain('rec:locatedIn sbr:room-1');
    expect(content).toContain('rec:hasPoint sbr:pt-1');
    expect(content).not.toMatch(/sbr:dev-1[^.]*rec:hasPart/s);
  });

  it('merges edited model rows into output and omits blank values', async () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const modelRows = Array.from(buildResourceModelMap(rows).values()).map((row) => {
      if (row.id === 'DEV001') {
        return {
          ...row,
          description: 'Edited description',
          customNote: '',
        };
      }
      return row;
    });

    const result = await runOutputPlugin('RDF', 'Turtle', { rows, modelRows, schema });
    expect(result.content).toContain('rec:description "Edited description"');
    expect(result.content).not.toContain('customNote');
  });

  it('returns detailed SHACL issues for missing required fields', async () => {
    const shapeText = `
      @prefix sh: <http://www.w3.org/ns/shacl#> .
      @prefix sbco: <https://www.sbco.or.jp/ont/> .
      @prefix rec: <https://w3id.org/rec/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      sbco:PointShape a sh:NodeShape ;
        sh:targetClass sbco:PointExt ;
        sh:property [ sh:path rec:name ; sh:minCount 1 ; sh:datatype xsd:string ] .
    `;
    const rows = [
      {
        id: 'P1',
        name: '',
        kind: 'PointExt',
      },
    ];
    const { issues } = await validateRowsWithShacl(rows, shapeText);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('name');
    expect(issues[0]?.focusNode).toContain('/P1');
    expect(issues[0]?.severity).toBe('violation');
    expect(issues[0]?.sourceConstraintComponent).toContain('MinCountConstraintComponent');
  });

  it('parses the repository SHACL graph and validates required fields', async () => {
    const shapeText = readFileSync(
      path.resolve(__dirname, '../../../schema/building_model.shacl.ttl'),
      'utf-8',
    );
    const rows = [
      {
        id: 'P1',
        pointType: 'Temperature',
        name: '',
        kind: 'PointExt',
      },
    ];
    const { issues } = await validateRowsWithShacl(rows, shapeText);
    expect(issues.some((issue) => issue.field === 'name')).toBe(true);
  });

  it('returns matching SHACL results for RDF and YAML plugins', async () => {
    const shapeText = readFileSync(
      path.resolve(__dirname, '../../../schema/building_model.shacl.ttl'),
      'utf-8',
    );
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const rdfResult = await runOutputPlugin('RDF', 'Turtle', {
      rows,
      schema,
      shacl: { shapeText },
    });
    const yamlResult = await runOutputPlugin('YAML', 'YAML', {
      rows,
      schema,
      shacl: { shapeText },
    });
    expect(yamlResult.issues).toEqual(rdfResult.issues);
    expect(rdfResult.issues).toEqual([]);
  });

  it('produces zero writable/interval SHACL datatype violations against the current schema (#27)', async () => {
    // End-to-end regression for #27: a real THX-scale point list (1,865 points) run through
    // parseCsv -> RDF output plugin -> the current datamodels SHACL produced 3,730 blocking
    // sh:datatype violations (writable + interval), because both serialized as plain string
    // literals instead of xsd:boolean/xsd:integer. This CSV isn't vendored here, so this
    // exercises the same pipeline against a smaller fixture with the same shapes of values
    // (an uppercase CSV boolean token, a numeric interval) that triggered it.
    const shapeText = readFileSync(
      path.resolve(__dirname, '../../../schema/building_model.shacl.ttl'),
      'utf-8',
    );
    const rows = parseCsv(
      [
        'gateway_id,device_id,device_name,point_type,point_id,point_name,writable,interval',
        'GW001,DEV001,Sensor 1,Temperature,PT001,Room Temperature,TRUE,300',
      ].join('\n'),
      { schema },
    );
    const result = await runOutputPlugin('RDF', 'Turtle', { rows, schema, shacl: { shapeText } });

    const datatypeIssues = (result.issues ?? []).filter((issue) =>
      issue.sourceConstraintComponent?.includes('DatatypeConstraintComponent'),
    );
    expect(datatypeIssues).toEqual([]);
  });

  it('supports SHACL Core datatype, pattern, cardinality and severity', async () => {
    const shape = `
      @prefix sh: <http://www.w3.org/ns/shacl#> .
      @prefix ex: <https://example.test/> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      ex:Shape a sh:NodeShape ; sh:targetClass ex:Thing ;
        sh:property [ sh:path ex:value ; sh:datatype xsd:integer ; sh:pattern "^[0-9]+$" ; sh:maxCount 1 ; sh:severity sh:Warning ] .
    `;
    const data = `
      @prefix ex: <https://example.test/> .
      ex:item a ex:Thing ; ex:value "bad", "also-bad" .
    `;
    const result = await validateRdfWithShacl(data, shape);
    expect(result.conforms).toBe(false);
    expect(result.issues.some((issue) => issue.severity === 'warning')).toBe(true);
    expect(result.issues.some((issue) => issue.field === 'value')).toBe(true);
  });
});

describe('schema mapping', () => {
  it('maps pointlist fields into schema props and custom tags/properties', () => {
    const rows = parseCsv(loadCsv('valid.csv'), { schema });
    const point = rows.find((row) => row.id === 'PT001');
    expect(point).toBeDefined();

    expect(point?.pointType).toBe('Temperature');
    expect(point?.pointSpecification).toBe('Measurement');
    expect(point?.unit).toBe('celsius');
    expect(point?.maxPresValue).toBe('50');
    expect(point?.minPresValue).toBe('-10');
    expect(point?.scale).toBe('1.0');

    const tags = point?.customTags ? JSON.parse(point.customTags) : [];
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: 'temperature', flag: true },
        { key: 'room101', flag: true },
      ]),
    );

    // gatewayId/localId/writable/interval/deviceIdBacnet/objectTypeBacnet/instanceNoBacnet are
    // formal PointExt schema properties (datamodels #34/#36, synced into schema/*.json here for
    // #27) -- buildSchemaCache (schema-mapping.ts) derives "known property" straight from the
    // schema JSON's $defs.PointExt.properties, so these map to direct row fields rather than
    // customProperties. They used to land in customProperties only because the vendored schema
    // copy predated #34.
    expect(point?.gatewayId).toBe('GW001');
    expect(point?.localId).toBe('LOCAL001');
    expect(point?.writable).toBe('false');
    expect(point?.interval).toBe('60');
    expect(point?.deviceIdBacnet).toBe('BAC001');
    expect(point?.objectTypeBacnet).toBe('Analog-Input');
    expect(point?.instanceNoBacnet).toBe('1001');
    expect(point?.deviceId).toBe('DEV001');
    expect(point?.deviceName).toBe('Temperature Sensor 01');

    // deviceType/description are EquipmentExt-level in the schema, not PointExt -- for a Point
    // row they still fall outside the known-property set and bucket under customProperties.
    const custom = point?.customProperties ? JSON.parse(point.customProperties) : {};
    expect(custom.deviceType).toBe('Sensor');
    expect(custom.description).toBe('Room 101 temperature sensor');
    expect(custom.extra).toBe('alpha');
    expect(custom.gatewayId).toBeUndefined();
    expect(custom.writable).toBeUndefined();
    expect(custom.interval).toBeUndefined();
    expect(custom.deviceId).toBeUndefined();
    expect(custom.deviceName).toBeUndefined();
    expect(custom.tags).toBeUndefined();
  });
});

describe('schema mapping (pointlist)', () => {
  it('maps pointlist fields into schema props and custom tags/properties', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const point = rows.find((row) => row.id === 'PT001');
    expect(point).toBeDefined();

    expect(point?.pointType).toBe('Temperature');
    expect(point?.pointSpecification).toBe('Measurement');
    expect(point?.unit).toBe('℃');
    expect(point?.maxPresValue).toBe('50');
    expect(point?.minPresValue).toBe('-10');
    expect(point?.scale).toBe('1.0');

    const tags = point?.customTags ? JSON.parse(point.customTags) : [];
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: 'temperature', flag: true },
        { key: 'room101', flag: true },
      ]),
    );

    // See the "schema mapping" block above for why these are now direct fields, not
    // customProperties, since the #27 schema sync.
    expect(point?.gatewayId).toBe('GW001');
    expect(point?.localId).toBe('LOCAL001');
    expect(point?.writable).toBe('false');
    expect(point?.interval).toBe('60');
    expect(point?.deviceIdBacnet).toBe('BAC001');
    expect(point?.objectTypeBacnet).toBe('Analog-Input');
    expect(point?.instanceNoBacnet).toBe('1001');
    expect(point?.deviceId).toBe('DEV001');
    expect(point?.deviceName).toBe('Temperature Sensor 01');

    const custom = point?.customProperties ? JSON.parse(point.customProperties) : {};
    expect(custom.deviceType).toBe('Sensor');
    expect(custom.description).toBe('Room 101 temperature sensor');
    expect(custom.gatewayId).toBeUndefined();
    expect(custom.writable).toBeUndefined();
    expect(custom.interval).toBeUndefined();
  });
});

describe('hierarchy signal utilities', () => {
  it('detects hierarchy signal changes for monitored columns', () => {
    const before = {
      site: 'Site A',
      building: 'Building A',
      level: 'Level 1',
      deviceName: 'Device A',
      pointName: 'Point A',
      note: 'unchanged',
    };
    const after = {
      ...before,
      building: 'Building B',
    };
    const ignoreChange = {
      ...before,
      note: 'updated',
    };

    expect(hasHierarchySignalChange(before, after)).toBe(true);
    expect(hasHierarchySignalChange(before, ignoreChange)).toBe(false);
  });

  it('normalizes hierarchy signals consistently', () => {
    const signals = resolveHierarchySignals({
      siteName: 'Site A',
      buildingId: 'Building A',
      floorName: 'Level 1',
      zone: 'Zone A',
      deviceId: 'Device A',
      pointId: 'Point A',
    });
    expect(signals.site).toBe('Site A');
    expect(signals.building).toBe('Building A');
    expect(signals.level).toBe('Level 1');
    expect(signals.room).toBe('Zone A');
    expect(signals.roomKind).toBe('Zone');
  });
});

describe('schema descriptions', () => {
  it('returns property descriptions from schema definitions', () => {
    const description = getSchemaPropertyDescription(schema, 'site', 'name');
    expect(description).toBeTruthy();
  });
});

describe('resource model map', () => {
  it('provides space and equipment resources for editing', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const map = buildResourceModelMap(rows);
    const values = Array.from(map.values());

    const site = values.find((row) => row.kind === 'Site' && row.name === 'TokyoSite1');
    expect(site).toBeDefined();

    const equipment = values.find(
      (row) => row.kind === 'EquipmentExt' && row.name === 'Temperature Sensor 01',
    );
    expect(equipment).toBeDefined();

    const point = values.find((row) => row.kind === 'PointExt' && row.id === 'PT001');
    expect(point).toBeDefined();
  });
});

describe('large fixture', () => {
  it('parses and validates a large csv without errors', () => {
    const rows = parseCsv(loadCsv('large.csv'), { schema });
    expect(rows).toHaveLength(1000);

    const tree = buildTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe('LargeSite');
    const building = tree[0]?.children[0];
    const level = building?.children[0];
    const room = level?.children[0];
    const equipment = room?.children[0];
    expect(equipment?.id).toBe('DEV-L');
    expect(equipment?.children).toHaveLength(1000);

    const { issues } = validate(rows);
    expect(issues).toHaveLength(0);
  });
});

describe('device templates', () => {
  it('builds device templates from csv with point types', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const templates = buildDeviceTemplatesFromCsv(rows);
    const sensor = templates.find((template) => template.deviceType === 'Sensor');
    expect(sensor).toBeDefined();
    expect(sensor?.properties.some((prop) => prop.pointType === 'Temperature')).toBe(true);
  });

  it('detects template diffs between csv and yaml', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const templates = buildDeviceTemplatesFromCsv(rows);
    const sensor = templates.find((template) => template.deviceType === 'Sensor');
    expect(sensor).toBeDefined();
    if (!sensor) return;

    const altered = {
      ...sensor,
      properties: sensor.properties.map((prop) =>
        prop.name === sensor.properties[0]?.name ? { ...prop, access: 'readWrite' as const } : prop,
      ),
    };

    const diff = diffDeviceTemplate(sensor, altered);
    expect(diff.mismatched.length).toBeGreaterThan(0);
  });

  it('serializes and parses device template yaml', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const templates = buildDeviceTemplatesFromCsv(rows);
    const template = templates[0];
    expect(template).toBeDefined();
    if (!template) return;

    const yamlText = serializeDeviceTemplate(template);
    const parsed = parseDeviceTemplateYaml(yamlText, {
      namespace: template.namespace,
      deviceType: template.deviceType,
    });
    expect(parsed.className).toBe(template.className);
    expect(parsed.properties.length).toBeGreaterThan(0);
  });

  it('builds base templates per namespace', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const bases = buildBaseTemplatesFromRows(rows);
    expect(bases.length).toBeGreaterThan(0);
    const base = bases[0];
    expect(base?.deviceType).toBe('Base');
  });

  it('resolves template inheritance and merges properties', () => {
    const base = {
      namespace: 'default',
      deviceType: 'Base',
      className: 'Base',
      description: 'Base template',
      properties: [
        {
          name: 'version',
          access: 'read' as const,
          pointType: 'version',
        },
      ],
    };
    const child = {
      namespace: 'default',
      deviceType: 'Sensor',
      className: 'Sensor',
      extends: 'Base',
      properties: [
        {
          name: 'temperature',
          access: 'read' as const,
          pointType: 'Temperature',
        },
      ],
    };
    const resolved = resolveDeviceTemplateInheritance([base, child], child);
    expect(resolved.properties.some((prop) => prop.name === 'version')).toBe(true);
    expect(resolved.properties.some((prop) => prop.name === 'temperature')).toBe(true);
  });

  it('detects circular template inheritance', () => {
    const first = {
      namespace: 'default',
      deviceType: 'A',
      className: 'A',
      extends: 'B',
      properties: [],
    };
    const second = {
      namespace: 'default',
      deviceType: 'B',
      className: 'B',
      extends: 'A',
      properties: [],
    };
    expect(() => resolveDeviceTemplateInheritance([first, second], first)).toThrow(/継承ループ/);
  });

  it('applies template point types back to rows', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const templates = buildDeviceTemplatesFromCsv(rows);
    const template = templates[0];
    expect(template).toBeDefined();
    if (!template) return;

    const updated = applyTemplateToRows(rows, template);
    expect(updated.some((row) => row.pointType)).toBe(true);
  });

  it('builds a zip output for templates', async () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const templates = buildDeviceTemplatesFromCsv(rows);
    const zipBytes = await buildTemplatesZip(templates.slice(0, 1));
    expect(zipBytes.byteLength).toBeGreaterThan(0);
  });
});

describe('exportDtdlInterfaces', () => {
  it('generates an Interface for each class present in rows', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const json = exportDtdlInterfaces(rows);
    const interfaces = JSON.parse(json) as {
      '@type': string;
      '@id': string;
      displayName: string;
    }[];

    expect(Array.isArray(interfaces)).toBe(true);
    expect(interfaces.length).toBeGreaterThan(0);
    const classNames = interfaces.map((i) => i.displayName);
    expect(classNames).toContain('Building');
    expect(classNames).toContain('EquipmentExt');
    expect(classNames).toContain('PointExt');
  });

  it('each Interface has required DTDL fields', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const interfaces = JSON.parse(exportDtdlInterfaces(rows)) as Record<string, unknown>[];

    for (const iface of interfaces) {
      expect(iface['@context']).toBe('dtmi:dtdl:context;3');
      expect(typeof iface['@id']).toBe('string');
      expect((iface['@id'] as string).startsWith('dtmi:sbco:')).toBe(true);
      expect(iface['@type']).toBe('Interface');
      expect(typeof iface['displayName']).toBe('string');
      expect(Array.isArray(iface['contents'])).toBe(true);
    }
  });

  it('Building Interface includes hasPart Relationship', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const interfaces = JSON.parse(exportDtdlInterfaces(rows)) as {
      displayName: string;
      contents: { '@type': string; name: string }[];
    }[];
    const building = interfaces.find((i) => i.displayName === 'Building');
    expect(building).toBeDefined();
    const hasPart = building?.contents.find(
      (c) => c['@type'] === 'Relationship' && c.name === 'hasPart',
    );
    expect(hasPart).toBeDefined();
  });

  it('EquipmentExt Interface includes locatedIn Relationship', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const interfaces = JSON.parse(exportDtdlInterfaces(rows)) as {
      displayName: string;
      contents: { '@type': string; name: string }[];
    }[];
    const equipment = interfaces.find((i) => i.displayName === 'EquipmentExt');
    expect(equipment).toBeDefined();
    const locatedIn = equipment?.contents.find(
      (c) => c['@type'] === 'Relationship' && c.name === 'locatedIn',
    );
    expect(locatedIn).toBeDefined();
  });
});

describe('exportDtdlTwinGraph', () => {
  it('produces digitalTwins with correct structure', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const graph = JSON.parse(exportDtdlTwinGraph(rows)) as {
      digitalTwinsFileInfo: { fileVersion: string };
      digitalTwinsGraph: {
        digitalTwins: { $dtId: string; $metadata: { $model: string }; name?: string }[];
        relationships: { $relationshipId: string; $relationshipName: string }[];
      };
    };

    expect(graph.digitalTwinsFileInfo.fileVersion).toBe('1.0.0');
    expect(Array.isArray(graph.digitalTwinsGraph.digitalTwins)).toBe(true);
    expect(graph.digitalTwinsGraph.digitalTwins.length).toBeGreaterThan(0);
  });

  it('each twin has $dtId and $metadata.$model', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const { digitalTwinsGraph } = JSON.parse(exportDtdlTwinGraph(rows)) as {
      digitalTwinsGraph: { digitalTwins: { $dtId: string; $metadata: { $model: string } }[] };
    };

    for (const twin of digitalTwinsGraph.digitalTwins) {
      expect(typeof twin.$dtId).toBe('string');
      expect(twin.$dtId.length).toBeGreaterThan(0);
      expect(twin.$metadata.$model.startsWith('dtmi:sbco:')).toBe(true);
    }
  });

  it('relationships include hasPart and locatedIn entries', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const { digitalTwinsGraph } = JSON.parse(exportDtdlTwinGraph(rows)) as {
      digitalTwinsGraph: { relationships: { $relationshipName: string }[] };
    };

    const names = new Set(digitalTwinsGraph.relationships.map((r) => r.$relationshipName));
    expect(names.has('hasPart')).toBe(true);
    expect(names.has('locatedIn')).toBe(true);
  });
});

describe('runOutputPlugin DTDL', () => {
  it('rejects unknown plugins without fabricating output', async () => {
    await expect(runOutputPlugin('unknown', 'unknown', { rows: [] })).rejects.toThrow(
      'Output plugin not found',
    );
  });

  it('runs DTDL/Interfaces plugin and returns JSON', async () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const result = await runOutputPlugin('DTDL', 'Interfaces', { rows });

    expect(result.extension).toBe('dtdl.json');
    expect(result.mimeType).toContain('application/json');
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('runs DTDL/Twin Graph plugin and returns JSON', async () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const result = await runOutputPlugin('DTDL', 'Twin Graph', { rows });

    expect(result.extension).toBe('json');
    expect(result.mimeType).toContain('application/json');
    const parsed = JSON.parse(result.content) as { digitalTwinsGraph: unknown };
    expect(parsed.digitalTwinsGraph).toBeDefined();
  });

  it('DTDL plugin appears in getOutputPlugins()', () => {
    const plugins = getOutputPlugins();
    const formats = new Set(plugins.map((p) => p.format));
    expect(formats.has('DTDL')).toBe(true);
    const ids = plugins.map((p) => p.id);
    expect(ids).toContain('dtdl-interfaces');
    expect(ids).toContain('dtdl-twin-graph');
  });
});

type WotProperty = {
  '@type': string;
  title: string;
  type: string;
  readOnly: boolean;
  observable: boolean;
  unit?: string;
  minimum?: number;
  maximum?: number;
  forms?: { href: string; op: string[]; contentType: string }[];
};

type WotThingShape = {
  '@context': unknown[];
  '@type': string | string[];
  id: string;
  title: string;
  base: string;
  properties?: Record<string, WotProperty>;
  links?: { rel: string; href: string; type?: string }[];
  securityDefinitions?: Record<string, { scheme: string }>;
  security?: string;
};

describe('exportWotThingModel', () => {
  it('emits a Thing Model for every non-point resource', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const things = JSON.parse(exportWotThingModel(rows)) as WotThingShape[];

    expect(Array.isArray(things)).toBe(true);
    expect(things.length).toBeGreaterThan(0);

    for (const t of things) {
      expect(Array.isArray(t['@type'])).toBe(true);
      expect((t['@type'] as string[])[0]).toBe('tm:ThingModel');
      expect(t.id.startsWith('urn:sbco:')).toBe(true);
      expect(t.securityDefinitions).toBeUndefined();
    }
  });

  it('renders child points as PropertyAffordances on the parent Equipment', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const things = JSON.parse(exportWotThingModel(rows)) as WotThingShape[];

    const equipmentThings = things.filter((t) =>
      (t['@type'] as string[]).some((tt) => tt.endsWith(':EquipmentExt')),
    );
    const withProps = equipmentThings.find(
      (t) => t.properties && Object.keys(t.properties).length > 0,
    );
    expect(withProps).toBeDefined();

    const props = withProps!.properties!;
    const firstKey = Object.keys(props)[0];
    const prop = props[firstKey];
    expect(prop['@type'].endsWith(':PointExt')).toBe(true);
    expect(typeof prop.readOnly).toBe('boolean');
    expect(prop.observable).toBe(true);
    expect(prop.forms).toBeUndefined();
  });

  it('uses tm:submodel link relations to traverse the spatial hierarchy', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const things = JSON.parse(exportWotThingModel(rows)) as WotThingShape[];

    const withSubmodel = things.find((t) => (t.links ?? []).some((l) => l.rel === 'tm:submodel'));
    expect(withSubmodel).toBeDefined();
    const submodelLink = withSubmodel!.links!.find((l) => l.rel === 'tm:submodel')!;
    expect(submodelLink.type).toBe('application/tm+json');
    expect(submodelLink.href.startsWith('urn:sbco:')).toBe(true);
  });
});

describe('exportWotTd', () => {
  it('emits TDs with nosec security and form placeholders on every property', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const things = JSON.parse(exportWotTd(rows)) as WotThingShape[];

    expect(things.length).toBeGreaterThan(0);

    for (const t of things) {
      expect(t.securityDefinitions?.nosec_sc.scheme).toBe('nosec');
      expect(t.security).toBe('nosec_sc');
    }

    const withProps = things.find((t) => t.properties && Object.keys(t.properties).length > 0);
    expect(withProps).toBeDefined();
    const props = withProps!.properties!;
    for (const key of Object.keys(props)) {
      const forms = props[key].forms;
      expect(Array.isArray(forms)).toBe(true);
      expect(forms!.length).toBeGreaterThan(0);
      expect(forms![0].href).toContain('{{HREF_BASE}}');
      expect(forms![0].op).toContain('readproperty');
    }
  });

  it('uses item link relations for spatial hierarchy in TDs', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const things = JSON.parse(exportWotTd(rows)) as WotThingShape[];

    const rels = new Set(things.flatMap((t) => (t.links ?? []).map((l) => l.rel)));
    expect(rels.has('item')).toBe(true);
    expect(rels.has('tm:submodel')).toBe(false);
  });
});

describe('runOutputPlugin WoT', () => {
  it('runs WoT/Thing Description plugin and returns valid JSON', async () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const result = await runOutputPlugin('WoT', 'Thing Description', { rows });

    expect(result.extension).toBe('td.json');
    expect(result.mimeType).toContain('application/td+json');
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('runs WoT/Thing Model plugin and returns valid JSON', async () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const result = await runOutputPlugin('WoT', 'Thing Model', { rows });

    expect(result.extension).toBe('tm.json');
    expect(result.mimeType).toContain('application/tm+json');
    const parsed = JSON.parse(result.content) as WotThingShape[];
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed[0]['@type'] as string[])[0]).toBe('tm:ThingModel');
  });

  it('WoT plugins appear in getOutputPlugins()', () => {
    const ids = getOutputPlugins().map((p) => p.id);
    expect(ids).toContain('wot-td');
    expect(ids).toContain('wot-tm');
  });
});

describe('validateWotThings', () => {
  it('returns no issues for generated TDs from the sample dataset', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const things = JSON.parse(exportWotTd(rows)) as unknown[];
    const issues = validateWotThings(things, 'td');
    expect(issues).toEqual([]);
  });

  it('returns no issues for generated TMs from the sample dataset', () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const things = JSON.parse(exportWotThingModel(rows)) as unknown[];
    const issues = validateWotThings(things, 'tm');
    expect(issues).toEqual([]);
  });

  it('flags TDs missing required security fields', () => {
    const broken = [
      {
        '@context': 'https://www.w3.org/2022/wot/td/v1.1',
        title: 'broken',
        id: 'urn:test:broken',
      },
    ];
    const issues = validateWotThings(broken, 'td');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.code === 'wot-td')).toBe(true);
    expect(issues.some((i) => i.rowId === 'urn:test:broken')).toBe(true);
  });

  it('runOutputPlugin surfaces validation issues alongside content', async () => {
    const rows = parseCsv(loadSampleCsv(), { schema });
    const result = await runOutputPlugin('WoT', 'Thing Description', { rows });
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('hierarchy coverage (#B-01)', () => {
  const HEADER =
    'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,point_type,point_specification,point_id,point_name,writable,local_id';
  const OK =
    'GW1,DEV1,Sensor 1,Sensor,S1,B1,1F,Room101,Temperature,Measurement,PT001,Temp,false,L1';
  const NO_ROOM = 'GW1,DEV2,Sensor 2,Sensor,S1,B1,1F,-,Temperature,Measurement,PT002,Temp,false,L2';
  const NO_FLOOR =
    'GW1,DEV3,Sensor 3,Sensor,S1,B1,-,Room103,Temperature,Measurement,PT003,Temp,false,L3';
  const NO_DEVICE = 'GW1,,,Sensor,S1,B1,1F,Room104,Temperature,Measurement,PT004,Temp,false,L4';

  const mixedCsv = [HEADER, OK, NO_ROOM, NO_FLOOR, NO_DEVICE].join('\n') + '\n';

  it('reports the same rows buildTree drops, for the same reasons', () => {
    // floor="-" is normalized to "unset" by normalizeHierarchyValue, so it reads as a
    // missing level -- the middle link of the chain, which takes Room/Equipment/Point
    // with it.
    expect(getHierarchyDropReasons({ site: 'S', building: 'B', floor: '-' })).toEqual(['level']);
    expect(getHierarchyDropReasons({ site: 'S', building: 'B', floor: '－' })).toEqual(['level']);
    expect(getHierarchyDropReasons({ site: 'S', building: 'B', floor: '' })).toEqual(['level']);
    expect(
      getHierarchyDropReasons({ site: 'S', building: 'B', floor: '1F', pointId: 'PT1' }),
    ).toEqual(['device']);
    expect(
      getHierarchyDropReasons({
        site: 'S',
        building: 'B',
        floor: '1F',
        pointId: 'PT1',
        deviceId: 'D1',
      }),
    ).toEqual([]);

    // The predicate has to agree with what buildTree() actually does, not merely look
    // plausible: every row it calls dropped must be absent from the tree, and every row
    // it clears must be present.
    const rows = parseCsv(mixedCsv, { schema });
    const dropped = new Set(listUnrepresentedRows(rows).map((row) => row.rowId));
    expect(dropped).toEqual(new Set(['PT003', 'PT004']));

    const inTree = new Set<string>();
    const visit = (nodes: ReturnType<typeof buildTree>) => {
      for (const node of nodes) {
        inTree.add(node.id);
        visit(node.children);
      }
    };
    visit(buildTree(rows));
    for (const id of ['PT001', 'PT002']) expect(inTree.has(id)).toBe(true);
    for (const id of dropped) expect(inTree.has(id as string)).toBe(false);
  });

  it('summarizes dropped rows with exact totals and a per-reason breakdown', () => {
    const rows = parseCsv(mixedCsv, { schema });
    const issues = checkHierarchyCoverage(rows);
    const summary = issues.find((issue) => issue.code === ROW_DROPPED && !issue.rowId);

    expect(summary?.severity).toBe('violation');
    expect(summary?.message).toContain('入力 4 行のうち 2 行');
    expect(summary?.message).toContain('出力に含まれるのは 2 行です');
    expect(summary?.message).toContain('floor/level 未設定 1件');
    expect(summary?.message).toContain('device_id/device_name 未設定 1件');
    // Nothing was withheld at this size, so no truncation notice.
    expect(summary?.message).not.toContain('省略');

    const perRow = issues.filter((issue) => issue.code === ROW_DROPPED && issue.rowId);
    expect(perRow.map((issue) => issue.rowId).sort()).toEqual(['PT003', 'PT004']);
  });

  it('caps per-row issues but keeps the true totals in the summary', () => {
    const overCap = MAX_ROW_ISSUES + 25;
    const rows = parseCsv(
      [
        HEADER,
        OK,
        ...Array.from(
          { length: overCap },
          (_, i) =>
            `GW1,DEV${i},Sensor ${i},Sensor,S1,B1,-,Room1,Temperature,Measurement,PT9${i},Temp,false,L9${i}`,
        ),
      ].join('\n') + '\n',
      { schema },
    );

    const issues = checkHierarchyCoverage(rows);
    const summary = issues.find((issue) => issue.code === ROW_DROPPED && !issue.rowId);
    expect(summary?.message).toContain(`${overCap} 行は`);
    expect(summary?.message).toContain('残り 25 件は省略');
    expect(issues.filter((issue) => issue.code === ROW_DROPPED && issue.rowId)).toHaveLength(
      MAX_ROW_ISSUES,
    );
  });

  it('flags the Building-OS-incompatible Level-direct shape as a warning, not a violation', () => {
    const rows = parseCsv(mixedCsv, { schema });
    const roomIssues = checkHierarchyCoverage(rows).filter(
      (issue) => issue.code === BUILDINGOS_ROOM_MISSING,
    );

    expect(roomIssues.every((issue) => issue.severity === 'warning')).toBe(true);
    // PT002 keeps its Equipment/Point -- it is emitted, just without a Room in between --
    // so it must not also be reported as dropped.
    expect(roomIssues.some((issue) => issue.rowId === 'PT002')).toBe(true);
    expect(roomIssues.some((issue) => issue.rowId === 'PT003')).toBe(false);
  });

  it('reports rows with no resolvable id in explicit id/parentId graph mode', () => {
    const rows = parseCsv(
      ['id,name,kind,parent_id', 'site-1,Site,site,', ',Orphan,room,site-1'].join('\n') + '\n',
    );
    expect(resolveTreeMode(rows)).toBe('explicit-graph');
    expect(listUnrepresentedRows(rows).map((row) => row.reasons)).toEqual([['id']]);
  });

  it('reports nothing for the shipped fixtures, which resolve every row', () => {
    for (const csv of [loadCsv('valid.csv'), loadCsv('large.csv'), loadSampleCsv()]) {
      expect(checkHierarchyCoverage(parseCsv(csv, { schema }))).toEqual([]);
    }
  });
});

describe('output plugins fail closed on dropped rows (#B-01)', () => {
  const csv =
    [
      'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,point_type,point_specification,point_id,point_name,writable,local_id',
      'GW1,DEV1,Sensor 1,Sensor,S1,B1,1F,Room101,Temperature,Measurement,PT001,Temp,false,L1',
      'GW1,DEV3,Sensor 3,Sensor,S1,B1,-,Room103,Temperature,Measurement,PT003,Temp,false,L3',
    ].join('\n') + '\n';

  const shapeText = readFileSync(
    path.resolve(__dirname, '../../../schema/building_model.shacl.ttl'),
    'utf-8',
  );

  it.each([
    ['JSON', 'Tree'],
    ['RDF', 'Turtle'],
    ['YAML', 'YAML'],
    ['DTDL', 'Interfaces'],
    ['DTDL', 'Twin Graph'],
    ['WoT', 'Thing Description'],
    ['WoT', 'Thing Model'],
  ])('blocks %s/%s output because the graph cannot carry every row', async (format, serializer) => {
    const rows = parseCsv(csv, { schema });
    const result = await runOutputPlugin(format, serializer, {
      rows,
      schema,
      shacl: format === 'RDF' || format === 'YAML' ? { shapeText } : undefined,
    });

    const dropped = (result.issues ?? []).filter((issue) => issue.code === ROW_DROPPED);
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((issue) => issue.severity === 'violation')).toBe(true);
    // Coverage comes first: "this row was never examined" has to be read before any
    // conclusion drawn from the SHACL results underneath it.
    expect(result.issues?.[0]?.code).toBe(ROW_DROPPED);
  });

  it.each([
    ['CSV', 'CSV'],
    ['JSON-LD', 'JSON-LD'],
  ])('does not block %s output, which serializes the rows directly', async (format, serializer) => {
    const rows = parseCsv(csv, { schema });
    const result = await runOutputPlugin(format, serializer, { rows, schema });
    expect(result.issues ?? []).toEqual([]);
    expect(result.content).toContain('PT003');
  });

  it('measures the input rows, not the merged resource model (web output path)', async () => {
    // apps/web calls runOutputPlugin with modelRows, and mergeOutputRows() folds the resource
    // model into the row set -- adding synthesized Site/Building/Level/Room rows that were
    // never input rows and carry none of the hierarchy columns. Reconciling against that merged
    // set reported every synthesized row as unresolvable, so the count was wrong in both
    // directions at once: inflated here, and silent about it in the CLI, which passes no
    // modelRows at all.
    const rows = parseCsv(csv, { schema });
    const modelRows = Array.from(buildResourceModelMap(rows).values());
    const result = await runOutputPlugin('RDF', 'Turtle', { rows, modelRows, schema });

    const dropped = result.issues?.filter((issue) => issue.code === ROW_DROPPED) ?? [];
    expect(dropped.filter((issue) => issue.rowId).map((issue) => issue.rowId)).toEqual(['PT003']);
    expect(dropped.find((issue) => !issue.rowId)?.message).toContain('入力 2 行のうち 1 行');
  });

  it('emits exactly as many PointExt nodes as the reconciliation promises', async () => {
    const rows = parseCsv(csv, { schema });
    const result = await runOutputPlugin('RDF', 'Turtle', { rows, schema });
    const represented = rows.length - listUnrepresentedRows(rows).length;
    expect(result.content.match(/sbco:PointExt/g) ?? []).toHaveLength(represented);
  });
});
