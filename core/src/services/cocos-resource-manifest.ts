export {};
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { URL } = require('node:url');
const captureSettings = require('./protocol-capture-settings');

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
function runtimeSettings() {
    const saved = captureSettings.getSettings();
    return {
        server: String(process.env.FARM_PROTOCOL_RESOURCE_SERVER || saved.resourceServer || '').trim(),
        bundle: String(process.env.FARM_PROTOCOL_RESOURCE_BUNDLE || saved.resourceBundle || '').trim(),
        bundleVersion: String(process.env.FARM_PROTOCOL_RESOURCE_VERSION || saved.resourceBundleVersion || '').trim(),
    };
}
function validatePublicHttpUrl(raw: string, requireHttps = true): URL {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || (requireHttps && url.protocol !== 'https:') || url.username || url.password) throw new Error('资源 URL 必须是无凭据的 HTTPS URL');
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.startsWith('127.') || url.hostname.startsWith('10.') || url.hostname.startsWith('192.168.') || url.hostname === '::1' || url.hostname.startsWith('169.254.')) throw new Error('资源服务器地址不可为本机或私网');
    return url;
}
function isPrivateAddress(address: string): boolean {
    const value = String(address || '').toLowerCase();
    if (value.includes(':')) return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:') || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.') || value.startsWith('::ffff:192.168.');
    const parts = value.split('.').map(Number);
    return parts.length === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224);
}
async function requestBuffer(raw: string): Promise<Buffer> {
    const url = validatePublicHttpUrl(raw);
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry: any) => isPrivateAddress(entry.address))) throw new Error('资源 manifest 主机必须解析为公网地址');
    return new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const request = client.get(url, { timeout: 15000, headers: { 'user-agent': 'qq-farm-helper-resource-index/1.0' }, lookup(hostname: string, options: any, callback: any) {
            dns.lookup(hostname, { all: true, verbatim: true }).then((records: any[]) => {
                if (!records.length || records.some((entry: any) => isPrivateAddress(entry.address))) return callback(new Error('manifest host resolves to a private address'));
                if (options?.all) callback(null, records);
                else callback(null, records[0].address, records[0].family);
            }, callback);
        } }, (response: any) => {
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`manifest HTTP ${response.statusCode}`)); return; }
            const chunks: Buffer[] = []; let length = 0;
            response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > MAX_MANIFEST_BYTES) request.destroy(new Error('manifest exceeds 16 MB')); else chunks.push(chunk); });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('manifest timeout')));
        request.on('error', reject);
    });
}
async function loadManifestSettings() {
    const config = runtimeSettings();
    if (!config.server || !config.bundle || !config.bundleVersion) return { configured: false, settings: config, bundles: [] };
    if (!/^[\w-]{1,80}$/i.test(config.bundle) || !/^[\w.-]{1,80}$/i.test(config.bundleVersion)) throw new Error('manifest bundle 或版本格式无效');
    const server = validatePublicHttpUrl(config.server);
    if (!server.pathname.endsWith('/')) server.pathname += '/';
    const url = new URL(`remote/${config.bundle}/config.${config.bundleVersion}.json`, server);
    const content = await requestBuffer(url.href);
    let manifest: any;
    try { manifest = JSON.parse(content.toString('utf8')); } catch { throw new Error('Cocos config manifest JSON 无效'); }
    if (!Array.isArray(manifest.uuids) || !manifest.paths || typeof manifest.paths !== 'object' || !Array.isArray(manifest.types)) throw new Error('Cocos config manifest 缺少 uuids/paths/types');
    const byPath = new Map<string, any[]>();
    for (const [indexText, value] of Object.entries(manifest.paths)) {
        const index = Number(indexText); const tuple = value as any[];
        if (!Number.isInteger(index) || index < 0 || index >= manifest.uuids.length || !Array.isArray(tuple) || typeof tuple[0] !== 'string') continue;
        const rawType = manifest.types[Number(tuple[1])];
        const type = typeof rawType === 'string' ? rawType : '';
        const key = tuple[0].replace(/\/spriteFrame$/, '');
        const list = byPath.get(key) || [];
        list.push({ index, type, uuid: String(manifest.uuids[index]), path: tuple[0] });
        byPath.set(key, list);
    }
    const nativeVersions = new Map<number, string>();
    const nativePairs = manifest.versions?.native;
    if (Array.isArray(nativePairs)) {
        for (let i = 0; i + 1 < nativePairs.length; i += 2) {
            const index = Number(nativePairs[i]);
            if (Number.isInteger(index) && index >= 0 && index < manifest.uuids.length) nativeVersions.set(index, String(nativePairs[i + 1]));
        }
    }
    const redirects = new Map<number, number>();
    const redirectPairs = manifest.redirect;
    if (Array.isArray(redirectPairs)) for (let i = 0; i + 1 < redirectPairs.length; i += 2) redirects.set(Number(redirectPairs[i]), Number(redirectPairs[i + 1]));
    const deps = Array.isArray(manifest.deps) ? manifest.deps : [];
    const resolvePath = (resourcePath: string, mappingSource = 'cocos-manifest') => {
        const key = String(resourcePath || '').replace(/\/spriteFrame$/, '');
        const matches = byPath.get(key) || [];
        if (matches.length !== 1) return { resourcePath, resourceUrl: '', mappingSource, error: `manifest path matches ${matches.length}` };
        const record = matches[0];
        let currentIndex = record.index;
        let currentBundle = config.bundle;
        let hops = 0;
        while (redirects.has(currentIndex) && hops < 16) {
            const dependencyOrdinal = redirects.get(currentIndex);
            const targetBundle = deps[dependencyOrdinal];
            if (typeof targetBundle !== 'string' || targetBundle !== config.bundle) break;
            const sourceUuid = decodeUuid(String(manifest.uuids[currentIndex])).split('@')[0];
            const candidateIndices = manifest.uuids.map((uuid: string, index: number) => decodeUuid(String(uuid)).split('@')[0] === sourceUuid ? index : -1).filter((index: number) => index >= 0);
            if (candidateIndices.length !== 1) break;
            currentIndex = candidateIndices[0]; currentBundle = targetBundle; hops++;
        }
        const nativeVersion = nativeVersions.get(currentIndex);
        const uuid = decodeUuid(String(manifest.uuids[currentIndex])).split('@')[0];
        const nativeBase = String(manifest.nativeBase || 'native').replace(/^\/+|\/+$/g, '');
        const extension = Object.entries(manifest.extensionMap || {}).find(([, indices]: [string, any]) => Array.isArray(indices) && indices.map(Number).includes(currentIndex))?.[0] || '.png';
        const resourceUrl = nativeVersion && extension === '.png' ? new URL(`remote/${currentBundle}/${nativeBase}/${uuid.slice(0, 2)}/${uuid}.${nativeVersion}${extension}`, server).href : '';
        return { resourcePath, resourceUrl, mappingSource, expectedSha256: '', expectedBytes: null, contentType: 'image/png', error: resourceUrl ? '' : 'manifest 缺少 PNG native hash' };
    };
    return { configured: true, settings: { ...config, server: server.href }, manifestUrl: url.href, manifestSha256: crypto.createHash('sha256').update(content).digest('hex'), resolvePath };
}
function decodeUuid(input: string): string {
    if (input.length !== 22 || !/^[\w+/]{22}$/i.test(input)) return input;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let hex = input.slice(0, 2);
    for (let i = 2; i < 22; i += 2) {
        const left = alphabet.indexOf(input[i]);
        const right = alphabet.indexOf(input[i + 1]);
        if (left < 0 || right < 0) return input;
        hex += (left >> 2).toString(16);
        hex += (((left & 3) << 2) | (right >> 4)).toString(16);
        hex += (right & 15).toString(16);
    }
    return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}
module.exports = { loadManifestSettings, runtimeSettings };
