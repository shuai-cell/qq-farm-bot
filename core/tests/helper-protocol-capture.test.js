const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protobuf = require('protobufjs');
const { scanHelperSession, discoverResources, decodeEmbeddedJson } = require('../dist/services/helper-protocol-capture');
const { types: sharedTypes } = require('../dist/utils/proto');

function fixtureSession(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-helper-capture-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify({ format_version: 2, started_at_ms: 1795624137192 }));
    fs.mkdirSync(path.join(root, 'handshakes'));
    fs.writeFileSync(path.join(root, 'connections.jsonl'), `${JSON.stringify({ connection_id: 1, timestamp_ms: 1795624684671, url_file: 'handshakes/connection-000001-url.txt', size: 120 })}\n`);
    fs.writeFileSync(path.join(root, 'handshakes', 'connection-000001-url.txt'), 'wss://fixture.example.invalid/game?code=[REDACTED]');
    return root;
}
function frame(meta, body) {
    return Buffer.from(sharedTypes.GateMessage.encode({ meta: { service_name: 'gamepb.activitypb.ActivityService', method_name: meta.method, message_type: 2, error_code: 0, server_seq: meta.seq || 1 }, body }).finish());
}

test('Helper manifest scan decodes Muge and ActivityData, expanding nested JSON resource paths', async t => {
    const dir = fixtureSession(t);
    const list = sharedTypes.MugeListReply.encode({ groups: [{ head: { id: '2026111707', name: '以薯换福' }, children: [{ head: { id: '2026111708', name: '以薯换福' }, extra: Buffer.from(JSON.stringify({ uid: 'YiShuHuanFuMainUI', icon: 'https://cdn.example.test/activity.png' })) }] }] }).finish();
    const getGroup = sharedTypes.GetGroupReply.encode({ group: { activity: { activity_id: '2026111707', name: '以薯换福' }, children: [{ activity: { activity_id: '2026111708', group_id: '2026111707', name: '以薯换福', type: 26, extra: Buffer.from(JSON.stringify({ uid: 'YiShuHuanFuMainUI', tips: { txt: ['以薯换福'] }, icon: 'https://cdn.example.test/detail.png' })) } }] } }).finish();
    const frames = [frame({ method: 'List', seq: 1 }, list), frame({ method: 'GetGroup', seq: 2 }, getGroup)];
    const rows = frames.map((buffer, index) => ({ sequence: index + 1, connection_id: 1, timestamp_ms: 1795624684844 + index, direction: 'server_to_client', file: `${String(index + 1).padStart(6, '0')}-recv.bin`, size: buffer.length }));
    rows.forEach((row, index) => fs.writeFileSync(path.join(dir, row.file), frames[index]));
    fs.writeFileSync(path.join(dir, 'manifest.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const result = await scanHelperSession(dir);
    assert.equal(result.source, 'qq-farm-code-helper');
    assert.equal(result.frameCount, 2);
    assert.equal(result.activityCount, 2);
    const listRow = result.activities.find(row => row.method === 'List');
    const detailRow = result.activities.find(row => row.method === 'GetGroup');
    assert.ok(listRow.activityIds.includes('2026111707'));
    assert.ok(listRow.activityIds.includes('2026111708'));
    assert.deepEqual(listRow.urls, ['https://cdn.example.test/activity.png']);
    assert.ok(detailRow.decoded.group.children[0].activity.extra.tips.txt[0].includes('以薯换福'));
    assert.deepEqual(detailRow.urls, ['https://cdn.example.test/detail.png']);
    assert.match(detailRow.bodyBase64, /^[A-Za-z0-9+/]+=*$/);
});

test('Helper scan rejects directories without a native Helper manifest', async t => {
    const dir = fixtureSession(t);
    fs.unlinkSync(path.join(dir, 'manifest.jsonl'));
    await assert.rejects(scanHelperSession(dir), /manifest\.jsonl/);
});

test('nested base64 JSON and resource path extractor handles known Muge shape', () => {
    const expanded = decodeEmbeddedJson(Buffer.from(JSON.stringify({ id: '2026111708', icon: 'gui/activity/icon.png' })).toString('base64'));
    assert.equal(expanded.icon, 'gui/activity/icon.png');
    const found = discoverResources({ extra: { icon: 'gui/activity/icon.png', url: 'https://cdn.example.test/a.png' } });
    assert.deepEqual(found.urls, ['https://cdn.example.test/a.png']);
    assert.deepEqual(found.resourcePaths, ['gui/activity/icon.png']);
});
