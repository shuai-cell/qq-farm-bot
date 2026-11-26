<script setup lang="ts">
import { NButton } from 'naive-ui/es/button'
import { NInput } from 'naive-ui/es/input'
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import { useToastStore } from '@/stores/toast'

interface CaptureSettings { helperSessionDirectory: string, retentionDays: number, maxBytes: number, resourceServer?: string, resourceBundle?: string, resourceBundleVersion?: string }
interface ManifestResult { configured: boolean, settings: CaptureSettings, manifestUrl?: string, manifestSha256?: string, requestedPaths?: Array<any>, unresolvedPaths?: Array<any>, resolvedResources?: Array<any>, resourceCount?: number, saved?: boolean }
interface ActivityRow { sequence: number, connectionId: number, timestamp: string, file: string, method: string, activityIds: string[], bodyBytes: number, bodySha256: string, urls: string[], resourcePaths: string[], resources?: Array<{ id: string, title: string, resourceUrl: string }>, bulletins?: Array<{ id: string, title: string, resourceUrl: string }>, decoded: any, alternateDecoded: any, rawWireFields: any[] }
interface CaptureSession { date: string, id: string, bytes: number, frameCount: number, activityCount: number, activities: ActivityRow[], connections: Array<{ connectionId: number, timestamp: string, codePresent: boolean }>, startedAt?: string, formatVersion?: number, frameErrors?: number }
interface Asset { activityId: string, version: string, resourceUrl: string, url?: string, resourcePath?: string, file?: string, sha256?: string, contentType?: string, size?: number, error?: string, localFile?: string }
interface CaptureData { source: string, directory: string, helperSessionDirectory: string, helperAssetDirectory: string, indexedAt: string, sessions: CaptureSession[], totalBytes: number, assets: Asset[] }

const toast = useToastStore()
const loading = ref(false)
const scanning = ref(false)
const saving = ref(false)
const downloading = ref(false)
const resolvingManifest = ref(false)
const manifestResult = ref<ManifestResult | null>(null)
const settings = ref<CaptureSettings>({ helperSessionDirectory: 'D:\\0lishuai\\download\\protocol-captures\\session-1795624137192', retentionDays: 14, maxBytes: 1024 ** 3, resourceServer: '', resourceBundle: '', resourceBundleVersion: '' })
const data = ref<CaptureData>({ source: 'qq-farm-code-helper', directory: '', helperSessionDirectory: '', helperAssetDirectory: '', indexedAt: '', sessions: [], totalBytes: 0, assets: [] })
const scanResult = ref<CaptureSession | null>(null)
const expanded = ref('')
const error = ref('')
const maxGb = computed({
  get: () => String(Number((settings.value.maxBytes / 1024 ** 3).toFixed(1))),
  set: (value: string) => { settings.value.maxBytes = Math.round((Number(value) || 0.01) * 1024 ** 3) },
})
const retentionInput = computed({
  get: () => String(settings.value.retentionDays),
  set: (value: string) => { settings.value.retentionDays = Number(value) || 1 },
})
const usedPercent = computed(() => Math.min(100, Math.round(data.value.totalBytes / Math.max(1, settings.value.maxBytes) * 100)))
const activityCount = computed(() => scanResult.value?.activityCount || data.value.sessions.reduce((sum, session) => sum + session.activityCount, 0))
const resourcesDiscovered = computed(() => scanResult.value?.activities.reduce((sum, row) => sum + row.urls.length + row.resourcePaths.length + (row.resources?.length || 0), 0) || 0)
function prettyBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`
}
function activityTitle(item: ActivityRow) {
  const decoded = item.decoded?.group?.activity || item.alternateDecoded?.groups?.[0]?.head || item.decoded?.activities?.[0]?.activity || {}
  const bulletinTitle = item.bulletins?.[0]?.title || item.decoded?.bulletins?.[0]?.title
  return decoded.name || bulletinTitle || `活动 ${item.activityIds?.[0] || ''}`
}
function uniqueActivities(rows: ActivityRow[]) {
  const unique = new Map<string, ActivityRow>()
  for (const row of rows) unique.set(`${row.connectionId}|${row.method}|${row.bodySha256}`, { ...row, urls: row.urls || [], resourcePaths: row.resourcePaths || [], activityIds: row.activityIds || [], rawWireFields: row.rawWireFields || [] })
  return [...unique.values()].sort((a, b) => b.sequence - a.sequence)
}
function mappedResource(resourcePath: string) {
  const normalized = resourcePath.replace(/\/spriteFrame$/, '')
  return data.value.assets.find(item => String(item.resourcePath || '').replace(/\/spriteFrame$/, '') === normalized && item.resourceUrl) || null
}
async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const response = await api.get('/api/protocol-capture', { skipErrorToast: true } as any)
    if (!response.data?.ok)
      throw new Error(response.data?.error || '读取 Helper 会话状态失败')
    const incoming = response.data.data || {}
    settings.value = { ...settings.value, ...incoming.settings, ...incoming.manifestSettings }
    data.value = { ...data.value, ...incoming }
    if (incoming.sessions?.[0])
      scanResult.value = { ...incoming.sessions[0], connections: incoming.sessions[0].connections || [], activities: uniqueActivities(incoming.sessions[0].activities || []) }
    if (!expanded.value && incoming.sessions?.[0]?.activities?.[0])
      expanded.value = incoming.sessions[0].id
  }
  catch (cause) { error.value = getApiErrorMessage(cause, '读取 Helper 会话状态失败') }
  finally { loading.value = false }
}
async function scanSession() {
  scanning.value = true
  error.value = ''
  try {
    const response = await api.post('/api/protocol-capture/helper-session/scan', { directory: settings.value.helperSessionDirectory }, { skipErrorToast: true } as any)
    if (!response.data?.ok)
      throw new Error(response.data?.error || '扫描 Helper 会话失败')
    const result = response.data.data
    settings.value = { ...settings.value, ...result.settings }
    scanResult.value = { ...result, connections: result.connections || [], activities: uniqueActivities(result.activities || []) }
    data.value = { ...data.value, ...result, sessions: [scanResult.value], directory: result.directory, helperSessionDirectory: result.directory, helperAssetDirectory: result.helperAssetDirectory }
    expanded.value = result.id
    toast.success(`扫描完成：${result.frameCount} 帧，发现 ${result.activityCount} 条活动协议`)
  }
  catch (cause) {
    error.value = getApiErrorMessage(cause, '扫描 Helper 会话失败')
    toast.error(error.value)
  }
  finally { scanning.value = false }
}
async function saveSettings() {
  saving.value = true
  try {
    const response = await api.put('/api/protocol-capture/settings', settings.value)
    if (!response.data?.ok)
      throw new Error(response.data?.error || '保存失败')
    settings.value = { ...settings.value, ...response.data.data.settings }
    data.value.helperAssetDirectory = response.data.data.helperAssetDirectory || data.value.helperAssetDirectory
    toast.success('Helper 会话路径与索引设置已保存')
  }
  catch (cause) { toast.error(getApiErrorMessage(cause, '保存设置失败')) }
  finally { saving.value = false }
}
async function resolveCocosManifest() {
  resolvingManifest.value = true
  try {
    const response = await api.post('/api/protocol-capture/resource-manifest', settings.value, { skipErrorToast: true } as any)
    if (!response.data?.ok)
      throw new Error(response.data?.error || '读取资源 manifest 失败')
    manifestResult.value = response.data.data
    settings.value = { ...settings.value, ...response.data.data.settings }
    await refresh()
    toast.success(response.data.data.configured ? `资源清单已解析：匹配 ${response.data.data.resolvedResources?.length || 0} 条，待补充 ${response.data.data.unresolvedPaths?.length || 0} 条` : '先填写 CDN、bundle 名与版本号')
  }
  catch (cause) { toast.error(getApiErrorMessage(cause, '资源 manifest 解析失败')) }
  finally { resolvingManifest.value = false }
}
async function downloadAssets() {
  downloading.value = true
  try {
    const response = await api.post('/api/protocol-capture/download-assets')
    if (!response.data?.ok)
      throw new Error(response.data?.error || '素材任务失败')
    toast.success(response.data.data?.output || '素材索引处理完成')
    await refresh()
  }
  catch (cause) { toast.error(getApiErrorMessage(cause, '素材下载失败')) }
  finally { downloading.value = false }
}
function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}
onMounted(refresh)
</script>

<template>
  <main class="capture-page">
    <header class="capture-hero cartoon-card">
      <div class="capture-hero__copy">
        <span class="capture-eyebrow"><i class="i-carbon-data-collection" /> HELPER SESSION · OFFLINE</span>
        <h1>协议采集与活动索引</h1>
        <p>直接读取 QQ 农场助手（Helper）保存的完整 WebSocket 会话，不从 bot 自身流量采集。解析 ActivityService.List / GetGroup，并保留原始 protobuf body。</p>
      </div>
      <div class="capture-hero__actions">
        <span class="capture-source"><i />{{ scanResult?.id || '尚未扫描' }}</span>
        <NButton secondary :loading="loading" @click="refresh">
          <i class="i-carbon-renew mr-1" />刷新
        </NButton>
      </div>
      <div class="capture-orbit capture-orbit--one" /><div class="capture-orbit capture-orbit--two" />
    </header>

    <section class="capture-metrics" aria-label="Helper 会话概况">
      <article class="capture-metric cartoon-card">
        <span>会话帧数</span><strong>{{ scanResult?.frameCount || 0 }}</strong><small>来自 Helper manifest.jsonl</small>
      </article>
      <article class="capture-metric cartoon-card">
        <span>活动协议</span><strong>{{ activityCount }}</strong><small>List / GetGroup 原始响应</small>
      </article>
      <article class="capture-metric cartoon-card">
        <span>资源引用</span><strong>{{ resourcesDiscovered }}</strong><small>CDN URL 与 Cocos 资源路径</small>
      </article>
      <article class="capture-metric cartoon-card">
        <span>素材文件</span><strong>{{ data.assets.length }}</strong><small>去重并按活动/版本归档</small>
      </article>
    </section>

    <div v-if="error" class="capture-error">
      <i class="i-carbon-warning-alt" />{{ error }} <button @click="scanSession">
        重试扫描
      </button>
    </div>

    <div class="capture-columns">
      <section class="capture-panel cartoon-card">
        <div class="capture-section-heading">
          <div><span class="capture-kicker">01 / SOURCE</span><h2>Helper 会话源</h2></div><span class="capture-icon"><i class="i-carbon-folder-open" /></span>
        </div>
        <p class="capture-description">
          指定包含 session.json、manifest.jsonl 和 .bin 文件的 Helper 会话目录。扫描只读原始会话。
        </p>
        <label class="capture-field"><span>会话目录</span><NInput v-model:value="settings.helperSessionDirectory" placeholder="D:\\…\\protocol-captures\\session-…" /></label>
        <div class="source-checklist">
          <span><i class="i-carbon-checkmark-filled" /> session.json</span><span><i class="i-carbon-checkmark-filled" /> manifest.jsonl</span><span><i class="i-carbon-checkmark-filled" /> *-recv.bin / *-send.bin</span>
        </div>
        <div class="capture-field-grid">
          <label class="capture-field"><span>索引与素材保留天数</span><NInput v-model:value="retentionInput" inputmode="numeric" /></label>
          <label class="capture-field"><span>索引与素材占用上限（GB）</span><NInput v-model:value="maxGb" inputmode="decimal" /></label>
        </div>
        <div class="capture-storage">
          <div><span>bot 本地副本空间</span><b>{{ usedPercent }}%</b></div><div class="capture-progress">
            <i :style="{ width: `${usedPercent}%` }" />
          </div><small class="capture-path">{{ data.helperAssetDirectory || 'runtime/protocol-captures/assets/session-id' }}</small>
        </div>
        <div class="capture-actions">
          <NButton type="primary" :loading="scanning" @click="scanSession">
            <i class="i-carbon-search mr-1" />扫描 Helper 会话
          </NButton><NButton secondary :loading="saving" @click="saveSettings">
            <i class="i-carbon-save mr-1" />保存路径
          </NButton>
        </div>
        <div class="capture-notice">
          <i class="i-carbon-information" /><span>不会读取 handshakes 目录中的 URL 内容，也不会显示或保存明文 Code。活动 body 单独保存为本机文件，索引仅展示脱敏字段。</span>
        </div>
      </section>

      <section class="capture-panel capture-assets cartoon-card">
        <div class="capture-section-heading">
          <div><span class="capture-kicker">02 / DISCOVERY</span><h2>以薯换福 · 协议发现</h2></div><span class="capture-icon capture-icon--gold"><i class="i-carbon-catalog" /></span>
        </div>
        <div class="manifest-config">
          <h3><i class="i-carbon-catalog" /> Cocos CDN 资源清单</h3>
          <p>活动 body 中的 resource paths 不是可下载 URL。配置该版本小程序 <code>settings.json</code> 里的 assets.server、remoteBundles 与 bundleVers，按 Cocos manifest/native redirect 精确映射。</p>
          <div class="manifest-grid">
            <label class="capture-field"><span>CDN server</span><NInput v-model:value="settings.resourceServer" placeholder="https://cdn-resource.nqf.qq.com/release/" /></label>
            <label class="capture-field"><span>Remote bundle</span><NInput v-model:value="settings.resourceBundle" placeholder="例如 activity / extraRes" /></label>
            <label class="capture-field"><span>Bundle version</span><NInput v-model:value="settings.resourceBundleVersion" placeholder="settings.json 中对应的 bundleVers 值" /></label>
          </div>
          <div class="manifest-actions">
            <NButton secondary :loading="resolvingManifest" :disabled="!settings.resourceServer || !settings.resourceBundle || !settings.resourceBundleVersion" @click="resolveCocosManifest">
              <i class="i-carbon-search mr-1" />解析 Cocos manifest
            </NButton><span v-if="manifestResult?.configured">{{ manifestResult.resolvedResources?.length || 0 }} 已映射 · {{ manifestResult.unresolvedPaths?.length || 0 }} 待处理</span>
          </div>
          <div v-if="manifestResult?.manifestUrl" class="manifest-proof">
            <code>{{ manifestResult.manifestUrl }}</code><small>manifest SHA-256 {{ manifestResult.manifestSha256 }}</small>
          </div>
        </div>
        <div v-if="scanResult" class="activity-summary">
          <div class="activity-summary__top">
            <span class="activity-badge"><i class="i-carbon-gift" />{{ scanResult.id }}</span><span>{{ scanResult.frameCount }} 帧 · {{ prettyBytes(scanResult.bytes) }}</span>
          </div>
          <div class="activity-id-row">
            <span v-for="activityId in [...new Set(scanResult.activities.flatMap(item => item.activityIds))].filter(id => id.startsWith('20261117'))" :key="activityId" class="activity-id-chip">{{ activityId }}</span>
          </div>
          <p class="capture-description">
            列表与详情来自 Helper 原始响应；详情中的说明已解码。玩法状态与活动操作协议仍需逐项适配。
          </p>
        </div>
        <div v-if="scanResult?.activities.length" class="asset-list">
          <article v-for="activity in scanResult.activities" :key="`${activity.sequence}-${activity.method}`" class="activity-row">
            <button class="activity-row__toggle" :aria-expanded="expanded === `${activity.sequence}`" @click="expanded = expanded === `${activity.sequence}` ? '' : `${activity.sequence}`">
              <span class="activity-method">{{ activity.method }}</span><strong>{{ activityTitle(activity) }}</strong><span class="activity-seq">#{{ activity.sequence }} · conn {{ activity.connectionId }}</span><i class="session-chevron i-carbon-chevron-down" :class="{ rotated: expanded === `${activity.sequence}` }" />
            </button>
            <div v-if="expanded === `${activity.sequence}`" class="activity-detail">
              <div class="activity-meta">
                <code>{{ activity.activityIds.join(' · ') }}</code><time>{{ activity.timestamp }}</time><span>{{ prettyBytes(activity.bodyBytes) }}</span>
              </div>
              <div v-if="activity.resources?.length" class="resource-block">
                <h3>关联公告素材</h3><div v-for="resource in activity.resources" :key="resource.id" class="bulletin-resource">
                  <strong>{{ resource.title }}</strong><span>{{ resource.id }}</span><a :href="resource.resourceUrl" target="_blank" rel="noreferrer">{{ resource.resourceUrl }}</a>
                </div>
              </div>
              <div v-if="activity.urls.length" class="resource-block">
                <h3>HTTPS 资源</h3><a v-for="url in activity.urls" :key="url" :href="url" target="_blank" rel="noreferrer">{{ url }}</a>
              </div>
              <div v-if="activity.resourcePaths.length" class="resource-block">
                <h3>Cocos 资源路径</h3><div v-for="resourcePath in activity.resourcePaths" :key="resourcePath" class="mapped-resource">
                  <code>{{ resourcePath }}</code><a v-if="mappedResource(resourcePath)" :href="mappedResource(resourcePath)?.url" target="_blank" rel="noreferrer">{{ mappedResource(resourcePath)?.url }}</a><span v-else>需要该版本的 Cocos manifest 才能映射 CDN URL</span>
                </div>
              </div>
              <details><summary>查看脱敏活动 JSON</summary><pre>{{ prettyJson(activity.decoded || activity.alternateDecoded) }}</pre></details>
              <details><summary>查看原始 wire 字段结构</summary><pre>{{ prettyJson(activity.rawWireFields) }}</pre><code>SHA-256 {{ activity.bodySha256 }}</code></details>
            </div>
          </article>
        </div>
        <div v-else class="capture-empty">
          <span class="capture-empty__icon"><i class="i-carbon-search-locate" /></span><strong>尚无 Helper 活动索引</strong><p>填写 Helper 会话目录，点“扫描 Helper 会话”。预设目录包含你提供的 session-1795624137192。</p><code>List: 2026111707 · GetGroup: 2026111707 → 1708 / 1709</code>
        </div>
        <div class="asset-actions">
          <NButton type="primary" :loading="downloading" :disabled="!scanResult" @click="downloadAssets">
            <i class="i-carbon-download mr-1" />下载 HTTPS 素材
          </NButton><span>按活动 ID / Helper 版本 / SHA-256 清单去重</span>
        </div>
        <div v-if="data.assets.length" class="asset-list asset-list--downloaded">
          <article v-for="(asset, index) in data.assets.slice(0, 12)" :key="`${asset.resourceUrl}-${asset.resourcePath}-${index}`" class="asset-row">
            <span class="asset-thumb"><i class="i-carbon-image" /></span><div class="asset-copy">
              <strong>{{ asset.activityId || '活动资源' }}</strong><span>{{ asset.file || asset.resourceUrl || asset.resourcePath }}</span><code v-if="asset.sha256">{{ asset.contentType }} · {{ prettyBytes(asset.size || 0) }} · {{ asset.sha256.slice(0, 16) }}…</code><em v-else>{{ asset.error || '路径映射待解析' }}</em>
            </div><i class="asset-status" :class="asset.sha256 ? 'is-done' : 'is-pending'" />
          </article>
        </div>
      </section>
    </div>

    <section class="capture-panel capture-sessions cartoon-card">
      <div class="capture-section-heading capture-session-heading">
        <div><span class="capture-kicker">03 / EVIDENCE</span><h2>会话索引证据</h2></div><span class="session-total">{{ scanResult?.connections?.length || 0 }} connections · {{ scanResult?.frameErrors || 0 }} skipped frames</span>
      </div>
      <div v-if="scanResult" class="evidence-grid">
        <article class="evidence-item">
          <span>来源</span><strong>QQ 农场助手 · Helper</strong>
        </article><article class="evidence-item">
          <span>Session</span><strong>{{ scanResult.id }}</strong>
        </article><article class="evidence-item">
          <span>启动时间</span><strong>{{ scanResult.startedAt || '—' }}</strong>
        </article><article class="evidence-item">
          <span>协议格式</span><strong>Helper v{{ scanResult.formatVersion }}</strong>
        </article>
      </div>
      <div v-if="scanResult?.connections?.length" class="connection-list">
        <div v-for="connection in scanResult.connections" :key="connection.connectionId" class="connection-row">
          <span>连接 #{{ connection.connectionId }}</span><time>{{ connection.timestamp }}</time><span>握手 URL 已省略</span>
        </div>
      </div>
      <div v-else class="session-blank">
        <i class="i-carbon-document-unknown" /><span>扫描 Helper 会话后显示 connection_id 和抓包时间。</span>
      </div>
    </section>
    <footer class="capture-footer">
      <i class="i-carbon-locked" />仅管理员可见 · 不从 bot WebSocket 流量采集 · Helper 明文握手文件不会被读取
    </footer>
  </main>
</template>

<style scoped>
.capture-page {
  --capture-muted: var(--ui-muted, #718078);
  --capture-accent: var(--ui-primary, #438d63);
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 12px;
  color: var(--ui-ink, #24362c);
}
.capture-hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 178px;
  overflow: hidden;
  padding: 28px 34px;
  border: 1px solid color-mix(in srgb, var(--ui-primary, #438d63) 18%, transparent);
  background:
    radial-gradient(
      ellipse at 86% 5%,
      color-mix(in srgb, var(--ui-primary, #438d63) 23%, transparent),
      transparent 36%
    ),
    linear-gradient(120deg, color-mix(in srgb, var(--ui-surface) 94%, #dcefe2), var(--ui-surface));
  box-shadow: var(--ui-shadow-sm, 0 8px 24px rgba(36, 54, 44, 0.06));
}
.capture-hero__copy,
.capture-hero__actions {
  position: relative;
  z-index: 1;
}
.capture-eyebrow,
.capture-kicker {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--capture-accent);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
}
.capture-hero h1 {
  margin: 11px 0 7px;
  font-size: clamp(25px, 3vw, 34px);
  font-weight: 800;
  letter-spacing: -0.04em;
}
.capture-hero p,
.capture-description {
  max-width: 640px;
  margin: 0;
  color: var(--capture-muted);
  font-size: 12px;
  line-height: 1.7;
}
.capture-hero__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.capture-source {
  max-width: 220px;
  overflow: hidden;
  padding: 8px 11px;
  border-radius: 999px;
  background: var(--ui-surface-strong);
  color: var(--capture-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.capture-source i {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: #d8a544;
}
.capture-orbit {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--ui-primary, #438d63) 18%, transparent);
  border-radius: 50%;
  pointer-events: none;
}
.capture-orbit--one {
  right: 13%;
  top: -90px;
  width: 310px;
  height: 310px;
}
.capture-orbit--two {
  right: 17%;
  top: -50px;
  width: 230px;
  height: 230px;
}
.capture-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 13px;
}
.capture-metric {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 17px 19px;
  border: 1px solid var(--ui-border, rgba(70, 100, 80, 0.12));
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm, 0 5px 16px rgba(20, 40, 20, 0.04));
}
.capture-metric > span,
.evidence-item > span {
  color: var(--capture-muted);
  font-size: 11px;
  font-weight: 600;
}
.capture-metric strong {
  font-size: 25px;
  line-height: 1.1;
  letter-spacing: -0.035em;
}
.capture-metric small {
  color: var(--capture-muted);
  font-size: 10px;
}
.capture-columns {
  display: grid;
  grid-template-columns: minmax(350px, 0.88fr) minmax(450px, 1.12fr);
  align-items: stretch;
  gap: 16px;
}
.capture-panel {
  min-width: 0;
  padding: 21px;
  border: 1px solid var(--ui-border, rgba(70, 100, 80, 0.13));
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm, 0 6px 20px rgba(30, 60, 40, 0.05));
}
.capture-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.capture-section-heading h2 {
  margin: 4px 0 0;
  font-size: 19px;
  font-weight: 750;
  letter-spacing: -0.025em;
}
.capture-icon {
  display: grid;
  width: 39px;
  height: 39px;
  place-items: center;
  border-radius: 13px;
  background: color-mix(in srgb, var(--ui-primary, #438d63) 11%, var(--ui-surface-soft));
  color: var(--capture-accent);
  font-size: 20px;
}
.capture-icon--gold {
  background: rgba(225, 177, 68, 0.14);
  color: #b58119;
}
.capture-description {
  margin: -5px 0 15px;
  font-size: 11px;
}
.capture-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 13px;
}
.capture-field > span {
  color: var(--capture-muted);
  font-size: 11px;
  font-weight: 700;
}
.capture-field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.source-checklist {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}
.source-checklist span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 7px;
  border-radius: 8px;
  background: var(--ui-surface-soft);
  color: var(--capture-muted);
  font-size: 9px;
}
.source-checklist i {
  color: var(--capture-accent);
}
.capture-storage {
  margin-top: 16px;
}
.capture-storage > div:first-child {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
}
.capture-progress {
  height: 7px;
  margin: 8px 0;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}
.capture-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #65bc7c, #379b68);
}
.capture-path {
  display: block;
  overflow-wrap: anywhere;
  color: var(--capture-muted);
  font-size: 9px;
  line-height: 1.5;
}
.capture-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 15px;
}
.capture-actions :deep(.n-button__content),
.asset-actions :deep(.n-button__content) {
  color: #fff;
}
.capture-actions :deep(.n-button--default-type .n-button__content) {
  color: var(--capture-ink);
}
.capture-notice {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  padding: 10px;
  border-radius: 10px;
  background: color-mix(in srgb, #e7b74c 12%, var(--ui-surface));
  color: var(--capture-muted);
  font-size: 9px;
  line-height: 1.55;
}
.capture-notice i {
  flex: none;
  color: #b58119;
}
.capture-source {
}
.capture-assets {
  display: flex;
  flex-direction: column;
}
.manifest-config {
  margin: 0 0 15px;
  padding: 11px;
  border: 1px solid var(--ui-border, rgba(70, 100, 80, 0.12));
  border-radius: 11px;
  background: var(--ui-surface-soft);
}
.manifest-config h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--capture-ink);
  font-size: 11px;
}
.manifest-config h3 i {
  color: var(--capture-accent);
}
.manifest-config p {
  margin: 6px 0 10px;
  color: var(--capture-muted);
  font-size: 9px;
  line-height: 1.5;
}
.manifest-config p code,
.manifest-proof code {
  font-size: 9px;
}
.manifest-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 10px;
}
.manifest-grid .capture-field:first-child {
  grid-column: 1/-1;
}
.manifest-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.manifest-actions > span,
.manifest-proof small {
  color: var(--capture-muted);
  font-size: 9px;
}
.manifest-proof {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  overflow-wrap: anywhere;
}
.activity-summary {
  margin-bottom: 12px;
  padding: 11px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--ui-primary-soft) 42%, var(--ui-surface-soft));
}
.activity-summary__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--capture-muted);
  font-size: 9px;
}
.activity-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--capture-accent);
  font-size: 11px;
  font-weight: 750;
}
.activity-id-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.activity-id-chip {
  padding: 4px 7px;
  border-radius: 7px;
  background: var(--ui-surface);
  color: var(--capture-ink);
  font:
    10px ui-monospace,
    monospace;
}
.activity-summary .capture-description {
  margin: 9px 0 0;
  font-size: 10px;
}
.asset-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 12px 0;
}
.asset-actions > span {
  color: var(--capture-muted);
  font-size: 9px;
}
.capture-empty {
  display: flex;
  min-height: 145px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 14px;
  text-align: center;
  border: 1px dashed var(--ui-border, rgba(70, 100, 80, 0.17));
  border-radius: 13px;
  background: color-mix(in srgb, var(--ui-surface-soft) 55%, transparent);
}
.capture-empty__icon {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 12px;
  background: var(--ui-surface);
  color: var(--capture-accent);
  font-size: 18px;
}
.capture-empty strong {
  margin-top: 9px;
  font-size: 12px;
}
.capture-empty p {
  max-width: 370px;
  margin: 5px 0 8px;
  color: var(--capture-muted);
  font-size: 9px;
  line-height: 1.6;
}
.capture-empty code,
.activity-meta code {
  padding: 4px 7px;
  border-radius: 7px;
  background: var(--ui-surface-strong);
  color: var(--capture-muted);
  font-size: 9px;
}
.asset-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 4px;
}
.asset-list--downloaded {
  max-height: 220px;
  overflow: auto;
}
.asset-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px;
  border: 1px solid var(--ui-border, rgba(70, 100, 80, 0.1));
  border-radius: 11px;
  background: var(--ui-surface-soft);
}
.asset-thumb {
  display: grid;
  width: 31px;
  height: 31px;
  flex: none;
  place-items: center;
  border-radius: 9px;
  background: var(--ui-surface);
  color: var(--capture-accent);
}
.asset-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}
.asset-copy strong {
  font-size: 10px;
}
.asset-copy > span {
  overflow: hidden;
  color: var(--capture-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-copy code,
.asset-copy em {
  color: var(--capture-muted);
  font-size: 9px;
  font-style: normal;
}
.asset-copy em {
  color: #bd7d30;
}
.asset-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #37ad6b;
}
.asset-status.is-pending {
  background: #dda640;
}
.activity-row {
  overflow: hidden;
  border: 1px solid var(--ui-border, rgba(70, 100, 80, 0.11));
  border-radius: 11px;
  background: var(--ui-surface-soft);
}
.activity-row__toggle {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.activity-row__toggle strong {
  flex: 1;
  font-size: 10px;
}
.activity-method {
  padding: 4px 7px;
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--capture-accent);
  font-size: 9px;
  font-weight: 700;
}
.activity-seq {
  color: var(--capture-muted);
  font:
    9px ui-monospace,
    monospace;
}
.session-chevron {
  color: var(--capture-muted);
  transition: transform 0.18s;
}
.session-chevron.rotated {
  transform: rotate(180deg);
}
.activity-detail {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 0 10px 11px;
}
.activity-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  color: var(--capture-muted);
  font-size: 9px;
}
.activity-meta time {
  margin-left: auto;
}
.resource-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px;
  border-radius: 9px;
  background: var(--ui-surface);
}
.resource-block h3 {
  margin: 0;
  color: var(--capture-muted);
  font-size: 9px;
}
.resource-block a,
.resource-block > code {
  overflow-wrap: anywhere;
  color: var(--capture-accent);
  font-size: 9px;
}
.activity-detail details {
  font-size: 9px;
}
.activity-detail summary {
  color: var(--capture-muted);
  cursor: pointer;
}
.activity-detail pre {
  max-height: 220px;
  overflow: auto;
  padding: 9px;
  border-radius: 8px;
  background: var(--ui-surface-strong);
  font-size: 9px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.activity-detail details > code {
  font-size: 8px;
  overflow-wrap: anywhere;
}
.capture-sessions {
  padding: 20px;
}
.capture-session-heading {
  margin-bottom: 12px;
}
.session-total {
  color: var(--capture-muted);
  font-size: 9px;
}
.evidence-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
}
.evidence-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
  padding: 10px;
  border-radius: 10px;
  background: var(--ui-surface-soft);
}
.evidence-item strong {
  overflow: hidden;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.connection-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.connection-row {
  display: flex;
  gap: 14px;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--ui-surface-soft);
  color: var(--capture-muted);
  font-size: 9px;
}
.connection-row span:first-child {
  color: var(--capture-accent);
  font-weight: 700;
}
.connection-row time {
  flex: 1;
}
.session-blank {
  display: flex;
  min-height: 76px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--capture-muted);
  font-size: 10px;
}
.session-blank i {
  font-size: 19px;
}
.capture-error {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 14px;
  border: 1px solid rgba(190, 80, 60, 0.2);
  border-radius: 12px;
  background: rgba(190, 80, 60, 0.08);
  color: #a13e30;
  font-size: 11px;
}
.capture-error button {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.capture-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--capture-muted);
  font-size: 9px;
}
.dark .capture-hero {
  background:
    radial-gradient(ellipse at 86% 5%, rgba(67, 141, 99, 0.2), transparent 36%),
    linear-gradient(120deg, #1e2923, #1a1f25);
}
@media (max-width: 900px) {
  .capture-columns {
    grid-template-columns: 1fr;
  }
  .evidence-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .capture-page {
    gap: 12px;
  }
  .capture-hero {
    min-height: 0;
    align-items: flex-start;
    flex-direction: column;
    gap: 16px;
    padding: 20px;
  }
  .capture-hero__actions {
    width: 100%;
    justify-content: space-between;
  }
  .capture-orbit--one {
    right: -50px;
    top: -130px;
  }
  .capture-orbit--two {
    right: -15px;
    top: -95px;
  }
  .capture-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .capture-metric {
    padding: 12px;
  }
  .capture-metric strong {
    font-size: 21px;
  }
  .capture-panel {
    padding: 15px;
  }
  .capture-field-grid {
    gap: 9px;
  }
  .capture-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .asset-actions {
    align-items: flex-start;
    flex-direction: column;
  }
  .capture-footer {
    align-items: flex-start;
    line-height: 1.5;
  }
  .connection-row {
    flex-wrap: wrap;
    gap: 7px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .capture-progress i,
  .session-chevron {
    transition: none;
  }
}
</style>
