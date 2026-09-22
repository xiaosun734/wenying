#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const objectKey = process.argv[2];
if (!objectKey) {
  console.error('用法：node scripts/compare-output.mjs <objectKey>');
  process.exit(1);
}

const db = new DatabaseSync(resolve(root, 'data', 'wenying.sqlite'), { readOnly: true });
const row = db.prepare('SELECT metadata_json FROM media_assets WHERE object_key = ?').get(objectKey);
if (!row) {
  console.error('DB 里没有这条 objectKey');
  process.exit(1);
}
const meta = JSON.parse(row.metadata_json);
const localPath = resolve(root, 'data', 'media', objectKey);
const local = readFileSync(localPath);
console.log('本地文件:', localPath);
console.log('  尺寸', local.readUInt32BE(16) + 'x' + local.readUInt32BE(20), '字节', local.length);
console.log('  本地 sha256', createHash('sha256').update(local).digest('hex'));
console.log('  DB sha256  ', meta.sha256);

const env = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)
  .filter(line => /^\s*[A-Za-z_]/.test(line))
  .map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, '')];
  }));
const baseUrl = String(env.COMFYUI_BASE_URL || '').replace(/\/+$/, '');
const params = new URLSearchParams({ filename: meta.filename, subfolder: meta.subfolder || '', type: meta.type || 'output' });
const response = await fetch(`${baseUrl}/view?${params}`);
const remote = Buffer.from(await response.arrayBuffer());
console.log('ComfyUI 输出:', meta.filename);
console.log('  尺寸', remote.readUInt32BE(16) + 'x' + remote.readUInt32BE(20), '字节', remote.length);
console.log('  sha256', createHash('sha256').update(remote).digest('hex'));
console.log('  与本地一致:', createHash('sha256').update(remote).digest('hex') === createHash('sha256').update(local).digest('hex'));

mkdirSync(resolve(root, 'tmp-test'), { recursive: true });
const target = resolve(root, 'tmp-test', 'remote-' + meta.filename);
writeFileSync(target, remote);
console.log('  已另存:', target);
console.log('promptId:', meta.promptId);
console.log('seed:', meta.seed, 'width/height:', meta.width, meta.height);
