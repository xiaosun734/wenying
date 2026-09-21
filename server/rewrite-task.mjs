import { randomUUID } from 'node:crypto';
import {
  createScriptVersion,
  createSegment,
  getProject,
  getTask,
  listSegments,
  timestamp,
  transaction,
  updateProject,
  updateTask,
  estimateDurationMs,
} from './db.mjs';
import { auditText, cleanSourceText } from './safety.mjs';
import { validateRewriteResult } from './providers/openai-compatible.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RewriteTaskRunner {
  constructor({ db, provider, logger = console }) {
    this.db = db;
    this.provider = provider;
    this.logger = logger;
    this.queue = [];
    this.running = false;
  }

  enqueue(taskId) {                      //任务入队
    if (!this.queue.includes(taskId)) this.queue.push(taskId);            //去重，防止重复入队
    void this.drain();
  }

  async drain() {                         // 队列消费
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const taskId = this.queue.shift();
        await this.run(taskId);                      //串行执行：一次只运行一个任务，下一个任务等待上一个完成
      }
    } finally {
      this.running = false;                          //确保 running 标志被重置
    }
  }

  async run(taskId) {                             //核心执行流程
    const task = getTask(this.db, taskId);
    if (!task || !['pending', 'running'].includes(task.status)) return;
    const project = getProject(this.db, task.project_id);
    if (!project) return;
    const startedAt = task.started_at || timestamp();
    updateTask(this.db, task.id, {
      status: 'running',
      current_step: 'preparing',
      progress: 5,
      started_at: startedAt,
      updated_at: timestamp(),
      error_code: null,
      error_message: null,
    });
    updateProject(this.db, project.id, { status: 'script_processing', updated_at: timestamp() });

    try {
      const sourceText = cleanSourceText(project.source_text || '');
      if (!sourceText) {
        throw Object.assign(new Error('原文保存已过期，请重新提交正文'), { code: 'SOURCE_EXPIRED', retryable: false });
      }
      const sourceAudit = auditText(sourceText);
      if (!sourceAudit.ok) throw Object.assign(new Error(sourceAudit.message), { code: sourceAudit.code, retryable: false });

      updateTask(this.db, task.id, { current_step: 'rewriting', progress: 25, updated_at: timestamp() });
      const result = await this.provider.rewrite({
        sourceText,
        background: cleanSourceText(project.background || ''),
        genre: project.genre,
        promptVersion: task.prompt_version,
        idempotencyKey: task.idempotency_key,
      });

      updateTask(this.db, task.id, { current_step: 'segmenting', progress: 72, updated_at: timestamp() });
      const normalized = validateRewriteResult(result);
      const outputAudit = auditText(`${normalized.cleanedText}\n${normalized.segments.map(segment => segment.scriptText).join('\n')}`);
      if (!outputAudit.ok) throw Object.assign(new Error(outputAudit.message), { code: outputAudit.code, retryable: false });

      updateTask(this.db, task.id, { current_step: 'validating', progress: 90, updated_at: timestamp() });
      const versionId = randomUUID();
      transaction(this.db, () => {
        createScriptVersion(this.db, {
          id: versionId,
          projectId: project.id,
          source: 'ai',
          immutable: false,
          promptVersion: task.prompt_version,
          provider: normalized.provider,
          model: normalized.model,
          cleanedText: normalized.cleanedText,
          usage: normalized.usage,
        });
        normalized.segments.forEach(segment => createSegment(this.db, {
          id: randomUUID(),
          projectId: project.id,
          scriptVersionId: versionId,
          sequence: segment.sequence,
          title: segment.title,
          scriptText: segment.scriptText,
          summary: segment.summary,
          durationMs: estimateDurationMs(segment.scriptText),
        }));
        updateProject(this.db, project.id, {
          status: 'script_ready',
          draft_script_version_id: versionId,
          updated_at: timestamp(),
        });
        updateTask(this.db, task.id, {
          status: 'succeeded',
          current_step: 'completed',
          progress: 100,
          completed_at: timestamp(),
          updated_at: timestamp(),
        });
      });
    } catch (error) {
      const code = error.code || 'SCRIPT_PROVIDER_FAILED';
      const message = error.message || '文案生成失败，请稍后重试；本次未扣视频额度';
      updateTask(this.db, task.id, {
        status: 'failed',
        current_step: 'failed',
        error_code: code,
        error_message: ['CONTENT_REVIEW_REJECTED', 'SOURCE_EXPIRED'].includes(code) ? message : '文案生成失败，请稍后重试；本次未扣视频额度',
        updated_at: timestamp(),
      });
      updateProject(this.db, project.id, { status: 'script_failed', updated_at: timestamp() });
      const detail = this.provider.lastProviderMessage ? ` (${this.provider.lastProviderMessage})` : '';
      this.logger.error?.(`[rewrite-task] ${task.id} failed: ${code}${detail}`);
    }
  }

  retry(taskId) {
    const task = getTask(this.db, taskId);
    if (!task || task.status !== 'failed') return null;
    updateTask(this.db, task.id, {
      status: 'pending',
      current_step: 'queued',
      progress: 0,
      retry_count: task.retry_count + 1,
      error_code: null,
      error_message: null,
      started_at: null,
      completed_at: null,
      updated_at: timestamp(),
    });
    updateProject(this.db, task.project_id, { status: 'script_processing', updated_at: timestamp() });
    this.enqueue(task.id);
    return getTask(this.db, task.id);
  }

  recover(taskIds) {
    taskIds.forEach(taskId => this.enqueue(taskId));
  }
}

export async function waitForTask(runner, taskId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = getTask(runner.db, taskId);
    if (task && ['succeeded', 'failed'].includes(task.status)) return task;
    await sleep(25);
  }
  return getTask(runner.db, taskId);
}
