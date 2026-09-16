const ADMIN_TABLE_DEFS = [
  ['projects', '作品'],
  ['script_versions', '文案版本'],
  ['segments', '片段'],
  ['segment_versions', '片段版本'],
  ['segment_shots', '镜头'],
  ['media_assets', '媒体资产'],
  ['generation_tasks', '视频任务'],
  ['script_tasks', '文案任务'],
  ['storyboard_plans', '分镜方案'],
  ['storyboard_tasks', '分镜任务'],
  ['visual_bibles', '视觉圣经'],
  ['shot_transitions', '镜头转场'],
  ['export_tasks', '导出任务'],
  ['knowledge_bases', '知识库'],
  ['knowledge_items', '知识条目'],
  ['retrieval_runs', '检索运行'],
].map(([name, label]) => ({ name, label }));

export class AdminDbError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function listAdminTables(db) {
  return ADMIN_TABLE_DEFS.map(def => {
    const info = getTableInfo(db, def.name);
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${quote(def.name)}`).get().count;
    return {
      name: def.name,
      label: def.label,
      count: Number(count),
      primaryKey: info.primaryKey,
      columns: info.columns,
    };
  });
}

export function getAdminOverview(db) {
  const count = table => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count);
  const mediaByType = db.prepare(`
    SELECT type, provider, model, COUNT(*) AS count
    FROM media_assets
    GROUP BY type, provider, model
    ORDER BY count DESC
  `).all().map(row => ({ ...row, count: Number(row.count) }));
  const mockCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM media_assets
    WHERE lower(coalesce(provider, '')) LIKE '%mock%'
       OR lower(coalesce(model, '')) LIKE '%mock%'
       OR lower(coalesce(object_key, '')) LIKE 'mock/%'
       OR lower(coalesce(metadata_json, '')) LIKE '%mock/%'
  `).get().count);
  return {
    database: 'data/wenying.sqlite',
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    counts: {
      projects: count('projects'),
      segments: count('segments'),
      shots: count('segment_shots'),
      mediaAssets: count('media_assets'),
      generationTasks: count('generation_tasks'),
      metadataRecords: count('media_assets'),
    },
    mediaByType,
    mockMediaAssets: mockCount,
  };
}

export function listAdminRows(db, tableName, { search = '', limit = 50, offset = 0 } = {}) {
  const info = getTableInfo(db, tableName);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const textColumns = info.columns.filter(column => /TEXT|CHAR|CLOB/i.test(column.type)).map(column => column.name);
  const values = [];
  let where = '';
  const normalizedSearch = String(search || '').trim();
  if (normalizedSearch && textColumns.length) {
    where = ` WHERE ${textColumns.map(column => `CAST(${quote(column)} AS TEXT) LIKE ?`).join(' OR ')}`;
    values.push(...textColumns.map(() => `%${normalizedSearch}%`));
  }
  const orderColumn = info.columns.some(column => column.name === 'updated_at')
    ? 'updated_at'
    : info.columns.some(column => column.name === 'created_at')
      ? 'created_at'
      : info.primaryKey;
  const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quote(info.name)}${where}`).get(...values).count);
  const rows = db.prepare(`
    SELECT *
    FROM ${quote(info.name)}${where}
    ORDER BY ${quote(orderColumn)} DESC
    LIMIT ? OFFSET ?
  `).all(...values, safeLimit, safeOffset);
  return {
    table: { name: info.name, label: info.label, primaryKey: info.primaryKey, columns: info.columns },
    rows,
    total,
    limit: safeLimit,
    offset: safeOffset,
  };
}

export function updateAdminRow(db, tableName, keyValue, input) {
  const info = getTableInfo(db, tableName);
  const key = String(keyValue || '');
  if (!key) throw new AdminDbError(400, 'ADMIN_KEY_REQUIRED', '缺少记录主键');
  const existing = db.prepare(`SELECT * FROM ${quote(info.name)} WHERE ${quote(info.primaryKey)} = ?`).get(key);
  if (!existing) throw new AdminDbError(404, 'ADMIN_ROW_NOT_FOUND', '记录不存在');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdminDbError(400, 'ADMIN_INVALID_BODY', '修改内容必须是 JSON 对象');
  }
  const allowed = new Map(info.columns.filter(column => column.name !== info.primaryKey).map(column => [column.name, column]));
  const entries = Object.entries(input).filter(([name]) => name !== info.primaryKey && allowed.has(name));
  if (!entries.length) throw new AdminDbError(400, 'ADMIN_NO_FIELDS', '没有可修改的字段');
  const assignments = entries.map(([name]) => `${quote(name)} = ?`).join(', ');
  const values = entries.map(([name, value]) => normalizeValue(value, allowed.get(name)));
  db.prepare(`UPDATE ${quote(info.name)} SET ${assignments} WHERE ${quote(info.primaryKey)} = ?`).run(...values, key);
  return db.prepare(`SELECT * FROM ${quote(info.name)} WHERE ${quote(info.primaryKey)} = ?`).get(key);
}

export function deleteAdminRow(db, tableName, keyValue) {
  const info = getTableInfo(db, tableName);
  const key = String(keyValue || '');
  if (!key) throw new AdminDbError(400, 'ADMIN_KEY_REQUIRED', '缺少记录主键');
  const result = db.prepare(`DELETE FROM ${quote(info.name)} WHERE ${quote(info.primaryKey)} = ?`).run(key);
  if (!result.changes) throw new AdminDbError(404, 'ADMIN_ROW_NOT_FOUND', '记录不存在');
  return { deleted: true, table: info.name, key };
}

function getTableInfo(db, tableName) {
  const def = ADMIN_TABLE_DEFS.find(item => item.name === tableName);
  if (!def) throw new AdminDbError(404, 'ADMIN_TABLE_NOT_ALLOWED', '该数据表不允许在后台直接编辑');
  const columns = db.prepare(`PRAGMA table_info(${quote(def.name)})`).all().map(column => ({
    name: column.name,
    type: column.type || 'TEXT',
    nullable: !column.notnull,
    primaryKey: Boolean(column.pk),
    defaultValue: column.dflt_value,
  }));
  if (!columns.length) throw new AdminDbError(404, 'ADMIN_TABLE_NOT_FOUND', '数据表不存在');
  const primaryKey = columns.find(column => column.primaryKey)?.name || columns[0].name;
  return { ...def, columns, primaryKey, name: def.name };
}

function normalizeValue(value, column) {
  if (value === '' && column.nullable) return null;
  if (value === null || value === undefined) return null;
  if (/INT|REAL|FLOA|DOUB|NUM/i.test(column.type)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new AdminDbError(400, 'ADMIN_INVALID_NUMBER', `${column.name} 必须是数字`);
    return number;
  }
  if (/_json$/i.test(column.name) && typeof value !== 'string') return JSON.stringify(value);
  if (/_json$/i.test(column.name) && typeof value === 'string' && value.trim()) {
    try { JSON.parse(value); } catch { throw new AdminDbError(400, 'ADMIN_INVALID_JSON', `${column.name} 不是合法 JSON`); }
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function quote(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}
