import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith('--')) continue;
  const [key, inline] = value.slice(2).split('=', 2);
  args.set(key, inline ?? process.argv[index + 1]);
  if (inline === undefined) index += 1;
}

const databasePath = resolve(args.get('database') || process.env.DATABASE_PATH || './data/wenying.sqlite');
const logPath = resolve(args.get('log') || process.env.GENERATION_METADATA_LOG_PATH || resolve(dirname(databasePath), 'generation-metadata.jsonl'));
const mediaRoot = resolve(args.get('media-root') || process.env.MEDIA_OUTPUT_DIR || resolve(dirname(databasePath), 'media'));
const dryRun = args.has('dry-run');

const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys = ON;');

const mockMediaWhere = `
  lower(coalesce(provider, '')) LIKE '%mock%'
  OR lower(coalesce(model, '')) LIKE '%mock%'
  OR lower(coalesce(object_key, '')) LIKE 'mock/%'
  OR lower(coalesce(metadata_json, '')) LIKE '%"provider":"mock"%'
  OR lower(coalesce(metadata_json, '')) LIKE '%mock/%'
`;
const mockAssetRows = db.prepare(`
  SELECT id, object_key, type, provider, model
  FROM media_assets
  WHERE ${mockMediaWhere}
  ORDER BY created_at
`).all();
const mockExportRows = db.prepare(`
  SELECT id, object_key
  FROM export_tasks
  WHERE lower(coalesce(object_key, '')) LIKE 'mock/%'
`).all();

const taskTables = ['script_tasks', 'storyboard_tasks', 'generation_tasks'];
const mockTaskRows = [];
for (const table of taskTables) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes('provider') || !columns.includes('model')) continue;
  const rows = db.prepare(`
    SELECT id, '${table}' AS table_name, provider, model
    FROM ${table}
    WHERE lower(coalesce(provider, '')) LIKE '%mock%'
       OR lower(coalesce(model, '')) LIKE '%mock%'
  `).all();
  mockTaskRows.push(...rows);
}

let logRecords = [];
if (existsSync(logPath)) {
  logRecords = readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
const isMockRecord = record => {
  const asset = record?.asset || {};
  const metadata = record?.metadata || {};
  const haystack = JSON.stringify({ asset, metadata }).toLowerCase();
  return String(asset.objectKey || '').toLowerCase().startsWith('mock/')
    || String(asset.provider || '').toLowerCase().includes('mock')
    || String(asset.model || '').toLowerCase().includes('mock')
    || haystack.includes('"provider":"mock"')
    || haystack.includes('mock/');
};
const mockLogRecords = logRecords.filter(isMockRecord);

const summary = {
  databasePath,
  logPath,
  mediaRoot,
  dryRun,
  mockMediaAssets: mockAssetRows.length,
  mockExportTasks: mockExportRows.length,
  mockTasks: mockTaskRows.length,
  logRecords: logRecords.length,
  mockLogRecords: mockLogRecords.length,
};
console.log(JSON.stringify(summary, null, 2));

if (dryRun) {
  db.close();
  process.exit(0);
}

try {
  db.exec('BEGIN IMMEDIATE;');

  if (mockAssetRows.length) {
    const deleteAsset = db.prepare('DELETE FROM media_assets WHERE id = ?');
    for (const row of mockAssetRows) deleteAsset.run(row.id);
  }
  if (mockExportRows.length) {
    const deleteExport = db.prepare('DELETE FROM export_tasks WHERE id = ?');
    for (const row of mockExportRows) deleteExport.run(row.id);
  }

  // Remove only task rows explicitly marked as mock. Current data normally has none.
  for (const table of taskTables) {
    const rows = mockTaskRows.filter(row => row.table_name === table);
    if (!rows.length) continue;
    const deleteTask = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const row of rows) deleteTask.run(row.id);
  }

  db.exec('COMMIT;');
} catch (error) {
  try { db.exec('ROLLBACK;'); } catch {}
  db.close();
  throw error;
}
db.close();

if (existsSync(logPath)) {
  const kept = logRecords.filter(record => !isMockRecord(record));
  const tempPath = `${logPath}.tmp-${process.pid}`;
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(tempPath, kept.length ? `${kept.map(record => JSON.stringify(record)).join('\n')}\n` : '', 'utf8');
  renameSync(tempPath, logPath);
  summary.logRecordsAfter = kept.length;
}

// Delete physical files only when they are inside the configured media root and
// their relative path is explicitly mock/*. The current project has none.
const mockObjectKeys = [...mockAssetRows.map(row => row.object_key), ...mockExportRows.map(row => row.object_key)]
  .filter(key => String(key || '').toLowerCase().startsWith('mock/'));
for (const objectKey of mockObjectKeys) {
  const relative = String(objectKey).replaceAll('\\', '/');
  const filePath = resolve(mediaRoot, relative);
  const mediaPrefix = `${mediaRoot}${process.platform === 'win32' ? '\\' : '/'} `
    .slice(0, -1);
  if (!filePath.startsWith(mediaPrefix) || !existsSync(filePath)) continue;
  rmSync(filePath, { force: true });
}

console.log(JSON.stringify({
  removedMediaAssets: mockAssetRows.length,
  removedExportTasks: mockExportRows.length,
  removedTasks: mockTaskRows.length,
  removedLogRecords: mockLogRecords.length,
}, null, 2));
