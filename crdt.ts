// crdt.ts

// --- Step 1: Define the core data structures ---

type SiteID = string;
type CharID = [number, SiteID]; // [timestamp, siteID] - The unique, sortable address

// The object for a single character in our document.
interface CRDTChar {
  id: CharID;
  prevId: CharID | null; // ID of the character to the left. Null for the first char.
  value: string;
  isDeleted?: boolean;
}

// An "Operation" is the command sent over the network.
interface InsertOperation {
  type: 'INSERT';
  char: CRDTChar;
}

interface DeleteOperation {
  type: 'DELETE';
  charId: CharID;
}

type Operation = InsertOperation | DeleteOperation;

// A helper to serialize a CharID into a string for use as a Map key.
function serializeId(id: CharID): string {
  return `${id[0]}-${id[1]}`;
}

// --- Step 2: The CRDT Document Class ---

class CRDTTextDocument {
  public readonly siteId: SiteID;
  private chars: Map<string, CRDTChar>; // A map of all characters in the document, keyed by their serialized ID.

  // Special markers for the beginning and end of the document.
  private static START_MARKER: CRDTChar = {
    id: [0, '_START_'],
    prevId: null,
    value: '',
  };
  private static END_MARKER: CRDTChar = {
    id: [Infinity, '_END_'],
    prevId: [0, '_START_'],
    value: '',
  };

  constructor(siteId: SiteID) {
    if (!siteId) throw new Error('A siteId is required.');
    this.siteId = siteId;
    this.chars = new Map();
    // Every document starts with these boundary markers.
    this.chars.set(
      serializeId(CRDTTextDocument.START_MARKER.id),
      CRDTTextDocument.START_MARKER
    );
    this.chars.set(
      serializeId(CRDTTextDocument.END_MARKER.id),
      CRDTTextDocument.END_MARKER
    );
  }

  /**
   * Generates a new character and the corresponding "Insert" operation.
   * This is what a client calls when the user types something.
   */
  public localInsert(value: string, index: number): InsertOperation {
    const visibleChars = this.getVisibleChars();
    // Find the ID of the character that will be to the left of our new character.
    const prevChar = visibleChars[index]; // Note: index 0 is START_MARKER
    const prevId = prevChar.id;

    // Create the new character with a unique, sortable ID.
    const newChar: CRDTChar = {
      id: [Date.now(), this.siteId],
      prevId: prevId,
      value: value,
      isDeleted: false,
    };

    const operation: InsertOperation = { type: 'INSERT', char: newChar };

    // Apply the operation to our own document immediately.
    this.applyOperation(operation);

    return operation;
  }

  public localDelete(index: number): DeleteOperation | null {
    const visibleChars = this.getVisibleChars();
    console.log(
      'Debug: visibleChars before delete:',
      visibleChars.map((c) => c.value)
    );
    // We target index + 1 because visibleChars[0] is the START marker.
    const charToDelete = visibleChars[index + 1];
    console.log(
      'Debug: trying to delete at visual index',
      index,
      '-> internal index',
      index + 1,
      'which is char:',
      charToDelete?.value
    );

    if (!charToDelete || charToDelete.value === '') {
      console.error('Cannot delete start/end markers.');
      return null;
    }

    const operation: DeleteOperation = {
      type: 'DELETE',
      charId: charToDelete.id,
    };

    this.applyOperation(operation);
    return operation;
  }

  /**
   * Applies an operation from any client (including itself).
   * This method is deceptively simple and is the heart of the CRDT.
   * There is no "conflict" checking here. All valid operations are simply integrated.
   */
  public applyOperation(operation: Operation) {
    switch (operation.type) {
      case 'INSERT':
        // Add the new character to our map. The magic happens during rendering.
        this.chars.set(serializeId(operation.char.id), operation.char);
        break;
      case 'DELETE':
        const char = this.chars.get(serializeId(operation.charId));
        if (char) {
          char.isDeleted = true;
        }
        break;
    }
  }

  /**
   * Renders the document to a string. This is where the sorting
   * and conflict resolution becomes visible.
   */
  public toString(withDebug = false): string {
    const allChars = this.getOrderedChars();
    const visibleChars = allChars.filter((c) => !c.isDeleted);

    if (withDebug) {
      console.log(`[${this.siteId}] Document Chars (Sorted, with Tombstones):`);
      allChars.forEach((c) => {
        const idStr = c.id[0] === Infinity ? 'Infinity' : c.id[0];
        const deletedMarker = c.isDeleted ? ' (DELETED)' : '';
        console.log(
          `  - Char: '${c.value}', ID: [${idStr}, ${c.id[1]}]${deletedMarker}`
        );
      });
    }

    // Filter out the boundary markers and join the character values.
    return visibleChars
      .slice(1, -1)
      .map((c) => c.value)
      .join('');
  }

  private getVisibleChars(): CRDTChar[] {
    return this.getOrderedChars().filter((c) => !c.isDeleted);
  }

  /**
   * A helper method to get all characters in their correct, sorted order.
   * In a real-world, high-performance system, you would not rebuild this
   * array every time. You'd use a more optimized data structure like a
   * skip list or a balanced binary tree. For a demo, this is perfect.
   */
  private getOrderedChars(): CRDTChar[] {
    const allChars = Array.from(this.chars.values());

    // This sort is the "magic" of conflict resolution.
    // It sorts by timestamp first, then by siteId as a tie-breaker.
    // This guarantees that all clients will have the exact same order.
    allChars.sort((a, b) => {
      const [tsA, siteA] = a.id;
      const [tsB, siteB] = b.id;
      if (tsA !== tsB) return tsA - tsB;
      if (siteA < siteB) return -1;
      if (siteA > siteB) return 1;
      return 0;
    });

    // This is a simplified linked-list traversal for demo purposes.
    // A full implementation would actually walk the `prevId` chain.
    // But sorting by ID achieves the same deterministic result.
    return allChars;
  }
}

// --- Step 3: Run the Demo Simulation ---

async function runCommitStyleDemo() {
  console.log('--- CRDT Commit-Style Edit Simulation ---');

  // 1. Create a client for Alice.
  const docAlice = new CRDTTextDocument('Alice');
  console.log(`Initial State: "${docAlice.toString()}"\n`);

  // 2. Alice types "boob"
  console.log('Step 1: Alice types "boob"');
  docAlice.localInsert('b', 0);
  docAlice.localInsert('o', 1);
  await new Promise((res) => setTimeout(res, 1)); // Ensure unique timestamps
  const o2_op = docAlice.localInsert('o', 2);
  docAlice.localInsert('b', 3);

  console.log(`Current Text: "${docAlice.toString()}"`);
  docAlice.toString(true);
  console.log('');

  // 3. Alice "commits" a change: she wants to change the second 'o' to a 'b'.
  // This is a DELETE operation followed by an INSERT operation.
  console.log("Step 2: Alice changes the second 'o' to 'b'");

  // The text is "boob", so the character to delete is at index 2.
  const deleteOp = docAlice.localDelete(2);
  console.log('Generated Delete Op:', deleteOp);

  // The text is now effectively "bob", so the insertion point is at index 2.
  const insertOp = docAlice.localInsert('b', 2);
  console.log('Generated Insert Op:', insertOp.char);

  console.log(`\nFinal Text: "${docAlice.toString()}"`);
  console.log('Final state with tombstones:');
  docAlice.toString(true);

  console.log(
    '\nNotice the second "o" is marked as DELETED but still exists in the data structure.'
  );
}

runCommitStyleDemo();
