export {};
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getRuntimePaths } = require('../config/runtime-paths');
const FILE = () => path.resolve(String(process.env.FARM_PROTOCOL_CAPTURE_SETTINGS_FILE || path.join(getRuntimePaths().runtimeDir, 'protocol-capture-settings.json')));
const DEFAULTS = {
    helperSessionDirectory: 'D:\\0lishuai\\download\\protocol-captures\\session-1795624137192',
    retentionDays: 14,
    maxBytes: 1024 * 1024 * 1024,
    resourceServer: '',
    resourceBundle: '',
    resourceBundleVersion: '',
};
let cachedSettings = { ...DEFAULTS };
let cachedMtime = -1;
let lastRefreshAt = 0;
const REFRESH_INTERVAL_MS = 1000;
function normalize(input: any) {
    const helperSessionDirectory = path.resolve(String(input?.helperSessionDirectory || DEFAULTS.helperSessionDirectory).trim());
    const retentionInput = Number(input?.retentionDays);
    const byteInput = Number(input?.maxBytes);
    const resourceServer = String(input?.resourceServer || '').trim();
    const resourceBundle = String(input?.resourceBundle || '').trim();
    const resourceBundleVersion = String(input?.resourceBundleVersion || '').trim();
    const retentionDays = Math.max(1, Math.min(3650, Number.isFinite(retentionInput) && retentionInput > 0 ? Math.trunc(retentionInput) : DEFAULTS.retentionDays));
    const maxBytes = Math.max(1024 * 1024, Math.min(1024 * 1024 * 1024 * 1024, Number.isFinite(byteInput) && byteInput > 0 ? Math.trunc(byteInput) : DEFAULTS.maxBytes));
    return { helperSessionDirectory, retentionDays, maxBytes, resourceServer, resourceBundle, resourceBundleVersion };
}
function getSettings() {
    const now = Date.now(); const file = FILE();
    if (now - lastRefreshAt < REFRESH_INTERVAL_MS) {
        try { if (fs.statSync(file).mtimeMs === cachedMtime) return { ...cachedSettings }; } catch { return { ...cachedSettings }; }
    }
    lastRefreshAt = now;
    try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs !== cachedMtime) { cachedSettings = { ...DEFAULTS, ...normalize(JSON.parse(fs.readFileSync(file, 'utf8'))) }; cachedMtime = stat.mtimeMs; }
    } catch { cachedSettings = { ...DEFAULTS }; cachedMtime = -1; }
    return { ...cachedSettings };
}
function saveSettings(input: any) {
    const settings = normalize(input); const file = FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
    cachedSettings = { ...settings }; cachedMtime = fs.statSync(file).mtimeMs; lastRefreshAt = Date.now();
    return settings;
}
function helperStorageRoot() { return path.join(getRuntimePaths().runtimeDir, 'protocol-captures'); }
function helperStorageDirectory(sessionDirectory?: string) {
    const session = path.resolve(String(sessionDirectory || getSettings().helperSessionDirectory));
    const key = crypto.createHash('sha256').update(session.toLowerCase()).digest('hex').slice(0, 16);
    return path.join(helperStorageRoot(), key);
}
function helperAssetDirectory(sessionDirectory?: string) { return path.join(helperStorageDirectory(sessionDirectory), 'assets'); }
function helperRawBodyDirectory(sessionDirectory?: string) { return path.join(helperStorageDirectory(sessionDirectory), 'raw-bodies'); }
function helperIndexFile(sessionDirectory?: string) { return path.join(helperStorageDirectory(sessionDirectory), 'activity-index.json'); }
function helperResourceManifestFile(sessionDirectory?: string) { return path.join(helperStorageDirectory(sessionDirectory), 'resource-manifest.json'); }
function pruneHelperStorage(currentSessionDirectory: string) {
    const settings = getSettings(); const root = helperStorageRoot();
    fs.mkdirSync(root, { recursive: true });
    const current = helperStorageDirectory(currentSessionDirectory);
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter((item: any) => item.isDirectory()).map((item: any) => {
        const folder = path.join(root, item.name); const stat = fs.statSync(folder); let size = 0; const stack = [folder];
        while (stack.length) {
            const target = stack.pop();
            for (const child of fs.readdirSync(target, { withFileTypes: true })) {
                const childPath = path.join(target, child.name);
                if (child.isDirectory()) stack.push(childPath); else if (child.isFile()) size += fs.statSync(childPath).size;
            }
        }
        return { folder, mtimeMs: stat.mtimeMs, size, current: folder === current };
    });
    const cutoff = Date.now() - settings.retentionDays * 86400000;
    for (const entry of entries) if (!entry.current && entry.mtimeMs < cutoff) fs.rmSync(entry.folder, { recursive: true, force: true });
    let used = entries.filter((entry: any) => entry.current || entry.mtimeMs >= cutoff).reduce((sum: number, entry: any) => sum + entry.size, 0);
    for (const entry of entries.filter((item: any) => !item.current && item.mtimeMs >= cutoff).sort((a: any, b: any) => a.mtimeMs - b.mtimeMs)) {
        if (used <= settings.maxBytes) break;
        fs.rmSync(entry.folder, { recursive: true, force: true }); used -= entry.size;
    }
    return { usedBytes: used, maxBytes: settings.maxBytes, currentDirectory: current };
}
module.exports = { getSettings, saveSettings, helperStorageDirectory, helperAssetDirectory, helperRawBodyDirectory, helperIndexFile, helperResourceManifestFile, pruneHelperStorage, DEFAULTS };
