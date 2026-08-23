import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const validFixture = path.resolve(__dirname, '../../../packages/fixtures/valid.csv');
const invalidFixture = path.resolve(__dirname, '../../../packages/fixtures/invalid.csv');

async function loadCsv(page: Page, fixture = validFixture) {
  page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
  await page.goto('./');
  await page.getByTestId('csv-input').setInputFiles(fixture);
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('grid-csv')).toBeVisible();
}

async function selectFormat(page: Page, format: string) {
  await page.getByTestId('output-format-select').getByRole('combobox').click();
  await page.getByRole('option', { name: format, exact: true }).click();
}

test('shows the onboarding screen on a fresh visit and can proceed to the sample data', async ({
  page,
}) => {
  await page.goto('./');

  await expect(page.getByRole('heading', { name: /建物のデータモデルを/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'サンプルデータで試す' })).toBeVisible();
  await expect(page.getByTestId('csv-input')).toBeAttached();

  await page.getByRole('button', { name: 'CSV仕様を見る' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('CSV仕様');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'サンプルデータで試す' }).click();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('grid-csv')).toBeVisible();
  await expect(page.getByRole('heading', { name: /建物のデータモデルを/ })).toBeHidden();
});

test('does not offer a sample-data shortcut once real data is loaded', async ({ page }) => {
  // Once work is in progress, a stray "サンプル" button next to "CSVを
  // 読み込む" risks silently overwriting it. Onboarding already covers
  // loading the sample before any data exists.
  await loadCsv(page);
  await expect(page.getByRole('button', { name: 'サンプル', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSVを読み込む' })).toBeVisible();
});

test('loads CSV under the Pages subpath and exposes every column in the virtualized grid', async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  await loadCsv(page);

  await expect(page.getByTestId('tree-item-site:site-1')).toBeVisible();
  await expect(page.getByTestId('tree-item-building:site:site-1/bldg-1')).toBeVisible();
  await expect(page.getByTestId('grid-csv').getByRole('grid')).toHaveAttribute(
    'aria-colcount',
    '30',
  );

  await page.getByTestId('grid-search').fill('Room 201');
  await expect(page.getByTestId('grid-csv').locator('[role="row"][data-id]')).toHaveCount(1);
  expect(externalRequests).toEqual([]);
});

test('edits through DataGrid and preserves Tree selection and expansion after rebuild', async ({
  page,
}) => {
  await loadCsv(page);

  const floor = page.getByTestId('tree-item-level:building:site:site-1/bldg-1/floor-1');
  await floor
    .locator('xpath=ancestor::*[@role="treeitem"][1]')
    .locator('.MuiTreeItem-iconContainer')
    .click();
  const room = page.getByTestId(
    'tree-item-room:level:building:site:site-1/bldg-1/floor-1/Room-101',
  );
  await expect(room).toBeVisible();

  await page.getByTestId('grid-csv').locator('[role="row"][data-id="PT001__0"]').click();
  const nameCell = page
    .getByTestId('inspector-panel')
    .locator('[role="row"][data-id="name"] [role="gridcell"][data-field="value"]');
  await nameCell.dblclick();
  const editor = nameCell.locator('input');
  await editor.fill('Room Temperature Updated');
  await editor.press('Enter');

  await expect(nameCell).toContainText('Room Temperature Updated');
  await expect(room).toBeVisible();
});

test('downloads RDF, YAML, DTDL, and WoT through the async output registry', async ({ page }) => {
  await loadCsv(page);

  for (const format of ['RDF', 'YAML', 'DTDL', 'WoT']) {
    await selectFormat(page, format);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ダウンロード', exact: true }).click();
    const download = await downloadPromise;
    const outputPath = test.info().outputPath(`${format}-${download.suggestedFilename()}`);
    await download.saveAs(outputPath);
    expect((await fs.readFile(outputPath)).byteLength).toBeGreaterThan(10);
  }
});

test('blocks download and opens Issue Drawer when SHACL validation fails', async ({ page }) => {
  await loadCsv(page, invalidFixture);
  await selectFormat(page, 'RDF');
  await page.getByRole('button', { name: 'ダウンロード', exact: true }).click();

  await expect(page.getByTestId('output-error')).toContainText('ダウンロードを中止');
  await expect(page.getByTestId('issues-drawer')).toBeVisible();
});

test('shows kind as a read-only Class in the Inspector', async ({ page }) => {
  await loadCsv(page);

  await page.getByTestId('grid-csv').locator('[role="row"][data-id="PT001__0"]').click();
  const inspector = page.getByTestId('inspector-panel');

  // kind isn't a column in pointlist.md-shaped CSVs, so it's synthesized
  // from the resolved class and appended last among the row's properties;
  // scroll the virtualized grid down to reach it.
  const scroller = inspector.locator('.MuiDataGrid-virtualScroller');
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const classCell = inspector.locator('[data-id="kind"] [data-field="property"]');
  await expect(classCell).toHaveText('Class');
  const classValueCell = inspector.locator('[data-id="kind"] [data-field="value"]');
  await expect(classValueCell).toHaveText('PointExt');

  await classValueCell.dblclick();
  await expect(inspector.locator('.MuiDataGrid-cell--editing')).toHaveCount(0);
});

test('shows the property description as a tooltip instead of a persistent column', async ({
  page,
}) => {
  await loadCsv(page);
  await page.getByTestId('grid-csv').locator('[role="row"][data-id="PT001__0"]').click();
  const inspector = page.getByTestId('inspector-panel');

  await expect(inspector.getByRole('columnheader', { name: '説明' })).toHaveCount(0);
  await expect(inspector.getByRole('columnheader', { name: 'プロパティ' })).toBeVisible();
  await expect(inspector.getByRole('columnheader', { name: '値' })).toBeVisible();

  // MUI sets the Tooltip's title as aria-label on the child, independent of
  // whether the visual popper is currently shown, so this checks the
  // tooltip is wired to the right content without fighting hover timing.
  const nameProperty = inspector.locator('[data-id="name"] [data-field="property"] span');
  await expect(nameProperty).toHaveAttribute('aria-label', 'Machine or Human-readable name');

  // The hoverable tooltip target must cover the whole cell, not just the
  // short property text — hovering near the cell's far edge (well past
  // "name"'s few characters) must still trigger it.
  const nameCell = inspector.locator('[data-id="name"] [data-field="property"]');
  await nameCell.scrollIntoViewIfNeeded();
  const box = await nameCell.boundingBox();
  if (!box) throw new Error('name property cell has no bounding box');
  await page.mouse.move(box.x + box.width - 15, box.y + box.height / 2);
  await expect(page.getByRole('tooltip')).toContainText('Machine or Human-readable name');
});

test('highlights an Issue-referenced field even when the row never had that column', async ({
  page,
}) => {
  // point_name is entirely omitted (not just left blank), reproducing the
  // scenario where the Inspector previously had no row at all to highlight.
  await page.goto('./');
  await page.getByTestId('csv-input').setInputFiles({
    name: 'missing-point-name.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,' +
        'point_type,point_specification,point_id,writable,local_id\n' +
        'GW001,DEV001,Sensor 1,Sensor,Site1,Bldg1,1F,Room1,Temperature,Measurement,PT001,false,LOC001\n',
    ),
  });
  await expect(page.getByTestId('grid-csv')).toBeVisible();

  await page.getByTestId('validation-summary').click();
  const drawer = page.getByTestId('issues-drawer');
  const issue = drawer.getByText('PT001 / pointName');
  await expect(issue).toBeVisible();
  await issue.locator('xpath=following-sibling::button[contains(text(),"対象を表示")]').click();

  const inspector = page.getByTestId('inspector-panel');
  // Synthesized fields (present in the Issue but absent from the row) are
  // appended last among the row's properties; scroll down to reach it.
  const scroller = inspector.locator('.MuiDataGrid-virtualScroller');
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const pointNameCell = inspector.locator('[data-id="pointName"] [data-field="value"]');
  await expect(pointNameCell).toBeVisible();
  await expect(pointNameCell).toHaveClass(/cell-error/);
  await expect(pointNameCell).toHaveCSS('background-color', 'rgb(251, 234, 231)');
});

test('loads the sample data cleanly and exports CSV matching the pointlist.md shape', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'サンプルデータで試す' }).click();
  await expect(page.getByTestId('tree')).toBeVisible();

  await expect(page.getByTestId('validation-summary')).toHaveText('検証OK');

  await selectFormat(page, 'CSV');
  await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
  const headerLine = (await page.getByTestId('output-preview-content').innerText()).split(
    /\r?\n/,
  )[0];
  const columns = headerLine.split(',');

  expect(columns).not.toContain('kind');
  expect(columns).not.toContain('id');
  expect(columns).not.toContain('parentId');
  expect(columns).toContain('gatewayId');
  expect(columns).toContain('pointId');
  expect(columns).toContain('pointName');

  const csvBody = await page.getByTestId('output-preview-content').innerText();
  // eslint-disable-next-line no-control-regex
  expect(csvBody).toMatch(/^[\x00-\x7F]*$/); // sample content is ASCII-only (English)
  expect(csvBody).toContain('hq/main-building/'); // localId reads as an MQTT topic
  await page.getByRole('button', { name: '閉じる', exact: true }).click();

  // regression: selecting any node below root must still scope the CSV
  // grid to that node's rows, not empty it out.
  await page.getByTestId('tree').getByText('Main Building', { exact: true }).click();
  await expect(page.getByTestId('grid-csv').locator('[role="row"][data-id]')).not.toHaveCount(0);
});

test('hides the serializer selector when a format has only one option', async ({ page }) => {
  await loadCsv(page);

  await selectFormat(page, 'CSV');
  await expect(page.getByTestId('output-serializer-select')).toBeHidden();

  await selectFormat(page, 'DTDL');
  await expect(page.getByTestId('output-serializer-select')).toBeVisible();
});

test('shows preview content despite blocking issues, but still blocks download', async ({
  page,
}) => {
  await loadCsv(page, invalidFixture);
  await selectFormat(page, 'RDF');

  await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
  await expect(page.getByTestId('output-preview-content')).toContainText('@prefix');
  await page.getByRole('button', { name: '閉じる', exact: true }).click();

  await page.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  await expect(page.getByTestId('output-error')).toContainText('ダウンロードを中止');
});

test('rejects over-limit input atomically and keeps the existing model', async ({ page }) => {
  await loadCsv(page);
  await expect(page.getByTestId('grid-csv').locator('[role="row"][data-id]')).toHaveCount(5);

  await page.getByTestId('csv-input').setInputFiles({
    name: 'too-large.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`id,name\n1,${'x'.repeat(5 * 1024 * 1024)}\n`),
  });

  await expect(page.getByTestId('csv-input-error')).toContainText('5 MiB');
  await expect(page.getByTestId('grid-csv').locator('[role="row"][data-id]')).toHaveCount(5);
});

test('blocks RDF download when a row cannot reach the output at all', async ({ page }) => {
  // floor="-" reads as an unset Level, and Level is a link in the middle of the chain -- the
  // row's Equipment and Point are never generated, so it contributes nothing to the Turtle.
  // Before this check the file downloaded anyway and SHACL reported zero violations, having
  // never seen the missing row.
  await loadCsv(page);
  await page.getByTestId('csv-input').setInputFiles({
    name: 'dropped-row.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,point_type,point_specification,point_id,point_name,writable,local_id',
        'GW1,DEV1,Sensor 1,Sensor,S1,B1,1F,Room101,Temperature,Measurement,PT001,Temp,false,L1',
        'GW1,DEV3,Sensor 3,Sensor,S1,B1,-,Room103,Temperature,Measurement,PT003,Temp,false,L3',
      ].join('\n') + '\n',
    ),
  });
  await expect(page.getByTestId('grid-csv').locator('[role="row"][data-id]')).toHaveCount(2);

  await selectFormat(page, 'RDF');
  await page.getByRole('button', { name: 'ダウンロード', exact: true }).click();

  await expect(page.getByTestId('output-error')).toContainText('ダウンロードを中止');
  await expect(page.getByTestId('issues-drawer')).toBeVisible();
  await expect(page.getByTestId('issues-drawer')).toContainText('row_dropped');
  await expect(page.getByTestId('issues-drawer')).toContainText('出力に含まれるのは 1 行です');
});

test('warns without blocking when installation_area leaves Equipment under a Level', async ({
  page,
}) => {
  // Valid RDF that the vendored SHACL accepts, but not a shape Building OS ingests -- so it
  // is surfaced as a warning and the download still goes through.
  await loadCsv(page);
  await page.getByTestId('csv-input').setInputFiles({
    name: 'roomless.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'gateway_id,device_id,device_name,device_type,site,building,floor,installation_area,point_type,point_specification,point_id,point_name,writable,local_id',
        'GW1,DEV1,Sensor 1,Sensor,S1,B1,1F,Room101,Temperature,Measurement,PT001,Temp,false,L1',
        'GW1,DEV2,Sensor 2,Sensor,S1,B1,1F,-,Temperature,Measurement,PT002,Temp,false,L2',
      ].join('\n') + '\n',
    ),
  });

  await selectFormat(page, 'RDF');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'ダウンロード', exact: true }).click();
  await expect(await download).toBeTruthy();
  await expect(page.getByTestId('output-error')).toHaveCount(0);

  await page.getByTestId('validation-summary').click();
  await expect(page.getByTestId('issues-drawer')).toContainText('buildingos_room_missing');
});

test('shows generated device templates', async ({ page }) => {
  await loadCsv(page);
  await page.getByTestId('view-templates').click();
  await expect(page.getByTestId('templates-view')).toBeVisible();
  await expect(page.getByTestId('template-item-Sensor')).toBeVisible();
  await page.getByTestId('template-item-Sensor').click();
  await expect(page.getByTestId('template-properties-grid')).toBeVisible();
});
