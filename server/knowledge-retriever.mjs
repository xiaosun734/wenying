import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listKnowledgeBases, listKnowledgeItems, upsertKnowledgeBase, upsertKnowledgeItem } from './db.mjs';

export const RETRIEVAL_STRATEGY_VERSION = 'hybrid-tags-text-v1';

export async function seedKnowledgeDirectory(db, directory) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  for (const filename of files) {
    const knowledgeBase = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    validateKnowledgeBase(knowledgeBase, filename);
    upsertKnowledgeBase(db, knowledgeBase);
    for (const item of knowledgeBase.items) {
      const normalized = JSON.stringify({ title: item.title, content: item.content, tags: item.tags || {}, constraints: item.constraints || {} });
      upsertKnowledgeItem(db, {
        ...item,
        knowledgeBaseId: knowledgeBase.id,
        source: item.source || `${knowledgeBase.name}@${knowledgeBase.version}`,
        contentHash: createHash('sha256').update(normalized).digest('hex'),
      });
    }
  }
  return listKnowledgeBases(db);
}

export class KnowledgeRetriever {
  constructor({ db, topK = 6 } = {}) {
    this.db = db;
    this.topK = topK;
  }

  snapshot() {
    return {
      strategyVersion: RETRIEVAL_STRATEGY_VERSION,
      knowledgeBases: listKnowledgeBases(this.db).map(item => ({ id: item.id, version: item.version })),
    };
  }

  retrieve(query, { baseIds = [], topK = this.topK } = {}) {
    const queryText = flattenText(query);
    const queryNgrams = ngrams(queryText);
    return listKnowledgeItems(this.db, baseIds)
      .filter(item => passesConstraints(item.constraints, query))
      .map(item => {
        const tagText = flattenText(item.tags);
        const contentText = `${item.title}${item.content}${tagText}`;
        const tagScore = tagMatches(query, item.tags);
        const textScore = dice(queryNgrams, ngrams(contentText));
        const score = tagScore * 0.55 + textScore * 0.3 + Number(item.priority || 0.5) * 0.15;
        return {
          id: item.id,
          knowledgeBaseId: item.knowledge_base_id,
          title: item.title,
          content: item.content,
          tags: item.tags,
          source: item.source,
          score: Number(score.toFixed(4)),
        };
      })
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, topK));
  }
}

function validateKnowledgeBase(value, filename) {
  if (!value?.id || !value?.name || !value?.version || !Array.isArray(value.items)) {
    throw new Error(`知识库格式无效: ${filename}`);
  }
  for (const item of value.items) {
    if (!item?.id || !item?.title || !item?.content) throw new Error(`知识条目格式无效: ${filename}`);
  }
}

function passesConstraints(constraints = {}, query = {}) {
  const durationMs = Number(query.durationMs || 0);
  const subjectCount = Number(query.subjectCount || 0);
  if (constraints.minDurationMs && durationMs && durationMs < constraints.minDurationMs) return false;
  if (constraints.maxDurationMs && durationMs && durationMs > constraints.maxDurationMs) return false;
  if (constraints.minSubjects && subjectCount && subjectCount < constraints.minSubjects) return false;
  if (constraints.maxSubjects && subjectCount && subjectCount > constraints.maxSubjects) return false;
  return true;
}

function tagMatches(query, tags) {
  const queryValues = scalarValues(query);
  const tagValues = scalarValues(tags);
  if (!queryValues.length || !tagValues.length) return 0;
  let matches = 0;
  for (const queryValue of queryValues) {
    if (tagValues.some(tag => tag === queryValue || tag.includes(queryValue) || queryValue.includes(tag))) matches += 1;
  }
  return matches / Math.max(queryValues.length, 1);
}

function scalarValues(value) {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(scalarValues);
  if (typeof value === 'string') return value.split(/[\s,，、/]+/).map(item => item.trim()).filter(Boolean);
  return [];
}

function flattenText(value) {
  return scalarValues(value).join('').toLowerCase();
}

function ngrams(text) {
  const cleaned = String(text || '').replace(/\s+/g, '');
  const set = new Set();
  for (let index = 0; index < cleaned.length - 1; index += 1) set.add(cleaned.slice(index, index + 2));
  return set;
}

function dice(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}
