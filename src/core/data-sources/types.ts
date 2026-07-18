import type { InputOrigin } from '@/core/input/types';

export type DataSourceCategory = 'sql' | 'nosql' | 'warehouse' | 'lakehouse' | 'api';
export type DataLearningMode = 'automatic' | 'ask' | 'off';
export type DataQueryApprovalMode = 'auto_read' | 'ask_each_query';
export type NativeConnectorId = 'postgres-native' | 'mysql-native';

export interface DataSourcePolicy {
  agentAccessEnabled: boolean;
  readOnly: true;
  maxRows: number;
  timeoutMs: number;
  maxConcurrentQueries: 1;
  allowedNamespaces: string[];
  allowedObjects: string[];
  queryApproval: DataQueryApprovalMode;
  learningMode: DataLearningMode;
  leastPrivilegeAcknowledgement?: {
    connectionRevision: number;
    acknowledgedAt: string;
  };
}

export type EditableDataSourcePolicy = Omit<DataSourcePolicy, 'leastPrivilegeAcknowledgement'>;

export interface DataSourceTlsConfig {
  mode: 'disable' | 'require' | 'verify-full';
  caPem?: string;
}

export interface NativeSqlConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  tls: DataSourceTlsConfig;
}

export interface DataSourceReadOnlyAssessment {
  level: 'verified' | 'warning' | 'unknown';
  reasons: string[];
  userAcknowledgementRequired: boolean;
}

export interface DataSourceTestSummary {
  status: 'reachable' | 'error';
  testedAt: string;
  connectionRevision: number;
  latencyMs: number;
  tlsActive?: boolean;
  readOnlyAssessment: DataSourceReadOnlyAssessment;
  errorCode?: DataSourceErrorCode;
}

export interface DataSourceTestResult extends DataSourceTestSummary {
  connectorId: string;
  databaseProduct?: string;
  databaseVersionFamily?: string;
  currentDatabase?: string;
  visibleNamespaceCount?: number;
  warnings: string[];
}

export interface DataSource {
  version: 1;
  revision: number;
  connectionRevision: number;
  id: string;
  name: string;
  description: string;
  category: 'sql';
  connectorId: NativeConnectorId;
  transport: { type: 'native' };
  connection: NativeSqlConnectionConfig;
  businessTimezone: string;
  isDefault: boolean;
  enabled: boolean;
  lifecycleState: 'active' | 'deleting';
  secretVersion: number;
  policy: DataSourcePolicy;
  createdAt: string;
  updatedAt: string;
  lastTest?: DataSourceTestSummary;
}

export type CreateDataSourceFields = Omit<
  DataSource,
  | 'id'
  | 'version'
  | 'revision'
  | 'connectionRevision'
  | 'lifecycleState'
  | 'secretVersion'
  | 'createdAt'
  | 'updatedAt'
  | 'lastTest'
  | 'policy'
> & { policy: EditableDataSourcePolicy };

export interface CreateDataSourceInput {
  source: CreateDataSourceFields;
  password: string;
  leastPrivilegeAcknowledged: boolean;
}

export interface UpdateDataSourceInput {
  expectedRevision: number;
  patch: Partial<CreateDataSourceFields>;
  passwordAction: 'keep' | 'replace';
  password?: string;
  leastPrivilegeAcknowledged?: boolean;
}

export interface TestDataSourceCandidateInput {
  source: CreateDataSourceFields;
  password: string;
}

export interface DataSourceSecret {
  password: string;
}

export interface DataSourceCapabilities {
  queryLanguages: Array<'sql' | 'mongodb-pipeline' | 'elasticsearch-dsl' | 'graphql'>;
  schemaDiscovery: 'full' | 'partial' | 'none';
  supportsParameters: boolean;
  supportsPagination: boolean;
  supportsCancellation: boolean;
  readOnlyGuarantee: 'database' | 'connector' | 'declared' | 'unknown';
  resultShapes: Array<'tabular' | 'documents' | 'scalar'>;
}

export interface DataAccessPrincipal {
  sessionId: string;
  turnId: string;
  origin: InputOrigin;
  attended: boolean;
  desktopUiSession: boolean;
}

export interface DataTurnSnapshot {
  currentUserText: string;
  origin: InputOrigin;
  attended: boolean;
  durableLearningEligible: boolean;
}

/** Metadata exposed to data tools other than the original user text. */
export type DataTurnAccessSnapshot = Omit<DataTurnSnapshot, 'currentUserText'>;

export interface DataSourceSummary {
  id: string;
  name: string;
  description: string;
  category: DataSourceCategory;
  connectorId: string;
  transport: 'native' | 'mcp';
  businessTimezone: string;
  isDefault: boolean;
  capabilities: Pick<DataSourceCapabilities, 'queryLanguages' | 'schemaDiscovery' | 'resultShapes'>;
}

export interface DataSourceSummaryPage {
  sources: DataSourceSummary[];
  nextCursor?: string;
}

export interface DataSourcePublicView {
  source: Omit<DataSource, 'secretVersion'>;
  passwordConfigured: boolean;
}

export interface SavedDataSourceTestResult {
  test: DataSourceTestResult;
  source: DataSourcePublicView;
}

export interface DataObjectRef {
  namespace: string;
  name: string;
  qualifiedName: string;
  kind: 'table' | 'view';
  comment?: string;
}

export interface DataFieldDescription {
  name: string;
  databaseType: string;
  nullable: boolean;
  defaultExpression?: string;
  comment?: string;
  primaryKey: boolean;
}

export interface DataRelationshipDescription {
  from: { object: string; fields: string[] };
  to: { object: string; fields: string[] };
}

export interface DataObjectDescription extends DataObjectRef {
  fields: DataFieldDescription[];
  relationships: DataRelationshipDescription[];
  contextFacts: DataContextFact[];
}

export interface DataSourceDescription {
  source: DataSourceSummary;
  scope: 'catalog' | 'objects';
  objects: Array<DataObjectRef | DataObjectDescription>;
  nextCursor?: string;
  schemaFingerprint: string;
  renderedContext?: string;
  warnings: string[];
}

export interface DataDescribeRequest {
  source_id: string;
  scope: 'catalog' | 'objects';
  search?: string;
  objects?: string[];
  cursor?: string;
  include_context?: boolean;
}

export type DataQueryParameter =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'date'; value: string };

export interface DataQueryRequest {
  source_id: string;
  query_language: 'sql';
  query: string;
  parameters?: DataQueryParameter[];
  purpose: string;
}

export type DataQueryValidation =
  | {
      valid: true;
      dialect: 'postgresql' | 'mysql';
      safeSql: string;
      referencedObjects: string[];
      placeholderCount: number;
    }
  | {
      valid: false;
      code:
        | 'QUERY_PARSE_FAILED'
        | 'QUERY_NOT_READ_ONLY'
        | 'QUERY_MULTIPLE_STATEMENTS'
        | 'QUERY_OBJECT_DENIED'
        | 'QUERY_PARAMETER_MISMATCH'
        | 'QUERY_SHAPE_UNSUPPORTED';
      message: string;
    };

export interface DataColumn {
  name: string;
  databaseType?: string;
  normalizedType:
    | 'null'
    | 'boolean'
    | 'number'
    | 'string'
    | 'date'
    | 'json'
    | 'binary-omitted'
    | 'mixed';
}

export interface DataResult {
  sourceId: string;
  sourceName: string;
  shape: 'tabular' | 'documents' | 'scalar';
  columns?: DataColumn[];
  rows?: unknown[][];
  documents?: Array<Record<string, unknown>>;
  value?: unknown;
  rowCount: number;
  truncated: boolean;
  truncationReasons?: Array<'row_limit' | 'result_size' | 'cell_size'>;
  executionMs: number;
  provenance: {
    connectorId: string;
    transport: 'native' | 'mcp';
    queryLanguage: string;
    queryHash: string;
  };
}

export type DataContextFactKind =
  | 'object_meaning'
  | 'field_meaning'
  | 'enum_value'
  | 'unit'
  | 'metric_definition'
  | 'join_hint'
  | 'exclusion_rule'
  | 'timezone_rule'
  | 'caveat'
  | 'other';

export interface DataContextSubject {
  namespace?: string;
  object?: string;
  field?: string;
}

export interface DataContextFact {
  id: string;
  kind: DataContextFactKind;
  subject: DataContextSubject;
  assertion: string;
  structuredValue?: { value?: string; meaning?: string; unit?: string };
  status: 'active' | 'superseded';
  provenance: {
    source: 'user_chat' | 'settings';
    sessionId?: string;
    turnId?: string;
    evidenceQuote?: string;
    createdAt: string;
  };
  confidence: 'user_asserted';
  schemaFingerprint?: string;
  /** Ephemeral assessment returned by schema-aware reads; never persisted as fact state. */
  stale?: boolean;
  staleReason?: string;
}

export interface DataSourceContext {
  version: 1;
  sourceId: string;
  revision: number;
  overviewMarkdown: string;
  facts: DataContextFact[];
  createdAt: string;
  updatedAt: string;
  /** Ephemeral read warnings; omitted from persisted context records. */
  warnings?: string[];
}

export interface DataLearningTurn {
  principal: DataAccessPrincipal;
  currentUserText: string;
  durableLearningEligible: boolean;
}

export interface LearnDataContextFactInput {
  kind: DataContextFactKind;
  namespace?: string;
  object?: string;
  field?: string;
  assertion: string;
  value?: string;
  meaning?: string;
  unit?: string;
  evidence_quote: string;
}

export interface LearnDataContextRequest {
  source_id: string;
  facts: LearnDataContextFactInput[];
  reason: string;
}

export interface LearnContextResult {
  sourceId: string;
  sourceName: string;
  priorRevision: number;
  currentRevision: number;
  addedFacts: DataContextFact[];
  deduplicatedFactIds: string[];
}

export interface ManualContextFactInput {
  kind: DataContextFactKind;
  subject: DataContextSubject;
  assertion: string;
  structuredValue?: DataContextFact['structuredValue'];
}

export type ManualContextFactOperation =
  | { operation: 'add'; fact: ManualContextFactInput }
  | { operation: 'replace'; factId: string; fact: ManualContextFactInput }
  | { operation: 'supersede'; factId: string };

export interface ManualContextUpdate {
  expectedRevision: number;
  overviewMarkdown?: string;
  factOperations?: ManualContextFactOperation[];
}

export interface DataContextRevisionSummary {
  revision: number;
  createdAt: string;
  createdBy: 'user_chat' | 'settings';
  activeFactCount: number;
}

export interface DataSourceCatalog {
  version: 1;
  sourceIds: string[];
  normalizedNameToId: Record<string, string>;
  defaultSourceId?: string;
}

export interface DataSourceContextEnvelope {
  version: 1;
  current: DataSourceContext;
  retainedRevisions: number[];
}

export interface DataSourcesStatus {
  state: 'initializing' | 'ready' | 'unavailable' | 'stopping';
  available: boolean;
  toolsEnabled: boolean;
  connectorIds: string[];
  errorCode?: DataSourceErrorCode;
}

export interface DataSourceConnector {
  readonly id: string;
  getCapabilities(source: DataSource): DataSourceCapabilities;
  testConnection(
    source: DataSource,
    secret: DataSourceSecret,
    signal?: AbortSignal
  ): Promise<DataSourceTestResult>;
  describe(
    source: DataSource,
    secret: DataSourceSecret,
    request: DataDescribeRequest,
    signal?: AbortSignal
  ): Promise<DataSourceDescription>;
  validateQuery(source: DataSource, request: DataQueryRequest): DataQueryValidation;
  query(
    source: DataSource,
    secret: DataSourceSecret,
    request: DataQueryRequest,
    signal?: AbortSignal
  ): Promise<DataResult>;
  invalidateSchema?(sourceId: string): void | Promise<void>;
  invalidateSource(sourceId: string): Promise<void>;
  dispose(): Promise<void>;
}

export type DataSourceErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_DISABLED'
  | 'SOURCE_REVISION_CONFLICT'
  | 'SOURCE_DELETION_PENDING'
  | 'DATA_SOURCE_STORE_CORRUPT'
  | 'DATA_SOURCES_UNAVAILABLE'
  | 'DATA_ACCESS_ORIGIN_DENIED'
  | 'SERVICE_FORBIDDEN'
  | 'AGENT_ACCESS_DISABLED'
  | 'CONNECT_TIMEOUT'
  | 'AUTH_FAILED'
  | 'TLS_FAILED'
  | 'SOURCE_UNREACHABLE'
  | 'CONNECTOR_NOT_FOUND'
  | 'SECRET_NOT_FOUND'
  | 'QUERY_PARSE_FAILED'
  | 'QUERY_NOT_READ_ONLY'
  | 'QUERY_MULTIPLE_STATEMENTS'
  | 'QUERY_OBJECT_DENIED'
  | 'QUERY_PARAMETER_MISMATCH'
  | 'QUERY_SHAPE_UNSUPPORTED'
  | 'QUERY_TIMEOUT'
  | 'QUERY_CANCELLED'
  | 'QUERY_BUSY'
  | 'RESULT_TRUNCATED'
  | 'SCHEMA_NOT_FOUND'
  | 'CONTEXT_EVIDENCE_MISSING'
  | 'CONTEXT_CONFLICT'
  | 'CONTEXT_SCHEMA_AMBIGUOUS'
  | 'CONTEXT_REVISION_CONFLICT';
