export {};
export interface Account {
  id: string;
  /** 归属的面板用户 id；存量账号迁移后归属超级管理员。 */
  ownerId: string;
  name: string;
  code: string;
  platform: string;
  uin: string;
  qq: string;
  avatar: string;
  nick?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsData {
  accounts: Account[];
  nextId: number;
}
