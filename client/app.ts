// Import the core OT and diffing functions.
// These are the building blocks for our collaborative editor.
import {
  diffToOperations,
  applyOperations,
  transformOperations,
  Operation,
} from '../common/ot';
import { diff } from '../server/versioning';

document.addEventListener('DOMContentLoaded', () => {
  // --- DOM Element Selection ---
  const editor = document.getElementById('editor') as HTMLTextAreaElement;
  const statusDiv = document.getElementById('status');
  const charCount = document.getElementById('char-count');
  const wordCount = document.getElementById('word-count');
  const lineCount = document.getElementById('line-count');
  const syncStatus = document.getElementById('sync-status');
  const userCount = document.getElementById('user-count');
  const userAvatars = document.getElementById('user-avatars');
  const copyRoomIdButton = document.getElementById('copy-room-id');

  if (!editor) {
    console.error(
      "Fatal Error: Text editor element with id='editor' not found."
    );
    return;
  }

  console.log(editor.textContent);

  const noteId = 'my-test-note';

  // --- State Management Variables ---
  let ws: WebSocket;
  let latestHash: string | null = null;
  let synchronizedContent: string = '';
  let inFlightOps: Operation[] | null = null;
  let pendingOps: Operation[] | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- UI and Status Functions ---
  function updateStatus(text: string, color = '#888', isPulse = false) {
    if (syncStatus) {
      const pulseClass = isPulse ? 'animate-pulse' : '';
      syncStatus.innerHTML = `
                <div class="w-2 h-2 rounded-full ${pulseClass}" style="background-color: ${color};"></div>
                <span class="text-sm font-medium" style="color: ${color};">${text}</span>
            `;
    }
  }

  function setEditorContent(content: string, keepCursor = false) {
    let cursorPosition: number | undefined;
    if (keepCursor) {
      cursorPosition = editor.selectionStart;
    }
    editor.value = content;
    if (keepCursor && cursorPosition !== undefined) {
      try {
        editor.setSelectionRange(cursorPosition, cursorPosition);
      } catch (e) {
        /* Ignored */
      }
    }
    updateCounters();
  }

  function updateCounters() {
    if (!editor || !charCount || !wordCount || !lineCount) return;
    const text = editor.value;
    const chars = text.length;
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const lines = text.split('\n').length;

    charCount.textContent = `${chars} characters`;
    wordCount.textContent = `${words} words`;
    lineCount.textContent = `${lines} lines`;
  }

  // --- WebSocket Connection ---
  function connect() {
    updateStatus('Connecting...', '#f59e0b', true);
    const wsUrl = `ws://localhost:3000/ws/note/${noteId}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      updateStatus('Syncing...', '#3b82f6', true);
      try {
        const response = await fetch(
          `http://localhost:3000/api/note/${noteId}`
        );
        if (!response.ok) throw new Error('Failed to fetch initial state');
        const data = await response.json();

        latestHash = data.latest_hash;
        synchronizedContent = data.latest_content;
        setEditorContent(synchronizedContent);
        console.log(synchronizedContent);

        updateStatus('Connected', '#16a34a');
        editor.disabled = false;
        editor.focus();
      } catch (error) {
        console.error('Initialization Error:', error);
        updateStatus('Connection Failed', '#dc2626');
        editor.disabled = true;
      }
    };

    ws.onmessage = (event) => {
      const { type, payload } = JSON.parse(event.data);
      switch (type) {
        case 'ack':
          handleAck(payload);
          break;
        case 'update':
          handleUpdate(payload);
          break;
        case 'conflict':
          handleConflict(payload);
          break;
        case 'user_count_update':
          handleUserCountUpdate(payload);
          break;
        case 'error':
          console.error('Server Error:', payload.message);
          updateStatus('Error', '#dc2626');
          break;
      }
    };

    ws.onclose = () => {
      updateStatus('Disconnected', '#f97316');
      editor.disabled = true;
      setTimeout(connect, 2000);
    };
  }

  // --- OT Message Handlers ---
  function handleAck(payload: { new_hash: string }) {
    latestHash = payload.new_hash;
    if (inFlightOps) {
      synchronizedContent = applyOperations(synchronizedContent, inFlightOps);
    }
    inFlightOps = null;

    if (pendingOps) {
      sendOperations(pendingOps);
      pendingOps = null;
    } else {
      updateStatus('Synced', '#16a34a');
    }
  }

  function handleUserCountUpdate(payload: { count: number }) {
    if (userCount) {
      const userText = payload.count === 1 ? 'user' : 'users';
      userCount.textContent = `${payload.count} ${userText} online`;
    }
  }

  function handleUpdate(payload: {
    latest_hash: string;
    operations: Operation[];
  }) {
    updateStatus('Receiving changes...', '#3b82f6', true);
    const incomingOps = payload.operations;
    synchronizedContent = applyOperations(synchronizedContent, incomingOps);
    latestHash = payload.latest_hash;
    let newEditorContent = synchronizedContent;

    if (inFlightOps) {
      const transformedInFlight = transformOperations(inFlightOps, incomingOps);
      inFlightOps = transformedInFlight;
      newEditorContent = applyOperations(newEditorContent, inFlightOps);
    }

    if (pendingOps) {
      const transformedPending = transformOperations(pendingOps, incomingOps);
      pendingOps = transformedPending;
      newEditorContent = applyOperations(newEditorContent, pendingOps);
    }

    setEditorContent(newEditorContent, true);
    setTimeout(() => updateStatus('Synced', '#16a34a'), 500);
  }

  function handleConflict(payload: any) {
    console.error('Fatal conflict from server!', payload);
    updateStatus('Fatal conflict', '#dc2626');
    alert(
      'A conflict occurred that could not be automatically resolved. The page will be reloaded to get the latest version.'
    );
    window.location.reload();
  }

  // --- Sending Operations to Server ---
  function sendOperations(ops: Operation[]) {
    if (ws.readyState !== WebSocket.OPEN) {
      updateStatus('Not connected', '#dc2626');
      return;
    }

    if (inFlightOps) {
      pendingOps = pendingOps ? [...pendingOps, ...ops] : ops;
      updateStatus('Waiting for sync...', '#f59e0b');
      return;
    }

    inFlightOps = ops;
    updateStatus('Syncing...', '#3b82f6', true);

    ws.send(
      JSON.stringify({
        type: 'sync',
        payload: { base_hash: latestHash, operations: ops },
      })
    );
  }

  // --- Event Listeners & Initial Load ---
  editor.addEventListener('input', () => {
    updateStatus('Typing...', '#888');
    clearTimeout(debounceTimer!);
    debounceTimer = setTimeout(() => {
      const currentText = editor.value;
      let baseContentForDiff = synchronizedContent;
      if (inFlightOps) {
        baseContentForDiff = applyOperations(baseContentForDiff, inFlightOps);
      }
      if (pendingOps) {
        baseContentForDiff = applyOperations(baseContentForDiff, pendingOps);
      }
      const ops = diffToOperations(diff(baseContentForDiff, currentText));
      if (ops.length > 0) {
        sendOperations(ops);
      }
    }, 500);
  });

  if (copyRoomIdButton) {
    copyRoomIdButton.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const originalText = copyRoomIdButton.textContent;
        copyRoomIdButton.textContent = 'Copied!';
        setTimeout(() => {
          copyRoomIdButton.textContent = originalText;
        }, 2000);
      });
    });
  }

  editor.disabled = true;
  connect();
  updateCounters();
});
