import { describe, expect, it } from 'vitest';
import { AppLocalStore, createInstalledRecord } from '../AppLocalStore';
import { AppMetadataIndex } from '../AppMetadataIndex';
import { makeManifest, MemoryConfigStorage } from './testUtils';

describe('AppMetadataIndex', () => {
  it('finds installed apps by manifest capabilities and metadata markdown', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const linear = makeManifest();
    const notion = makeManifest({
      appId: 'com.example.notion',
      slug: 'notion',
      name: 'Notion',
      description: 'Read workspace docs.',
      capabilities: ['Search pages', 'Read docs'],
      runtime: {
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://mcp.notion.example/mcp',
        serverName: 'notion',
      },
    });

    await store.upsertInstalledApp(createInstalledRecord(linear));
    await store.saveManifest(linear.appId, linear);
    await store.saveMetadataMarkdown(linear.appId, 'Find issues, projects, teams, and salary planning tickets.');
    await store.upsertInstalledApp(createInstalledRecord(notion));
    await store.saveManifest(notion.appId, notion);
    await store.saveMetadataMarkdown(notion.appId, 'Search docs and meeting notes.');

    const results = await new AppMetadataIndex(store).search('project issue trend', 5);

    expect(results[0]).toMatchObject({
      appId: linear.appId,
      suggestedAction: 'connect_auth',
      status: 'needs_auth',
    });
    expect(results.map(result => result.appId)).toContain(linear.appId);
  });

  it('does not index installed apps missing cached markdown', async () => {
    const store = new AppLocalStore(new MemoryConfigStorage());
    const manifest = makeManifest();

    await store.upsertInstalledApp(createInstalledRecord(manifest));
    await store.saveManifest(manifest.appId, manifest);

    const results = await new AppMetadataIndex(store).search('issues', 5);

    expect(results).toEqual([]);
  });
});
