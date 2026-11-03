/** Optional planner-only translations, never independent-review evidence. */
export function labelTranslationsShape(value: unknown, labels: unknown): boolean {
 const source = labels === undefined ? [] : labels;
 return value === undefined || Array.isArray(source) && Array.isArray(value) && value.length === source.length
  && value.every(v => typeof v === 'string' && !!v.trim());
}

/** A legacy copy may omit optional Chinese; two supplied versions must agree. */
export function labelTranslationsConflict(a: unknown, b: unknown): boolean {
 return a !== undefined && b !== undefined && JSON.stringify(a) !== JSON.stringify(b);
}
