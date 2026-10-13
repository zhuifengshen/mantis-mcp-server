import { createHash } from 'node:crypto';
import type { Entity } from './projects.js';

export const operationMarker = (id: string) => `[mantis-mcp operation_id=${id}]`;
export const textHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function locateNote(issue: Entity, operationId: string, userId: number, bodyHash: string): Entity[] {
  return (issue.notes ?? []).filter((n: Entity) => n.text?.includes(operationMarker(operationId)))
    .filter((n: Entity) => n.reporter?.id === userId && textHash(n.text) === bodyHash);
}
