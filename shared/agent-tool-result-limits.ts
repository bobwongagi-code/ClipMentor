/** Keep text results small; clear image batches need a separate bounded allowance. */
export const TOOL_RESULT_TEXT_BYTES = 768 * 1024;
export const TOOL_RESULT_VISUAL_BYTES = 4 * 1024 * 1024;
export const TOOL_RESULT_BODY_BYTES = 5 * 1024 * 1024;
export const TOOL_RESULT_STANDARD_BODY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export function isBoundedVisualToolResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { __images, ...metadata } = value as Record<string, unknown>;
  return Array.isArray(__images) && __images.length > 0 && __images.length <= 8
    && __images.every((image) => image && typeof image === 'object'
      && Number.isFinite(image.frame) && typeof image.base64 === 'string'
      && image.base64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.base64))
    && encoder.encode(JSON.stringify(metadata)).byteLength <= TOOL_RESULT_TEXT_BYTES
    && encoder.encode(JSON.stringify(value)).byteLength <= TOOL_RESULT_VISUAL_BYTES;
}
