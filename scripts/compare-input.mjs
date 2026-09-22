#!/usr/bin/env node
/** 对比 ComfyUI input 目录里的上传参考图，和本地源文件是否同一张。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const [subfolder, filename, localRelative] = process.argv.slice(2);
if (!subfolder || !filename || !localRelative) {
  console.error('用法：node scripts/compare-input.mjs <subfolder> <filename> <本地文件相对路径>');
  process.exit(1);
}
const env = Object.fromEntries(readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)
  .filter(line => /^\s*[A-Za-z_]/.test(line))
  .map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, '')];
  }));
const baseUrl = String(env.COMFYUI_BASE_URL || '').replace(/\/+$/, '');
const params = new URLSearchParams({ filename, subfolder, type: 'input' });
const response = await fetch(`${baseUrl}/view?${params}`);
if (!response.ok) {
  console.error('拉取失败', response.status);
  process.exit(1);
}
const remote = Buffer.from(await response.arrayBuffer());
const local = readFileSync(resolve(root, localRelative));
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
console.log('ComfyUI input:', subfolder + '/' + filename);
console.log('  ', remote.readUInt32BE(16) + 'x' + remote.readUInt32BE(20), remote.length, hash(remote).slice(0, 16));
console.log('本地源文件:', localRelative);
console.log('  ', local.readUInt32BE(16) + 'x' + local.readUInt32BE(20), local.length, hash(local).slice(0, 16));
console.log('  同一张:', hash(remote) === hash(local));
