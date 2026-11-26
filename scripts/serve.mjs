import { createServer, request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const upstream = new URL(process.env.OLYMP_ORIGIN || 'http://127.0.0.1:8787');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png' };
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
  try {
    const file = resolve(root, '.' + decodeURIComponent(path) + (path.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(resolve(root) + sep)) throw Error();
    const body = await readFile(file);
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(Number(process.env.PORT ?? 8000), '127.0.0.1', () => {
    console.log('Vizint listening on http://127.0.0.1:' + server.address().port);
  });
}
