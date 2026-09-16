import { resolve } from 'node:path';
import { closeDatabase, openDatabase } from './db.mjs';
import { buildGenerationSpec } from './storyboard-task.mjs';

const databasePath = resolve(process.argv[2] || process.env.DATABASE_PATH || './data/wenying.sqlite');
const force = process.argv.includes('--force');
const db = await openDatabase(databasePath);

try {
  const shots = db.prepare(`
    SELECT ss.*, sp.configuration_json, sp.director_analysis_json, s.project_id
    FROM segment_shots ss
    JOIN segment_versions sv ON sv.id = ss.segment_version_id
    JOIN segments s ON s.id = sv.segment_id
    LEFT JOIN storyboard_plans sp ON sp.id = ss.storyboard_plan_id
    WHERE ? = 1 OR ss.generation_spec_json IS NULL OR ss.generation_spec_json = '{}'
    ORDER BY ss.created_at
  `).all(force ? 1 : 0);
  const update = db.prepare('UPDATE segment_shots SET generation_spec_json = ?, updated_at = ? WHERE id = ?');
  const bibleQuery = db.prepare('SELECT content_json FROM visual_bibles WHERE project_id = ? ORDER BY created_at DESC LIMIT 1');
  const now = new Date().toISOString();
  let updated = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const shot of shots) {
      const director = parseJson(shot.director_analysis_json, {});
      const beat = director.segments?.flatMap(item => item.beats || []).find(item => item.beatId === shot.beat_id);
      const bible = parseJson(bibleQuery.get(shot.project_id)?.content_json, {});
      const configuration = parseJson(shot.configuration_json, {});
      const spec = buildGenerationSpec({
        plot: shot.plot_text,
        shotSize: shot.shot_size,
        movement: shot.camera_movement,
        angle: shot.camera_angle,
        focalLengthMm: shot.focal_length_mm,
        composition: shot.composition,
        purpose: shot.narrative_purpose,
      }, beat, bible, configuration);
      update.run(JSON.stringify(spec), now, shot.id);
      updated += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify({ databasePath, force, scanned: shots.length, updated }));
} finally {
  closeDatabase(db);
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
