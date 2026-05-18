import { TSRolloutStorageProvider } from '@/storage/rollout/provider/TSRolloutStorageProvider';

export class DesktopRuntimeRolloutStorageProvider extends TSRolloutStorageProvider {
  constructor(rolloutDbPath: string) {
    super({ dbPath: rolloutDbPath });
  }
}
