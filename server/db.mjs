import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeVisualBibleContent, visualBibleContentHash } from './visual-assets.mjs';

export const SCHEMA_VERSION = 8;

const now = () => new Date().toISOString();
const metadataLogPaths = new WeakMap();

export async function openDatabase(filename, { metadataLogPath } = {}) {
  if (filename !== ':memory:') {
    await mkdir(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  const configuredMetadataLogPath = metadataLogPath
    || process.env.GENERATION_METADATA_LOG_PATH
    || (filename === ':memory:' ? '' : resolve(dirname(filename), 'generation-metadata.jsonl'));
  if (configuredMetadataLogPath) metadataLogPaths.set(db, resolve(configuredMetadataLogPath));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      genre TEXT NOT NULL,
      source_text TEXT,
      copyright_confirmed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      draft_script_version_id TEXT,
      active_script_version_id TEXT,
      source_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS script_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(project_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_script_tasks_status ON script_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_script_tasks_project ON script_tasks(project_id);

    CREATE TABLE IF NOT EXISTS script_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      immutable INTEGER NOT NULL DEFAULT 0,
      prompt_version TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      cleaned_text TEXT,
      usage_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_script_versions_project ON script_versions(project_id, created_at);

    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      title TEXT NOT NULL,
      script_text TEXT NOT NULL,
      summary TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      active_version_id TEXT,
      media_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(script_version_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_segments_version ON segments(script_version_id, sequence);

    CREATE TABLE IF NOT EXISTS segment_versions (
      id TEXT PRIMARY KEY,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      script_text TEXT NOT NULL,
      prompt_text TEXT NOT NULL DEFAULT '',
      voice_id TEXT NOT NULL,
      visual_style TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      storyboard_plan_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_segment_versions_segment ON segment_versions(segment_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS visual_bibles (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      script_version_id TEXT REFERENCES script_versions(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      revision INTEGER NOT NULL DEFAULT 0,
      confirmed_at TEXT,
      confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visual_bibles_project ON visual_bibles(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS segment_shots (
      id TEXT PRIMARY KEY,
      segment_version_id TEXT NOT NULL REFERENCES segment_versions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      prompt_zh TEXT NOT NULL DEFAULT '',
      prompt_en TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      provider TEXT,
      model TEXT,
      provider_job_id TEXT,
      storyboard_plan_id TEXT,
      beat_id TEXT,
      plot_text TEXT NOT NULL DEFAULT '',
      shot_size TEXT NOT NULL DEFAULT '',
      camera_movement TEXT NOT NULL DEFAULT '',
      camera_angle TEXT NOT NULL DEFAULT '',
      focal_length_mm INTEGER,
      composition TEXT NOT NULL DEFAULT '',
      narrative_purpose TEXT NOT NULL DEFAULT '',
      selection_reason TEXT NOT NULL DEFAULT '',
      evidence_ids_json TEXT,
      generation_spec_json TEXT NOT NULL DEFAULT '{}',
      keyframe_prompt_zh TEXT NOT NULL DEFAULT '',
      keyframe_prompt_en TEXT NOT NULL DEFAULT '',
      keyframe_status TEXT NOT NULL DEFAULT 'missing',
      selected_keyframe_asset_id TEXT,
      selected_endframe_asset_id TEXT,
      generation_signature TEXT,
      keyframe_signature TEXT,
      motion_signature TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(segment_version_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_segment_shots_version ON segment_shots(segment_version_id, sequence);

    CREATE TABLE IF NOT EXISTS storyboard_plans (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
      base_plan_id TEXT REFERENCES storyboard_plans(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      revision INTEGER NOT NULL DEFAULT 0,
      configuration_json TEXT NOT NULL DEFAULT '{}',
      director_analysis_json TEXT,
      shot_selection_json TEXT,
      knowledge_snapshot_json TEXT,
      prompt_versions_json TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_storyboard_plans_project ON storyboard_plans(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS storyboard_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      storyboard_plan_id TEXT NOT NULL REFERENCES storyboard_plans(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      from_layer TEXT NOT NULL DEFAULT 'director',
      idempotency_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(project_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_storyboard_tasks_status ON storyboard_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_storyboard_tasks_project ON storyboard_tasks(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '{}',
      constraints_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT '',
      priority REAL NOT NULL DEFAULT 0.5,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_items_base ON knowledge_items(knowledge_base_id);

    CREATE TABLE IF NOT EXISTS retrieval_runs (
      id TEXT PRIMARY KEY,
      storyboard_plan_id TEXT NOT NULL REFERENCES storyboard_plans(id) ON DELETE CASCADE,
      segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
      beat_id TEXT NOT NULL,
      query_json TEXT NOT NULL,
      results_json TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_retrieval_runs_plan ON retrieval_runs(storyboard_plan_id, segment_id);

    CREATE TABLE IF NOT EXISTS shot_transitions (
      id TEXT PRIMARY KEY,
      storyboard_plan_id TEXT NOT NULL REFERENCES storyboard_plans(id) ON DELETE CASCADE,
      from_shot_id TEXT NOT NULL REFERENCES segment_shots(id) ON DELETE CASCADE,
      to_shot_id TEXT NOT NULL REFERENCES segment_shots(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'cut',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      motivation TEXT NOT NULL DEFAULT '',
      execution TEXT NOT NULL DEFAULT 'composer',
      evidence_ids_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(from_shot_id, to_shot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shot_transitions_plan ON shot_transitions(storyboard_plan_id);

    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      segment_version_id TEXT REFERENCES segment_versions(id) ON DELETE CASCADE,
      shot_id TEXT REFERENCES segment_shots(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      object_key TEXT NOT NULL,
      metadata_json TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      generation_signature TEXT,
      source_asset_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_assets_segment_version ON media_assets(segment_version_id, type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_assets_project ON media_assets(project_id, type, created_at DESC);

    CREATE TABLE IF NOT EXISTS generation_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_task_id TEXT REFERENCES generation_tasks(id) ON DELETE CASCADE,
      segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
      segment_version_id TEXT REFERENCES segment_versions(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      configuration_json TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(project_id, type, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project ON generation_tasks(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_parent ON generation_tasks(parent_task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_status ON generation_tasks(status);

    CREATE TABLE IF NOT EXISTS export_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      ratio TEXT NOT NULL,
      resolution TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      object_key TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(project_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_export_tasks_project ON export_tasks(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_export_tasks_status ON export_tasks(status);
  `);
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all().map(column => column.name);
  if (!projectColumns.includes('source_expires_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN source_expires_at TEXT');
  }
  if (!projectColumns.includes('active_generation_task_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN active_generation_task_id TEXT');
  }
  if (!projectColumns.includes('active_storyboard_plan_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN active_storyboard_plan_id TEXT');
  }
  const segmentColumns = db.prepare('PRAGMA table_info(segments)').all().map(column => column.name);
  if (!segmentColumns.includes('active_version_id')) {
    db.exec('ALTER TABLE segments ADD COLUMN active_version_id TEXT');
  }
  if (!segmentColumns.includes('media_status')) {
    db.exec("ALTER TABLE segments ADD COLUMN media_status TEXT NOT NULL DEFAULT 'pending'");
  }
  const segmentVersionColumns = db.prepare('PRAGMA table_info(segment_versions)').all().map(column => column.name);
  if (!segmentVersionColumns.includes('storyboard_plan_id')) db.exec('ALTER TABLE segment_versions ADD COLUMN storyboard_plan_id TEXT');
  const shotColumns = db.prepare('PRAGMA table_info(segment_shots)').all().map(column => column.name);
  const shotMigrations = [
    ['storyboard_plan_id', 'TEXT'], ['beat_id', 'TEXT'], ['plot_text', "TEXT NOT NULL DEFAULT ''"],
    ['shot_size', "TEXT NOT NULL DEFAULT ''"], ['camera_movement', "TEXT NOT NULL DEFAULT ''"],
    ['camera_angle', "TEXT NOT NULL DEFAULT ''"], ['focal_length_mm', 'INTEGER'],
    ['composition', "TEXT NOT NULL DEFAULT ''"], ['narrative_purpose', "TEXT NOT NULL DEFAULT ''"],
    ['selection_reason', "TEXT NOT NULL DEFAULT ''"], ['evidence_ids_json', 'TEXT'],
    ['generation_spec_json', "TEXT NOT NULL DEFAULT '{}'"],
  ];
  for (const [column, definition] of shotMigrations) {
    if (!shotColumns.includes(column)) db.exec(`ALTER TABLE segment_shots ADD COLUMN ${column} ${definition}`);
  }
  const assetColumns = db.prepare('PRAGMA table_info(media_assets)').all().map(column => column.name);
  if (!assetColumns.includes('shot_id')) db.exec('ALTER TABLE media_assets ADD COLUMN shot_id TEXT REFERENCES segment_shots(id) ON DELETE CASCADE');
  const bibleColumns = db.prepare('PRAGMA table_info(visual_bibles)').all().map(column => column.name);
  if (!bibleColumns.includes('script_version_id')) db.exec('ALTER TABLE visual_bibles ADD COLUMN script_version_id TEXT');
  if (!bibleColumns.includes('source_hash')) db.exec("ALTER TABLE visual_bibles ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''");
  if (!bibleColumns.includes('content_hash')) db.exec("ALTER TABLE visual_bibles ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  if (!bibleColumns.includes('status')) db.exec("ALTER TABLE visual_bibles ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
  if (!bibleColumns.includes('confirmed_at')) db.exec('ALTER TABLE visual_bibles ADD COLUMN confirmed_at TEXT');
  const visualShotMigrations = [
    ['keyframe_prompt_zh', "TEXT NOT NULL DEFAULT ''"], ['keyframe_prompt_en', "TEXT NOT NULL DEFAULT ''"],
    ['keyframe_status', "TEXT NOT NULL DEFAULT 'missing'"], ['selected_keyframe_asset_id', 'TEXT'],
    ['selected_endframe_asset_id', 'TEXT'], ['generation_signature', 'TEXT'],
    ['keyframe_signature', 'TEXT'], ['motion_signature', 'TEXT'],
  ];
  for (const [column, definition] of visualShotMigrations) {
    if (!shotColumns.includes(column)) db.exec(`ALTER TABLE segment_shots ADD COLUMN ${column} ${definition}`);
  }
  if (!assetColumns.includes('generation_signature')) db.exec('ALTER TABLE media_assets ADD COLUMN generation_signature TEXT');
  if (!assetColumns.includes('source_asset_id')) db.exec('ALTER TABLE media_assets ADD COLUMN source_asset_id TEXT');
  db.exec("CREATE INDEX IF NOT EXISTS idx_media_assets_signature ON media_assets(generation_signature)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_segment_shots_keyframe_status ON segment_shots(keyframe_status)");
  db.prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('version', String(SCHEMA_VERSION));
  return db;
}

export function closeDatabase(db) {
  db.close();
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createProject(db, { id, title, genre, sourceText, copyrightConfirmed, sourceExpiresAt = null }) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO projects(id, title, genre, source_text, copyright_confirmed, status, source_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(id, title, genre, sourceText, copyrightConfirmed ? 1 : 0, sourceExpiresAt, timestamp, timestamp);
  return getProject(db, id);
}

export function getProject(db, id) {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

export function listProjects(db) {
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(row => ({ ...row }));
}

export function updateProject(db, id, fields) {
  const allowed = ['status', 'draft_script_version_id', 'active_script_version_id', 'active_generation_task_id', 'active_storyboard_plan_id', 'source_text', 'source_expires_at', 'updated_at'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getProject(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE projects SET ${assignments} WHERE id = ?`).run(...values, id);
  return getProject(db, id);
}

export function createTask(db, task) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO script_tasks(
      id, project_id, status, current_step, progress, idempotency_key,
      provider, model, prompt_version, created_at, updated_at
    ) VALUES (?, ?, 'pending', 'queued', 0, ?, ?, ?, ?, ?, ?)
  `).run(task.id, task.projectId, task.idempotencyKey, task.provider, task.model, task.promptVersion, timestamp, timestamp);
  return getTask(db, task.id);
}

export function getTask(db, id) {
  const row = db.prepare('SELECT * FROM script_tasks WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

export function getTaskByIdempotency(db, projectId, idempotencyKey) {
  const row = db.prepare('SELECT * FROM script_tasks WHERE project_id = ? AND idempotency_key = ?').get(projectId, idempotencyKey);
  return row ? { ...row } : null;
}

export function getLatestTask(db, projectId) {
  const row = db.prepare('SELECT * FROM script_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId);
  return row ? { ...row } : null;
}

export function updateTask(db, id, fields) {
  const allowed = ['status', 'current_step', 'progress', 'error_code', 'error_message', 'retry_count', 'updated_at', 'started_at', 'completed_at'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getTask(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE script_tasks SET ${assignments} WHERE id = ?`).run(...values, id);
  return getTask(db, id);
}

export function recoverRunningTasks(db) {
  db.prepare(`
    UPDATE script_tasks
    SET status = 'pending', current_step = 'queued', updated_at = ?, started_at = NULL
    WHERE status = 'running'
  `).run(now());
  return db.prepare("SELECT id FROM script_tasks WHERE status = 'pending' ORDER BY created_at").all().map(row => row.id);
}

export function clearExpiredSources(db) {
  const result = db.prepare(`
    UPDATE projects
    SET source_text = NULL, source_expires_at = NULL, updated_at = ?
    WHERE source_text IS NOT NULL AND source_expires_at IS NOT NULL AND source_expires_at <= ?
  `).run(now(), now());
  return result.changes;
}

export function createScriptVersion(db, version) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO script_versions(
      id, project_id, source, immutable, prompt_version, provider, model, cleaned_text, usage_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.id,
    version.projectId,
    version.source,
    version.immutable ? 1 : 0,
    version.promptVersion,
    version.provider,
    version.model,
    version.cleanedText || null,
    version.usage ? JSON.stringify(version.usage) : null,
    timestamp,
  );
  return getScriptVersion(db, version.id);
}

export function getScriptVersion(db, id) {
  const row = db.prepare('SELECT * FROM script_versions WHERE id = ?').get(id);
  return row ? normalizeVersion(row) : null;
}

function normalizeVersion(row) {
  return { ...row, immutable: Boolean(row.immutable), usage: row.usage_json ? JSON.parse(row.usage_json) : null };
}

export function listScriptVersions(db, projectId) {
  return db.prepare('SELECT * FROM script_versions WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map(normalizeVersion);
}

export function createSegment(db, segment) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO segments(
      id, project_id, script_version_id, sequence, title, script_text, summary, duration_ms, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    segment.id,
    segment.projectId,
    segment.scriptVersionId,
    segment.sequence,
    segment.title,
    segment.scriptText,
    segment.summary || null,
    segment.durationMs,
    timestamp,
    timestamp,
  );
  return getSegment(db, segment.id);
}

export function getSegment(db, id) {
  const row = db.prepare('SELECT * FROM segments WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

export function listSegments(db, scriptVersionId) {
  return db.prepare('SELECT * FROM segments WHERE script_version_id = ? ORDER BY sequence').all(scriptVersionId).map(row => ({ ...row }));
}

export function updateSegmentDraft(db, id, { scriptText, revision }) {
  const timestamp = now();
  const result = db.prepare(`
    UPDATE segments
    SET script_text = ?, duration_ms = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(scriptText, estimateDurationMs(scriptText), timestamp, id, revision);
  if (!result.changes) return null;
  return getSegment(db, id);
}

export function isVersionImmutable(db, scriptVersionId) {
  const row = db.prepare('SELECT immutable FROM script_versions WHERE id = ?').get(scriptVersionId);
  return Boolean(row?.immutable);
}

export function createSegmentVersion(db, version) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO segment_versions(
      id, segment_id, source, script_text, prompt_text, voice_id, visual_style, duration_ms, status, storyboard_plan_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.id,
    version.segmentId,
    version.source,
    version.scriptText,
    version.promptText || '',
    version.voiceId,
    version.visualStyle,
    version.durationMs || 0,
    version.status || 'pending',
    version.storyboardPlanId || null,
    timestamp,
    timestamp,
  );
  return getSegmentVersion(db, version.id);
}

export function getSegmentVersion(db, id) {
  const row = db.prepare('SELECT * FROM segment_versions WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

export function getLatestSegmentVersion(db, segmentId) {
  const row = db.prepare('SELECT * FROM segment_versions WHERE segment_id = ? ORDER BY created_at DESC LIMIT 1').get(segmentId);
  return row ? { ...row } : null;
}

export function updateSegmentVersion(db, id, fields) {
  const allowed = ['script_text', 'prompt_text', 'voice_id', 'visual_style', 'duration_ms', 'status', 'updated_at'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getSegmentVersion(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE segment_versions SET ${assignments} WHERE id = ?`).run(...values, id);
  return getSegmentVersion(db, id);
}

export function createVisualBible(db, bible) {
  const timestamp = now();
  const content = normalizeVisualBibleContent(bible.content || {});
  const contentHash = visualBibleContentHash(content);
  const scriptVersionId = bible.scriptVersionId || null;
  const sourceHash = String(bible.sourceHash || '').trim();
  const status = bible.confirmed ? 'confirmed' : 'draft';
  db.prepare('INSERT INTO visual_bibles(id, project_id, script_version_id, source_hash, content_json, content_hash, status, revision, confirmed, confirmed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
    .run(bible.id, bible.projectId, scriptVersionId, sourceHash, JSON.stringify(content), contentHash, status, bible.confirmed ? 1 : 0, bible.confirmed ? timestamp : null, timestamp, timestamp);
  return getVisualBible(db, bible.id);
}
export function getLatestVisualBible(db, projectId, scriptVersionId = null) {
  if (scriptVersionId) {
    const bound = db.prepare('SELECT * FROM visual_bibles WHERE project_id = ? AND script_version_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId, scriptVersionId);
    if (bound) return normalizeBible(bound);
    // Older projects stored a bible without binding it to a script version.
    // Falling back to an unbound bible keeps those projects usable; a bible
    // bound to a different script version is never reused.
    const unbound = db.prepare('SELECT * FROM visual_bibles WHERE project_id = ? AND script_version_id IS NULL ORDER BY created_at DESC LIMIT 1').get(projectId);
    return unbound ? normalizeBible(unbound) : null;
  }
  const row = db.prepare('SELECT * FROM visual_bibles WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId);
  return row ? normalizeBible(row) : null;
}

export function getVisualBible(db, id) {
  const row = db.prepare('SELECT * FROM visual_bibles WHERE id = ?').get(id);
  return row ? normalizeBible(row) : null;
}

export function updateVisualBible(db, id, { content, revision, confirmed }) {
  const current = getVisualBible(db, id);
  if (!current) return null;
  const normalized = content === undefined ? current.content : normalizeVisualBibleContent(content);
  const timestamp = now();
  const nextConfirmed = confirmed === undefined ? current.confirmed : Boolean(confirmed);
  const status = nextConfirmed ? 'confirmed' : 'draft';
  const result = db.prepare(`UPDATE visual_bibles SET content_json = ?, content_hash = ?, status = ?, confirmed = ?, confirmed_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
    .run(JSON.stringify(normalized), visualBibleContentHash(normalized), status, nextConfirmed ? 1 : 0, nextConfirmed ? (current.confirmed_at || timestamp) : null, timestamp, id, revision);
  return result.changes ? getVisualBible(db, id) : null;
}

function normalizeBible(row) {
  const content = normalizeVisualBibleContent(JSON.parse(row.content_json || '{}'));
  return {
    ...row,
    content,
    content_hash: row.content_hash || visualBibleContentHash(content),
    status: row.status || (row.confirmed ? 'confirmed' : 'draft'),
    confirmed: Boolean(row.confirmed),
  };
}
export function createSegmentShot(db, shot) {
  const timestamp = now();
  db.prepare(`INSERT INTO segment_shots(
    id, segment_version_id, sequence, prompt_zh, prompt_en, duration_ms, status, provider, model, provider_job_id,
    storyboard_plan_id, beat_id, plot_text, shot_size, camera_movement, camera_angle, focal_length_mm,
    composition, narrative_purpose, selection_reason, evidence_ids_json, generation_spec_json,
    keyframe_prompt_zh, keyframe_prompt_en, keyframe_status, selected_keyframe_asset_id,
    selected_endframe_asset_id, generation_signature, keyframe_signature, motion_signature, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(shot.id, shot.segmentVersionId, shot.sequence, shot.promptZh || '', shot.promptEn || '', shot.durationMs || 0,
      shot.status || 'pending', shot.provider || null, shot.model || null, shot.providerJobId || null,
      shot.storyboardPlanId || null, shot.beatId || null, shot.plot || '', shot.shotSize || '', shot.movement || '',
      shot.angle || '', shot.focalLengthMm || null, shot.composition || '', shot.purpose || '', shot.selectionReason || '',
      JSON.stringify(shot.evidenceIds || []), JSON.stringify(shot.generationSpec || {}),
      shot.keyframePromptZh || shot.generationSpec?.keyframePrompt || '', shot.keyframePromptEn || '',
      shot.keyframeStatus || (shot.selectedKeyframeAssetId ? 'confirmed' : 'missing'), shot.selectedKeyframeAssetId || null,
      shot.selectedEndframeAssetId || null, shot.generationSignature || null, shot.keyframeSignature || null,
      shot.motionSignature || null, timestamp, timestamp);
  return getSegmentShot(db, shot.id);
}
export function getSegmentShot(db, id) {
  const row = db.prepare('SELECT * FROM segment_shots WHERE id = ?').get(id);
  return row ? normalizeShot(row) : null;
}

export function listSegmentShots(db, segmentVersionId) {
  return db.prepare('SELECT * FROM segment_shots WHERE segment_version_id = ? ORDER BY sequence').all(segmentVersionId).map(normalizeShot);
}

function normalizeShot(row) {
  return {
    ...row,
    evidence_ids: row.evidence_ids_json ? JSON.parse(row.evidence_ids_json) : [],
    generation_spec: row.generation_spec_json ? JSON.parse(row.generation_spec_json) : {},
  };
}

export function updateSegmentShot(db, id, fields) {
  const allowed = ['prompt_zh', 'prompt_en', 'duration_ms', 'status', 'provider', 'model', 'provider_job_id', 'plot_text', 'shot_size', 'camera_movement', 'camera_angle', 'focal_length_mm', 'composition', 'narrative_purpose', 'selection_reason', 'evidence_ids_json', 'generation_spec_json', 'keyframe_prompt_zh', 'keyframe_prompt_en', 'keyframe_status', 'selected_keyframe_asset_id', 'selected_endframe_asset_id', 'generation_signature', 'keyframe_signature', 'motion_signature', 'updated_at'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getSegmentShot(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE segment_shots SET ${assignments} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  return getSegmentShot(db, id);
}

export function getSegmentVersionForPlan(db, segmentId, storyboardPlanId) {
  const row = db.prepare(`
    SELECT * FROM segment_versions
    WHERE segment_id = ? AND storyboard_plan_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(segmentId, storyboardPlanId);
  return row ? { ...row } : null;
}

export function createStoryboardPlan(db, plan) {
  const createdAt = now();
  db.prepare(`INSERT INTO storyboard_plans(
    id, project_id, script_version_id, base_plan_id, status, revision, configuration_json,
    director_analysis_json, shot_selection_json, knowledge_snapshot_json, prompt_versions_json,
    provider, model, confirmed_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(
      plan.id, plan.projectId, plan.scriptVersionId, plan.basePlanId || null, plan.status || 'draft',
      JSON.stringify(plan.configuration || {}), plan.directorAnalysis ? JSON.stringify(plan.directorAnalysis) : null,
      plan.shotSelection ? JSON.stringify(plan.shotSelection) : null,
      plan.knowledgeSnapshot ? JSON.stringify(plan.knowledgeSnapshot) : null,
      JSON.stringify(plan.promptVersions || {}), plan.provider, plan.model, createdAt, createdAt,
    );
  return getStoryboardPlan(db, plan.id);
}

export function getStoryboardPlan(db, id) {
  const row = db.prepare('SELECT * FROM storyboard_plans WHERE id = ?').get(id);
  return row ? normalizeStoryboardPlan(row) : null;
}

export function getLatestStoryboardPlan(db, projectId) {
  const row = db.prepare('SELECT * FROM storyboard_plans WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId);
  return row ? normalizeStoryboardPlan(row) : null;
}

export function updateStoryboardPlan(db, id, fields, revision = null) {
  const jsonFields = new Set(['configuration', 'director_analysis', 'shot_selection', 'knowledge_snapshot', 'prompt_versions']);
  const aliases = {
    configuration: 'configuration_json', director_analysis: 'director_analysis_json', shot_selection: 'shot_selection_json',
    knowledge_snapshot: 'knowledge_snapshot_json', prompt_versions: 'prompt_versions_json',
  };
  const allowed = new Set(['status', 'configuration', 'director_analysis', 'shot_selection', 'knowledge_snapshot', 'prompt_versions', 'confirmed_at', 'updated_at']);
  const entries = Object.entries(fields).filter(([key, value]) => allowed.has(key) && value !== undefined);
  if (!entries.length) return getStoryboardPlan(db, id);
  const assignments = entries.map(([key]) => `${aliases[key] || key} = ?`);
  assignments.push('revision = revision + 1');
  const values = entries.map(([key, value]) => jsonFields.has(key) ? (value === null ? null : JSON.stringify(value)) : value);
  let sql = `UPDATE storyboard_plans SET ${assignments.join(', ')} WHERE id = ?`;
  values.push(id);
  if (revision !== null) { sql += ' AND revision = ?'; values.push(revision); }
  const result = db.prepare(sql).run(...values);
  return result.changes ? getStoryboardPlan(db, id) : null;
}

function normalizeStoryboardPlan(row) {
  const parse = (value, fallback) => value ? JSON.parse(value) : fallback;
  return {
    ...row,
    configuration: parse(row.configuration_json, {}),
    director_analysis: parse(row.director_analysis_json, null),
    shot_selection: parse(row.shot_selection_json, null),
    knowledge_snapshot: parse(row.knowledge_snapshot_json, null),
    prompt_versions: parse(row.prompt_versions_json, {}),
  };
}

export function createStoryboardTask(db, task) {
  const createdAt = now();
  db.prepare(`INSERT INTO storyboard_tasks(
    id, project_id, storyboard_plan_id, status, current_step, progress, from_layer, idempotency_key,
    provider, model, created_at, updated_at
  ) VALUES (?, ?, ?, 'pending', 'queued', 0, ?, ?, ?, ?, ?, ?)`)
    .run(task.id, task.projectId, task.storyboardPlanId, task.fromLayer || 'director', task.idempotencyKey,
      task.provider, task.model, createdAt, createdAt);
  return getStoryboardTask(db, task.id);
}

export function getStoryboardTask(db, id) {
  const row = db.prepare('SELECT * FROM storyboard_tasks WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

export function getStoryboardTaskByIdempotency(db, projectId, idempotencyKey) {
  const row = db.prepare('SELECT * FROM storyboard_tasks WHERE project_id = ? AND idempotency_key = ?').get(projectId, idempotencyKey);
  return row ? { ...row } : null;
}

export function getLatestStoryboardTask(db, projectId) {
  const row = db.prepare('SELECT * FROM storyboard_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId);
  return row ? { ...row } : null;
}

export function updateStoryboardTask(db, id, fields) {
  const allowed = new Set(['status', 'current_step', 'progress', 'retry_count', 'error_code', 'error_message', 'updated_at', 'started_at', 'completed_at']);
  const entries = Object.entries(fields).filter(([key, value]) => allowed.has(key) && value !== undefined);
  if (!entries.length) return getStoryboardTask(db, id);
  db.prepare(`UPDATE storyboard_tasks SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), id);
  return getStoryboardTask(db, id);
}

export function recoverRunningStoryboardTasks(db) {
  db.prepare(`UPDATE storyboard_tasks SET status = 'pending', current_step = 'queued', started_at = NULL, updated_at = ? WHERE status = 'running'`).run(now());
  return db.prepare("SELECT id FROM storyboard_tasks WHERE status = 'pending' ORDER BY created_at").all().map(row => row.id);
}

export function upsertKnowledgeBase(db, knowledgeBase) {
  db.prepare(`INSERT INTO knowledge_bases(id, name, version, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .run(knowledgeBase.id, knowledgeBase.name, knowledgeBase.version, knowledgeBase.enabled === false ? 0 : 1, now());
}

export function upsertKnowledgeItem(db, item) {
  db.prepare(`INSERT INTO knowledge_items(
    id, knowledge_base_id, title, content, tags_json, constraints_json, source, priority, content_hash, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET knowledge_base_id = excluded.knowledge_base_id, title = excluded.title,
    content = excluded.content, tags_json = excluded.tags_json, constraints_json = excluded.constraints_json,
    source = excluded.source, priority = excluded.priority, content_hash = excluded.content_hash, updated_at = excluded.updated_at`)
    .run(item.id, item.knowledgeBaseId, item.title, item.content, JSON.stringify(item.tags || {}),
      JSON.stringify(item.constraints || {}), item.source || '', Number(item.priority ?? 0.5), item.contentHash, now());
}

export function listKnowledgeItems(db, baseIds = []) {
  const rows = baseIds.length
    ? db.prepare(`SELECT i.* FROM knowledge_items i JOIN knowledge_bases b ON b.id = i.knowledge_base_id WHERE b.enabled = 1 AND i.knowledge_base_id IN (${baseIds.map(() => '?').join(',')})`).all(...baseIds)
    : db.prepare('SELECT i.* FROM knowledge_items i JOIN knowledge_bases b ON b.id = i.knowledge_base_id WHERE b.enabled = 1').all();
  return rows.map(row => ({ ...row, tags: JSON.parse(row.tags_json || '{}'), constraints: JSON.parse(row.constraints_json || '{}') }));
}

export function listKnowledgeBases(db) {
  return db.prepare('SELECT * FROM knowledge_bases WHERE enabled = 1 ORDER BY id').all().map(row => ({ ...row, enabled: Boolean(row.enabled) }));
}

export function createRetrievalRun(db, run) {
  const createdAt = now();
  db.prepare(`INSERT INTO retrieval_runs(id, storyboard_plan_id, segment_id, beat_id, query_json, results_json, strategy_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(run.id, run.storyboardPlanId, run.segmentId, run.beatId, JSON.stringify(run.query), JSON.stringify(run.results), run.strategyVersion, createdAt);
  return { ...run, created_at: createdAt };
}

export function listRetrievalRuns(db, storyboardPlanId) {
  return db.prepare('SELECT * FROM retrieval_runs WHERE storyboard_plan_id = ? ORDER BY created_at').all(storyboardPlanId)
    .map(row => ({ ...row, query: JSON.parse(row.query_json), results: JSON.parse(row.results_json) }));
}

export function createShotTransition(db, transition) {
  const createdAt = now();
  db.prepare(`INSERT INTO shot_transitions(
    id, storyboard_plan_id, from_shot_id, to_shot_id, type, duration_ms, motivation, execution, evidence_ids_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(transition.id, transition.storyboardPlanId, transition.fromShotId, transition.toShotId,
      transition.type || 'cut', transition.durationMs || 0, transition.motivation || '', transition.execution || 'composer',
      JSON.stringify(transition.evidenceIds || []), createdAt, createdAt);
  return getShotTransition(db, transition.id);
}

export function getShotTransition(db, id) {
  const row = db.prepare('SELECT * FROM shot_transitions WHERE id = ?').get(id);
  return row ? { ...row, evidence_ids: JSON.parse(row.evidence_ids_json || '[]') } : null;
}

export function listShotTransitions(db, storyboardPlanId) {
  return db.prepare('SELECT * FROM shot_transitions WHERE storyboard_plan_id = ? ORDER BY created_at').all(storyboardPlanId)
    .map(row => ({ ...row, evidence_ids: JSON.parse(row.evidence_ids_json || '[]') }));
}

export function clearStoryboardArtifacts(db, storyboardPlanId) {
  db.prepare('DELETE FROM shot_transitions WHERE storyboard_plan_id = ?').run(storyboardPlanId);
  db.prepare('DELETE FROM segment_versions WHERE storyboard_plan_id = ?').run(storyboardPlanId);
}

export function invalidateShotAssets(db, shotId) {
  return db.prepare("UPDATE media_assets SET status = 'stale' WHERE shot_id = ? AND status = 'ready'").run(shotId).changes;
}

export function updateSegmentMedia(db, id, fields) {
  const allowed = ['active_version_id', 'media_status', 'updated_at'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getSegment(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE segments SET ${assignments} WHERE id = ?`).run(...values, id);
  return getSegment(db, id);
}

export function updateSegmentDuration(db, id, durationMs) {
  db.prepare('UPDATE segments SET duration_ms = ?, updated_at = ? WHERE id = ?')
    .run(Math.max(1, Math.round(Number(durationMs) || 1)), now(), id);
  return getSegment(db, id);
}

export function createMediaAsset(db, asset) {
  const timestamp = now();
  const metadataJson = asset.metadata ? JSON.stringify(asset.metadata) : null;
  const generationSignature = asset.generationSignature || asset.generation_signature || asset.metadata?.generationSignature || null;
  db.prepare(`
    INSERT INTO media_assets(
      id, project_id, segment_version_id, shot_id, type, provider, model, object_key, metadata_json,
      duration_ms, size_bytes, generation_signature, source_asset_id, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    asset.id,
    asset.projectId,
    asset.segmentVersionId || null,
    asset.shotId || null,
    asset.type,
    asset.provider,
    asset.model,
    asset.objectKey,
    metadataJson,
    asset.durationMs || 0,
    asset.sizeBytes || 0,
    generationSignature,
    asset.sourceAssetId || null,
    asset.status || 'ready',
    timestamp,
  );
  const persisted = getMediaAsset(db, asset.id);
  appendGenerationMetadataLog(db, persisted);
  return persisted;
}
function appendGenerationMetadataLog(db, asset) {
  const logPath = metadataLogPaths.get(db);
  if (!logPath || !asset) return;

  try {
    let shot = null;
    if (asset.shot_id) {
      const row = db.prepare(`
        SELECT sequence, prompt_zh, prompt_en, generation_spec_json, provider_job_id
        FROM segment_shots
        WHERE id = ?
      `).get(asset.shot_id);
      if (row) {
        shot = {
          sequence: row.sequence,
          promptZh: row.prompt_zh,
          promptEn: row.prompt_en,
          providerJobId: row.provider_job_id,
          generationSpec: row.generation_spec_json ? JSON.parse(row.generation_spec_json) : {},
        };
      }
    }

    const record = {
      schemaVersion: 1,
      recordedAt: asset.created_at,
      asset: {
        id: asset.id,
        projectId: asset.project_id,
        segmentVersionId: asset.segment_version_id,
        shotId: asset.shot_id,
        type: asset.type,
        provider: asset.provider,
        model: asset.model,
        objectKey: asset.object_key,
        durationMs: asset.duration_ms,
        sizeBytes: asset.size_bytes,
        status: asset.status,
      },
      shot,
      metadata: asset.metadata,
    };

    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[metadata-log] failed to write ${logPath}: ${error.message}`);
  }
}

export function getMediaAsset(db, id) {
  const row = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(id);
  return row ? normalizeAsset(row) : null;
}

export function updateMediaAsset(db, id, fields) {
  const allowed = ['status', 'metadata_json', 'generation_signature', 'source_asset_id'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getMediaAsset(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE media_assets SET ${assignments} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  return getMediaAsset(db, id);
}

function normalizeAsset(row) {
  return {
    ...row,
    objectKey: row.object_key,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    shotId: row.shot_id,
    segmentVersionId: row.segment_version_id,
    generationSignature: row.generation_signature || (row.metadata_json ? JSON.parse(row.metadata_json).generationSignature : null),
    sourceAssetId: row.source_asset_id || null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  };
}

export function listMediaAssets(db, { projectId, segmentVersionId, shotId, type, status } = {}) {
  const conditions = [];
  const values = [];
  if (projectId) { conditions.push('project_id = ?'); values.push(projectId); }
  if (segmentVersionId) { conditions.push('segment_version_id = ?'); values.push(segmentVersionId); }
  if (shotId) { conditions.push('shot_id = ?'); values.push(shotId); }
  if (type) { conditions.push('type = ?'); values.push(type); }
  if (status) { conditions.push('status = ?'); values.push(status); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM media_assets${where} ORDER BY created_at`).all(...values).map(normalizeAsset);
}

export function invalidateProjectVisualDependents(db, projectId, { includeReferences = false } = {}) {
  const timestamp = now();
  const allowedTypes = includeReferences
    ? ['shot_keyframe_candidate', 'shot_keyframe_selected', 'shot_endframe_candidate', 'shot_video', 'video']
    : ['shot_keyframe_candidate', 'shot_keyframe_selected', 'shot_endframe_candidate', 'shot_video', 'video'];
  const placeholders = allowedTypes.map(() => '?').join(',');
  const assets = db.prepare(`UPDATE media_assets SET status = 'stale' WHERE project_id = ? AND type IN (${placeholders}) AND status = 'ready'`).run(projectId, ...allowedTypes).changes;
  const shots = db.prepare(`
    UPDATE segment_shots
    SET keyframe_status = CASE WHEN selected_keyframe_asset_id IS NULL THEN 'missing' ELSE 'stale' END,
        updated_at = ?
    WHERE segment_version_id IN (
      SELECT sv.id FROM segment_versions sv
      JOIN segments s ON s.id = sv.segment_id
      WHERE s.project_id = ?
    )
  `).run(timestamp, projectId).changes;
  return { assets, shots };
}

/**
 * Marks the reference candidates of one visual entity stale. Used when the
 * user rewrites a character/scene/prop appearance: the old reference images no
 * longer describe the locked setting and must be regenerated and re-confirmed.
 */
export function invalidateEntityReferenceAssets(db, projectId, { entityId, kind } = {}) {
  if (!entityId || !kind) return { assets: 0 };
  const rows = db.prepare(`
    SELECT id, metadata_json FROM media_assets
    WHERE project_id = ? AND type IN ('character_reference', 'scene_reference', 'prop_reference')
  `).all(projectId);
  let assets = 0;
  for (const row of rows) {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata_json || '{}'); } catch { metadata = {}; }
    if (metadata.entityId !== entityId || metadata.entityKind !== kind) continue;
    db.prepare("UPDATE media_assets SET status = 'stale' WHERE id = ?").run(row.id);
    assets += 1;
  }
  return { assets };
}

export function invalidateSelectedKeyframeDependents(db, shotId) {
  const shot = getSegmentShot(db, shotId);
  if (!shot) return 0;
  const timestamp = now();
  db.prepare("UPDATE media_assets SET status = 'stale' WHERE shot_id = ? AND type IN ('shot_video', 'video') AND status = 'ready'").run(shotId);
  return db.prepare('UPDATE segment_shots SET motion_signature = NULL, generation_signature = NULL, status = ?, updated_at = ? WHERE id = ?')
    .run(shot.keyframe_status === 'confirmed' ? 'planned' : 'pending', timestamp, shotId).changes;
}
export function createGenerationTask(db, task) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO generation_tasks(
      id, project_id, parent_task_id, segment_id, segment_version_id, type, status, current_step,
      progress, configuration_json, provider, model, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'queued', 0, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.projectId,
    task.parentTaskId || null,
    task.segmentId || null,
    task.segmentVersionId || null,
    task.type,
    task.configuration ? JSON.stringify(task.configuration) : null,
    task.provider,
    task.model,
    task.idempotencyKey,
    timestamp,
    timestamp,
  );
  return getGenerationTask(db, task.id);
}

export function getGenerationTask(db, id) {
  const row = db.prepare('SELECT * FROM generation_tasks WHERE id = ?').get(id);
  return row ? normalizeGenerationTask(row) : null;
}

export function getGenerationTaskByIdempotency(db, projectId, type, idempotencyKey) {
  const row = db.prepare('SELECT * FROM generation_tasks WHERE project_id = ? AND type = ? AND idempotency_key = ?').get(projectId, type, idempotencyKey);
  return row ? normalizeGenerationTask(row) : null;
}

export function getLatestGenerationTask(db, projectId) {
  const row = db.prepare('SELECT * FROM generation_tasks WHERE project_id = ? AND parent_task_id IS NULL ORDER BY created_at DESC LIMIT 1').get(projectId);
  return row ? normalizeGenerationTask(row) : null;
}

export function getLatestGenerationTaskForTypes(db, projectId, types = []) {
  if (!types.length) return null;
  const placeholders = types.map(() => '?').join(',');
  const row = db.prepare(`SELECT * FROM generation_tasks WHERE project_id = ? AND type IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`).get(projectId, ...types);
  return row ? normalizeGenerationTask(row) : null;
}
export function getChildGenerationTask(db, parentTaskId, segmentId) {
  const row = db.prepare('SELECT * FROM generation_tasks WHERE parent_task_id = ? AND segment_id = ? ORDER BY created_at DESC LIMIT 1').get(parentTaskId, segmentId);
  return row ? normalizeGenerationTask(row) : null;
}

export function listGenerationTasks(db, parentTaskId) {
  return db.prepare('SELECT * FROM generation_tasks WHERE parent_task_id = ? ORDER BY created_at').all(parentTaskId).map(normalizeGenerationTask);
}

function normalizeGenerationTask(row) {
  return { ...row, configuration: row.configuration_json ? JSON.parse(row.configuration_json) : {} };
}

export function updateGenerationTask(db, id, fields) {
  const allowed = ['status', 'current_step', 'progress', 'segment_version_id', 'configuration_json', 'retry_count', 'error_code', 'error_message', 'updated_at', 'started_at', 'completed_at'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getGenerationTask(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE generation_tasks SET ${assignments} WHERE id = ?`).run(...values, id);
  return getGenerationTask(db, id);
}

export function recoverRunningGenerationTasks(db) {
  db.prepare(`
    UPDATE generation_tasks
    SET status = 'pending', current_step = 'queued', updated_at = ?, started_at = NULL
    WHERE status = 'running'
  `).run(now());
  return db.prepare("SELECT id FROM generation_tasks WHERE status = 'pending' AND parent_task_id IS NULL ORDER BY created_at").all().map(row => row.id);
}

export function createExportTask(db, task) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO export_tasks(
      id, project_id, status, ratio, resolution, progress, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, 'pending', ?, ?, 0, ?, ?, ?)
  `).run(task.id, task.projectId, task.ratio, task.resolution, task.idempotencyKey, timestamp, timestamp);
  return getExportTask(db, task.id);
}

export function getExportTask(db, id) {
  const row = db.prepare('SELECT * FROM export_tasks WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

export function getExportTaskByIdempotency(db, projectId, idempotencyKey) {
  const row = db.prepare('SELECT * FROM export_tasks WHERE project_id = ? AND idempotency_key = ?').get(projectId, idempotencyKey);
  return row ? { ...row } : null;
}

export function listExportTasks(db, projectId) {
  return db.prepare('SELECT * FROM export_tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map(row => ({ ...row }));
}

export function updateExportTask(db, id, fields) {
  const allowed = ['status', 'progress', 'object_key', 'size_bytes', 'error_code', 'error_message', 'updated_at', 'completed_at'];
  const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
  if (!entries.length) return getExportTask(db, id);
  const assignments = entries.map(([key]) => `${key} = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE export_tasks SET ${assignments} WHERE id = ?`).run(...values, id);
  return getExportTask(db, id);
}

export function recoverRunningExportTasks(db) {
  db.prepare(`UPDATE export_tasks SET status = 'pending', progress = 0, updated_at = ? WHERE status = 'running'`).run(now());
  return db.prepare("SELECT id FROM export_tasks WHERE status = 'pending' ORDER BY created_at").all().map(row => row.id);
}

export function estimateDurationMs(text) {
  const chars = Array.from(text || '').length;
  return Math.max(2000, Math.round((chars / 4.2) * 1000));
}

export function copyVersion(db, { fromVersionId, toVersion, segments }) {
  return transaction(db, () => {
    createScriptVersion(db, toVersion);
    for (const segment of segments) {
      createSegment(db, { ...segment, scriptVersionId: toVersion.id });
    }
    return getScriptVersion(db, toVersion.id);
  });
}

export function timestamp() {
  return now();
}
