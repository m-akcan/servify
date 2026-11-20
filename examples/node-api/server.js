// Zero-dependency demo API. Servify detects Node, builds it, injects PORT.
const http = require('node:http');
const os = require('node:os');
const port = process.env.PORT || 3000;
let hits = 0;
http
  .createServer((req, res) => {
    hits++;
    if (req.url === '/healthz') return res.end('ok');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hello: 'from servify', replica: process.env.SERVIFY_REPLICA_INDEX, host: os.hostname(), hits, redis: !!process.env.REDIS_URL }));
  })
  .listen(port, () => console.log(`node-api listening on :${port}`));
