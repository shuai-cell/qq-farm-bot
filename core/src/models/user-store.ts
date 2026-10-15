export {};
const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('../services/json-db');
const security = require('./auth-security');

const USERS_FILE: string = getDataFile('users.json');
const ADMIN_FILE: string = getDataFile('admin.json');

/** 主超级管理员的固定用户 id，存量账号迁移的归属基准。 */
const ADMIN_USER_ID = '1';

interface UserRecord {
    id: string;
    username: string;
    password: string;
    role: 'admin' | 'user';
    enabled: boolean;
    createdAt: number;
    mustChangePassword?: boolean;
}

interface UsersData {
    users: UserRecord[];
    nextId: number;
}

interface PublicUser {
    id: string;
    username: string;
    role: 'admin' | 'user';
    enabled: boolean;
    createdAt: number;
    mustChangePassword: boolean;
}

let data: UsersData | null = null;

function toPublic(user: UserRecord): PublicUser {
    return {
        id: user.id,
        username: user.username,
        role: user.role === 'admin' ? 'admin' : 'user',
        enabled: user.enabled !== false,
        createdAt: user.createdAt,
        mustChangePassword: user.mustChangePassword === true,
    };
}

function normalizeUser(raw: any): UserRecord | null {
    if (!raw || typeof raw !== 'object' || !String(raw.password || '').trim()) return null;
    const username = String(raw.username || '').trim();
    if (!username) return null;
    const record: UserRecord = {
        id: String(raw.id || '').trim(),
        username,
        password: String(raw.password),
        role: raw.role === 'admin' ? 'admin' : 'user',
        enabled: raw.enabled !== false,
        createdAt: Number(raw.createdAt) || Date.now(),
    };
    if (raw.mustChangePassword === true) record.mustChangePassword = true;
    return record;
}

function save(): void {
    ensureDataDir();
    if (!data) return;
    writeJsonFileAtomic(USERS_FILE, data);
}

/** 从旧的单管理员文件迁移出 admin 用户记录。 */
function migrateFromAdminFile(): UserRecord | null {
    try {
        if (!fs.existsSync(ADMIN_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
        const source = raw?.admin || raw;
        const password = String(source?.password || '').trim();
        const username = String(source?.username || 'admin').trim() || 'admin';
        if (!password) return null;
        const record: UserRecord = {
            id: ADMIN_USER_ID,
            username,
            password,
            role: 'admin',
            enabled: true,
            createdAt: Number(source?.createdAt) || Date.now(),
        };
        if (source?.mustChangePassword === true) record.mustChangePassword = true;
        return record;
    } catch {
        return null;
    }
}

function load(): UsersData {
    if (data) return data;
    ensureDataDir();

    let existing: any = null;
    try {
        if (fs.existsSync(USERS_FILE)) existing = readJsonFile(USERS_FILE, () => null);
    } catch {
        existing = null;
    }

    const rawUsers = Array.isArray(existing?.users) ? existing.users : [];
    const users: UserRecord[] = [];
    for (const raw of rawUsers) {
        const normalized = normalizeUser(raw);
        if (normalized && normalized.id && !users.some(u => u.id === normalized.id)) users.push(normalized);
    }

    if (users.length > 0) {
        // 确保始终存在一个启用的超级管理员
        if (!users.some(u => u.role === 'admin')) {
            const migrated = migrateFromAdminFile();
            if (migrated && !users.some(u => u.id === migrated.id)) users.unshift(migrated);
        }
        const maxId = users.reduce((m, u) => Math.max(m, Number.parseInt(u.id, 10) || 0), 0);
        let nextId = Number.parseInt(existing?.nextId, 10);
        if (!Number.isFinite(nextId) || nextId <= maxId) nextId = maxId + 1;
        data = { users, nextId };
        return data;
    }

    // 首次初始化 / 迁移
    const adminUser = migrateFromAdminFile() || {
        id: ADMIN_USER_ID,
        username: 'admin',
        password: security.hashPassword('admin'),
        role: 'admin' as const,
        enabled: true,
        createdAt: Date.now(),
        mustChangePassword: true,
    };
    data = { users: [adminUser], nextId: Number.parseInt(ADMIN_USER_ID, 10) + 1 };
    save();
    console.log(`[用户] 已初始化管理员账号 ${adminUser.username}（id=${adminUser.id}）`);
    return data;
}

function findByUsername(username: string): UserRecord | null {
    const name = String(username || '').trim();
    if (!name) return null;
    return load().users.find(u => u.username === name) || null;
}

function getUserById(id: unknown): UserRecord | null {
    const sid = String(id || '').trim();
    if (!sid) return null;
    return load().users.find(u => u.id === sid) || null;
}

function getUserPublic(id: unknown): PublicUser | null {
    const user = getUserById(id);
    return user ? toPublic(user) : null;
}

function listUsers(): PublicUser[] {
    return load().users.map(toPublic);
}

function getAdminUserId(): string {
    return ADMIN_USER_ID;
}

function validateUser(username: string, password: string, ip: string = 'unknown'): any {
    security.loadLoginAttempts();
    const rateLimit = security.checkRateLimit(ip);
    if (!rateLimit.allowed) return { error: 'rate_limit', ...rateLimit };

    const user = findByUsername(username);
    const lockout = security.checkUserLockout(user?.id || '');
    if (lockout.locked) return { error: 'locked', ...lockout };

    if (!user || !security.verifyPassword(String(password), user.password)) {
        const attempt = security.recordFailedAttempt(user?.id || '');
        return attempt.locked
            ? { error: 'locked', message: attempt.message }
            : { error: 'invalid_credentials', message: `用户名或密码错误，剩余尝试次数: ${attempt.remainingAttempts}` };
    }

    if (user.enabled === false) {
        return { error: 'disabled', message: '账号已被禁用，请联系管理员' };
    }

    security.clearFailedAttempts(user.id);
    if (security.needsRehash(user.password)) {
        user.password = security.hashPassword(String(password));
        save();
    }
    return { id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword === true };
}

function isUsernameTaken(username: string, exceptId?: string): boolean {
    const name = String(username || '').trim();
    if (!name) return true;
    return load().users.some(u => u.username === name && u.id !== String(exceptId || ''));
}

function createUser(input: { username: string; password: string }): { ok: boolean; error?: string; user?: PublicUser } {
    const username = String(input?.username || '').trim();
    const password = String(input?.password || '');
    if (!username) return { ok: false, error: '用户名不能为空' };
    if (username.length > 32) return { ok: false, error: '用户名长度不能超过32位' };
    if (isUsernameTaken(username)) return { ok: false, error: '用户名已存在' };
    const strength = security.validatePasswordStrength(password);
    if (!strength.valid) return { ok: false, error: strength.errors.join('；') };

    const current = load();
    const user: UserRecord = {
        id: String(current.nextId++),
        username,
        password: security.hashPassword(password),
        role: 'user',
        enabled: true,
        createdAt: Date.now(),
        mustChangePassword: true,
    };
    current.users.push(user);
    save();
    return { ok: true, user: toPublic(user) };
}

function resetPassword(id: unknown, newPassword: string): { ok: boolean; error?: string; message?: string } {
    const user = getUserById(id);
    if (!user) return { ok: false, error: '用户不存在' };
    const strength = security.validatePasswordStrength(String(newPassword || ''));
    if (!strength.valid) return { ok: false, error: strength.errors.join('；') };
    user.password = security.hashPassword(String(newPassword));
    user.mustChangePassword = true;
    security.loadLoginAttempts();
    security.clearFailedAttempts(user.id);
    save();
    return { ok: true, message: '密码已重置' };
}

function changeOwnPassword(id: unknown, oldPassword: string, newPassword: string): { ok: boolean; error?: string; message?: string } {
    const user = getUserById(id);
    if (!user) return { ok: false, error: '用户不存在' };
    if (!security.verifyPassword(String(oldPassword || ''), user.password)) return { ok: false, error: '当前密码错误' };
    const strength = security.validatePasswordStrength(String(newPassword || ''));
    if (!strength.valid) return { ok: false, error: strength.errors.join('；') };
    user.password = security.hashPassword(String(newPassword));
    delete user.mustChangePassword;
    save();
    return { ok: true, message: '密码修改成功' };
}

function setEnabled(id: unknown, enabled: boolean): { ok: boolean; error?: string; user?: PublicUser } {
    const user = getUserById(id);
    if (!user) return { ok: false, error: '用户不存在' };
    if (user.id === ADMIN_USER_ID && !enabled) return { ok: false, error: '不能禁用超级管理员' };
    user.enabled = !!enabled;
    save();
    return { ok: true, user: toPublic(user) };
}

load();

module.exports = {
    ADMIN_USER_ID,
    getAdminUserId,
    listUsers,
    getUserById,
    getUserPublic,
    findByUsername,
    isUsernameTaken,
    validateUser,
    createUser,
    resetPassword,
    changeOwnPassword,
    setEnabled,
};
