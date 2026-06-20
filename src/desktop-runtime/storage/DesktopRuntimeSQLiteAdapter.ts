import { NodeSQLiteAdapter } from '@/server/storage/NodeSQLiteAdapter';

export class DesktopRuntimeSQLiteAdapter extends NodeSQLiteAdapter {
  constructor(storageDbPath: string) {
    super({ dbPath: storageDbPath });
  }
}
