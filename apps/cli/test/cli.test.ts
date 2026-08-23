import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { getOutputPlugins } from '@repo/core';
import { runCli, Writer } from '../src/index';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const VALID_CSV = resolve(REPO_ROOT, 'packages/fixtures/valid.csv');
const INVALID_CSV = resolve(REPO_ROOT, 'packages/fixtures/invalid.csv');

function makeIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (chunk: string) => stdout.push(chunk) } satisfies Writer,
      stderr: { write: (chunk: string) => stderr.push(chunk) } satisfies Writer,
    },
    stdout,
    stderr,
  };
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runCli', () => {
  it.each(['CSV', 'JSON-LD', 'YAML'])(
    'produces non-empty output for --format %s',
    async (format) => {
      const { io, stdout } = makeIo();
      const code = await runCli(['--input', VALID_CSV, '--format', format], io);
      expect(code).toBe(0);
      expect(stdout.join('')).not.toHaveLength(0);
    },
  );

  it('produces Turtle output for --format RDF --serializer Turtle', async () => {
    const { io, stdout } = makeIo();
    const code = await runCli(
      ['--input', VALID_CSV, '--format', 'RDF', '--serializer', 'Turtle'],
      io,
    );
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('@prefix');
  });

  it('errors when a format has multiple serializers and none is given', async () => {
    const { io, stderr } = makeIo();
    const code = await runCli(['--input', VALID_CSV, '--format', 'DTDL'], io);
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/multiple serializers/);
    expect(stderr.join('')).toMatch(/Interfaces/);
  });

  it('lists all registered plugins with --list-formats', async () => {
    const { io, stdout } = makeIo();
    const code = await runCli(['--list-formats'], io);
    expect(code).toBe(0);
    const output = stdout.join('');
    for (const plugin of getOutputPlugins()) {
      expect(output).toContain(`--format ${plugin.format} --serializer ${plugin.serializer}`);
    }
  });

  it('prints structural validation warnings for a CSV with a duplicate id', async () => {
    const { io, stderr } = makeIo();
    const code = await runCli(['--input', INVALID_CSV, '--format', 'CSV'], io);
    expect(code).toBe(0);
    expect(stderr.join('')).toMatch(/id_duplicate/);
  });

  it('exits with code 2 when the input file does not exist', async () => {
    const { io, stderr } = makeIo();
    const code = await runCli(
      ['--input', resolve(REPO_ROOT, 'does-not-exist.csv'), '--format', 'CSV'],
      io,
    );
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/Failed to read/);
  });

  it('writes output to a file when --out is given', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'repo-cli-test-'));
    const outPath = join(tmpDir, 'output.csv');
    tmpDirs.push(tmpDir);
    const { io } = makeIo();
    const code = await runCli(['--input', VALID_CSV, '--format', 'CSV', '--out', outPath], io);
    expect(code).toBe(0);
    const content = readFileSync(outPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });
});

describe('runCli input limits', () => {
  const HEADER =
    'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,point_type,point_specification,point_id,point_name,writable,local_id';

  function writeCsv(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-limits-'));
    tmpDirs.push(dir);
    const file = join(dir, 'input.csv');
    writeFileSync(file, [HEADER, ...lines].join('\n') + '\n', 'utf-8');
    return file;
  }

  // 20,001 rows: one past the default, so the default rejects it and any raised limit accepts
  // it. Kept just over the boundary so the fixture stays cheap to generate.
  const overDefaultRows = () =>
    writeCsv(
      Array.from(
        { length: 20_001 },
        (_, i) =>
          `GW1,DEV${i},Sensor ${i},Sensor,S1,B1,1F,Room1,Temperature,Measurement,PT${i},Temp,false,L${i}`,
      ),
    );

  it('rejects input over the default row limit', async () => {
    const { io, stderr } = makeIo();
    const code = await runCli(
      [
        '--input',
        overDefaultRows(),
        '--format',
        'CSV',
        '--out',
        join(mkdtempSync(join(tmpdir(), 'cli-out-')), 'o.csv'),
      ],
      io,
    );
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('20,000行');
  });

  it('accepts the same input once --max-rows is raised', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-out-'));
    tmpDirs.push(dir);
    const out = join(dir, 'out.csv');
    const { io, stderr } = makeIo();
    const code = await runCli(
      ['--input', overDefaultRows(), '--format', 'CSV', '--max-rows', '25000', '--out', out],
      io,
    );
    expect(code).toBe(0);
    expect(stderr.join('')).toContain('Rows read: 20001 -> rows in output: 20001');
    expect(readFileSync(out, 'utf-8').trim().split('\n')).toHaveLength(20_002);
  });

  // Written in --flag=value form: parseArgs rejects a bare "--max-bytes -1" as an ambiguous
  // argument before our own check ever sees it (still exit 2, different message).
  it.each([
    ['--max-rows', '0'],
    ['--max-rows', 'abc'],
    ['--max-bytes', '-1'],
    ['--max-columns', '1.5'],
  ])('rejects %s=%s as not a positive integer', async (flag, value) => {
    const { io, stderr } = makeIo();
    const code = await runCli(['--input', VALID_CSV, '--format', 'CSV', `${flag}=${value}`], io);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain(`${flag} must be a positive integer`);
  });
});

describe('runCli hierarchy coverage', () => {
  function writeDroppedRowCsv(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-dropped-'));
    tmpDirs.push(dir);
    const file = join(dir, 'input.csv');
    writeFileSync(
      file,
      [
        'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,point_type,point_specification,point_id,point_name,writable,local_id',
        'GW1,DEV1,Sensor 1,Sensor,S1,B1,1F,Room101,Temperature,Measurement,PT001,Temp,false,L1',
        // installation_area unset: emitted, but Equipment hangs off the Level (warning).
        'GW1,DEV2,Sensor 2,Sensor,S1,B1,1F,-,Temperature,Measurement,PT002,Temp,false,L2',
        // floor unset: the row reaches no graph-derived output at all (violation).
        'GW1,DEV3,Sensor 3,Sensor,S1,B1,-,Room103,Temperature,Measurement,PT003,Temp,false,L3',
      ].join('\n') + '\n',
      'utf-8',
    );
    return file;
  }

  it('exits 1 and writes nothing when a row cannot reach the output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-out-'));
    tmpDirs.push(dir);
    const out = join(dir, 'out.ttl');
    const { io, stderr } = makeIo();

    const code = await runCli(
      ['--input', writeDroppedRowCsv(), '--format', 'RDF', '--serializer', 'Turtle', '--out', out],
      io,
    );

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('row_dropped');
    expect(stderr.join('')).toContain('Rows read: 3 -> rows in output: 2 (dropped: 1)');
    expect(() => readFileSync(out, 'utf-8')).toThrow();
  });

  it('writes with --allow-issues, and the file holds exactly the reconciled rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-out-'));
    tmpDirs.push(dir);
    const out = join(dir, 'out.ttl');
    const { io, stderr } = makeIo();

    const code = await runCli(
      [
        '--input',
        writeDroppedRowCsv(),
        '--format',
        'RDF',
        '--serializer',
        'Turtle',
        '--allow-issues',
        '--out',
        out,
      ],
      io,
    );

    expect(code).toBe(0);
    const content = readFileSync(out, 'utf-8');
    expect(content.match(/sbco:PointExt/g) ?? []).toHaveLength(2);
    expect(content).not.toContain('PT003');
    expect(stderr.join('')).toContain('buildingos_room_missing');
  });

  it('does not block CSV output, which carries every row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-out-'));
    tmpDirs.push(dir);
    const out = join(dir, 'out.csv');
    const { io, stderr } = makeIo();

    const code = await runCli(
      ['--input', writeDroppedRowCsv(), '--format', 'CSV', '--out', out],
      io,
    );

    expect(code).toBe(0);
    expect(readFileSync(out, 'utf-8')).toContain('PT003');
    expect(stderr.join('')).toContain('Rows read: 3 -> rows in output: 3');
  });
});
