import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import api, { getApiErrorMessage } from '@/api'

export interface AdminInfo {
  id?: string
  username: string
  role: 'admin' | 'user'
  avatar?: string
  enabled?: boolean
  mustChangePassword?: boolean
}

export interface LoginResult {
  ok: boolean
  error?: string
  errorType?: 'rate_limit' | 'locked' | 'invalid_credentials' | 'disabled'
  remainingMs?: number
  data?: {
    token: string
    role: 'admin' | 'user'
    user: { id: string, username: string }
    mustChangePassword?: boolean
  }
}

export const useUserStore = defineStore('user', () => {
  const token = useStorage('admin_token', '')
  // 默认值为 null 时 @vueuse 会选用 "any" 序列化器（write 用 String()），
  // 会把对象存成 "[object Object]"。这里显式使用容错的 JSON 序列化器。
  const userInfo = useStorage<AdminInfo | null>('user_info', null, undefined, {
    serializer: {
      read: (raw: string) => {
        try {
          const parsed = JSON.parse(raw)
          return parsed && typeof parsed === 'object' ? parsed as AdminInfo : null
        }
        catch {
          return null
        }
      },
      write: (value: AdminInfo | null) => JSON.stringify(value),
    },
  })
  const isLoggedIn = computed(() => !!token.value)
  const username = computed(() => userInfo.value?.username || '')
  const avatar = computed(() => userInfo.value?.avatar || '')
  const role = computed(() => userInfo.value?.role || 'user')
  const isAdmin = computed(() => userInfo.value?.role === 'admin')

  async function login(username: string, password: string): Promise<LoginResult> {
    try {
      const res = await api.post('/api/login', { username, password })
      if (res.data.ok) {
        token.value = res.data.data.token
        userInfo.value = {
          id: res.data.data.user.id,
          username: res.data.data.user.username,
          role: res.data.data.role,
          mustChangePassword: res.data.data.mustChangePassword,
        }
      }
      return res.data
    }
    catch (error: any) {
      const data = error.response?.data
      return data
        ? { ok: false, error: getApiErrorMessage(data, '网络错误'), errorType: data.errorType, remainingMs: data.remainingMs }
        : { ok: false, error: getApiErrorMessage(error, '网络错误') }
    }
  }

  async function logout() {
    try {
      await api.post('/api/logout')
    }
    finally {
      token.value = ''
      userInfo.value = null
    }
  }

  async function fetchUserInfo() {
    try {
      const res = await api.get('/api/user/me')
      if (res.data.ok)
        userInfo.value = res.data.data
      return res.data
    }
    catch {
      return { ok: false }
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    const res = await api.post('/api/user/change-password', { oldPassword, newPassword })
    return res.data
  }

  return {
    token,
    userInfo,
    isLoggedIn,
    username,
    avatar,
    role,
    isAdmin,
    login,
    logout,
    fetchUserInfo,
    changePassword,
  }
})
