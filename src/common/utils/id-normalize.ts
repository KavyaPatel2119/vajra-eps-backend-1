/**
 * Safe ObjectId / string / unknown → string for comparisons and API payloads.
 */
export function toIdString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && 'toString' in (value as object)) {
    try {
      const s = (value as { toString: () => string }).toString();
      return typeof s === 'string' ? s : String(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

/** Drops null/undefined/empty entries (common bad Mongo data). */
export function normalizeStudentIdList(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id) => id != null && id !== '')
    .map((id) => toIdString(id))
    .filter((s) => s.length > 0);
}
