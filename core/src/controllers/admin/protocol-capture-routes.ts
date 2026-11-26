import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
let downloadRunning = false;
const { createAuthRequired, requireAdmin } = require('./middleware');
const settingsStore = require('../../services/protocol-capture-settings');
const helperCapture = require('../../services/helper-protocol-capture');
const cocosManifest = require('../../services/cocos-resource-manifest');
const { mapExternalResources } = require('../../services/helper-resource-mappings');

function currentSessionDirectoryBytes(root: string): number {
    if (!fs.existsSync(root)) return 0;
    let total = 0;
    const stack = [root];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(target);
            else if (entry.isFile()) total += fs.statSync(target).size;
        }
    }
    return total;
}
function loadJson(file: string): any | null {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
}
function mountProtocolCaptureRoutes(app: Application, ctx: AdminContext): void {
    const auth = createAuthRequired(ctx);
    app.post('/api/protocol-capture/helper-session/scan', auth, requireAdmin, async (req: Request, res: Response) => {
        try {
            const saved = settingsStore.getSettings();
            const directory = String(req.body?.directory || saved.helperSessionDirectory || '').trim();
            if (!directory) return res.status(400).json({ ok: false, error: '请填写 Helper 会话目录' });
            const result = await helperCapture.scanHelperSession(directory);
            const indexPath = settingsStore.helperIndexFile(directory);
            const helperAssetDirectory = settingsStore.helperAssetDirectory(directory);
            const bodyDirectory = settingsStore.helperRawBodyDirectory(directory);
            const pendingBodies: Array<{ target: string; bytes: Buffer }> = [];
            const persistedActivities = result.activities.map((activity: any) => {
                const bodyFile = `${activity.sequence}-${activity.bodySha256.slice(0, 12)}.bin`;
                const target = path.join(bodyDirectory, bodyFile);
                if (!fs.existsSync(target)) pendingBodies.push({ target, bytes: Buffer.from(activity.bodyBase64, 'base64') });
                const { bodyBase64: _bodyBase64, ...entry } = activity;
                return { ...entry, rawBodyFile: bodyFile };
            });
            const persisted = { ...result, activities: persistedActivities, resources: result.resources || [] };
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            const tempPath = `${indexPath}.${process.pid}.tmp`;
            const indexText = JSON.stringify(persisted, null, 2);
            const storageEstimate = Buffer.byteLength(indexText) + pendingBodies.reduce((sum, item) => sum + item.bytes.length, 0);
            if (Buffer.byteLength(indexText) > 32 * 1024 * 1024) throw new Error('解码索引超过 32 MB 安全上限');
            const otherUsage = Math.max(0, currentSessionDirectoryBytes(settingsStore.helperStorageDirectory()) - currentSessionDirectoryBytes(settingsStore.helperStorageDirectory(directory)));
            if (otherUsage + storageEstimate > saved.maxBytes) throw new Error('Helper 会话原始 body 与索引超过当前磁盘预算，请调整预算后扫描');
            fs.mkdirSync(bodyDirectory, { recursive: true });
            for (const body of pendingBodies) fs.writeFileSync(body.target, body.bytes, { flag: 'wx', mode: 0o600 });
            fs.writeFileSync(tempPath, indexText, { mode: 0o600 });
            fs.renameSync(tempPath, indexPath);
            const resourceManifestPath = settingsStore.helperResourceManifestFile(directory);
            fs.mkdirSync(path.dirname(resourceManifestPath), { recursive: true });
            const resourceTempPath = `${resourceManifestPath}.${process.pid}.tmp`;
            const resourceManifestText = JSON.stringify({ sessionId: result.id, sessionDirectory: directory, resources: result.resources || [], unresolvedPaths: (result.activities || []).flatMap((activity: any) => (activity.resourcePaths || []).filter((resourcePath: string) => !(result.resources || []).some((item: any) => item.resourcePath === resourcePath))) }, null, 2);
            fs.writeFileSync(resourceTempPath, resourceManifestText, { mode: 0o600 });
            fs.renameSync(resourceTempPath, resourceManifestPath);
            const helperSettings = settingsStore.saveSettings({ ...saved, helperSessionDirectory: directory });
            const storage = settingsStore.pruneHelperStorage(directory);
            res.json({ ok: true, data: { ...persisted, sessionActivityBytes: Buffer.byteLength(indexText), helperAssetDirectory, storage, settings: helperSettings } });
        } catch (error: any) {
            res.status(400).json({ ok: false, error: String(error?.message || '读取 Helper 会话失败').slice(0, 1000) });
        }
    });
    app.get('/api/protocol-capture', auth, requireAdmin, async (_req: Request, res: Response) => {
        try {
            const settings = settingsStore.getSettings();
            let helperIndex = loadJson(settingsStore.helperIndexFile(settings.helperSessionDirectory));
            if (helperIndex && path.resolve(helperIndex.directory) !== path.resolve(settings.helperSessionDirectory)) helperIndex = null;
            let totalBytes = 0;
            const helperAssetDirectory = settingsStore.helperAssetDirectory(settings.helperSessionDirectory);
            const assetsManifest = loadJson(path.join(helperAssetDirectory, 'manifest.json'));
            if (fs.existsSync(settingsStore.helperAssetDirectory(settings.helperSessionDirectory))) {
                const stack = [settingsStore.helperAssetDirectory(settings.helperSessionDirectory)];
                while (stack.length) {
                    const current = stack.pop();
                    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                        const target = path.join(current, entry.name);
                        if (entry.isDirectory()) stack.push(target);
                        else if (entry.isFile()) totalBytes += fs.statSync(target).size;
                    }
                }
            }
            const bodyDirectory = settingsStore.helperRawBodyDirectory(settings.helperSessionDirectory);
            totalBytes += currentSessionDirectoryBytes(bodyDirectory);
            const activities = (helperIndex?.activities || []).map((activity: any) => ({
                ...activity,
                rawBodyPath: activity.rawBodyFile ? path.join(bodyDirectory, activity.rawBodyFile) : '',
            }));
            const sessions = helperIndex ? [{
                date: helperIndex.startedAt || '', startedAt: helperIndex.startedAt || '', formatVersion: helperIndex.formatVersion || 0,
                id: helperIndex.id, bytes: helperIndex.bytes || 0, frameCount: helperIndex.frameCount || 0,
                activityCount: helperIndex.activityCount || 0, frameErrors: helperIndex.frameErrors || 0,
                connections: helperIndex.connections || [], activities,
            }] : [];
            const resourceIndex = loadJson(settingsStore.helperResourceManifestFile(settings.helperSessionDirectory));
            const resources = resourceIndex?.resources || assetsManifest?.resources || helperIndex?.resources || [];
            if (fs.existsSync(bodyDirectory)) {
                for (const entry of fs.readdirSync(bodyDirectory, { withFileTypes: true })) if (entry.isFile()) totalBytes += fs.statSync(path.join(bodyDirectory, entry.name)).size;
            }
            const manifestSettings = cocosManifest.runtimeSettings();
            const manifestIndex = loadJson(settingsStore.helperResourceManifestFile(settings.helperSessionDirectory));
            const extractedResources = [...mapExternalResources(helperIndex || { activities: [] }), ...(manifestIndex?.resources || [])];
            const storage = settingsStore.pruneHelperStorage(settings.helperSessionDirectory);
            res.json({ ok: true, data: {
                settings, manifestSettings, storage, source: 'qq-farm-code-helper', directory: settings.helperSessionDirectory,
                helperSessionDirectory: settings.helperSessionDirectory,
                helperAssetDirectory, rawBodyDirectory: bodyDirectory,
                indexedAt: helperIndex?.startedAt || '', sessions, totalBytes, assets: [...extractedResources, ...resources].slice(-500).reverse(),
            } });
        } catch (error: any) { res.status(500).json({ ok: false, error: error.message || '读取 Helper 会话索引失败' }); }
    });
    app.post('/api/protocol-capture/resource-manifest', auth, requireAdmin, async (req: Request, res: Response) => {
        try {
            const previous = settingsStore.getSettings();
            const settings = settingsStore.saveSettings({ ...previous, ...req.body });
            const response = await cocosManifest.loadManifestSettings();
            if (response.configured) {
                const index = loadJson(settingsStore.helperResourceManifestFile(settings.helperSessionDirectory));
                const paths = [...new Set([
                    ...(index?.resources || []).map((item: any) => String(item.resourcePath || '')),
                    ...(index?.activities || []).flatMap((activity: any) => activity.resourcePaths || []),
                ].filter(Boolean))];
                const pathOwners = new Map<string, string>();
                for (const activity of index?.activities || []) for (const resourcePath of activity.resourcePaths || []) {
                    const activityId = (activity.activityIds || []).find((id: string) => /^202\d{7}$/.test(String(id))) || (activity.activityIds || [])[0] || 'unknown';
                    if (resourcePath && !pathOwners.has(resourcePath)) pathOwners.set(resourcePath, activityId);
                }
                const mapped = paths.map((resourcePath: string) => ({ ...response.resolvePath(resourcePath, 'cocos-manifest-path'), activityId: pathOwners.get(resourcePath) || 'unknown' }));
                response.requestedPaths = mapped;
                response.unresolvedPaths = mapped.filter((item: any) => !item.resourceUrl);
                response.resolvedResources = mapped.filter((item: any) => item.resourceUrl);
            }
            const manifestPath = settingsStore.helperResourceManifestFile(settings.helperSessionDirectory);
            const current = loadJson(manifestPath) || { sessionId: path.basename(settings.helperSessionDirectory), sessionDirectory: settings.helperSessionDirectory, resources: [] };
            const updates = response.resolvedResources || [];
            if (updates.length) {
                const byKey = new Map((current.resources || []).map((item: any) => [`${item.resourcePath}|${item.resourceUrl}`, item]));
                const activityIdsByPath = new Map<string, string>();
                for (const row of current.resources || []) if (row.resourcePath && row.activityId) activityIdsByPath.set(row.resourcePath, row.activityId);
                updates.forEach((item: any) => byKey.set(`${item.resourcePath}|${item.resourceUrl}`, { ...item, activityId: activityIdsByPath.get(item.resourcePath) || 'unknown', version: settings.resourceBundleVersion }));
                current.resources = [...byKey.values()];
                current.manifest = { url: response.manifestUrl, sha256: response.manifestSha256 };
                fs.writeFileSync(manifestPath, JSON.stringify(current, null, 2), { mode: 0o600 });
            }
            res.json({ ok: true, data: { ...response, settings, resourceCount: current.resources?.length || 0, saved: updates.length > 0 } });
        } catch (error: any) { res.status(400).json({ ok: false, error: String(error?.message || 'Cocos manifest 解析失败').slice(0, 1000) }); }
    });
    app.post('/api/protocol-capture/download-assets', auth, requireAdmin, async (_req: Request, res: Response) => {
        if (downloadRunning) return res.status(409).json({ ok: false, error: '素材下载任务正在运行' });
        downloadRunning = true;
        try {
            const saved = settingsStore.getSettings();
            const indexPath = settingsStore.helperIndexFile(saved.helperSessionDirectory);
            if (!fs.existsSync(indexPath)) throw new Error('请先扫描 Helper 会话，建立活动资源索引');
            const indexDoc = loadJson(indexPath);
            if (!indexDoc || path.resolve(indexDoc.directory) !== path.resolve(saved.helperSessionDirectory)) throw new Error('索引和当前 Helper 会话目录不匹配，请重新扫描');
            const resourceManifestPath = settingsStore.helperResourceManifestFile(saved.helperSessionDirectory);
            if (!fs.existsSync(resourceManifestPath)) throw new Error('请先扫描 Helper 会话，生成活动资源路径清单');
            const outputDir = settingsStore.helperAssetDirectory(saved.helperSessionDirectory);
            const scriptCandidates = [
                path.resolve(__dirname, '../../../tools/download-captured-activity-assets.js'),
                path.resolve(__dirname, '../../../../tools/download-captured-activity-assets.js'),
            ];
            const script = scriptCandidates.find((candidate: string) => fs.existsSync(candidate));
            if (!script) throw new Error('找不到活动素材下载脚本，请更新本地构建');
            const { stdout } = await execFileAsync(process.execPath, [script, '', `--index-file=${resourceManifestPath}`, `--out-dir=${outputDir}`], { timeout: 120000, maxBuffer: 256 * 1024 });
            res.json({ ok: true, data: { output: String(stdout || '').trim() } });
        } catch (error: any) { res.status(500).json({ ok: false, error: String(error?.stderr || error?.message || '素材下载失败').slice(0, 2000) }); }
        finally { downloadRunning = false; }
    });
    app.put('/api/protocol-capture/settings', auth, requireAdmin, (req: Request, res: Response) => {
        try {
            const current = settingsStore.getSettings();
            const data = settingsStore.saveSettings({ ...current, ...req.body });
            res.json({ ok: true, data: { settings: data, directory: data.helperSessionDirectory, helperAssetDirectory: settingsStore.helperAssetDirectory(data.helperSessionDirectory) } });
        } catch (error: any) { res.status(400).json({ ok: false, error: error.message || '保存采集设置失败' }); }
    });
}
module.exports = { mountProtocolCaptureRoutes };
