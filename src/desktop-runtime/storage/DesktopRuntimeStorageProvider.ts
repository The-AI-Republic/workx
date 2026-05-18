import { ServerStorageProvider } from '@/server/storage/ServerStorageProvider';

export class DesktopRuntimeStorageProvider extends ServerStorageProvider {
  constructor(storageDbPath: string) {
    super({ dbPath: storageDbPath });
  }
}
