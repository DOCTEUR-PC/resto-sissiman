const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3002;
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
    let filePath = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[ext] || 'text/plain' });
        res.end(data);
    });
}).listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
