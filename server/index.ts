import { VersionHistory, diff, DiffResult } from './versioning';
import {
  Operation,
  applyOperations,
  operationalTransform,
  diffToOperations,
} from '../common/ot';

console.log('Starting real-time sync server on http://localhost:3000');

// --- In-memory storage for note histories ---
// In a real app, this would be a database.
const noteHistories = new Map<string, VersionHistory>();
const noteConnections = new Map<string, Set<any>>(); // socket : noteId

interface WebSocketData {
  noteId: string;
}

function getHistoryForNote(noteId: string): VersionHistory {
  if (!noteHistories.has(noteId)) {
    console.log(`Creating new history for note: ${noteId}`);
    const newHistory = new VersionHistory(noteId);
    // Create an initial commit for the note
    newHistory.commit('', 'Initial empty commit');
    noteHistories.set(noteId, newHistory);
  }
  return noteHistories.get(noteId)!;
}

function broadcastUserCount(noteId: string) {
  const connections = noteConnections.get(noteId);
  if (connections) {
    const message = JSON.stringify({
      type: 'user_count_update',
      payload: { count: connections.size },
    });
    for (const ws of connections) {
      ws.send(message);
    }
  }
}

// --- The Sync Server ---

Bun.serve<WebSocketData, undefined>({
  port: 3000,
  async fetch(req, server) {
    const url = new URL(req.url);

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname.startsWith('/ws/note/')) {
      const noteId = url.pathname.split('/').pop()!;
      const upgraded = server.upgrade<WebSocketData>(req, {
        data: { noteId },
      });
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return; // Bun handles the response
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/note/')) {
      const noteId = url.pathname.split('/').pop()!;
      console.log(`\n--- Received GET Request for [${noteId}] ---`);
      const noteHistory = getHistoryForNote(noteId);
      const latest_hash = noteHistory.getHeadHash();
      const latest_content = noteHistory.getCurrentContent();

      const response = JSON.stringify({
        status: 'success',
        latest_hash,
        latest_content,
      });
      return new Response(response, {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404, headers });
  },
  websocket: {
    open(ws) {
      const { noteId } = ws.data;
      console.log(
        `[${noteId}] Client connected. Total: ${
          (noteConnections.get(noteId)?.size || 0) + 1
        }`
      );
      if (!noteConnections.has(noteId)) {
        noteConnections.set(noteId, new Set());
      }
      noteConnections.get(noteId)!.add(ws);
      broadcastUserCount(noteId);
    },
    close(ws, code, reason) {
      const { noteId } = ws.data;
      const connections = noteConnections.get(noteId);
      if (connections) {
        connections.delete(ws);
        broadcastUserCount(noteId);
        if (connections.size === 0) {
          console.log(`[${noteId}] Last client disconnected.`);
          noteConnections.delete(noteId);
        }
      }
    },
    async message(ws, message) {
      const { noteId } = ws.data;
      const { type, payload } = JSON.parse(message.toString());

      if (type !== 'sync') return;

      const { base_hash, operations: client_ops } = payload;

      console.log(`\n--- [${noteId}] Received OT Sync Request ---`);
      console.log(`Client base hash: ${base_hash}`);

      const noteHistory = getHistoryForNote(noteId);
      const base_content = noteHistory.getContent(base_hash);
      const server_content = noteHistory.getCurrentContent();

      if (base_content === null) {
        ws.send(
          JSON.stringify({
            type: 'error',
            payload: { message: 'Base hash not found. Please reload.' },
          })
        );
        return;
      }

      if (base_hash === noteHistory.getHeadHash()) {
        console.log(`[${noteId}] ✅ Fast-forward`);
        const client_content = applyOperations(base_content, client_ops);
        const newCommitHash = noteHistory.commit(
          client_content,
          `Update from client`
        );

        ws.send(
          JSON.stringify({ type: 'ack', payload: { new_hash: newCommitHash } })
        );

        const updateMessage = JSON.stringify({
          type: 'update',
          payload: { latest_hash: newCommitHash, operations: client_ops },
        });
        for (const client of noteConnections.get(noteId) || []) {
          if (client !== ws) client.send(updateMessage);
        }
      } else {
        console.log(`[${noteId}] ⏳ Concurrent edit. Applying OT...`);
        const client_content = applyOperations(base_content, client_ops);

        const { success, mergedContent, error } = operationalTransform(
          base_content,
          client_content,
          server_content!,
          diff
        );

        if (!success) {
          console.log(`[${noteId}] ❌ OT Failed: ${error}`);
          ws.send(
            JSON.stringify({ type: 'conflict', payload: { message: error } })
          );
          return;
        }

        const newCommitHash = noteHistory.commit(
          mergedContent!,
          'Merged update from client'
        );
        console.log(`[${noteId}] ✅ Clean merge! New HEAD: ${newCommitHash}`);

        ws.send(
          JSON.stringify({ type: 'ack', payload: { new_hash: newCommitHash } })
        );

        const server_update_diff = diff(server_content!, mergedContent!);
        const server_update_ops = diffToOperations(server_update_diff);

        if (server_update_ops.length > 0) {
          const updateMessage = JSON.stringify({
            type: 'update',
            payload: {
              latest_hash: newCommitHash,
              operations: server_update_ops,
            },
          });
          for (const client of noteConnections.get(noteId) || []) {
            if (client !== ws) client.send(updateMessage);
          }
        }
      }
    },
  },
});
