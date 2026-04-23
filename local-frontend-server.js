const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const port = Number(process.env.FRONTEND_PORT || 8080);
const siteRoot = __dirname;
const tokenRoutes = new Set(['/', '/index.html', '/hype', '/hype/', '/lit', '/lit/', '/pump', '/pump/', '/sky', '/sky/', '/aave', '/aave/']);
const fileRouteMap = new Map([
  ['/docs', 'docs.html'],
  ['/docs.html', 'docs.html'],
  ['/admin', 'admin.html'],
  ['/admin.html', 'admin.html'],
]);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
};

function sendFile(filePath, res) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error.code === 'ENOENT' ? 'File not found.' : 'Internal server error.');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, `http://localhost:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  if (tokenRoutes.has(pathname)) return path.join(siteRoot, 'index.html');
  if (fileRouteMap.has(pathname)) return path.join(siteRoot, fileRouteMap.get(pathname));

  const normalized = path.normalize(pathname).replace(/^([.][.][\/])+/, '');
  const candidate = path.join(siteRoot, normalized);
  if (!candidate.startsWith(siteRoot)) return null;

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  const htmlCandidate = `${candidate}.html`;
  if (fs.existsSync(htmlCandidate) && fs.statSync(htmlCandidate).isFile()) {
    return htmlCandidate;
  }

  return null;
}

http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request.');
    return;
  }

  const filePath = resolveRequestPath(req.url);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File not found.');
    return;
  }

  sendFile(filePath, res);
}).listen(port, '0.0.0.0', () => {
  console.log(`[Local Frontend] Serving ${siteRoot} on http://localhost:${port}`);
});