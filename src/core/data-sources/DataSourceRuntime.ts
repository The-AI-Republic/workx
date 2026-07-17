import { randomUUID } from 'node:crypto';
import { ContextLearningService } from './context/ContextLearningService';
import { renderDataSourceContext } from './context/contextRenderer';
import { assessContextStaleness } from './context/contextStaleness';
import { DataContextStore, createEmptyDataSourceContext } from './DataContextStore';
import { DataResultLimiter } from './DataResultLimiter';
import { DataSourceAccessPolicy } from './DataSourceAccessPolicy';
import { DataSourceError } from './errors';
import { DataSourceRegistry } from './DataSourceRegistry';
import { DataSourceSecretStore } from './DataSourceSecretStore';
import { DataSourceStore } from './DataSourceStore';
import { SourceQuerySemaphore } from './SourceQuerySemaphore';
import {
  connectionAffectingChange,
  schemaAffectingChange,
  validateCandidateInput,
  validateCreateInput,
  validateDataDescribeRequest,
  validateDataQueryRequest,
  validateLearnContextRequest,
  validateSourceFields,
  validateUpdateInput,
} from './validation';
import type {
  CreateDataSourceFields,
  CreateDataSourceInput,
  DataAccessPrincipal,
  DataContextRevisionSummary,
  DataDescribeRequest,
  DataLearningTurn,
  DataQueryRequest,
  DataResult,
  DataSource,
  DataSourceContext,
  DataSourceDescription,
  DataSourcePublicView,
  DataSourceSummary,
  DataSourceSummaryPage,
  DataSourceTestResult,
  LearnContextResult,
  LearnDataContextRequest,
  ManualContextUpdate,
  SavedDataSourceTestResult,
  TestDataSourceCandidateInput,
  UpdateDataSourceInput,
} from './types';

export interface DataSourceAuditEvent {
  sourceId: string;
  connectorId: string;
  operation: 'test' | 'describe' | 'query' | 'context_learn';
  startedAt: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  rowCount?: number;
  truncated?: boolean;
  queryHash?: string;
}

export interface DataSourceRuntimeDependencies {
  sourceStore: DataSourceStore;
  contextStore: DataContextStore;
  secretStore: DataSourceSecretStore;
  registry: DataSourceRegistry;
  accessPolicy?: DataSourceAccessPolicy;
  resultLimiter?: DataResultLimiter;
  audit?: (event: DataSourceAuditEvent) => void;
}

function editableFields(source: DataSource): CreateDataSourceFields {
  const policy = { ...source.policy };
  delete policy.leastPrivilegeAcknowledgement;
  return {
    name: source.name,
    description: source.description,
    category: source.category,
    connectorId: source.connectorId,
    transport: source.transport,
    connection: source.connection,
    businessTimezone: source.businessTimezone,
    isDefault: source.isDefault,
    enabled: source.enabled,
    policy,
  };
}

function listCursor(offset: number, search: string): string {
  return Buffer.from(JSON.stringify({ v: 1, offset, search })).toString('base64url');
}

function parseListCursor(cursor: string | undefined, search: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v: number;
      offset: number;
      search: string;
    };
    if (
      value.v !== 1 ||
      value.search !== search ||
      !Number.isInteger(value.offset) ||
      value.offset < 0
    )
      throw new Error();
    return value.offset;
  } catch {
    throw new DataSourceError('SOURCE_NOT_FOUND', 'Source-list cursor is invalid or stale.');
  }
}

export class DataSourceRuntime {
  private readonly accessPolicy: DataSourceAccessPolicy;
  private readonly resultLimiter: DataResultLimiter;
  private readonly contextLearning: ContextLearningService;
  private readonly audit: (event: DataSourceAuditEvent) => void;
  private readonly semaphores = new Map<string, SourceQuerySemaphore>();
  private readonly activeQueryControllers = new Map<string, Set<AbortController>>();
  private stopping = false;

  constructor(private readonly deps: DataSourceRuntimeDependencies) {
    this.accessPolicy = deps.accessPolicy ?? new DataSourceAccessPolicy();
    this.resultLimiter = deps.resultLimiter ?? new DataResultLimiter();
    this.contextLearning = new ContextLearningService(deps.contextStore);
    this.audit = deps.audit ?? (() => undefined);
  }

  getConnectorIds(): string[] {
    return this.deps.registry.listConnectorIds();
  }

  getSourceForAssessment(sourceId: string): Readonly<DataSource> {
    return this.deps.registry.getSource(sourceId);
  }

  validateQueryForAssessment(request: DataQueryRequest) {
    const validated = validateDataQueryRequest(request);
    const source = this.deps.registry.getSource(validated.source_id);
    return this.deps.registry.getConnector(source.id).validateQuery(source, validated);
  }

  async validateQueryForProgress(
    request: DataQueryRequest,
    principal: DataAccessPrincipal
  ): Promise<{
    sourceName: string;
    safeSql: string;
    connectorId: string;
    transport: 'native' | 'mcp';
  }> {
    request = validateDataQueryRequest(request);
    const source = this.deps.registry.getSource(request.source_id);
    await this.accessPolicy.assertAgentAccess(source, principal);
    const validation = this.deps.registry.getConnector(source.id).validateQuery(source, request);
    if (!validation.valid) throw new DataSourceError(validation.code, validation.message);
    return {
      sourceName: source.name,
      safeSql: validation.safeSql,
      connectorId: source.connectorId,
      transport: source.transport.type,
    };
  }

  async listSources(
    options: { search?: string; cursor?: string } = {},
    principal: DataAccessPrincipal
  ): Promise<DataSourceSummaryPage> {
    this.assertRunning();
    const search = (options.search ?? '').trim().normalize('NFKC').toLocaleLowerCase('en-US');
    const visible: DataSourceSummary[] = [];
    for (const source of this.deps.registry.listSources()) {
      try {
        await this.accessPolicy.assertAgentAccess(source, principal);
        await this.requireSecret(source);
      } catch {
        continue;
      }
      if (
        search &&
        !`${source.name}\n${source.description}`.toLocaleLowerCase('en-US').includes(search)
      )
        continue;
      visible.push(this.summary(source));
    }
    const offset = parseListCursor(options.cursor, search);
    const page = visible.slice(offset, offset + 50);
    return {
      sources: page,
      ...(offset + page.length < visible.length
        ? { nextCursor: listCursor(offset + page.length, search) }
        : {}),
    };
  }

  async listManagementSources(): Promise<DataSourcePublicView[]> {
    this.assertRunning();
    return Promise.all(this.deps.registry.listSources().map((source) => this.publicView(source)));
  }

  async getSource(sourceId: string): Promise<DataSourcePublicView> {
    this.assertRunning();
    return this.publicView(this.deps.registry.getSource(sourceId));
  }

  async createSource(rawInput: CreateDataSourceInput): Promise<DataSourcePublicView> {
    this.assertRunning();
    const input = validateCreateInput(rawInput);
    const id = randomUUID();
    const now = new Date().toISOString();
    const candidate: DataSource = {
      ...input.source,
      version: 1,
      id,
      revision: 1,
      connectionRevision: 1,
      lifecycleState: 'active',
      secretVersion: 1,
      policy: { ...input.source.policy },
      createdAt: now,
      updatedAt: now,
    };
    const test = await this.testCandidateSource(candidate, input.password);
    this.requireReachableTest(test);
    candidate.lastTest = test;
    candidate.policy = this.policyWithAcknowledgement(
      candidate,
      input.leastPrivilegeAcknowledged,
      test
    );
    await this.deps.secretStore.setPassword(id, 1, input.password);
    try {
      await this.deps.sourceStore.create(candidate, createEmptyDataSourceContext(id, now));
    } catch (error) {
      await this.deps.secretStore.deletePassword(id, 1).catch(() => undefined);
      throw error;
    }
    await this.syncRegistryFromStore();
    return this.publicView(candidate);
  }

  async updateSource(
    sourceId: string,
    rawInput: UpdateDataSourceInput
  ): Promise<DataSourcePublicView> {
    this.assertRunning();
    const input = validateUpdateInput(rawInput);
    const current = this.deps.registry.getSource(sourceId);
    if (current.revision !== input.expectedRevision) {
      throw new DataSourceError(
        'SOURCE_REVISION_CONFLICT',
        'The data source changed; reload before saving.'
      );
    }
    const proposed = {
      ...editableFields(current),
      ...input.patch,
    };
    if (
      current.isDefault &&
      (proposed.enabled === false || proposed.policy.agentAccessEnabled === false)
    ) {
      proposed.isDefault = false;
    }
    const merged = validateSourceFields(proposed);
    const passwordReplaced = input.passwordAction === 'replace';
    const currentFields = editableFields(current);
    const connectionChanged = connectionAffectingChange(currentFields, merged, passwordReplaced);
    const schemaChanged = schemaAffectingChange(currentFields, merged);
    const nextConnectionRevision = current.connectionRevision + (connectionChanged ? 1 : 0);
    const nextSecretVersion = current.secretVersion + (passwordReplaced ? 1 : 0);
    const password = passwordReplaced ? input.password! : await this.requireSecret(current);
    const updated: DataSource = {
      ...current,
      ...merged,
      revision: current.revision + 1,
      connectionRevision: nextConnectionRevision,
      secretVersion: nextSecretVersion,
      policy: {
        ...merged.policy,
        ...(!connectionChanged && current.policy.leastPrivilegeAcknowledgement
          ? {
              leastPrivilegeAcknowledgement: current.policy.leastPrivilegeAcknowledgement,
            }
          : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    if (connectionChanged) {
      const test = await this.testCandidateSource(updated, password);
      this.requireReachableTest(test);
      updated.lastTest = test;
      updated.policy = this.policyWithAcknowledgement(
        updated,
        input.leastPrivilegeAcknowledged === true,
        test
      );
    }
    if (passwordReplaced)
      await this.deps.secretStore.setPassword(sourceId, nextSecretVersion, password);
    try {
      await this.deps.sourceStore.update(updated, input.expectedRevision);
    } catch (error) {
      if (passwordReplaced)
        await this.deps.secretStore
          .deletePassword(sourceId, nextSecretVersion)
          .catch(() => undefined);
      throw error;
    }
    if (connectionChanged) {
      this.abortActiveQueries(sourceId);
      await this.deps.registry.getConnector(sourceId).invalidateSource(sourceId);
    } else if (schemaChanged) {
      await this.deps.registry.getConnector(sourceId).invalidateSchema?.(sourceId);
    }
    await this.syncRegistryFromStore();
    if (passwordReplaced)
      await this.deps.secretStore
        .deletePassword(sourceId, current.secretVersion)
        .catch(() => undefined);
    return this.publicView(updated);
  }

  async deleteSource(sourceId: string, expectedRevision: number): Promise<void> {
    this.assertRunning();
    const tombstone = await this.deps.sourceStore.markDeleting(sourceId, expectedRevision);
    this.deps.registry.upsertSource(tombstone);
    this.semaphores.get(sourceId)?.cancelQueued();
    this.abortActiveQueries(sourceId);
    await this.deps.registry.getConnector(sourceId).invalidateSource(sourceId);
    try {
      await this.deps.secretStore.deleteAllPasswordVersions(sourceId, tombstone.secretVersion);
      await this.deps.sourceStore.finalizeDelete(sourceId);
      await this.deps.registry.removeSource(sourceId);
      this.semaphores.delete(sourceId);
    } catch (error) {
      throw new DataSourceError(
        'SOURCE_DELETION_PENDING',
        'Deletion is pending and will resume at startup.',
        true,
        { cause: error }
      );
    }
  }

  async testSource(
    sourceId: string,
    expectedRevision: number,
    signal?: AbortSignal
  ): Promise<SavedDataSourceTestResult> {
    this.assertRunning();
    const source = this.deps.registry.getSource(sourceId);
    if (source.revision !== expectedRevision)
      throw new DataSourceError('SOURCE_REVISION_CONFLICT', 'The source changed before testing.');
    const password = await this.requireSecret(source);
    const test = await this.testCandidateSource(source, password, signal);
    const updated: DataSource = {
      ...source,
      revision: source.revision + 1,
      updatedAt: new Date().toISOString(),
      lastTest: test,
    };
    await this.deps.sourceStore.update(updated, expectedRevision);
    this.deps.registry.upsertSource(updated);
    return { test, source: await this.publicView(updated) };
  }

  async testCandidate(
    input: TestDataSourceCandidateInput,
    signal?: AbortSignal
  ): Promise<DataSourceTestResult> {
    const validated = validateCandidateInput(input);
    const now = new Date().toISOString();
    const source: DataSource = {
      ...validated.source,
      version: 1,
      id: randomUUID(),
      revision: 1,
      connectionRevision: 1,
      lifecycleState: 'active',
      secretVersion: 1,
      policy: validated.source.policy,
      createdAt: now,
      updatedAt: now,
    };
    return this.testCandidateSource(source, validated.password, signal);
  }

  async describe(
    request: DataDescribeRequest,
    principal: DataAccessPrincipal,
    signal?: AbortSignal
  ): Promise<DataSourceDescription> {
    this.assertRunning();
    request = validateDataDescribeRequest(request);
    const source = this.deps.registry.getSource(request.source_id);
    await this.accessPolicy.assertAgentAccess(source, principal);
    const password = await this.requireSecret(source);
    const started = Date.now();
    try {
      const description = await this.deps.registry
        .getConnector(source.id)
        .describe(source, { password }, request, signal);
      const storedContext = await this.deps.contextStore.get(source.id);
      const requested =
        request.objects ?? description.objects.map((object) => object.qualifiedName);
      const assessed = assessContextStaleness(storedContext, description, requested);
      const context = assessed.context;
      description.warnings.push(...assessed.warnings);
      if (request.include_context !== false)
        description.renderedContext = renderDataSourceContext(context, requested);
      for (const object of description.objects) {
        if (!('contextFacts' in object)) continue;
        object.contextFacts = context.facts.filter((fact) => {
          if (fact.status !== 'active' || fact.stale || !fact.subject.object) return false;
          return (
            fact.subject.object.toLocaleLowerCase('en-US') ===
              object.name.toLocaleLowerCase('en-US') &&
            (!fact.subject.namespace ||
              fact.subject.namespace.toLocaleLowerCase('en-US') ===
                object.namespace.toLocaleLowerCase('en-US'))
          );
        });
      }
      while (description.objects.length && JSON.stringify(description).length >= 40_000) {
        description.objects.pop();
        description.warnings.push('Description was truncated to the WorkX result limit.');
      }
      this.audit({
        sourceId: source.id,
        connectorId: source.connectorId,
        operation: 'describe',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        success: true,
      });
      return description;
    } catch (error) {
      this.audit({
        sourceId: source.id,
        connectorId: source.connectorId,
        operation: 'describe',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        success: false,
        errorCode: error instanceof DataSourceError ? error.code : 'SCHEMA_NOT_FOUND',
      });
      throw error;
    }
  }

  async query(
    request: DataQueryRequest,
    principal: DataAccessPrincipal,
    signal?: AbortSignal
  ): Promise<DataResult> {
    this.assertRunning();
    request = validateDataQueryRequest(request);
    let source = this.deps.registry.getSource(request.source_id);
    await this.accessPolicy.assertAgentAccess(source, principal);
    this.assertQueryAllowed(source, request);
    const semaphore = this.semaphores.get(source.id) ?? new SourceQuerySemaphore();
    this.semaphores.set(source.id, semaphore);
    const release = await semaphore.acquire(signal);
    const controller = new AbortController();
    const active = this.activeQueryControllers.get(source.id) ?? new Set<AbortController>();
    this.activeQueryControllers.set(source.id, active);
    active.add(controller);
    const onCallerAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const started = Date.now();
    try {
      this.assertRunning();
      source = this.deps.registry.getSource(request.source_id);
      await this.accessPolicy.assertAgentAccess(source, principal);
      const connector = this.deps.registry.getConnector(source.id);
      this.assertQueryAllowed(source, request);
      const password = await this.requireSecret(source);
      const result = await connector.query(source, { password }, request, controller.signal);
      const limited = this.resultLimiter.limit(result, source.policy.maxRows);
      this.audit({
        sourceId: source.id,
        connectorId: source.connectorId,
        operation: 'query',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        success: true,
        rowCount: limited.rowCount,
        truncated: limited.truncated,
        queryHash: limited.provenance.queryHash,
      });
      return limited;
    } catch (error) {
      this.audit({
        sourceId: source.id,
        connectorId: source.connectorId,
        operation: 'query',
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        success: false,
        errorCode: error instanceof DataSourceError ? error.code : 'SOURCE_UNREACHABLE',
      });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onCallerAbort);
      active.delete(controller);
      if (!active.size) this.activeQueryControllers.delete(source.id);
      release();
    }
  }

  async getContext(
    sourceId: string,
    principal?: DataAccessPrincipal,
    assessStale = false,
    signal?: AbortSignal
  ): Promise<DataSourceContext> {
    this.assertRunning();
    const source = this.deps.registry.getSource(sourceId);
    if (principal) await this.accessPolicy.assertAgentAccess(source, principal);
    const context = await this.deps.contextStore.get(sourceId);
    if (!assessStale) return context;
    const objects = [
      ...new Set(
        context.facts
          .filter((fact) => fact.status === 'active' && fact.subject.object)
          .map((fact) => [fact.subject.namespace, fact.subject.object].filter(Boolean).join('.'))
      ),
    ];
    if (!objects.length) return context;
    try {
      const password = await this.requireSecret(source);
      const description = await this.deps.registry
        .getConnector(source.id)
        .describe(
          source,
          { password },
          { source_id: source.id, scope: 'objects', objects, include_context: false },
          signal
        );
      return assessContextStaleness(context, description, objects).context;
    } catch {
      return {
        ...context,
        warnings: ['Schema staleness could not be checked because schema discovery failed.'],
      };
    }
  }

  async learnContext(
    request: LearnDataContextRequest,
    turn: DataLearningTurn
  ): Promise<LearnContextResult> {
    this.assertRunning();
    request = validateLearnContextRequest(request);
    const source = this.deps.registry.getSource(request.source_id);
    await this.accessPolicy.assertAgentAccess(source, turn.principal);
    const objects = [
      ...new Set(
        request.facts
          .filter((fact) => fact.object)
          .map((fact) => [fact.namespace, fact.object].filter(Boolean).join('.'))
      ),
    ];
    const schema = objects.length
      ? await this.describe(
          {
            source_id: source.id,
            scope: 'objects',
            objects,
            include_context: false,
          },
          turn.principal
        )
      : undefined;
    const started = Date.now();
    const result = await this.contextLearning.learn(source, request, turn, schema);
    this.audit({
      sourceId: source.id,
      connectorId: source.connectorId,
      operation: 'context_learn',
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      success: true,
    });
    return result;
  }

  updateContext(sourceId: string, input: ManualContextUpdate): Promise<DataSourceContext> {
    this.assertRunning();
    this.deps.registry.getSource(sourceId);
    return this.deps.contextStore.updateManual(sourceId, input);
  }

  listContextRevisions(sourceId: string): Promise<DataContextRevisionSummary[]> {
    this.assertRunning();
    this.deps.registry.getSource(sourceId);
    return this.deps.contextStore.listRevisions(sourceId);
  }

  revertContext(
    sourceId: string,
    targetRevision: number,
    expectedCurrentRevision: number
  ): Promise<DataSourceContext> {
    this.assertRunning();
    this.deps.registry.getSource(sourceId);
    return this.deps.contextStore.revert(sourceId, targetRevision, expectedCurrentRevision);
  }

  async refreshSchema(sourceId: string): Promise<void> {
    this.assertRunning();
    const connector = this.deps.registry.getConnector(sourceId);
    if (connector.invalidateSchema) await connector.invalidateSchema(sourceId);
    else await connector.invalidateSource(sourceId);
  }

  async resumePendingDeletions(): Promise<void> {
    for (const source of await this.deps.sourceStore.list()) {
      if (source.lifecycleState !== 'deleting') continue;
      try {
        await this.deps.secretStore.deleteAllPasswordVersions(source.id, source.secretVersion);
        await this.deps.sourceStore.finalizeDelete(source.id);
      } catch {
        // Keep the tombstone; the next startup or explicit retry resumes it.
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const semaphore of this.semaphores.values()) semaphore.cancelQueued();
    for (const sourceId of this.activeQueryControllers.keys()) this.abortActiveQueries(sourceId);
    this.semaphores.clear();
    await this.deps.registry.dispose();
  }

  private assertRunning(): void {
    if (this.stopping)
      throw new DataSourceError(
        'DATA_SOURCES_UNAVAILABLE',
        'Data-source runtime is stopping.',
        true
      );
  }

  private abortActiveQueries(sourceId: string): void {
    const active = this.activeQueryControllers.get(sourceId);
    if (!active) return;
    this.activeQueryControllers.delete(sourceId);
    for (const controller of active) controller.abort();
  }

  private async syncRegistryFromStore(): Promise<void> {
    for (const source of await this.deps.sourceStore.list()) {
      this.deps.registry.upsertSource(source);
    }
  }

  private summary(source: DataSource): DataSourceSummary {
    const capabilities = this.deps.registry.getConnector(source.id).getCapabilities(source);
    return {
      id: source.id,
      name: source.name,
      description: source.description,
      category: source.category,
      connectorId: source.connectorId,
      transport: source.transport.type,
      businessTimezone: source.businessTimezone,
      isDefault: source.isDefault,
      capabilities: {
        queryLanguages: capabilities.queryLanguages,
        schemaDiscovery: capabilities.schemaDiscovery,
        resultShapes: capabilities.resultShapes,
      },
    };
  }

  private async publicView(source: DataSource): Promise<DataSourcePublicView> {
    const { secretVersion, ...publicSource } = source;
    return {
      source: publicSource,
      passwordConfigured: Boolean(
        await this.deps.secretStore.getPassword(source.id, secretVersion)
      ),
    };
  }

  private async requireSecret(source: DataSource): Promise<string> {
    const password = await this.deps.secretStore.getPassword(source.id, source.secretVersion);
    if (!password)
      throw new DataSourceError('SECRET_NOT_FOUND', 'The database password is unavailable.');
    return password;
  }

  private assertQueryAllowed(source: DataSource, request: DataQueryRequest): void {
    const validation = this.deps.registry.getConnector(source.id).validateQuery(source, request);
    if (!validation.valid) throw new DataSourceError(validation.code, validation.message);
  }

  private async testCandidateSource(
    source: DataSource,
    password: string,
    signal?: AbortSignal
  ): Promise<DataSourceTestResult> {
    const started = Date.now();
    const test = await this.deps.registry
      .getConnectorById(source.connectorId)
      .testConnection(source, { password }, signal);
    this.audit({
      sourceId: source.id,
      connectorId: source.connectorId,
      operation: 'test',
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      success: test.status === 'reachable',
      ...(test.errorCode ? { errorCode: test.errorCode } : {}),
    });
    return test;
  }

  private requireReachableTest(test: DataSourceTestResult): void {
    if (test.status !== 'reachable') {
      throw new DataSourceError(
        test.errorCode ?? 'SOURCE_UNREACHABLE',
        test.warnings[0] ?? 'The database is unreachable.'
      );
    }
  }

  private policyWithAcknowledgement(
    source: DataSource,
    acknowledged: boolean,
    test: DataSourceTestResult
  ): DataSource['policy'] {
    if (test.readOnlyAssessment.userAcknowledgementRequired && !acknowledged) {
      throw new DataSourceError(
        'AGENT_ACCESS_DISABLED',
        'Acknowledge the least-privilege warning before saving.'
      );
    }
    return {
      ...source.policy,
      ...(test.readOnlyAssessment.userAcknowledgementRequired
        ? {
            leastPrivilegeAcknowledgement: {
              connectionRevision: source.connectionRevision,
              acknowledgedAt: new Date().toISOString(),
            },
          }
        : {}),
    };
  }
}
