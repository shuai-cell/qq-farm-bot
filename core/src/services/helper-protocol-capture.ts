export {};
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const protobuf = require('protobufjs');
const { getResourcePath } = require('../config/runtime-paths');
const { mapExternalResources } = require('./helper-resource-mappings');

const FRAME_RE = /^\d+-(?:send|recv)\.bin$/;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 10000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MANIFEST_FILE_PATTERN = /^\d+-(?:send|recv)\.bin$/;

let rootPromise: Promise<any> | null = null;
function getRoot(): Promise<any> {
    if (!rootPromise) {
        rootPromise = (async () => {
            const root = new protobuf.Root();
            const protoDir = getResourcePath('proto');
            const files = fs.readdirSync(protoDir).filter((name: string) => name.endsWith('.proto')).map((name: string) => path.join(protoDir, name));
            await root.load(files, { keepCase: true });
            return root;
        })().catch((error: Error) => { rootPromise = null; throw error; });
    }
    return rootPromise;
}
const sha256 = (value: Buffer): string => crypto.createHash('sha256').update(value).digest('hex');
const cleanId = (value: unknown): string => String(value ?? '').replace(/[^\w.-]/g, '_').slice(0, 80);
function decodeBytes(value: Buffer, depth = 0): unknown {
    if (depth > 24) return value.toString('base64');
    const text = value.toString('utf8');
    if (!text.includes('\uFFFD')) {
        try { if (/^\s*(?:\{|\[)/.test(text)) return decodeEmbedded(JSON.parse(text), depth + 1); } catch {}
    }
    return value.toString('base64');
}
function decodeEmbedded(value: unknown, depth = 0): unknown {
    if (depth > 24 || value == null) return value;
    if (Buffer.isBuffer(value)) return decodeBytes(value, depth + 1);
    if (typeof value === 'string') {
        if (value.length > 100000) return `${value.slice(0, 100000)}…[truncated]`;
        if (value.length >= 8 && value.length % 4 === 0 && /^[\w+/]+={0,2}$/.test(value)) {
            try {
                const bytes = Buffer.from(value, 'base64'); const text = bytes.toString('utf8');
                if (!text.includes('\uFFFD') && /^\s*(?:\{|\[)/.test(text)) return decodeEmbedded(JSON.parse(text), depth + 1);
            } catch {}
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(item => decodeEmbedded(item, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, decodeEmbedded(child, depth + 1)]));
    return value;
}
function redact(value: unknown, key = '', depth = 0): unknown {
    if (depth > 24) return '[depth-limit]';
    if (/(?:^|_)(?:token|cookie|password|secret|authorization|open.?id|gid|qq|code)(?:_|$)/i.test(key)) return '[redacted]';
    if (Array.isArray(value)) return value.map(item => redact(item, key, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey, depth + 1)]));
    if (typeof value === 'string' && value.length > 100000) return `${value.slice(0, 100000)}…[truncated]`;
    return value;
}
function discoverResources(value: unknown, depth = 0): { urls: string[]; resourcePaths: string[] } {
    const urls = new Set<string>(); const paths = new Set<string>();
    const visit = (item: any, key = '', level = depth) => {
        if (level > 24 || item == null) return;
        if (typeof item === 'string') {
            for (const raw of item.match(/https?:\/\/[^\s"'<>\\]+/g) || []) {
                try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password) urls.add(url.toString()); } catch {}
            }
            if (/(?:^|_)(?:res|resource|icon|image|path)(?:_|$)|(?:url|uri)$/i.test(key) && item.length < 1024 && !/^https?:\/\//i.test(item) && /^[\w./-]+$/.test(item)) paths.add(item);
        } else if (Array.isArray(item)) item.forEach(child => visit(child, key, level + 1));
        else if (typeof item === 'object') Object.entries(item).forEach(([childKey, child]) => visit(child, childKey, level + 1));
    };
    visit(value);
    return { urls: [...urls], resourcePaths: [...paths] };
}
function collectIds(value: any, ids = new Set<string>(), depth = 0): Set<string> {
    if (depth > 24 || !value || typeof value !== 'object') return ids;
    for (const key of ['activity_id', 'id']) if (value[key] !== undefined && /^(?:\d{6,}|202\d)/.test(String(value[key]))) ids.add(cleanId(value[key]));
    Object.values(value).forEach(child => collectIds(child, ids, depth + 1));
    return ids;
}
function wireSummary(body: Buffer, depth = 0): any[] {
    if (depth > 8) return [{ depthLimit: true, byteLength: body.length }];
    const reader = protobuf.Reader.create(body); const fields: any[] = [];
    try {
        while (reader.pos < reader.len && fields.length < 256) {
            const tag = reader.uint32(); const field = tag >>> 3; const wire = tag & 7;
            if (!field) throw new Error('invalid protobuf field');
            if (wire === 0) fields.push({ field, wire, value: reader.uint64().toString() });
            else if (wire === 1) { const raw = Buffer.from(reader.buf.subarray(reader.pos, reader.pos + 8)); reader.fixed64(); fields.push({ field, wire, byteLength: 8, sha256: sha256(raw) }); }
            else if (wire === 2) {
                const raw = Buffer.from(reader.bytes()); const entry: any = { field, wire, byteLength: raw.length, sha256: sha256(raw) };
                const text = raw.toString('utf8');
                if (text && !text.includes('\uFFFD') && Array.from(text).filter((char: string) => /[\p{L}\p{N}\p{P}\p{S}\s]/u.test(char)).length / Array.from(text).length > 0.92) entry.textPreview = text.slice(0, 512);
                if (raw.length && depth < 8) { try { entry.nested = wireSummary(raw, depth + 1); } catch {} }
                fields.push(entry);
            }
            else if (wire === 5) { const raw = Buffer.from(reader.buf.subarray(reader.pos, reader.pos + 4)); reader.fixed32(); fields.push({ field, wire, byteLength: 4, sha256: sha256(raw) }); }
            else throw new Error(`unsupported protobuf wire ${wire}`);
        }
    } catch (error) { return [{ parseError: String((error as Error).message), byteLength: body.length, sha256: sha256(body) }]; }
    return fields;
}
function parseFrame(bytes: Buffer, filename: string, row: any, types: any): any | null {
    if (!bytes.length || bytes.length > MAX_FRAME_BYTES) return null;
    let message: any;
    try { message = types.GateMessage.decode(bytes); } catch { return null; }
    const meta = message.meta || {};
    if (Number(meta.message_type) !== 2 || (Number(meta.error_code) || 0) !== 0) return null;
    const service = String(meta.service_name || ''); const method = String(meta.method_name || '');
    const activityMessage = service === 'gamepb.activitypb.ActivityService' && ['List', 'GetGroup'].includes(method);
    const bulletinMessage = service === 'gamepb.bulletinboardpb.BulletinBoardService' && method === 'GetBulletinList';
    if (!activityMessage && !bulletinMessage) return null;
    const body = Buffer.from(message.body || []);
    if (!body.length) return null;
    let decoded: any; let alternate: any = null;
    try {
        const type = bulletinMessage ? types.BulletinListReply : method === 'List' ? types.ActivityListReply : types.GetGroupReply;
        decoded = type.toObject(type.decode(body), { longs: String, enums: String, bytes: String });
    } catch { return null; }
    if (method === 'List') {
        try {
            const muge = types.MugeListReply.toObject(types.MugeListReply.decode(body), { longs: String, enums: String, bytes: String });
            if (Array.isArray(muge.groups) && muge.groups.some((group: any) => String(group.head?.id || '').startsWith('20261117'))) alternate = muge;
        } catch {}
    }
    const expanded = decodeEmbedded(decoded); const expandedAlternate = alternate ? decodeEmbedded(alternate) : null;
    const ids = new Set([...collectIds(expanded), ...collectIds(expandedAlternate)]);
    const found = discoverResources(expanded); const alt = discoverResources(expandedAlternate);
    const bulletinExtra = (expanded as any)?.bulletins || [];
    for (const row of bulletinExtra) if (row?.image_url) found.urls.push(row.image_url);
    const wireText = body.toString('utf8');
    const wireUrls = (wireText.match(/https?:\/\/[^\s"'<>\\]+/g) || []).flatMap((raw: string) => { try { const parsed = new URL(raw); return parsed.protocol === 'https:' ? [parsed.toString()] : []; } catch { return []; } });
    const timestamp = Number(row?.timestamp_ms) || 0;
    return {
        sequence: Number(row?.sequence) || Number(filename.match(/^(\d+)/)?.[1]) || 0,
        connectionId: Number(row?.connection_id) || 0,
        timestamp: timestamp ? new Date(timestamp).toISOString() : '',
        direction: String(row?.direction || 'server_to_client'), file: filename, service, method,
        clientVersion: '', activityIds: [...ids], bodyBytes: body.length, bodySha256: sha256(body), bodyBase64: body.toString('base64'),
        rawWireFields: wireSummary(body), urls: [...new Set([...found.urls, ...alt.urls, ...wireUrls])], resourcePaths: [...new Set([...found.resourcePaths, ...alt.resourcePaths])],
        bulletins: bulletinExtra.map((item: any) => ({ id: String(item.id || ''), title: item.title || '', resourceUrl: item.image_url || '' })).filter((item: any) => item.resourceUrl),
        decoded: redact(expanded), alternateDecoded: expandedAlternate ? redact(expandedAlternate) : null,
    };
}
function readManifest(sessionDirectory: string): Map<string, any> {
    const manifestPath = path.join(sessionDirectory, 'manifest.jsonl');
    if (!fs.existsSync(manifestPath)) return new Map();
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Helper manifest 超过扫描上限');
    const rows = new Map<string, any>();
    for (const line of fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).slice(-MAX_FILES)) {
        if (!line) continue;
        try { const row = JSON.parse(line); if (typeof row.file === 'string' && FRAME_RE.test(row.file)) rows.set(row.file, row); } catch {}
    }
    return rows;
}
async function scanHelperSession(inputPath: string) {
    const sessionDirectory = path.resolve(String(inputPath || '').trim());
    if (!fs.existsSync(sessionDirectory) || !fs.statSync(sessionDirectory).isDirectory()) throw new Error('Helper 会话目录不存在');
    const sessionMetadata = (() => { try { return JSON.parse(fs.readFileSync(path.join(sessionDirectory, 'session.json'), 'utf8')); } catch { return {}; } })();
    if (Number(sessionMetadata.format_version) !== 2 || !String(sessionMetadata.content || '').includes('双向二进制消息')) throw new Error('目录不是 QQ Farm Code Helper v2 协议会话');
    const manifest = readManifest(sessionDirectory);
    if (!manifest.size) throw new Error('Helper manifest 中没有可解析的二进制帧记录');
    const root = await getRoot();
    const types = {
        GateMessage: root.lookupType('gatepb.Message'),
        ActivityListReply: root.lookupType('gamepb.activitypb.ActivityListReply'),
        GetGroupReply: root.lookupType('gamepb.activitypb.GetGroupReply'),
        BulletinListReply: root.lookupType('gamepb.bulletinboardpb.GetBulletinListReply'),
        MugeListReply: root.lookupType('gamepb.activitypb.MugeListReply'),
    };
    const files = fs.readdirSync(sessionDirectory).filter((name: string) => FRAME_RE.test(name)).sort((a: string, b: string) => Number(a.match(/^\d+/)?.[0]) - Number(b.match(/^\d+/)?.[0])).slice(-MAX_FILES);
    const activities: any[] = []; let frameCount = 0; let totalBytes = 0; let frameErrors = 0;
    for (const filename of files) {
        const fullPath = path.join(sessionDirectory, filename);
        const parent = path.resolve(path.dirname(fullPath));
        if (parent !== path.resolve(sessionDirectory)) { frameErrors++; continue; }
        const stat = fs.statSync(fullPath);
        if (!stat.isFile() || stat.size > MAX_FRAME_BYTES) continue;
        if (totalBytes + stat.size > MAX_SESSION_BYTES) { frameErrors++; continue; }
        const manifestRow = manifest.get(filename);
        if (!manifestRow || !MANIFEST_FILE_PATTERN.test(String(manifestRow.file || ''))) { frameErrors++; continue; }
        frameCount++; totalBytes += stat.size;
        try { const activity = parseFrame(fs.readFileSync(fullPath), filename, manifestRow, types); if (activity) activities.push(activity); }
        catch { frameErrors++; }
    }
    if (!frameCount) throw new Error('Helper manifest 中没有匹配到安全的帧文件');
    const contextualBulletins = activities.filter(activity => activity.method === 'GetBulletinList').flatMap((activity: any) => activity.bulletins || []);
    const announcementByTitle = new Map<string, any>(contextualBulletins.map((item: any) => [String(item.title || '').replace(/[\s\p{P}]/gu, ''), item]));
    for (const activity of activities.filter(activity => activity.method === 'GetGroup')) {
        const detailName = String(activity.decoded?.group?.activity?.name || '');
        const announcement = announcementByTitle.get(detailName.replace(/[\s\p{P}]/gu, ''));
        if (announcement) activity.bulletins = [announcement];
    }
    const resourceManifest = mapExternalResources({ activities });
    const startedAtMs = Number(sessionMetadata.started_at_ms) || 0;
    const connections = (() => {
        const file = path.join(sessionDirectory, 'connections.jsonl');
        if (!fs.existsSync(file) || fs.statSync(file).size > MAX_INDEX_BYTES) return [];
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-100).flatMap((line: string) => { try { const row = JSON.parse(line); return [{ connectionId: Number(row.connection_id) || 0, timestamp: row.timestamp_ms ? new Date(Number(row.timestamp_ms)).toISOString() : '', codePresent: row.contains_code === true }]; } catch { return []; } });
    })();
    return { source: 'qq-farm-code-helper', directory: sessionDirectory, id: path.basename(sessionDirectory), startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : '', formatVersion: Number(sessionMetadata.format_version) || 0, frameCount, activityCount: activities.length, bytes: totalBytes, frameErrors, connections, activities: activities.sort((a, b) => b.sequence - a.sequence), resources: resourceManifest };
}
module.exports = { scanHelperSession, discoverResources, decodeEmbedded };
