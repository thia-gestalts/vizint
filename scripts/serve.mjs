import { createServer, request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { open, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const upstream = new URL(process.env.OLYMP_ORIGIN || 'http://127.0.0.1:8787');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png',
  '.vzpk': 'application/octet-stream' };

// Views have an opaque origin and read packs in byte ranges, so dataset
// files allow any origin and answer Range requests.
function datasetHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}
export const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/v1/')) {
    const forward = (upstream.protocol === 'https:' ? secureRequest : request)(upstream, {
      path, method: req.method, headers: { ...req.headers, host: upstream.host },
    }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    forward.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(forward);
    return;
  }
  const dataset = path.startsWith('/datasets/');
  if (dataset) datasetHeaders(res);
  if (dataset && req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const file = resolve(root, '.' + decodeURIComponent(path) + (path.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(resolve(root) + sep)) throw Error();
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    const range = dataset && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (!range) {
      res.end(await readFile(file));
      return;
    }
    const handle = await open(file);
    try {
      const { size } = await handle.stat();
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1);
      if (start >= size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const { buffer } = await handle.read(Buffer.alloc(end - start + 1), 0, end - start + 1, start);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': buffer.length });
      res.end(buffer);
    } finally {
      await handle.close();
    }
  } catch { res.writeHead(404); res.end(); }
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(Number(process.env.PORT ?? 8000), '127.0.0.1', () => {
    console.log('Vizint listening on http://127.0.0.1:' + server.address().port);
  });
}
