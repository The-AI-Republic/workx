import { DataSourceError } from '../errors';
import type { DataQueryParameter } from '../types';

export function encodeDataQueryParameters(
  parameters: DataQueryParameter[] | undefined
): Array<string | number | boolean | null> {
  return (parameters ?? []).map((parameter) => {
    switch (parameter.type) {
      case 'null':
        return null;
      case 'boolean':
      case 'string':
        return parameter.value;
      case 'number':
        if (!Number.isFinite(parameter.value)) {
          throw new DataSourceError(
            'QUERY_PARAMETER_MISMATCH',
            'Numeric parameters must be finite.'
          );
        }
        return parameter.value;
      case 'date': {
        if (Number.isNaN(Date.parse(parameter.value))) {
          throw new DataSourceError(
            'QUERY_PARAMETER_MISMATCH',
            'Date parameters must be ISO-8601 values.'
          );
        }
        return parameter.value;
      }
    }
  });
}

export function dataQueryParameterTypes(parameters: DataQueryParameter[] | undefined): string[] {
  return (parameters ?? []).map((parameter) => parameter.type);
}
