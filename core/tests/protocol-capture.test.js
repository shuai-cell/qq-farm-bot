const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { scanHelperSession } = require('../dist/services/helper-protocol-capture');
const captureSettings = require('../dist/services/protocol-capture-settings');
const { mapExternalResources } = require('../dist/services/helper-resource-mappings');
const { types, loadProto } = require('../dist/utils/proto');
let loadedTypes;
test.before(async () => { await loadProto(); loadedTypes = types; });

test('Helper capture settings persist the configurable session path and stay within limits', { concurrency: false }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-capture-settings-'));
    const priorFile = process.env.FARM_PROTOCOL_CAPTURE_SETTINGS_FILE;
    const priorRuntime = process.env.FARM_RUNTIME_DIR;
    try {
        process.env.FARM_RUNTIME_DIR = path.join(dir, 'runtime');
        delete process.env.FARM_PROTOCOL_CAPTURE_SETTINGS_FILE;
        const sessionPath = path.join(dir, 'session-fixture');
        const saved = captureSettings.saveSettings({ helperSessionDirectory: sessionPath, retentionDays: 99999, maxBytes: 42 });
        assert.equal(saved.helperSessionDirectory, sessionPath);
        assert.equal(saved.retentionDays, 3650);
        assert.equal(saved.maxBytes, 1024 * 1024);
        assert.equal(captureSettings.helperAssetDirectory(sessionPath), path.join(dir, 'runtime', 'protocol-captures', crypto.createHash('sha256').update(sessionPath.toLowerCase()).digest('hex').slice(0, 16), 'assets'));
        assert.deepEqual(captureSettings.getSettings(), saved);
    } finally {
        if (priorFile === undefined) delete process.env.FARM_PROTOCOL_CAPTURE_SETTINGS_FILE;
        else process.env.FARM_PROTOCOL_CAPTURE_SETTINGS_FILE = priorFile;
        if (priorRuntime === undefined) delete process.env.FARM_RUNTIME_DIR;
        else process.env.FARM_RUNTIME_DIR = priorRuntime;
    }
});

function makeSession(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-helper-capture-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify({ format_version: 2, started_at_ms: 1795624137192, content: '每条连接的完整 QQ 农场 WebSocket 握手 URL，以及已去除帧封装的双向二进制消息' }));
    fs.mkdirSync(path.join(directory, 'handshakes'));
    fs.writeFileSync(path.join(directory, 'connections.jsonl'), `${JSON.stringify({ connection_id: 1, timestamp_ms: 1795624684671, url_file: 'handshakes/connection-000001-url.txt', size: 120, contains_code: true })}\n`);
    fs.writeFileSync(path.join(directory, 'handshakes', 'connection-000001-url.txt'), 'sensitive handshake file is intentionally not read by scanner');
    return directory;
}
function gateResponse(method, body, seq = 1, service = 'gamepb.activitypb.ActivityService') {
    return Buffer.from(loadedTypes.GateMessage.encode({ meta: { service_name: service, method_name: method, message_type: 2, error_code: 0, server_seq: seq }, body }).finish());
}

test('Helper session scan decodes actual ActivityData and Muge List reply schemas', async t => {
    const directory = makeSession(t);

    // Use a compact generated Muge List protobuf fixture with the same wire layout.
    const root = loadedTypes.GetGroupReply.root;
    const MugeListReply = root.lookupType('gamepb.activitypb.MugeListReply');
    const list = Buffer.from(MugeListReply.encode({ groups: [{ head: { id: '2026111707', name: '以薯换福' }, children: [{ head: { id: '2026111708', name: '以薯换福' }, extra: Buffer.from(JSON.stringify({ uid: 'YiShuHuanFuMainUI', tips: { title: '活动说明', txt: ['红薯种入普通农田，成熟后收获红薯和蜜薯。'] } })) }, { head: { id: '2026111709', name: '以薯换福' } }] }] }).finish());
    const GetGroupReply = root.lookupType('gamepb.activitypb.GetGroupReply');
    const detail = Buffer.from(GetGroupReply.encode({ group: { activity: { activity_id: '2026111707', name: '以薯换福' }, children: [{ activity: { activity_id: '2026111708', group_id: '2026111707', name: '以薯换福', type: 26, extra: Buffer.from(JSON.stringify({ uid: 'YiShuHuanFuMainUI', tips: { title: '活动说明', txt: ['红薯成熟后额外收获蜜薯。'] } })) } }, { activity: { activity_id: '2026111709', group_id: '2026111707', name: '以薯换福', type: 6 } }] } }).finish());
    const bulletinType = loadedTypes.GetBulletinListReply;
    const bulletin = Buffer.from(bulletinType.encode({ bulletins: [{ id: '26112401', title: '以薯换福', status: 1, type: 2, image_url: 'https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png' }] }).finish());
    const frames = [gateResponse('List', list, 1), gateResponse('GetGroup', detail, 2), gateResponse('GetBulletinList', bulletin, 3, 'gamepb.bulletinboardpb.BulletinBoardService')];
    const rows = frames.map((body, index) => ({ sequence: index + 1, connection_id: 1, timestamp_ms: 1795624684844 + index, direction: 'server_to_client', file: `${String(index + 1).padStart(6, '0')}-recv.bin`, size: body.length }));
    frames.forEach((body, index) => fs.writeFileSync(path.join(directory, rows[index].file), body));
    fs.writeFileSync(path.join(directory, 'manifest.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const result = await scanHelperSession(directory);
    assert.equal(result.source, 'qq-farm-code-helper');
    assert.equal(result.frameCount, 3);
    assert.equal(result.activityCount, 3);
    assert.equal(result.connections.length, 1);
    assert.equal(result.connections[0].codePresent, true);
    const listActivity = result.activities.find(row => row.method === 'List');
    const getGroup = result.activities.find(row => row.method === 'GetGroup');
    const bulletinActivity = result.activities.find(row => row.method === 'GetBulletinList');
    assert.ok(listActivity.activityIds.includes('2026111707'));
    assert.ok(listActivity.activityIds.includes('2026111708'));
    assert.equal(listActivity.alternateDecoded.groups[0].head.name, '以薯换福');
    assert.ok(getGroup.decoded.group.children[0].activity.extra.tips.txt[0].includes('蜜薯'));
    assert.equal(getGroup.bodyBase64.length > 0, true);
    assert.ok(getGroup.rawWireFields.length > 0);
    assert.equal(result.activities.some(row => JSON.stringify(row).includes('sensitive handshake')), false);
    assert.equal(listActivity.urls.length, 0);
    assert.equal(bulletinActivity.bulletins[0].title, '以薯换福');
    assert.equal(bulletinActivity.bulletins[0].resourceUrl, 'https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png');
    assert.ok(result.resources.some(item => item.resourceUrl === 'https://cdn-resource.nqf.qq.com/uploads/gengxingonggao_bn.png'));
});

test('Helper resource paths remain explicitly unresolved until a matching client bundle manifest is supplied', () => {
    const resources = mapExternalResources({ activities: [{ activityIds: ['2026111708'], resourcePaths: ['gui/texture/yishuhuanfu/icon/spriteFrame'], urls: ['https://cdn-resource.nqf.qq.com/a.png'] }] });
    assert.equal(resources.find(item => item.resourcePath.includes('yishuhuanfu')).mappingSource, 'cocos-path-unresolved');
    assert.equal(resources.find(item => item.resourceUrl)?.resourceUrl, 'https://cdn-resource.nqf.qq.com/a.png');
});

test('Helper scanner rejects internal captures and incomplete manifests', async t => {
    const directory = makeSession(t);
    fs.writeFileSync(path.join(directory, 'manifest.jsonl'), `${JSON.stringify({ sequence: 1, connection_id: 1, timestamp_ms: 1, direction: 'server_to_client', file: 'bad.bin', size: 10 })}\n`);
    await assert.rejects(scanHelperSession(directory), /没有可解析的二进制帧记录/);
});
