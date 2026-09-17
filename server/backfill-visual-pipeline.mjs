import { resolve } from 'node:path';
import {
  closeDatabase,
  getLatestVisualBible,
  getStoryboardPlan,
  listSegmentShots,
  openDatabase,
  updateSegmentShot,
  updateVisualBible,
} from './db.mjs';
import { buildGenerationSpec, compileKeyframePrompt, compileMotionPrompt } from './storyboard-task.mjs';
import { buildGenerationSignature, visualBibleContentHash } from './visual-assets.mjs';

const databasePath = resolve(process.argv[2] || process.env.DATABASE_PATH || './data/wenying.sqlite');
const db = await openDatabase(databasePath, { metadataLogPath: '' });
let bibleCount = 0;
let shotCount = 0;

try {
  const bibles = db.prepare('SELECT * FROM visual_bibles ORDER BY created_at').all();
  for (const row of bibles) {
    const current = {
      ...row,
      content: JSON.parse(row.content_json || '{}'),
      confirmed: Boolean(row.confirmed),
    };
    const updated = updateVisualBible(db, row.id, { content: current.content, confirmed: current.confirmed, revision: current.revision });
    if (updated) bibleCount += 1;
  }

  const shotRows = db.prepare(`
    SELECT s.*, sp.id AS plan_id, sp.project_id, sp.configuration_json, sp.director_analysis_json
    FROM segment_shots s
    JOIN segment_versions sv ON sv.id = s.segment_version_id
    JOIN storyboard_plans sp ON sp.id = s.storyboard_plan_id
    ORDER BY sp.created_at, sv.created_at, s.sequence
  `).all();

  for (const row of shotRows) {
    const plan = getStoryboardPlan(db, row.plan_id);
    if (!plan) continue;
    const bible = getLatestVisualBible(db, plan.project_id, plan.script_version_id);
    const beat = plan.director_analysis?.segments
      ?.flatMap(item => item.beats || [])
      .find(item => item.beatId === row.beat_id);
    const editableShot = {
      plot: row.plot_text,
      shotSize: row.shot_size,
      movement: row.camera_movement,
      angle: row.camera_angle,
      focalLengthMm: row.focal_length_mm,
      composition: row.composition,
      purpose: row.narrative_purpose,
    };
    const spec = buildGenerationSpec(editableShot, beat, bible?.content || {}, plan.configuration || {});
    const bibleHash = visualBibleContentHash(bible?.content || {});
    const keyframePrompt = compileKeyframePrompt(editableShot, bible?.content || {}, plan.configuration || {}, spec);
    const motionPrompt = compileMotionPrompt(editableShot, bible?.content || {}, plan.configuration || {}, spec);
    const keyframeSignature = row.keyframe_signature || buildGenerationSignature({
      kind: 'keyframe', visualBibleHash: bibleHash, referenceAssetIds: spec.referenceAssetIds,
      promptCompilerVersion: 'keyframe-prompt-v1', prompt: keyframePrompt,
    });
    const motionSignature = row.motion_signature || buildGenerationSignature({
      kind: 'motion', visualBibleHash: bibleHash, referenceAssetIds: spec.referenceAssetIds,
      keyframeSignature, promptCompilerVersion: 'motion-prompt-v1', prompt: motionPrompt,
    });
    updateSegmentShot(db, row.id, {
      prompt_zh: motionPrompt,
      generation_spec_json: JSON.stringify(spec),
      keyframe_prompt_zh: keyframePrompt,
      keyframe_status: row.keyframe_status || (row.selected_keyframe_asset_id ? 'confirmed' : 'missing'),
      keyframe_signature: keyframeSignature,
      motion_signature: motionSignature,
      updated_at: new Date().toISOString(),
    });
    shotCount += 1;
  }

  console.log(JSON.stringify({ databasePath, bibleCount, shotCount, schemaVersion: 7 }, null, 2));
} finally {
  closeDatabase(db);
}