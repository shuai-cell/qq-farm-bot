export {};
function mapExternalResources(index: any) {
    const output: any[] = [];
    for (const activity of index?.activities || []) {
        const ids = Array.isArray(activity.activityIds) ? activity.activityIds : [];
        const activityId = ids.find((id: string) => /^20\d{8}$/.test(String(id))) || ids.find((id: string) => /^\d+$/.test(String(id))) || 'unknown';
        const seen = new Set<string>();
        for (const bulletin of activity.bulletins || []) {
            if (typeof bulletin.resourceUrl !== 'string' || !bulletin.resourceUrl) continue;
            const key = `bulletin:${bulletin.id || bulletin.resourceUrl}`;
            if (seen.has(key)) continue;
            seen.add(key);
            output.push({ activityId, bulletinId: bulletin.id || '', version: 'helper-session', resourceUrl: bulletin.resourceUrl, resourcePath: '', expectedSha256: '', mappingSource: 'bulletin-image-url', title: bulletin.title || '' });
        }
        for (const url of (activity.method === 'List' ? [] : activity.urls || [])) {
            if (typeof url !== 'string' || seen.has(url)) continue;
            seen.add(url);
            output.push({ activityId, version: 'helper-session', resourceUrl: url, resourcePath: '', expectedSha256: '', mappingSource: 'activity-body-url' });
        }
        for (const resourcePath of activity.resourcePaths || []) {
            output.push({ activityId, version: 'helper-session', resourceUrl: '', resourcePath, expectedSha256: '', mappingSource: 'cocos-path-unresolved', error: '此 Helper 活动响应只含 Cocos 路径；需提供同构建的 settings.json 与 bundle manifest 才能解析' });
        }
    }
    const seen = new Set<string>();
    return output.filter(item => {
        const key = `${item.resourceUrl}|${item.resourcePath}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
module.exports = { mapExternalResources };
