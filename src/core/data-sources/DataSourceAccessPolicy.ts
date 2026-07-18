import { DataSourceError } from './errors';
import type { DataAccessPrincipal, DataSource } from './types';

export type DataPrincipalAuthorizer = (
  principal: DataAccessPrincipal
) => boolean | Promise<boolean>;

export class DataSourceAccessPolicy {
  constructor(private readonly authorizePrincipal: DataPrincipalAuthorizer = () => true) {}

  async assertAgentAccess(source: DataSource, principal: DataAccessPrincipal): Promise<void> {
    if (
      principal.origin.channel !== 'local' ||
      !principal.attended ||
      !principal.desktopUiSession ||
      !(await this.authorizePrincipal(principal))
    ) {
      throw new DataSourceError(
        'DATA_ACCESS_ORIGIN_DENIED',
        'Data access is limited to attended local desktop turns.'
      );
    }
    if (source.lifecycleState !== 'active') {
      throw new DataSourceError('SOURCE_DELETION_PENDING', 'This data source is being deleted.');
    }
    if (!source.enabled)
      throw new DataSourceError('SOURCE_DISABLED', 'This data source is disabled.');
    if (!source.policy.agentAccessEnabled) {
      throw new DataSourceError(
        'AGENT_ACCESS_DISABLED',
        'Agent access is disabled for this data source.'
      );
    }
    if (
      source.lastTest?.status !== 'reachable' ||
      source.lastTest.connectionRevision !== source.connectionRevision
    ) {
      throw new DataSourceError(
        'AGENT_ACCESS_DISABLED',
        'The data source must pass a current connection test.'
      );
    }
    if (
      source.lastTest.readOnlyAssessment.userAcknowledgementRequired &&
      source.policy.leastPrivilegeAcknowledgement?.connectionRevision !== source.connectionRevision
    ) {
      throw new DataSourceError(
        'AGENT_ACCESS_DISABLED',
        'The least-privilege warning must be acknowledged.'
      );
    }
  }
}
