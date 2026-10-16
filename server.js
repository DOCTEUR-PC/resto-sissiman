const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3002;
const DIR = __dirname;
const TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(DIR, urlPath === '/' ? 'index.html' : urlPath);
    const ext = path.extname(filePath);
    const rel = path.relative(DIR, filePath);
    if (rel.startsWith('..') || rel.split(path.sep).some(p => p.startsWith('.')) || !TYPES[ext]) {
        res.writeHead(404); res.end('Not found'); return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[ext] || 'text/plain' });
        res.end(data);
    });
}).listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
