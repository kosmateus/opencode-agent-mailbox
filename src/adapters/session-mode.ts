import { createHash } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import type { TreeSetting, TreeSettings } from '../ports/index.js';

export class SessionModeStore implements TreeSettings {
  constructor(
    private readonly storage: Pick<Plugin.Context['storage'], 'get' | 'set' | 'remove'>,
    private readonly projectID: string,
  ) {}

  async get(rootSessionID: string, setting: TreeSetting): Promise<boolean | undefined> {
    const value = await this.storage.get(this.key(rootSessionID, setting));
    return typeof value === 'boolean' ? value : undefined;
  }

  async set(rootSessionID: string, setting: TreeSetting, enabled: boolean): Promise<void> {
    await this.storage.set(this.key(rootSessionID, setting), enabled);
  }
  async remove(sessionID: string): Promise<void> {
    await this.storage.remove(this.key(sessionID, 'bidirectional'));
    await this.storage.remove(this.key(sessionID, 'wakeOnReply'));
  }

  private key(rootSessionID: string, setting: TreeSetting): string {
    return `${setting}/${hash(this.projectID)}/${hash(rootSessionID)}`;
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
