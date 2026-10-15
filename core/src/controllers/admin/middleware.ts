import type { NextFunction, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

const crypto = require('node:crypto');
const store = require('../../models/store');
const userStore = require('../../models/user-store');
const { normalizeAccountRef, resolveAccountId } = require('../../services/account-resolver');

export interface AuthUser {
    id: string;
    username: string;
    role: 'admin' | 'user';
}

interface AuthenticatedRequest extends Request {
    adminToken?: string;
    user?: AuthUser;
}

function getClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return String(cfIp).trim();
    const realIp = req.headers['x-real-ip'];
    if (realIp) return String(realIp).trim();
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const first = String(forwarded).split(',').map(item => item.trim()).find(Boolean);
        if (first) return first;
    }
    const address = req.ip || (req as any).connection?.remoteAddress || req.socket?.remoteAddress;
    return String(address || 'unknown').replace(/^::ffff:/, '');
}

const issueToken = (): string => crypto.randomBytes(24).toString('hex');

function createAuthRequired(ctx: AdminContext) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        const token = String(req.headers['x-admin-token'] || '');
        const session = token ? ctx.tokens.get(token) : undefined;
        if (!token || !session) {
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        // 用户被禁用或删除后，其 token 立即失效
        const record = userStore.getUserById(session.userId);
        if (!record || record.enabled === false) {
            ctx.tokens.delete(token);
            res.status(401).json({ ok: false, error: 'Unauthorized' });
            return;
        }
        req.adminToken = token;
        req.user = { id: record.id, username: record.username, role: record.role === 'admin' ? 'admin' : 'user' };
        next();
    };
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    if (!req.user || req.user.role !== 'admin') {
        res.status(403).json({ ok: false, error: '需要管理员权限' });
        return;
    }
    next();
}

/** 撤销某用户的全部 token（改密/重置/禁用时调用）。 */
function revokeUserTokens(ctx: AdminContext, userId: string): void {
    const id = String(userId || '');
    if (!id) return;
    for (const [token, session] of ctx.tokens.entries()) {
        if (session.userId === id) ctx.tokens.delete(token);
    }
    if (ctx.io) {
        for (const socket of ctx.io.sockets.sockets.values()) {
            const socketUserId = String((socket.data as any)?.userId || '');
            if (socketUserId === id) socket.disconnect(true);
        }
    }
}

function getAccountList(ctx: AdminContext, user?: AuthUser | null): any[] {
    let accounts: any[] = [];
    try {
        if (ctx.provider && typeof ctx.provider.getAccounts === 'function') {
            const data = ctx.provider.getAccounts();
            if (Array.isArray(data?.accounts)) accounts = data.accounts;
        }
    } catch {
        accounts = [];
    }
    if (!accounts.length) {
        const data = store.getAccounts ? store.getAccounts() : { accounts: [] };
        accounts = Array.isArray(data.accounts) ? data.accounts : [];
    }
    if (user && user.id) {
        return accounts.filter((account: any) => String(account?.ownerId || '') === String(user.id));
    }
    return accounts;
}

function getAccountIds(ctx: AdminContext, user?: AuthUser | null): string[] {
    return getAccountList(ctx, user).map((account: any) => String(account.id || '')).filter(Boolean);
}

const isSoftRuntimeError = (err: any): boolean => {
    const message = String(typeof err === 'string' ? err : err?.message || '');
    return message === '账号未运行' || message === 'API Timeout';
};

function isGatewayProtocolError(err: any): boolean {
    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    return String(err?.name || '') === 'GatewayError'
        || typeof err?.errorMessage === 'string'
        || typeof err?.error_message === 'string'
        || /^(?:[\w-]+\.)+[\w-]+(?:\s+.*?)?\bcode=\d+(?:\s|$)/.test(message);
}

function getProtocolErrorMessage(err: any): string {
    const direct = String(err?.errorMessage || err?.error_message || '').trim();
    if (direct) return direct;

    const message = String(typeof err === 'string' ? err : err?.message || '').trim();
    if (!isGatewayProtocolError(err)) return '';
    return message.match(/\bcode=\d+\b\s*(.*)$/)?.[1]?.trim() || '';
}

function handleApiError(res: Response, err: any): void {
    const protocolMessage = getProtocolErrorMessage(err);
    const payload: any = {
        ok: false,
        error: protocolMessage || (typeof err === 'string' ? err : err?.message) || 'Unknown error',
    };
    if (protocolMessage) payload.errorMessage = protocolMessage;
    const errorCode = Number(err?.code);
    if (Number.isFinite(errorCode) && errorCode !== 0) payload.errorCode = errorCode;
    if (isSoftRuntimeError(err) || isGatewayProtocolError(err)) {
        res.json(payload);
        return;
    }
    res.status(500).json(payload);
}

function resolveAccId(ctx: AdminContext, rawRef: any, user?: AuthUser | null): string {
    const input = normalizeAccountRef(rawRef);
    if (!input) return '';
    const owned = getAccountList(ctx, user);
    const isOwned = (id: string): boolean => !!id && owned.some((a: any) => String(a.id || '') === id);
    if (ctx.provider && typeof ctx.provider.resolveAccountId === 'function') {
        const resolvedByProvider = normalizeAccountRef(ctx.provider.resolveAccountId(input));
        if (resolvedByProvider && isOwned(resolvedByProvider)) return resolvedByProvider;
    }
    const resolvedLocal = resolveAccountId(owned, input);
    return isOwned(resolvedLocal) ? resolvedLocal : '';
}

function getAccId(ctx: AdminContext, req: Request): string {
    return resolveAccId(ctx, req.headers['x-account-id'], (req as AuthenticatedRequest).user);
}

function buildKnownFriendGidSettings(accountId: string): {
    knownFriendGids: any[];
    knownFriendGidSyncCooldownSec: number;
    friendsListCacheTtlSec: number;
} {
    return {
        knownFriendGids: store.getKnownFriendGids ? store.getKnownFriendGids(accountId) : [],
        knownFriendGidSyncCooldownSec: store.getKnownFriendGidSyncCooldownSec
            ? store.getKnownFriendGidSyncCooldownSec(accountId)
            : 600,
        friendsListCacheTtlSec: store.getFriendsListCacheTtlSec
            ? store.getFriendsListCacheTtlSec(accountId)
            : 60,
    };
}

module.exports = {
    getClientIp,
    issueToken,
    createAuthRequired,
    requireAdmin,
    revokeUserTokens,
    getAccountList,
    getAccountIds,
    isSoftRuntimeError,
    isGatewayProtocolError,
    getProtocolErrorMessage,
    handleApiError,
    resolveAccId,
    getAccId,
    buildKnownFriendGidSettings,
};
