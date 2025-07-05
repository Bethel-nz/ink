import type { DiffResult } from '../server/versioning';

export interface Operation {
  type: 'retain' | 'insert' | 'delete';
  length?: number; // for retain/delete
  text?: string; // for insert
  position: number; // absolute position in the document
}

/**
 * Convert diff results to operations.
 * This version correctly handles newline characters.
 */
export function diffToOperations(diffs: DiffResult[]): Operation[] {
  const operations: Operation[] = [];
  let position = 0; // This tracks the cursor position in the *original* document.

  for (const diff of diffs) {
    switch (diff.type) {
      case 'unchanged':
        operations.push({
          type: 'retain',
          length: diff.line.length,
          position,
        });
        position += diff.line.length;
        break;

      case 'added':
        operations.push({
          type: 'insert',
          text: diff.line,
          position,
        });
        // Position does not advance because an insert doesn't consume from the original.
        break;

      case 'removed':
        operations.push({
          type: 'delete',
          length: diff.line.length,
          position,
        });
        position += diff.line.length;
        break;

      case 'modified':
        if (diff.charDiffs) {
          let charPos = position;
          for (const charDiff of diff.charDiffs) {
            switch (charDiff.type) {
              case 'unchanged':
                operations.push({
                  type: 'retain',
                  length: 1,
                  position: charPos,
                });
                charPos++;
                break;
              case 'added':
                operations.push({
                  type: 'insert',
                  text: charDiff.char,
                  position: charPos,
                });
                break;
              case 'removed':
                operations.push({
                  type: 'delete',
                  length: 1,
                  position: charPos,
                });
                charPos++;
                break;
            }
          }
          // Advance the main position tracker past the original content block.
          position += diff.oldLine?.length || 0;
        }
        break;
    }
  }

  return operations;
}

/**
 * Transform client operations against server operations
 * This is the core OT algorithm - simplified version
 */
export function transformOperations(
  clientOps: Operation[],
  serverOps: Operation[]
): Operation[] {
  const transformed: Operation[] = [];
  let clientIndex = 0;
  let serverIndex = 0;
  let positionOffset = 0;

  while (clientIndex < clientOps.length) {
    const clientOp = clientOps[clientIndex];
    if (!clientOp) {
      clientIndex++;
      continue;
    }
    const serverOp = serverOps[serverIndex];

    if (!serverOp) {
      // No more server ops, just apply remaining client ops with offset
      transformed.push({
        ...clientOp!,
        position: clientOp!.position + positionOffset,
      });
      clientIndex++;
      continue;
    }

    // Compare positions
    if (clientOp!.position < serverOp.position) {
      // Client operation comes before server operation
      transformed.push({
        ...clientOp!,
        position: clientOp!.position + positionOffset,
      });
      clientIndex++;
    } else if (clientOp!.position > serverOp.position) {
      // Server operation comes before client operation
      // Adjust client operation position based on server operation
      if (serverOp.type === 'insert') {
        positionOffset += serverOp.text?.length || 0;
      } else if (serverOp.type === 'delete') {
        positionOffset -= serverOp.length || 0;
      }
      serverIndex++;
    } else {
      // Operations at same position - conflict resolution
      if (clientOp!.type === 'insert' && serverOp.type === 'insert') {
        // Both inserting at same position - server wins, client gets pushed forward
        transformed.push({
          ...clientOp!,
          position: clientOp!.position + (serverOp.text?.length || 0),
        });
      } else if (clientOp!.type === 'delete' && serverOp.type === 'delete') {
        // Both deleting same thing - no-op (already deleted by server)
        // Skip this client operation
      } else {
        // Mixed operations - apply with current offset
        transformed.push({
          ...clientOp!,
          position: clientOp!.position + positionOffset,
        });
      }
      clientIndex++;
      serverIndex++;
    }
  }

  return transformed;
}

/**
 * Apply operations to text content
 */
export function applyOperations(
  content: string,
  operations: Operation[]
): string {
  let result = content;
  let offset = 0;

  // Sort operations by position to apply them in order
  const sortedOps = [...operations].sort((a, b) => a.position - b.position);

  for (const op of sortedOps) {
    const adjustedPosition = op.position + offset;

    switch (op.type) {
      case 'insert':
        result =
          result.slice(0, adjustedPosition) +
          op.text +
          result.slice(adjustedPosition);
        offset += op.text?.length || 0;
        break;

      case 'delete':
        result =
          result.slice(0, adjustedPosition) +
          result.slice(adjustedPosition + (op.length || 0));
        offset -= op.length || 0;
        break;

      case 'retain':
        // No-op for retain
        break;
    }
  }

  return result;
}

/**
 * Main operational transform function
 */
export function operationalTransform(
  baseContent: string,
  clientContent: string,
  serverContent: string,
  diffFunction: (a: string, b: string) => DiffResult[]
): { success: boolean; mergedContent?: string; error?: string } {
  try {
    // Extract operations from diffs
    const serverDiffs = diffFunction(baseContent, serverContent);
    const clientDiffs = diffFunction(baseContent, clientContent);

    const serverOps = diffToOperations(serverDiffs);
    const clientOps = diffToOperations(clientDiffs);

    // Transform client operations against server operations
    const transformedClientOps = transformOperations(clientOps, serverOps);

    // Apply transformed client operations to server content
    const mergedContent = applyOperations(serverContent, transformedClientOps);

    return { success: true, mergedContent };
  } catch (error) {
    return {
      success: false,
      error: `OT failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    };
  }
}

/**
 * Debug helper to visualize operations
 */
export function debugOperations(operations: Operation[]): void {
  console.log('--- Operations ---');
  operations.forEach((op, i) => {
    switch (op.type) {
      case 'retain':
        console.log(`${i}: RETAIN ${op.length} chars at pos ${op.position}`);
        break;
      case 'insert':
        console.log(`${i}: INSERT "${op.text}" at pos ${op.position}`);
        break;
      case 'delete':
        console.log(`${i}: DELETE ${op.length} chars at pos ${op.position}`);
        break;
    }
  });
  console.log('------------------');
}
