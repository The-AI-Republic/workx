import type { DataResult } from './types';
import { DATA_SOURCE_LIMITS } from './validation';

function normalizeValue(value: unknown): {
  value: unknown;
  cellTruncated: boolean;
} {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return {
      value: { omitted: true, type: 'binary', bytes: value.byteLength },
      cellTruncated: false,
    };
  }
  if (typeof value === 'bigint') return { value: value.toString(), cellTruncated: false };
  if (value instanceof Date) return { value: value.toISOString(), cellTruncated: false };
  if (typeof value === 'string' && value.length > DATA_SOURCE_LIMITS.maxCellChars) {
    return {
      value: `${value.slice(0, DATA_SOURCE_LIMITS.maxCellChars)}…[truncated]`,
      cellTruncated: true,
    };
  }
  return { value, cellTruncated: false };
}

export class DataResultLimiter {
  limit(input: DataResult, maxRows: number): DataResult {
    if (input.shape !== 'tabular' || !input.rows) return this.fitSerialized(input);
    const reasons = new Set(input.truncationReasons ?? []);
    if (input.rows.length > maxRows) reasons.add('row_limit');
    const rows: unknown[][] = [];
    for (const rawRow of input.rows.slice(0, maxRows)) {
      const row = rawRow.map((cell) => {
        const normalized = normalizeValue(cell);
        if (normalized.cellTruncated) reasons.add('cell_size');
        return normalized.value;
      });
      const candidate = {
        ...input,
        rows: [...rows, row],
        rowCount: rows.length + 1,
      };
      if (JSON.stringify(candidate).length >= DATA_SOURCE_LIMITS.maxResultChars) {
        reasons.add('result_size');
        break;
      }
      rows.push(row);
    }
    const result: DataResult = {
      ...input,
      columns: input.columns?.map((column) => ({
        ...column,
        name: column.name.slice(0, 512),
        ...(column.databaseType ? { databaseType: column.databaseType.slice(0, 256) } : {}),
      })),
      rows,
      rowCount: rows.length,
      truncated: reasons.size > 0,
      ...(reasons.size ? { truncationReasons: [...reasons] } : { truncationReasons: undefined }),
    };
    while (
      result.rows?.length &&
      JSON.stringify(result).length >= DATA_SOURCE_LIMITS.maxResultChars
    ) {
      result.rows.pop();
      result.rowCount = result.rows.length;
      reasons.add('result_size');
    }
    while (
      result.columns?.length &&
      JSON.stringify(result).length >= DATA_SOURCE_LIMITS.maxResultChars
    ) {
      result.columns.pop();
      for (const row of result.rows ?? []) row.length = result.columns.length;
      reasons.add('result_size');
    }
    if (reasons.size) {
      result.truncated = true;
      result.truncationReasons = [...reasons];
    }
    return result;
  }

  private fitSerialized(input: DataResult): DataResult {
    if (JSON.stringify(input).length < DATA_SOURCE_LIMITS.maxResultChars) return input;
    return {
      ...input,
      documents: undefined,
      value: undefined,
      rowCount: 0,
      truncated: true,
      truncationReasons: ['result_size'],
    };
  }
}
