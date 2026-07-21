import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { SubmissionContext } from '@/core/channels/types';
import { AppsServiceError } from '@/core/apps/AppsServiceError';
import type { AppsAccessController } from '@/core/apps/AppsAccessController';
import type { OpenHubAppsClient } from '@/core/apps/OpenHubAppsClient';

export interface AppsServiceDeps {
  access: AppsAccessController;
  client?: OpenHubAppsClient;
  authorizeContext: (context: SubmissionContext) => boolean;
}

function stringParam(
  params: Record<string, unknown>,
  key: string,
  max: number,
  required = true
): string | undefined {
  const value = params[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new AppsServiceError('APPS_INVALID_ARGUMENT', `Invalid ${key}.`);
  }
  return value;
}

function requireClient(deps: AppsServiceDeps): OpenHubAppsClient {
  deps.access.requireReady();
  if (!deps.client)
    throw new AppsServiceError('APPS_NOT_CONFIGURED', 'The Apps catalog is not configured.');
  return deps.client;
}

function validateFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Invalid credential fields.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32)
    throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Invalid credential fields.');
  let total = 0;
  const result: Record<string, string> = {};
  for (const [key, field] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) || typeof field !== 'string')
      throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Invalid credential fields.');
    const size = new TextEncoder().encode(field).byteLength;
    total += size;
    if (size > 16 * 1024 || total > 64 * 1024)
      throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Credential fields are too large.');
    result[key] = field;
  }
  return result;
}

export function createAppsServices(deps: AppsServiceDeps): Record<string, ServiceHandler> {
  const connectedAuth = new Set<string>();

  const refreshMcpAfterMutation = async <T>(operation: Promise<T>): Promise<T> => {
    const result = await operation;
    await deps.access.refreshMcp();
    return result;
  };

  const readAuthStatus = async (appId: string) => {
    const status = await requireClient(deps).getAuthStatus(appId);
    if (status?.status === 'connected') {
      if (!connectedAuth.has(appId)) {
        connectedAuth.add(appId);
        await deps.access.refreshMcp();
      }
    } else {
      connectedAuth.delete(appId);
    }
    return status;
  };

  const authorize =
    (handler: ServiceHandler): ServiceHandler =>
    async (params, context) => {
      if (!deps.authorizeContext(context))
        throw new AppsServiceError(
          'APPS_AUTH_METHOD_DISABLED',
          'Apps is not available from this service channel.'
        );
      return handler(params, context);
    };

  return {
    'apps.getState': authorize(async () => deps.access.refresh()),
    'apps.getPolicy': authorize(async () => deps.access.policy),
    'apps.marketplace.list': authorize(async (params) => {
      const query = stringParam(params, 'query', 256, false)?.trim();
      const cursor = stringParam(params, 'cursor', 2048, false);
      const limit = params.limit === undefined ? undefined : Number(params.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
        throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Invalid marketplace limit.');
      return requireClient(deps).marketplace({ query, cursor, limit });
    }),
    'apps.install': authorize(async (params) => {
      const appId = stringParam(params, 'appId', 256)!;
      connectedAuth.delete(appId);
      return refreshMcpAfterMutation(requireClient(deps).install(appId));
    }),
    'apps.uninstall': authorize(async (params) => {
      const appId = stringParam(params, 'appId', 256)!;
      connectedAuth.delete(appId);
      return refreshMcpAfterMutation(requireClient(deps).uninstall(appId));
    }),
    'apps.activate': authorize(async (params) =>
      refreshMcpAfterMutation(requireClient(deps).activate(stringParam(params, 'appId', 256)!))
    ),
    'apps.deactivate': authorize(async (params) =>
      refreshMcpAfterMutation(requireClient(deps).deactivate(stringParam(params, 'appId', 256)!))
    ),
    'apps.auth.getStatus': authorize(async (params) =>
      readAuthStatus(stringParam(params, 'appId', 256)!)
    ),
    'apps.auth.startOAuth': authorize(async (params) =>
      requireClient(deps).startOAuth(stringParam(params, 'appId', 256)!)
    ),
    'apps.auth.submitCredentials': authorize(async (params) => {
      const client = requireClient(deps);
      const appId = stringParam(params, 'appId', 256)!;
      const fields = validateFields(params.fields);
      const status = await client.getAuthStatus(appId);
      const declared = new Map((status?.manualFields ?? []).map((field) => [field.key, field]));
      if (Object.keys(fields).some((key) => !declared.has(key)))
        throw new AppsServiceError(
          'APPS_INVALID_ARGUMENT',
          'Credential fields do not match this app.'
        );
      if (
        [...declared.values()].some((field) => !field.optional && !(fields[field.key] ?? '').trim())
      )
        throw new AppsServiceError(
          'APPS_INVALID_ARGUMENT',
          'Required credential fields are missing.'
        );
      const accountHint = stringParam(params, 'accountHint', 256, false);
      const result = await client.submitCredentials(appId, fields, accountHint);
      if (result?.status === 'connected') {
        connectedAuth.add(appId);
        await deps.access.refreshMcp();
      }
      return result;
    }),
    'apps.credentials.validate': authorize(async (params) =>
      deps.access.validateCandidate(stringParam(params, 'apiKey', 16 * 1024)!)
    ),
    'apps.credentials.save': authorize(async (params) =>
      deps.access.saveCandidate(stringParam(params, 'apiKey', 16 * 1024)!)
    ),
    'apps.credentials.remove': authorize(async () => deps.access.removeStoredKey()),
    'apps.icon.get': authorize(async (params) =>
      requireClient(deps).getIcon(stringParam(params, 'appId', 256)!)
    ),
  };
}
