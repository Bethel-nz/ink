// mini-linear.ts
import { v4 as uuidv4 } from 'uuid'; // npm install uuid @types/uuid

// --- 1. The Data Model (like Linear's `Issue`) ---

// A helper type for the changes we're tracking.
type ModelChanges = Record<string, { oldValue: any; newValue: any }>;

class SyncableModel {
  public id: string;
  // This stores the actual data of the model.
  protected _data: Record<string, any> = {};
  // This tracks local, unsaved changes.
  private _pendingChanges: ModelChanges = {};

  // A reference to the queue where we'll send transactions.
  private transactionQueue: TransactionQueue;

  constructor(
    id: string,
    initialData: Record<string, any>,
    queue: TransactionQueue
  ) {
    this.id = id;
    this.transactionQueue = queue;
    this._data = { ...initialData, id };
  }

  protected setProperty<T>(key: string, value: T) {
    const oldValue = this._data[key];
    if (oldValue === value) return; // No change

    console.log(
      `[OPTIMISTIC UI] Setting ${key} to "${value}" on model ${this.id}`
    );

    // Optimistic update: change the local data immediately.
    this._data[key] = value;

    // Track the change for the next `save()` call.
    this._pendingChanges[key] = { oldValue, newValue: value };
  }

  /**
   * Creates a transaction from pending changes and sends it to the queue.
   */
  public save() {
    if (Object.keys(this._pendingChanges).length === 0) {
      console.log(`[CLIENT ${this.id}] No changes to save.`);
      return;
    }

    const payload = Object.fromEntries(
      Object.entries(this._pendingChanges).map(([key, { newValue }]) => [
        key,
        newValue,
      ])
    );

    const transaction: Transaction = {
      transactionId: uuidv4(),
      type: 'UPDATE',
      modelName: 'Issue',
      modelId: this.id,
      payload: payload,
    };

    console.log(
      `[CLIENT ${this.id}] Calling .save(). Creating transaction:`,
      transaction
    );
    this.transactionQueue.enqueue(transaction);

    // Clear pending changes after creating the transaction.
    this._pendingChanges = {};
  }

  /**
   * Called by the sync engine when a delta packet arrives from the server.
   * This is where "rebasing" happens.
   */
  public _applyServerUpdate(serverData: Record<string, any>) {
    console.log(
      `[REBASING ${this.id}] Applying server update. Server says:`,
      serverData
    );

    // Update our base data with the server's truth.
    // This doesn't wipe out our pending optimistic changes.
    this._data = { ...this._data, ...serverData };

    // More complex rebasing logic would go here. For example, if the server
    // updated a field that we also have a pending change for, we might
    // need to resolve it. LSE's model is that the local change wins.
    console.log(`[REBASING ${this.id}] New internal state:`, this._data);
  }

  public get data() {
    // The "view" of the data is the base data with pending changes applied on top.
    const currentView = { ...this._data };
    for (const key in this._pendingChanges) {
      currentView[key] = this._pendingChanges[key].newValue;
    }
    return currentView;
  }
}

// Concrete implementation for an Issue
class Issue extends SyncableModel {
  constructor(
    id: string,
    initialData: Record<string, any>,
    queue: TransactionQueue
  ) {
    super(id, initialData, queue);
  }

  get title(): string {
    return this.data.title;
  }

  set title(value: string) {
    this.setProperty('title', value);
  }

  get assigneeId(): string | null {
    return this.data.assigneeId;
  }

  set assigneeId(value: string | null) {
    this.setProperty('assigneeId', value);
  }
}

// --- 2. The Transaction and Queue (The Offline & Sync Layer) ---

interface Transaction {
  transactionId: string;
  type: 'UPDATE'; // | 'CREATE' | 'DELETE'
  modelName: string;
  modelId: string;
  payload: Record<string, any>;
}

class TransactionQueue {
  private outbox: Transaction[] = [];
  private server: MockServer;

  constructor(server: MockServer) {
    this.server = server;
  }

  enqueue(transaction: Transaction) {
    this.outbox.push(transaction);
    console.log(
      '[QUEUE] Transaction enqueued. Outbox size:',
      this.outbox.length
    );
    // In a real app, this would be debounced.
    this.flush();
  }

  flush() {
    if (this.outbox.length === 0) return;
    console.log('[QUEUE] Flushing outbox to server...');
    const transactionsToSend = [...this.outbox];
    this.outbox = [];
    this.server.processTransactions(transactionsToSend);
  }
}

// --- 3. The Mock Server (The Centralized Source of Truth) ---

interface DeltaPacket {
  lastSyncId: number;
  modelName: string;
  modelId: string;
  data: Record<string, any>; // The new, full state of the model
}

class MockServer {
  public lastSyncId = 100;
  // The server's own database
  public database: Record<string, any> = {};
  // A reference back to the client sync engine to "broadcast" deltas
  private clientSyncEngine: SyncEngine;

  constructor(initialDbState: Record<string, any>) {
    this.database = initialDbState;
  }

  // This connects the server back to the client for broadcasting.
  setClient(client: SyncEngine) {
    this.clientSyncEngine = client;
  }

  processTransactions(transactions: Transaction[]) {
    console.log(`[SERVER] Received ${transactions.length} transaction(s).`);
    transactions.forEach((tx) => {
      // 1. Update the server's database (the source of truth)
      if (!this.database[tx.modelId]) {
        this.database[tx.modelId] = {};
      }
      this.database[tx.modelId] = {
        ...this.database[tx.modelId],
        ...tx.payload,
      };

      // 2. Increment the global sync ID
      this.lastSyncId++;

      // 3. Create a delta packet
      const delta: DeltaPacket = {
        lastSyncId: this.lastSyncId,
        modelName: tx.modelName,
        modelId: tx.modelId,
        data: this.database[tx.modelId], // Send the full, new state
      };

      // 4. Broadcast the delta packet back to all clients
      console.log(
        `[SERVER] Broadcasting delta packet with syncId ${delta.lastSyncId}`
      );
      this.clientSyncEngine.handleDeltaPacket(delta);
    });
  }
}

// --- 4. The Client-Side Sync Engine (Manages the object pool) ---

class SyncEngine {
  private objectPool: Map<string, SyncableModel> = new Map();
  public readonly transactionQueue: TransactionQueue;
  private server: MockServer;

  constructor(server: MockServer) {
    this.server = server;
    this.transactionQueue = new TransactionQueue(server);
    this.server.setClient(this); // Connect server back to us for broadcasts
  }

  // Creates or retrieves a model instance from the pool.
  getModel(id: string, initialData: Record<string, any>): Issue {
    if (this.objectPool.has(id)) {
      return this.objectPool.get(id) as Issue;
    }
    const model = new Issue(id, initialData, this.transactionQueue);
    this.objectPool.set(id, model);
    return model;
  }

  handleDeltaPacket(delta: DeltaPacket) {
    console.log(`[SYNC ENGINE] Received delta for model ${delta.modelId}`);
    const model = this.objectPool.get(delta.modelId);
    if (model) {
      model._applyServerUpdate(delta.data);
    } else {
      // This is a new model we haven't seen before.
      console.log(
        `[SYNC ENGINE] Creating new model ${delta.modelId} from delta.`
      );
      this.getModel(delta.modelId, delta.data);
    }
  }
}

// --- 5. The Simulation ---

async function runDemo() {
  console.log('--- DEMO: Linear-Style Sync Engine ---');

  // --- Setup ---
  const initialIssueData = { title: 'Initial Title', assigneeId: null };
  const issueId = 'issue_123';

  // The server starts with some state in its DB.
  const server = new MockServer({ [issueId]: initialIssueData });

  // The client's sync engine connects to the server.
  const clientSyncEngine = new SyncEngine(server);

  // We load the issue into our client app.
  const myIssue = clientSyncEngine.getModel(issueId, initialIssueData);

  console.log('\n--- SCENARIO 1: Simple Edit ---');
  console.log('Current issue title:', myIssue.title);

  myIssue.title = 'Updated by client';
  console.log('After optimistic update:', myIssue.title);

  console.log('Calling save...');
  myIssue.save();

  // Wait a moment to see the logs
  await new Promise((res) => setTimeout(res, 100));

  console.log('\n--- SCENARIO 2: Concurrent Edit and Rebasing ---');
  const anotherIssueData = { title: 'Another Issue', assigneeId: 'user_A' };
  const anotherIssueId = 'issue_456';
  server.database[anotherIssueId] = anotherIssueData;

  const myOtherIssue = clientSyncEngine.getModel(
    anotherIssueId,
    anotherIssueData
  );

  console.log('Current state of other issue:', myOtherIssue.data);

  // You start editing the title locally.
  myOtherIssue.title = 'My Local Edit';
  console.log('After optimistic update:', myOtherIssue.data.title);

  // BEFORE you click save, a delta comes in from the server
  // where a collaborator changed the assignee.
  console.log('\n!!! INCOMING DELTA from another user !!!');
  const conflictingDelta: DeltaPacket = {
    lastSyncId: server.lastSyncId + 1,
    modelName: 'Issue',
    modelId: anotherIssueId,
    data: { ...anotherIssueData, assigneeId: 'user_B' }, // Collaborator changed assignee
  };
  clientSyncEngine.handleDeltaPacket(conflictingDelta);

  console.log('\nState after rebasing:');
  console.log('Assignee (from server):', myOtherIssue.assigneeId);
  console.log('Title (local change preserved):', myOtherIssue.title);

  // Now you finally click save.
  console.log('\nNow, we save our preserved local change...');
  myOtherIssue.save();
}

runDemo();
