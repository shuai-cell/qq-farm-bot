/* Download HTTPS resources discovered by protocol-capture activities/index.jsonl.
 * Usage: pnpm -C core exec tsx ../tools/download-captured-activity-assets.js <capture-root> [--max-bytes=52428800]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const captureRoot = path.resolve(process.argv[2] || '');
const indexFileArg = process.argv.find(arg => arg.startsWith('--index-file='));
const externalIndexFile = indexFileArg ? path.resolve(indexFileArg.slice('--index-file='.length)) : '';
const outputDirArg = process.argv.find(arg => arg.startsWith('--out-dir='));
const outputDir = outputDirArg ? path.resolve(outputDirArg.slice('--out-dir='.length)) : captureRoot;
const assetRoot = externalIndexFile ? outputDir : path.join(captureRoot, 'assets');
const maxBytes = Number(process.argv.find(arg => arg.startsWith('--max-bytes='))?.split('=')[1]) || 50 * 1024 * 1024;
const maxTotalBytes = Number(process.argv.find(arg => arg.startsWith('--max-total-bytes='))?.split('=')[1]) || Number(process.env.FARM_PROTOCOL_CAPTURE_MAX_BYTES) || 1024 * 1024 * 1024;
const allowedTypes = /^(image\/(png|jpeg|webp|gif|svg\+xml)|application\/(json|octet-stream)|audio\/[\w.+-]+|video\/[\w.+-]+|font\/[\w.+-]+)$/i;
function safeName(value) { return String(value || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 100) || 'unknown'; }
function privateAddress(address) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('::ffff:127.') || a.startsWith('::ffff:10.') || a.startsWith('::ffff:192.168.')) return true;
    const p = a.split('.').map(Number);
    return p.length === 4 && (p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] >= 224);
}
async function validateUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only credential-free HTTPS URLs are accepted');
    const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!records.length || records.some(record => privateAddress(record.address))) throw new Error('URL resolves to a non-public address');
    return url;
}
function download(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 3) return reject(new Error('Too many redirects'));
        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(url, { timeout: 15000, headers: { 'user-agent': 'qq-farm-activity-assets/1.0' }, lookup(hostname, options, callback) {
            dns.lookup(hostname, { all: true, verbatim: true }).then(records => {
                if (!records.length || records.some(record => privateAddress(record.address))) return callback(new Error('URL resolves to a non-public address'));
                if (options?.all) callback(null, records);
                else callback(null, records[0].address, records[0].family);
            }, callback);
        } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                try { const next = new URL(response.headers.location, url); validateUrl(next.href).then(value => download(value, redirectCount + 1)).then(resolve, reject); } catch (error) { reject(error); }
                return;
            }
            const type = String(response.headers['content-type'] || '').split(';')[0].trim();
            const declared = Number(response.headers['content-length'] || 0);
            if (response.statusCode !== 200 || !allowedTypes.test(type) || (declared && declared > maxBytes)) { response.resume(); reject(new Error(`Rejected response: status=${response.statusCode} type=${type} length=${declared}`)); return; }
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > maxBytes) req.destroy(new Error('Response exceeds byte limit')); else chunks.push(chunk); });
            response.on('end', () => resolve({ body: Buffer.concat(chunks), contentType: type }));
            response.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Download timeout')));
        req.on('error', reject);
    });
}
async function main() {
    if ((!captureRoot || !fs.existsSync(captureRoot)) && !externalIndexFile) throw new Error('Capture root does not exist');
    if (externalIndexFile && !fs.existsSync(externalIndexFile)) throw new Error('Helper activity index does not exist');
    fs.mkdirSync(assetRoot, { recursive: true });
    const entries = [];
    if (externalIndexFile) {
        const document = JSON.parse(fs.readFileSync(externalIndexFile, 'utf8'));
        const sourceRows = Array.isArray(document.resources) ? document.resources : document.activities;
        if (!Array.isArray(sourceRows)) throw new Error('Helper activity index is invalid');
        for (const row of sourceRows) {
            const activityId = (row.activityIds || ['unknown'])[0];
            const version = row.clientVersion || 'helper-session';
            for (const resourceUrl of row.urls || []) entries.push({ activityId, version, resourceUrl, resourcePath: '' });
            for (const resourcePath of row.resourcePaths || []) entries.push({ activityId, version, resourceUrl: '', resourcePath });
        }
    }
    if (!externalIndexFile && captureRoot && fs.existsSync(captureRoot)) for (const day of fs.readdirSync(captureRoot, { withFileTypes: true }).filter(item => item.isDirectory())) {
        const dayPath = path.join(captureRoot, day.name);
        for (const session of fs.readdirSync(dayPath, { withFileTypes: true }).filter(item => item.isDirectory())) {
            const index = path.join(dayPath, session.name, 'activities', 'index.jsonl');
            if (!fs.existsSync(index)) continue;
            for (const line of fs.readFileSync(index, 'utf8').split(/\r?\n/).filter(Boolean)) {
                try { const row = JSON.parse(line); for (const resourceUrl of row.urls || []) entries.push({ activityId: (row.activityIds || ['unknown'])[0], version: row.clientVersion || 'unknown', resourceUrl }); } catch {}
            }
        }
    }
    const seen = new Set(); const manifest = [];
    let downloadedBytes = 0;
    for (const item of entries) {
        if (!item.resourceUrl) {
            manifest.push({ ...item, status: 'unresolved', error: '仅有 Cocos 资源路径；尚未配置匹配该游戏版本的资源 manifest' });
            continue;
        }
        if (seen.has(item.resourceUrl)) continue;
        seen.add(item.resourceUrl);
        try {
            const url = await validateUrl(item.resourceUrl);
            const result = await download(url);
            if (downloadedBytes + result.body.length > maxTotalBytes) throw new Error('Capture asset disk budget exceeded');
            downloadedBytes += result.body.length;
            const hash = crypto.createHash('sha256').update(result.body).digest('hex');
            if (item.expectedSha256 && hash !== item.expectedSha256) throw new Error('SHA-256 does not match the bundled resource manifest');
            const dir = path.join(assetRoot, safeName(item.activityId), safeName(item.version));
            fs.mkdirSync(dir, { recursive: true });
            const ext = path.extname(url.pathname).slice(0, 12) || '.bin';
            const filename = `${hash.slice(0, 16)}${ext}`;
            const target = path.join(dir, filename);
            if (!fs.existsSync(target)) fs.writeFileSync(target, result.body, { flag: 'wx' });
            manifest.push({ ...item, file: path.relative(outputDir, target).split(path.sep).join('/'), contentType: result.contentType, size: result.body.length, sha256: hash });
        } catch (error) { manifest.push({ ...item, error: String(error.message || error) }); }
    }
    const manifestPath = path.join(assetRoot, 'manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    let previous = [];
    try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).resources || []; } catch {}
    const merged = new Map(previous.map(item => [`${item.activityId}|${item.version}|${item.resourceUrl}|${item.sha256 || ''}`, item]));
    for (const item of manifest) merged.set(`${item.activityId}|${item.version}|${item.resourceUrl}|${item.sha256 || ''}`, item);
    fs.writeFileSync(manifestPath, JSON.stringify({ updatedAt: new Date().toISOString(), resources: [...merged.values()] }, null, 2));
    console.log(JSON.stringify({ discovered: entries.length, downloaded: manifest.filter(item => item.sha256).length, failed: manifest.filter(item => item.error).length, manifest: manifestPath }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
