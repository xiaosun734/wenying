import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, createProject, openDatabase } from '../server/db.mjs';
import { getAdminOverview, listAdminRows, listAdminTables, updateAdminRow } from '../server/admin-db.mjs';

test('admin database API helpers expose and update whitelisted rows', async () => {
  const db = await openDatabase(':memory:');
  try {
    createProject(db, { id: 'admin-project', title: '后台测试', genre: '悬疑', sourceText: 'test' });
    const tables = listAdminTables(db);
    assert.ok(tables.some(table => table.name === 'projects'));
    const rows = listAdminRows(db, 'projects', { search: '后台测试' });
    assert.equal(rows.total, 1);
    assert.equal(rows.rows[0].title, '后台测试');
    const updated = updateAdminRow(db, 'projects', 'admin-project', { title: '后台已修改' });
    assert.equal(updated.title, '后台已修改');
    const overview = getAdminOverview(db);
    assert.equal(overview.counts.projects, 1);
    assert.equal(overview.integrity, 'ok');
  } finally {
    closeDatabase(db);
  }
});
