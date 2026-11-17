<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { computed, onMounted, ref } from 'vue'
import api, { getApiErrorMessage } from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import { useToastStore } from '@/stores/toast'

interface UserRow {
  id: string
  username: string
  role: 'admin' | 'user'
  enabled: boolean
  createdAt: number
  mustChangePassword: boolean
}

const toast = useToastStore()

const users = ref<UserRow[]>([])
const loading = ref(false)

const createVisible = ref(false)
const createSaving = ref(false)
const createForm = ref({ username: '', password: '', confirm: '' })

const resetVisible = ref(false)
const resetSaving = ref(false)
const resetTarget = ref<UserRow | null>(null)
const resetForm = ref({ password: '', confirm: '' })

const toggleTarget = ref<UserRow | null>(null)
const toggleVisible = ref(false)
const toggleSaving = ref(false)

const sortedUsers = computed(() =>
  [...users.value].sort((a, b) => Number(a.id) - Number(b.id)),
)

function formatDate(ts: number) {
  if (!ts)
    return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

async function fetchUsers() {
  loading.value = true
  try {
    const res = await api.get('/api/users')
    if (res.data.ok)
      users.value = res.data.data || []
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '获取用户列表失败'))
  }
  finally {
    loading.value = false
  }
}

function openCreate() {
  createForm.value = { username: '', password: '', confirm: '' }
  createVisible.value = true
}

async function handleCreate() {
  const { username, password, confirm } = createForm.value
  if (!username.trim()) {
    toast.warning('请输入用户名')
    return
  }
  if (password !== confirm) {
    toast.warning('两次输入的密码不一致')
    return
  }
  createSaving.value = true
  try {
    const res = await api.post('/api/users', { username: username.trim(), password }, { skipErrorToast: true } as any)
    if (res.data.ok) {
      toast.success('用户创建成功')
      createVisible.value = false
      await fetchUsers()
    }
    else {
      toast.error(getApiErrorMessage(res.data, '创建失败'))
    }
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '创建失败'))
  }
  finally {
    createSaving.value = false
  }
}

function openReset(user: UserRow) {
  resetTarget.value = user
  resetForm.value = { password: '', confirm: '' }
  resetVisible.value = true
}

async function handleReset() {
  if (!resetTarget.value)
    return
  const { password, confirm } = resetForm.value
  if (password !== confirm) {
    toast.warning('两次输入的密码不一致')
    return
  }
  resetSaving.value = true
  try {
    const res = await api.post(`/api/users/${resetTarget.value.id}/reset-password`, { newPassword: password }, { skipErrorToast: true } as any)
    if (res.data.ok) {
      toast.success('密码已重置')
      resetVisible.value = false
      await fetchUsers()
    }
    else {
      toast.error(getApiErrorMessage(res.data, '重置失败'))
    }
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '重置失败'))
  }
  finally {
    resetSaving.value = false
  }
}

function openToggle(user: UserRow) {
  toggleTarget.value = user
  toggleVisible.value = true
}

async function handleToggle() {
  const user = toggleTarget.value
  if (!user)
    return
  const nextEnabled = !user.enabled
  toggleSaving.value = true
  try {
    const res = await api.post(`/api/users/${user.id}/enabled`, { enabled: nextEnabled }, { skipErrorToast: true } as any)
    if (res.data.ok) {
      toast.success(nextEnabled ? '用户已启用' : '用户已禁用')
      toggleVisible.value = false
      await fetchUsers()
    }
    else {
      toast.error(getApiErrorMessage(res.data, '操作失败'))
    }
  }
  catch (error) {
    toast.error(getApiErrorMessage(error, '操作失败'))
  }
  finally {
    toggleSaving.value = false
  }
}

onMounted(fetchUsers)
</script>

<template>
  <div class="p-4 sm:p-6">
    <div class="mx-auto max-w-4xl">
      <div class="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 class="text-lg text-gray-900 font-bold dark:text-gray-100">
            用户管理
          </h1>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            新增用户、重置密码、禁用/启用。不同用户的账号与配置相互隔离。
          </p>
        </div>
        <BaseButton variant="primary" size="sm" @click="openCreate">
          <div class="i-carbon-add mr-1" />
          新增用户
        </BaseButton>
      </div>

      <div class="overflow-hidden farm-card rounded-lg">
        <div v-if="loading" class="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
          <div class="i-carbon-circle-dash animate-spin" />
          加载中...
        </div>
        <div v-else-if="sortedUsers.length === 0" class="py-12 text-center text-sm text-gray-400">
          暂无用户
        </div>
        <table v-else class="w-full text-left text-sm">
          <thead class="border-b border-gray-200 bg-gray-50/70 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-400">
            <tr>
              <th class="px-4 py-3 font-medium">
                用户名
              </th>
              <th class="px-4 py-3 font-medium">
                角色
              </th>
              <th class="px-4 py-3 font-medium">
                状态
              </th>
              <th class="hidden px-4 py-3 font-medium sm:table-cell">
                创建时间
              </th>
              <th class="px-4 py-3 text-right font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="user in sortedUsers"
              :key="user.id"
              class="border-b border-gray-100 last:border-0 dark:border-gray-800"
            >
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <span class="text-gray-900 font-medium dark:text-gray-100">{{ user.username }}</span>
                  <span
                    v-if="user.mustChangePassword"
                    class="rounded-lg bg-amber-50 px-1.5 py-0.2 text-[10px] text-amber-600 dark:bg-amber-900/25 dark:text-amber-400"
                  >
                    待改密
                  </span>
                </div>
              </td>
              <td class="px-4 py-3">
                <span
                  class="rounded-lg px-2 py-0.5 text-[11px] font-medium"
                  :class="user.role === 'admin'
                    ? 'bg-purple-50 text-purple-600 dark:bg-purple-900/25 dark:text-purple-400'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300'"
                >
                  {{ user.role === 'admin' ? '超级管理员' : '普通用户' }}
                </span>
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex items-center gap-1.5 text-xs"
                  :class="user.enabled ? 'text-green-600 dark:text-green-400' : 'text-gray-400'"
                >
                  <span class="h-2 w-2 rounded-full" :class="user.enabled ? 'bg-green-500' : 'bg-gray-400'" />
                  {{ user.enabled ? '已启用' : '已禁用' }}
                </span>
              </td>
              <td class="hidden px-4 py-3 text-xs text-gray-500 sm:table-cell dark:text-gray-400">
                {{ formatDate(user.createdAt) }}
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center justify-end gap-2">
                  <BaseButton variant="secondary" size="sm" @click="openReset(user)">
                    重置密码
                  </BaseButton>
                  <BaseButton
                    v-if="user.id !== '1'"
                    :variant="user.enabled ? 'danger' : 'success'"
                    size="sm"
                    @click="openToggle(user)"
                  >
                    {{ user.enabled ? '禁用' : '启用' }}
                  </BaseButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新增用户 -->
    <NModal
      :show="createVisible"
      :mask-closable="!createSaving"
      :auto-focus="false"
      @update:show="(v: boolean) => { if (!createSaving) createVisible = v }"
    >
      <NCard class="w-[min(420px,calc(100vw-32px))]" role="dialog" aria-modal="true" :bordered="false" title="新增用户" size="medium">
        <div class="flex flex-col gap-3">
          <BaseInput v-model="createForm.username" label="用户名" type="text" placeholder="登录用户名" />
          <BaseInput v-model="createForm.password" label="密码" type="password" placeholder="至少6位，含两种字符类型" />
          <BaseInput v-model="createForm.confirm" label="确认密码" type="password" placeholder="再次输入密码" />
          <p class="text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            新用户首次登录后需修改密码。
          </p>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <BaseButton variant="secondary" :disabled="createSaving" @click="createVisible = false">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="createSaving" @click="handleCreate">
              创建
            </BaseButton>
          </div>
        </template>
      </NCard>
    </NModal>

    <!-- 重置密码 -->
    <NModal
      :show="resetVisible"
      :mask-closable="!resetSaving"
      :auto-focus="false"
      @update:show="(v: boolean) => { if (!resetSaving) resetVisible = v }"
    >
      <NCard class="w-[min(420px,calc(100vw-32px))]" role="dialog" aria-modal="true" :bordered="false" :title="`重置密码 - ${resetTarget?.username || ''}`" size="medium">
        <div class="flex flex-col gap-3">
          <BaseInput v-model="resetForm.password" label="新密码" type="password" placeholder="至少6位，含两种字符类型" />
          <BaseInput v-model="resetForm.confirm" label="确认新密码" type="password" placeholder="再次输入新密码" />
          <p class="text-xs text-gray-500 leading-relaxed dark:text-gray-400">
            重置后该用户当前登录会话将失效，需在下次登录后修改密码。
          </p>
        </div>
        <template #footer>
          <div class="flex justify-end gap-2">
            <BaseButton variant="secondary" :disabled="resetSaving" @click="resetVisible = false">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="resetSaving" @click="handleReset">
              确定重置
            </BaseButton>
          </div>
        </template>
      </NCard>
    </NModal>

    <!-- 禁用/启用确认 -->
    <ConfirmModal
      :show="toggleVisible"
      :title="toggleTarget?.enabled ? '禁用用户' : '启用用户'"
      :message="toggleTarget?.enabled
        ? `确定禁用用户「${toggleTarget?.username}」吗？禁用后其登录会话将立即失效。`
        : `确定启用用户「${toggleTarget?.username}」吗？`"
      :type="toggleTarget?.enabled ? 'danger' : 'primary'"
      :loading="toggleSaving"
      @confirm="handleToggle"
      @cancel="toggleVisible = false"
    />
  </div>
</template>
