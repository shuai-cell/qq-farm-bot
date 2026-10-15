import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 用户管理路由（仅超级管理员可用）。
 * 支持：新增用户、重置密码、禁用/启用。
 */

const userStore = require('../../models/user-store');
const { createModuleLogger } = require('../../services/logger');
const { requireAdmin, revokeUserTokens } = require('./middleware');

const adminLogger = createModuleLogger('admin');

interface AuthedRequest extends Request {
    user?: { id: string; username: string; role: 'admin' | 'user' };
}

function mountUserRoutes(app: Application, ctx: AdminContext): void {
    // 列出全部用户（不含密码）
    app.get('/api/users', requireAdmin, (_req: Request, res: Response) => {
        res.json({ ok: true, data: userStore.listUsers() });
    });

    // 新增用户
    app.post('/api/users', requireAdmin, (req: AuthedRequest, res: Response) => {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const result = userStore.createUser({
            username: String(body.username || ''),
            password: String(body.password || ''),
        });
        if (!result.ok) {
            return res.status(400).json({ ok: false, error: result.error });
        }
        adminLogger.info('新增用户', { operator: req.user?.username, username: result.user?.username });
        res.json({ ok: true, data: result.user });
    });

    // 重置某用户密码
    app.post('/api/users/:id/reset-password', requireAdmin, (req: AuthedRequest, res: Response) => {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const newPassword = String(body.newPassword || body.password || '');
        const result = userStore.resetPassword(req.params.id, newPassword);
        if (!result.ok) {
            return res.status(400).json({ ok: false, error: result.error });
        }
        revokeUserTokens(ctx, String(req.params.id));
        adminLogger.info('重置用户密码', { operator: req.user?.username, targetId: req.params.id });
        res.json({ ok: true, message: result.message });
    });

    // 禁用/启用某用户
    app.post('/api/users/:id/enabled', requireAdmin, (req: AuthedRequest, res: Response) => {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const enabled = body.enabled !== false && body.enabled !== 'false';
        const result = userStore.setEnabled(req.params.id, enabled);
        if (!result.ok) {
            return res.status(400).json({ ok: false, error: result.error });
        }
        if (!enabled) revokeUserTokens(ctx, String(req.params.id));
        adminLogger.info(enabled ? '启用用户' : '禁用用户', { operator: req.user?.username, targetId: req.params.id });
        res.json({ ok: true, data: result.user });
    });
}

module.exports = { mountUserRoutes };
