import http from 'node:http';
import { createReadStream, readFile, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, relative as relativePathFn, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase, recoverRunningTasks, recoverRunningGenerationTasks, recoverRunningExportTasks, recoverRunningStoryboardTasks, clearExpiredSources } from './server/db.mjs';
import { createApi } from './server/api.mjs';
import { RewriteTaskRunner } from './server/rewrite-task.mjs';
import { createTextProvider } from './server/providers/openai-compatible.mjs';
import { createMediaProvider } from './server/providers/media.mjs';
import { MediaTaskRunner } from './server/media-task.mjs';
import { createComposerProvider } from './server/providers/composer.mjs';
import { createTtsProvider } from './server/providers/tts.mjs';
import { createSubtitleProvider } from './server/providers/subtitles.mjs';
import { ExportTaskRunner } from './server/export-task.mjs';
import { KnowledgeRetriever, seedKnowledgeDirectory } from './server/knowledge-retriever.mjs';
import { StoryboardTaskRunner } from './server/storyboard-task.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
loadDotEnv();

const port = Number(process.env.PORT || 4173);
const databasePath = resolve(process.env.DATABASE_PATH || join(root, 'data', 'wenying.sqlite'));
const mediaRoot = resolve(root, process.env.MEDIA_OUTPUT_DIR || join('data', 'media'));
process.env.MEDIA_OUTPUT_DIR = mediaRoot;
if (process.env.COMFYUI_WORKFLOW_PATH && !isAbsolute(process.env.COMFYUI_WORKFLOW_PATH)) {
  process.env.COMFYUI_WORKFLOW_PATH = resolve(root, process.env.COMFYUI_WORKFLOW_PATH);
}
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const db = await openDatabase(databasePath);
await seedKnowledgeDirectory(db, join(root, 'knowledge'));
clearExpiredSources(db);
const sourceCleanupTimer = setInterval(() => clearExpiredSources(db), 60 * 60 * 1000);
sourceCleanupTimer.unref();
const provider = createTextProvider();
const runner = new RewriteTaskRunner({ db, provider });
runner.recover(recoverRunningTasks(db));
const knowledgeRetriever = new KnowledgeRetriever({ db });
const storyboardRunner = new StoryboardTaskRunner({ db, provider, retriever: knowledgeRetriever });
storyboardRunner.recover(recoverRunningStoryboardTasks(db));
const mediaProvider = createMediaProvider();
const composer = createComposerProvider({ mediaRoot });
const ttsProvider = createTtsProvider({ mediaRoot });
const subtitleProvider = createSubtitleProvider({ mediaRoot });
const mediaRunner = new MediaTaskRunner({ db, provider: mediaProvider, ttsProvider, subtitleProvider, textProvider: provider, composer });
mediaRunner.recover(recoverRunningGenerationTasks(db));
const exportRunner = new ExportTaskRunner({ db, mediaRoot, ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH || 'ffprobe' });
exportRunner.recover(recoverRunningExportTasks(db));
const handleApi = createApi({ db, runner, provider, mediaRunner, mediaProvider, exportRunner, storyboardRunner });

const server = http.createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }
  if (pathname === '/media' || pathname.startsWith('/media/')) {
    await serveMedia(req, res, pathname, mediaRoot);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const relative = pathname === '/' ? '/index.html' : (pathname === '/admin' || pathname === '/admin/' ? '/admin.html' : pathname);
  const filePath = normalize(join(root, relative));
  const relativePath = relativePathFn(root, filePath);
  if (filePath !== root && (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const body = await new Promise((resolveRead, reject) => readFile(filePath, (error, data) => error ? reject(error) : resolveRead(data)));
    res.writeHead(200, {
      'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`文影服务已启动：http://127.0.0.1:${port}`);
  console.log(`文案 Provider：${provider.provider}/${provider.model}`);
  console.log(`媒体 Provider：${mediaProvider.provider}/${mediaProvider.model}`);
});

async function serveMedia(req, res, pathname, mediaDirectory) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  const requested = pathname.slice('/media/'.length);
  const filePath = normalize(join(mediaDirectory, requested));
  const relativePath = relativePathFn(mediaDirectory, filePath);
  if (
    !requested ||
    filePath !== mediaDirectory &&
    (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath))
  ) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const contentType = mime[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = parseRange(req.headers.range, fileStat.size);
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (!range) {
    headers['Content-Length'] = fileStat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(filePath).pipe(res);
    return;
  }
  headers['Content-Range'] = `bytes ${range.start}-${range.end}/${fileStat.size}`;
  headers['Content-Length'] = range.end - range.start + 1;
  res.writeHead(206, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
}

function parseRange(header, size) {
  if (!header || !header.startsWith('bytes=') || !size) return null;
  const [rawStart, rawEnd] = header.slice(6).split('-', 2);
  let start = rawStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd || 0));
  let end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

async function shutdown() {
  clearInterval(sourceCleanupTimer);
  await new Promise(resolveClose => server.close(resolveClose));
  closeDatabase(db);
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

function loadDotEnv() {
  const envPath = join(root, '.env');
  try {
    const contents = readFileSync(envPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = decodeDotEnvValue(match[2]);
    }
  } catch {
    // .env is optional; deployment environments can provide process variables.
  }
}

function decodeDotEnvValue(value) {
  return String(value)
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}
