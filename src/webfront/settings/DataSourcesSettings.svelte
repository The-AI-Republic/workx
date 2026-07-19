<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    CreateDataSourceFields,
    DataContextFact,
    DataContextFactKind,
    DataContextRevisionSummary,
    DataSourceContext,
    DataSourcePublicView,
    DataSourceTestResult,
  } from '@/core/data-sources/types';
  import { dataSourcesClient, dataSourceUiError } from '@/webfront/data-sources/client';
  import { t } from '../lib/i18n';

  let {
    onBack,
    initialSourceId,
    initialTab = 'details',
  }: {
    onBack?: () => void;
    initialSourceId?: string;
    initialTab?: 'details' | 'context';
  } = $props();

  type EditorTab = 'details' | 'context';

  let loading = $state(true);
  let busy = $state(false);
  let statusAvailable = $state(true);
  let errorMessage = $state('');
  let successMessage = $state('');
  let sources: DataSourcePublicView[] = $state([]);
  let contextCounts: Record<string, number> = $state({});
  let selected: DataSourcePublicView | null = $state(null);
  let editorOpen = $state(false);
  let activeTab: EditorTab = $state('details');
  let testResult: DataSourceTestResult | null = $state(null);
  let acknowledgeLeastPrivilege = $state(false);
  let allowedNamespacesText = $state('');
  let allowedObjectsText = $state('');
  let password = $state('');
  let passwordAction: 'keep' | 'replace' = $state('keep');

  let context: DataSourceContext | null = $state(null);
  let contextRevisions: DataContextRevisionSummary[] = $state([]);
  let overviewDraft = $state('');
  let factDraft = $state(newFactDraft());
  let editingFactId: string | null = $state(null);

  let form: CreateDataSourceFields = $state(emptySource());

  const factKinds: DataContextFactKind[] = [
    'object_meaning',
    'field_meaning',
    'enum_value',
    'unit',
    'metric_definition',
    'join_hint',
    'exclusion_rule',
    'timezone_rule',
    'caveat',
    'other',
  ];

  function emptySource(): CreateDataSourceFields {
    return {
      name: '',
      description: '',
      category: 'sql',
      connectorId: 'postgres-native',
      transport: { type: 'native' },
      connection: {
        host: '',
        port: 5432,
        database: '',
        username: '',
        tls: { mode: 'verify-full' },
      },
      businessTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      isDefault: false,
      enabled: true,
      policy: {
        agentAccessEnabled: false,
        readOnly: true,
        maxRows: 200,
        timeoutMs: 15_000,
        maxConcurrentQueries: 1,
        allowedNamespaces: [],
        allowedObjects: [],
        queryApproval: 'auto_read',
        learningMode: 'automatic',
      },
    };
  }

  function newFactDraft() {
    return {
      kind: 'other' as DataContextFactKind,
      namespace: '',
      object: '',
      field: '',
      assertion: '',
      value: '',
      meaning: '',
      unit: '',
    };
  }

  onMount(load);

  async function load() {
    loading = true;
    clearMessages();
    try {
      const runtimeStatus = await dataSourcesClient.status();
      statusAvailable = runtimeStatus.available;
      if (!runtimeStatus.available) {
        errorMessage = `Data Sources is unavailable (${runtimeStatus.errorCode ?? 'initialization failed'}).`;
        return;
      }
      sources = await dataSourcesClient.list();
      await loadContextCounts();
      if (initialSourceId) {
        const source = sources.find((item) => item.source.id === initialSourceId);
        if (source) await openEditor(source, initialTab);
      }
    } catch (error) {
      errorMessage = dataSourceUiError(error);
    } finally {
      loading = false;
    }
  }

  async function loadContextCounts() {
    const pairs = await Promise.all(
      sources
        .filter((item) => item.source.lifecycleState === 'active')
        .map(async (item) => {
          try {
            const value = await dataSourcesClient.getContext(item.source.id);
            return [
              item.source.id,
              value.facts.filter((fact) => fact.status === 'active').length,
            ] as const;
          } catch {
            return [item.source.id, 0] as const;
          }
        })
    );
    contextCounts = Object.fromEntries(pairs);
  }

  function clearMessages() {
    errorMessage = '';
    successMessage = '';
  }

  function openCreate() {
    clearMessages();
    selected = null;
    form = emptySource();
    allowedNamespacesText = '';
    allowedObjectsText = '';
    password = '';
    passwordAction = 'replace';
    testResult = null;
    acknowledgeLeastPrivilege = false;
    context = null;
    activeTab = 'details';
    editorOpen = true;
  }

  async function openEditor(source: DataSourcePublicView, tab: EditorTab = 'details') {
    clearMessages();
    selected = source;
    form = structuredClone($state.snapshot(source.source)) as unknown as CreateDataSourceFields;
    allowedNamespacesText = source.source.policy.allowedNamespaces.join('\n');
    allowedObjectsText = source.source.policy.allowedObjects.join('\n');
    password = '';
    passwordAction = 'keep';
    testResult = source.source.lastTest
      ? { ...source.source.lastTest, connectorId: source.source.connectorId, warnings: [] }
      : null;
    acknowledgeLeastPrivilege = Boolean(source.source.policy.leastPrivilegeAcknowledgement);
    activeTab = tab;
    editorOpen = true;
    if (tab === 'context') await loadContext(source.source.id);
  }

  function closeEditor() {
    password = '';
    editorOpen = false;
    selected = null;
    context = null;
    editingFactId = null;
    factDraft = newFactDraft();
    clearMessages();
  }

  function splitLines(value: string): string[] {
    return [
      ...new Set(
        value
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean)
      ),
    ];
  }

  function sourceFromForm(): CreateDataSourceFields {
    return {
      ...form,
      connection: {
        ...form.connection,
        tls: {
          mode: form.connection.tls.mode,
          ...(form.connection.tls.caPem ? { caPem: form.connection.tls.caPem } : {}),
        },
      },
      policy: {
        ...form.policy,
        allowedNamespaces: splitLines(allowedNamespacesText),
        allowedObjects: splitLines(allowedObjectsText),
      },
    };
  }

  function changeEngine() {
    form.connection.port = form.connectorId === 'postgres-native' ? 5432 : 3306;
    testResult = null;
  }

  function connectionTestFailure(result: DataSourceTestResult): string {
    return result.warnings[0] ?? `Connection test failed (${result.errorCode ?? 'unknown error'}).`;
  }

  async function testConnection() {
    clearMessages();
    busy = true;
    try {
      if (selected && passwordAction === 'keep') {
        const saved = await dataSourcesClient.test(selected.source.id, selected.source.revision);
        testResult = saved.test;
        selected = saved.source;
        sources = sources.map((item) =>
          item.source.id === saved.source.source.id ? saved.source : item
        );
        if (testResult.status === 'reachable') {
          successMessage =
            'Saved connection is reachable. Saving edited connection fields will test them again.';
        } else {
          errorMessage = connectionTestFailure(testResult);
        }
      } else {
        testResult = await dataSourcesClient.testCandidate({
          source: sourceFromForm(),
          password,
        });
        if (testResult.status === 'reachable') {
          successMessage = 'Candidate connection is reachable. Save will repeat this test.';
        } else {
          errorMessage = connectionTestFailure(testResult);
        }
      }
      if (testResult.status === 'reachable') {
        acknowledgeLeastPrivilege =
          testResult.readOnlyAssessment.level === 'verified' ? true : acknowledgeLeastPrivilege;
      }
    } catch (error) {
      errorMessage = dataSourceUiError(error);
    } finally {
      busy = false;
    }
  }

  async function saveSource() {
    clearMessages();
    busy = true;
    try {
      const source = sourceFromForm();
      let saved: DataSourcePublicView;
      if (selected) {
        saved = await dataSourcesClient.update(selected.source.id, {
          expectedRevision: selected.source.revision,
          patch: source,
          passwordAction,
          ...(passwordAction === 'replace' ? { password } : {}),
          leastPrivilegeAcknowledged: acknowledgeLeastPrivilege,
        });
      } else {
        saved = await dataSourcesClient.create({
          source,
          password,
          leastPrivilegeAcknowledged: acknowledgeLeastPrivilege,
        });
      }
      password = '';
      passwordAction = 'keep';
      selected = saved;
      sources = await dataSourcesClient.list();
      await loadContextCounts();
      form = structuredClone($state.snapshot(saved.source)) as unknown as CreateDataSourceFields;
      successMessage = 'Data source saved after a fresh connection test.';
    } catch (error) {
      errorMessage = dataSourceUiError(error);
    } finally {
      busy = false;
    }
  }

  async function deleteSource(source: DataSourcePublicView) {
    const label = source.source.lifecycleState === 'deleting' ? 'retry deleting' : 'delete';
    if (!window.confirm(`Permanently ${label} “${source.source.name}” and its saved context?`))
      return;
    clearMessages();
    busy = true;
    try {
      await dataSourcesClient.delete(source.source.id, source.source.revision);
      sources = await dataSourcesClient.list();
      contextCounts = { ...contextCounts, [source.source.id]: 0 };
      if (selected?.source.id === source.source.id) closeEditor();
      successMessage = 'Data source deleted.';
    } catch (error) {
      errorMessage = dataSourceUiError(error);
      await load();
    } finally {
      busy = false;
    }
  }

  async function testSaved(source: DataSourcePublicView) {
    clearMessages();
    busy = true;
    try {
      const saved = await dataSourcesClient.test(source.source.id, source.source.revision);
      sources = sources.map((item) => (item.source.id === source.source.id ? saved.source : item));
      if (saved.test.status === 'reachable') {
        successMessage = `${source.source.name} is reachable.`;
      } else {
        errorMessage = connectionTestFailure(saved.test);
      }
    } catch (error) {
      errorMessage = dataSourceUiError(error);
      sources = await dataSourcesClient.list();
    } finally {
      busy = false;
    }
  }

  async function selectTab(tab: EditorTab) {
    activeTab = tab;
    if (tab === 'context' && selected) await loadContext(selected.source.id);
  }

  async function loadContext(sourceId: string) {
    clearMessages();
    busy = true;
    try {
      [context, contextRevisions] = await Promise.all([
        dataSourcesClient.getContext(sourceId, true),
        dataSourcesClient.listContextRevisions(sourceId),
      ]);
      overviewDraft = context.overviewMarkdown;
      contextCounts = {
        ...contextCounts,
        [sourceId]: context.facts.filter((fact) => fact.status === 'active').length,
      };
      if (context.warnings?.length) errorMessage = context.warnings.join(' ');
    } catch (error) {
      errorMessage = dataSourceUiError(error);
    } finally {
      busy = false;
    }
  }

  async function saveOverview() {
    if (!selected || !context) return;
    await updateContext({
      expectedRevision: context.revision,
      overviewMarkdown: overviewDraft,
    });
  }

  function editFact(fact: DataContextFact) {
    editingFactId = fact.id;
    factDraft = {
      kind: fact.kind,
      namespace: fact.subject.namespace ?? '',
      object: fact.subject.object ?? '',
      field: fact.subject.field ?? '',
      assertion: fact.assertion,
      value: fact.structuredValue?.value ?? '',
      meaning: fact.structuredValue?.meaning ?? '',
      unit: fact.structuredValue?.unit ?? '',
    };
  }

  async function saveFact() {
    if (!context || !selected) return;
    const fact = {
      kind: factDraft.kind,
      subject: {
        ...(factDraft.namespace.trim() ? { namespace: factDraft.namespace.trim() } : {}),
        ...(factDraft.object.trim() ? { object: factDraft.object.trim() } : {}),
        ...(factDraft.field.trim() ? { field: factDraft.field.trim() } : {}),
      },
      assertion: factDraft.assertion,
      ...(factDraft.value || factDraft.meaning || factDraft.unit
        ? {
            structuredValue: {
              ...(factDraft.value ? { value: factDraft.value } : {}),
              ...(factDraft.meaning ? { meaning: factDraft.meaning } : {}),
              ...(factDraft.unit ? { unit: factDraft.unit } : {}),
            },
          }
        : {}),
    };
    await updateContext({
      expectedRevision: context.revision,
      factOperations: [
        editingFactId
          ? { operation: 'replace', factId: editingFactId, fact }
          : { operation: 'add', fact },
      ],
    });
    editingFactId = null;
    factDraft = newFactDraft();
  }

  async function supersedeFact(fact: DataContextFact) {
    if (!context || !selected || !window.confirm('Remove this fact from active context?')) return;
    await updateContext({
      expectedRevision: context.revision,
      factOperations: [{ operation: 'supersede', factId: fact.id }],
    });
  }

  async function updateContext(input: Parameters<typeof dataSourcesClient.updateContext>[1]) {
    if (!selected) return;
    clearMessages();
    busy = true;
    try {
      context = await dataSourcesClient.updateContext(selected.source.id, input);
      overviewDraft = context.overviewMarkdown;
      contextRevisions = await dataSourcesClient.listContextRevisions(selected.source.id);
      contextCounts = {
        ...contextCounts,
        [selected.source.id]: context.facts.filter((fact) => fact.status === 'active').length,
      };
      successMessage = 'Context saved.';
    } catch (error) {
      errorMessage = dataSourceUiError(error);
      if (selected) await loadContext(selected.source.id);
    } finally {
      busy = false;
    }
  }

  async function revertContext(revision: number) {
    if (!selected || !context) return;
    if (!window.confirm(`Restore context revision ${revision} as a new revision?`)) return;
    clearMessages();
    busy = true;
    try {
      context = await dataSourcesClient.revertContext(
        selected.source.id,
        revision,
        context.revision
      );
      overviewDraft = context.overviewMarkdown;
      contextRevisions = await dataSourcesClient.listContextRevisions(selected.source.id);
      successMessage = `Restored revision ${revision} without deleting history.`;
    } catch (error) {
      errorMessage = `${dataSourceUiError(error)} Context changed; review it before reverting.`;
      await loadContext(selected.source.id);
    } finally {
      busy = false;
    }
  }
</script>

<section class="data-sources" aria-labelledby="data-sources-title">
  <header class="page-header">
    <button class="back" type="button" onclick={onBack} aria-label={t('Back to settings')}>←</button
    >
    <div>
      <h2 id="data-sources-title">{t('Data Sources')}</h2>
      <p>Connect read-only PostgreSQL or MySQL databases for bounded AI-assisted analysis.</p>
    </div>
    {#if !editorOpen && statusAvailable}
      <button class="primary" type="button" onclick={openCreate}>Add data source</button>
    {/if}
  </header>

  <div class="notice" role="note">
    <strong>Data and privacy:</strong> Query results are sent to your selected AI model so it can answer
    your question. Bounded tool results and the assistant answer are stored in local WorkX conversation
    history under the current retention settings. The MVP limits returned data after database decoding,
    so a single unusually large value can briefly use driver memory.
  </div>

  <div class="messages" aria-live="polite">
    {#if errorMessage}<p class="message error">{errorMessage}</p>{/if}
    {#if successMessage}<p class="message success">{successMessage}</p>{/if}
  </div>

  {#if loading}
    <p class="empty">Loading data sources…</p>
  {:else if !statusAvailable}
    <button type="button" onclick={load}>Retry initialization check</button>
  {:else if !editorOpen}
    {#if sources.length === 0}
      <div class="empty">
        <p>No data sources yet.</p>
        <button class="primary" type="button" onclick={openCreate}>Connect a database</button>
      </div>
    {:else}
      <div class="source-list">
        {#each sources as item (item.source.id)}
          <article class:deleting={item.source.lifecycleState === 'deleting'} class="source-card">
            <div class="source-heading">
              <div>
                <h3>{item.source.name}</h3>
                <p>{item.source.description || 'No business description'}</p>
              </div>
              <span class="badge"
                >{item.source.connectorId === 'postgres-native' ? 'PostgreSQL' : 'MySQL'}</span
              >
            </div>
            <dl>
              <div>
                <dt>Database</dt>
                <dd>{item.source.connection.database}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {item.source.lifecycleState === 'deleting'
                    ? 'Deletion pending'
                    : (item.source.lastTest?.status ?? 'Untested')}
                </dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{contextCounts[item.source.id] ?? 0} active facts</dd>
              </div>
            </dl>
            <div class="badges">
              {#if item.source.isDefault}<span class="badge good">Default</span>{/if}
              <span class="badge" class:good={item.source.enabled}
                >{item.source.enabled ? 'Enabled' : 'Disabled'}</span
              >
              <span class="badge" class:good={item.source.policy.agentAccessEnabled}
                >{item.source.policy.agentAccessEnabled ? 'Agent access' : 'Agent blocked'}</span
              >
              {#if item.source.lastTest && item.source.lastTest.connectionRevision !== item.source.connectionRevision}
                <span class="badge warn">Stale test</span>
              {/if}
            </div>
            <p class="timestamp">
              {item.source.lastTest
                ? `Last tested ${new Date(item.source.lastTest.testedAt).toLocaleString()}`
                : 'Save or test before agent use.'}
            </p>
            <div class="actions">
              {#if item.source.lifecycleState === 'deleting'}
                <button type="button" onclick={() => deleteSource(item)}>Retry delete</button>
              {:else}
                <button type="button" onclick={() => openEditor(item)}>Edit</button>
                <button type="button" disabled={busy} onclick={() => testSaved(item)}>Test</button>
                <button type="button" onclick={() => openEditor(item, 'context')}>Context</button>
                <button class="danger" type="button" onclick={() => deleteSource(item)}
                  >Delete</button
                >
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="editor">
      <div class="editor-nav">
        <button type="button" onclick={closeEditor}>← All sources</button>
        <div role="tablist" aria-label="Data source editor">
          <button
            class:active={activeTab === 'details'}
            role="tab"
            aria-selected={activeTab === 'details'}
            onclick={() => selectTab('details')}>Connection & policy</button
          >
          {#if selected}
            <button
              class:active={activeTab === 'context'}
              role="tab"
              aria-selected={activeTab === 'context'}
              onclick={() => selectTab('context')}
              >Context ({contextCounts[selected.source.id] ?? 0})</button
            >
          {/if}
        </div>
      </div>

      {#if activeTab === 'details'}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void saveSource();
          }}
        >
          <fieldset disabled={busy}>
            <legend>{selected ? `Edit ${selected.source.name}` : 'New data source'}</legend>
            <div class="grid two">
              <label>Name<input required maxlength="100" bind:value={form.name} /></label>
              <label
                >Engine
                <select bind:value={form.connectorId} onchange={changeEngine}>
                  <option value="postgres-native">PostgreSQL</option>
                  <option value="mysql-native">MySQL 8+</option>
                </select>
              </label>
              <label
                >Host<input required autocomplete="off" bind:value={form.connection.host} /></label
              >
              <label
                >Port<input
                  required
                  type="number"
                  min="1"
                  max="65535"
                  bind:value={form.connection.port}
                /></label
              >
              <label
                >Database<input
                  required
                  autocomplete="off"
                  bind:value={form.connection.database}
                /></label
              >
              <label
                >Username<input
                  required
                  autocomplete="off"
                  bind:value={form.connection.username}
                /></label
              >
            </div>

            {#if selected}
              <label class="inline"
                ><input
                  type="radio"
                  name="password-action"
                  value="keep"
                  bind:group={passwordAction}
                  onchange={() => {
                    password = '';
                  }}
                /> Keep saved password</label
              >
              <label class="inline"
                ><input
                  type="radio"
                  name="password-action"
                  value="replace"
                  bind:group={passwordAction}
                /> Replace password</label
              >
            {/if}
            {#if !selected || passwordAction === 'replace'}
              <label
                >Password
                <input required type="password" autocomplete="new-password" bind:value={password} />
                <small
                  >Password is sent only for this operation and is never pre-filled or stored in UI
                  state after save.</small
                >
              </label>
            {/if}

            <div class="grid two">
              <label
                >TLS mode
                <select bind:value={form.connection.tls.mode}>
                  <option value="verify-full">Verify certificate and hostname</option>
                  <option value="require">Encrypt without certificate verification (warning)</option
                  >
                  <option value="disable">Disabled (warning)</option>
                </select>
              </label>
              <label
                >Business timezone<input
                  required
                  bind:value={form.businessTimezone}
                  placeholder="America/Los_Angeles"
                /></label
              >
            </div>
            {#if form.connection.tls.mode === 'require'}<p class="warning">
                TLS is encrypted but the server identity is not verified.
              </p>{/if}
            {#if form.connection.tls.mode === 'disable'}<p class="warning">
                Traffic is not encrypted. Use only on a trusted local network.
              </p>{/if}
            {#if form.connection.tls.mode !== 'disable'}
              <label
                >Custom CA certificate (optional)<textarea
                  rows="4"
                  autocomplete="off"
                  bind:value={form.connection.tls.caPem}
                ></textarea></label
              >
            {/if}

            <label
              >Business description<textarea rows="3" maxlength="2000" bind:value={form.description}
              ></textarea></label
            >
            <div class="allowlist-fields">
              <label
                >Allowed namespaces <small>One per line; blank allows all visible namespaces.</small
                ><textarea rows="4" bind:value={allowedNamespacesText}></textarea></label
              >
              <label
                >Allowed tables/views <small>Qualified names, one per line; blank allows all.</small
                ><textarea rows="4" bind:value={allowedObjectsText}></textarea></label
              >
            </div>

            <div class="grid three">
              <label
                >Max returned rows<input
                  type="number"
                  min="1"
                  max="1000"
                  bind:value={form.policy.maxRows}
                /></label
              >
              <label
                >Query timeout (ms)<input
                  type="number"
                  min="1000"
                  max="60000"
                  step="1000"
                  bind:value={form.policy.timeoutMs}
                /></label
              >
              <label
                >Query approval
                <select bind:value={form.policy.queryApproval}
                  ><option value="auto_read">Automatic read-only</option><option
                    value="ask_each_query">Ask every query</option
                  ></select
                >
              </label>
              <label
                >Context learning
                <select bind:value={form.policy.learningMode}
                  ><option value="automatic">Automatic durable facts</option><option value="ask"
                    >Ask before saving</option
                  ><option value="off">Off</option></select
                >
              </label>
            </div>

            <div class="checks">
              <label class="inline"
                ><input type="checkbox" bind:checked={form.enabled} /> Enabled</label
              >
              <label class="inline"
                ><input type="checkbox" bind:checked={form.policy.agentAccessEnabled} /> Allow the AI
                agent to analyze this source</label
              >
              <label class="inline"
                ><input type="checkbox" bind:checked={form.isDefault} /> Default source</label
              >
            </div>

            <div class="least-privilege">
              <strong>Use a dedicated read-only database account</strong>
              <ul>
                <li>Grant only connect, schema usage, and SELECT on approved objects.</li>
                <li>Prefer a read replica; revoke create and temporary-object privileges.</li>
              </ul>
              {#if testResult}
                <p>
                  <strong>Assessment: {testResult.readOnlyAssessment.level}</strong> — {testResult.readOnlyAssessment.reasons.join(
                    ' '
                  )}
                </p>
                {#if testResult.readOnlyAssessment.userAcknowledgementRequired}
                  <label class="inline"
                    ><input type="checkbox" bind:checked={acknowledgeLeastPrivilege} /> I confirm this
                    account is intentionally least-privileged and read-only.</label
                  >
                {/if}
              {/if}
            </div>

            <p class="help">
              Testing is a preview. Save always repeats a connection test against the exact values
              being persisted and can surface a changed warning.
            </p>
            <div class="actions sticky">
              <button
                type="button"
                disabled={busy || Boolean(selected && passwordAction === 'replace' && !password)}
                onclick={testConnection}>Test connection</button
              >
              <button class="primary" type="submit" disabled={busy}
                >{busy ? 'Working…' : 'Save data source'}</button
              >
            </div>
          </fieldset>
        </form>
      {:else if selected}
        {#if !context}
          <p>Loading context…</p>
        {:else}
          <div class="context-editor">
            <section>
              <h3>Business overview</h3>
              <p>Saved locally and supplied to the model only when this source is used.</p>
              <textarea rows="8" maxlength="20000" bind:value={overviewDraft}></textarea>
              <button
                type="button"
                disabled={busy || overviewDraft === context.overviewMarkdown}
                onclick={saveOverview}>Save overview</button
              >
            </section>

            <section>
              <h3>{editingFactId ? 'Replace structured fact' : 'Add structured fact'}</h3>
              <div class="grid three">
                <label
                  >Kind<select bind:value={factDraft.kind}
                    >{#each factKinds as kind (kind)}<option value={kind}
                        >{kind.replaceAll('_', ' ')}</option
                      >{/each}</select
                  ></label
                >
                <label>Namespace<input bind:value={factDraft.namespace} /></label>
                <label>Table/view<input bind:value={factDraft.object} /></label>
                <label>Column<input bind:value={factDraft.field} /></label>
                <label>Stored value<input bind:value={factDraft.value} /></label>
                <label>Meaning<input bind:value={factDraft.meaning} /></label>
                <label>Unit<input bind:value={factDraft.unit} /></label>
              </div>
              <label
                >Assertion<textarea
                  required
                  rows="3"
                  maxlength="2000"
                  bind:value={factDraft.assertion}
                ></textarea></label
              >
              <div class="actions">
                <button
                  class="primary"
                  type="button"
                  disabled={busy || !factDraft.assertion.trim()}
                  onclick={saveFact}>{editingFactId ? 'Save replacement' : 'Add fact'}</button
                >
                {#if editingFactId}<button
                    type="button"
                    onclick={() => {
                      editingFactId = null;
                      factDraft = newFactDraft();
                    }}>Cancel</button
                  >{/if}
              </div>
            </section>

            <section>
              <h3>Active facts</h3>
              {#if context.facts.filter((fact) => fact.status === 'active').length === 0}
                <p>
                  No structured facts yet. Facts explicitly stated in chat can also be saved
                  automatically.
                </p>
              {:else}
                <div class="facts">
                  {#each context.facts.filter((fact) => fact.status === 'active') as fact (fact.id)}
                    <article class="fact">
                      <div>
                        <span class="badge">{fact.kind.replaceAll('_', ' ')}</span>
                        <strong
                          >{[fact.subject.namespace, fact.subject.object, fact.subject.field]
                            .filter(Boolean)
                            .join('.') || 'Source-wide'}</strong
                        >
                      </div>
                      <p>{fact.assertion}</p>
                      {#if fact.structuredValue}<p class="muted">
                          {[
                            fact.structuredValue.value,
                            fact.structuredValue.meaning,
                            fact.structuredValue.unit,
                          ]
                            .filter(Boolean)
                            .join(' → ')}
                        </p>{/if}
                      <p class="timestamp">
                        {fact.provenance.source === 'user_chat'
                          ? 'Learned from attended chat'
                          : 'Added in settings'} · {new Date(
                          fact.provenance.createdAt
                        ).toLocaleString()}
                      </p>
                      {#if fact.provenance.evidenceQuote}<blockquote>
                          “{fact.provenance.evidenceQuote}”
                        </blockquote>{/if}
                      {#if fact.schemaFingerprint}<p class="muted">
                          Schema-associated fact; review after schema changes.
                        </p>{/if}
                      {#if fact.stale}<p class="warning" role="status">
                          Stale: {fact.staleReason ??
                            'The referenced schema item is no longer visible.'}
                        </p>{/if}
                      <div class="actions">
                        <button type="button" onclick={() => editFact(fact)}>Edit</button><button
                          class="danger"
                          type="button"
                          onclick={() => supersedeFact(fact)}>Supersede</button
                        >
                      </div>
                    </article>
                  {/each}
                </div>
              {/if}
            </section>

            <section>
              <h3>Revision history</h3>
              <p>Restoring creates a new revision and never deletes newer history.</p>
              <div class="revisions">
                {#each contextRevisions as revision (revision.revision)}
                  <div>
                    <span
                      >Revision {revision.revision} · {revision.activeFactCount} facts · {new Date(
                        revision.createdAt
                      ).toLocaleString()}</span
                    ><button
                      type="button"
                      disabled={busy || revision.revision === context.revision}
                      onclick={() => revertContext(revision.revision)}>Restore</button
                    >
                  </div>
                {/each}
              </div>
            </section>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .data-sources {
    padding: 1.5rem;
    color: var(--workx-text);
  }
  .page-header,
  .source-heading,
  .editor-nav,
  .actions,
  .revisions > div {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .page-header {
    align-items: flex-start;
  }
  .page-header > div,
  .source-heading > div {
    flex: 1;
  }
  h2,
  h3,
  p {
    margin-top: 0;
  }
  h2 {
    margin-bottom: 0.25rem;
  }
  .back {
    font-size: var(--text-xl);
    line-height: var(--text-xl--line-height);
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
  }
  button {
    border: 1px solid var(--workx-border);
    border-radius: 0.4rem;
    padding: 0.55rem 0.8rem;
    background: var(--workx-surface);
    color: var(--workx-text);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--workx-primary);
    color: var(--workx-background);
    font-weight: var(--font-weight-bold);
  }
  button.danger {
    color: var(--workx-error);
  }
  .notice,
  .least-privilege {
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    padding: 1rem;
    margin: 1rem 0;
    background: color-mix(in srgb, var(--workx-primary) 7%, var(--workx-surface));
    line-height: var(--leading-normal);
  }
  .message {
    border-radius: 0.4rem;
    padding: 0.65rem;
  }
  .message.error,
  .warning {
    color: var(--workx-error);
  }
  .message.success {
    color: var(--workx-success);
  }
  .empty {
    padding: 2rem;
    text-align: center;
  }
  .source-list,
  .facts {
    display: grid;
    gap: 1rem;
  }
  .source-card,
  .fact,
  .context-editor section {
    border: 1px solid var(--workx-border);
    border-radius: 0.55rem;
    padding: 1rem;
    background: var(--workx-surface);
  }
  .source-card.deleting {
    opacity: 0.75;
  }
  .source-heading {
    align-items: flex-start;
  }
  .source-heading h3 {
    margin-bottom: 0.25rem;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }
  dl div {
    min-width: 0;
  }
  dt {
    color: var(--workx-text-secondary);
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
  }
  dd {
    margin: 0.2rem 0 0;
    overflow-wrap: anywhere;
  }
  .badge {
    display: inline-block;
    border: 1px solid var(--workx-border);
    border-radius: 99px;
    padding: 0.2rem 0.5rem;
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
  }
  .badge.good {
    color: var(--workx-success);
  }
  .badge.warn {
    color: var(--workx-warning);
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.5rem 0;
  }
  .timestamp,
  .muted,
  small,
  .help {
    color: var(--workx-text-secondary);
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
  }
  .editor-nav {
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  [role='tablist'] {
    display: flex;
    gap: 0.4rem;
  }
  [role='tab'].active {
    border-color: var(--workx-primary);
  }
  fieldset {
    border: 0;
    padding: 0;
  }
  legend {
    font-size: var(--text-xl);
    line-height: var(--text-xl--line-height);
    font-weight: var(--font-weight-bold);
    margin-bottom: 1rem;
  }
  .grid {
    display: grid;
    gap: 0.8rem;
  }
  .grid.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .grid.three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .allowlist-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.8rem;
  }
  label {
    display: grid;
    gap: 0.3rem;
    margin-bottom: 0.8rem;
  }
  label.inline {
    display: inline-flex;
    align-items: center;
    margin-right: 1rem;
  }
  input,
  select,
  textarea {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--workx-border);
    border-radius: 0.35rem;
    padding: 0.55rem;
    background: var(--workx-background);
    color: var(--workx-text);
  }
  label.inline input {
    width: auto;
  }
  textarea {
    resize: vertical;
  }
  .checks {
    margin: 1rem 0;
  }
  .sticky {
    position: sticky;
    bottom: 0;
    padding: 0.75rem 0;
    background: var(--workx-background);
    justify-content: flex-end;
  }
  .context-editor {
    display: grid;
    gap: 1rem;
  }
  blockquote {
    border-left: 3px solid var(--workx-border);
    margin-left: 0;
    padding-left: 0.75rem;
    color: var(--workx-text-secondary);
  }
  .revisions {
    display: grid;
    gap: 0.4rem;
  }
  .revisions > div {
    justify-content: space-between;
  }
  @media (max-width: 700px) {
    .grid.two,
    .grid.three,
    dl {
      grid-template-columns: 1fr;
    }
    .page-header,
    .editor-nav {
      flex-wrap: wrap;
    }
  }
</style>
