// mini-git.ts
// An implementation of a Git-like version control system for a single document.

type Hash = string;

// --- Step 1: Define the core data structures (Git Objects) ---
// This section is unchanged.

/**
 * Blob: Represents the raw content of the file (our text).
 */
type GitBlob = string;

/**
 * Tree: Represents the directory structure.
 */
interface Tree {
  [filename: string]: Hash;
}

/**
 * Commit: Represents a snapshot in history.
 */
interface Commit {
  tree: Hash;
  parent: Hash | null;
  message: string;
  timestamp: string;
}

type GitObject = GitBlob | Tree | Commit;

// --- Step 2.5: The NEW Diffing Algorithm (Character-Level) ---

/**
 * Represents a diff for a single character.
 */
interface CharDiff {
  char: string;
  type: 'added' | 'removed' | 'unchanged';
}

/**
 * Represents the result of a diff for a single line.
 */
interface DiffResult {
  line: string;
  type: 'added' | 'removed' | 'unchanged' | 'modified';
  charDiffs?: CharDiff[];
  oldLine?: string;
  newLine?: string;
}

/**
 * Generates a character-by-character diff between two strings (lines).
 * This is the new core logic that works on individual characters.
 */
function generateCharacterDiff(line1: string, line2: string): CharDiff[] {
  const chars1 = line1.split('');
  const chars2 = line2.split('');
  const n = chars1.length;
  const m = chars2.length;
  const dp = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  // Build the Longest Common Subsequence (LCS) table for characters.
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (chars1[i - 1] === chars2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Reconstruct the diff from the LCS table.
  const result: CharDiff[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && chars1[i - 1] === chars2[j - 1]) {
      result.unshift({ char: chars1[i - 1], type: 'unchanged' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ char: chars2[j - 1], type: 'added' });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      result.unshift({ char: chars1[i - 1], type: 'removed' });
      i--;
    } else {
      break; // End of diff.
    }
  }
  return result;
}

/**
 * A line-by-line diffing function that detects modified lines and
 * provides character-level diffs for them.
 */
function diff(text1: string, text2: string): DiffResult[] {
  const lines1 = text1.split('\n');
  const lines2 = text2.split('\n');
  const n = lines1.length;
  const m = lines2.length;
  const dp = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  // Build the LCS table for lines.
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (lines1[i - 1] === lines2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Reconstruct the line-level diff from the LCS table.
  const rawResults: {
    line: string;
    type: 'added' | 'removed' | 'unchanged';
  }[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && lines1[i - 1] === lines2[j - 1]) {
      rawResults.unshift({ line: lines1[i - 1], type: 'unchanged' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawResults.unshift({ line: lines2[j - 1], type: 'added' });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawResults.unshift({ line: lines1[i - 1], type: 'removed' });
      i--;
    } else {
      break;
    }
  }

  // Post-process to find modified lines and generate character diffs for them.
  const finalResult: DiffResult[] = [];
  let k = 0;
  while (k < rawResults.length) {
    const current = rawResults[k];
    const next = k + 1 < rawResults.length ? rawResults[k + 1] : null;

    if (current.type === 'removed' && next && next.type === 'added') {
      finalResult.push({
        type: 'modified',
        line: '', // Not applicable for modified lines
        oldLine: current.line,
        newLine: next.line,
        charDiffs: generateCharacterDiff(current.line, next.line),
      });
      k += 2; // Consume both lines
    } else {
      finalResult.push({ type: current.type, line: current.line });
      k++;
    }
  }

  return finalResult;
}

// --- Step 2: The Version History Class ---
// This section is unchanged.

class VersionHistory {
  private db: Map<Hash, GitObject> = new Map();
  private HEAD: Hash | null = null;
  private redoStack: Hash[] = [];
  public readonly filename: string;

  constructor(filename: string = 'note.txt') {
    this.filename = filename;
  }

  private hashObject(data: GitBlob | Tree | Commit): Hash {
    const content = typeof data === 'string' ? data : JSON.stringify(data);
    const hasher = new Bun.CryptoHasher('sha1');
    hasher.update(content);
    return hasher.digest('hex');
  }

  public commit(content: string, message: string = ''): Hash {
    const blobHash = this.hashObject(content);
    if (!this.db.has(blobHash)) this.db.set(blobHash, content);

    const treeData: Tree = { [this.filename]: blobHash };
    const treeHash = this.hashObject(treeData);
    if (!this.db.has(treeHash)) this.db.set(treeHash, treeData);

    const commitData: Commit = {
      tree: treeHash,
      parent: this.HEAD,
      message: message || `Commit at ${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    };
    const commitHash = this.hashObject(commitData);
    this.db.set(commitHash, commitData);

    this.HEAD = commitHash;
    this.redoStack = [];
    return commitHash;
  }

  private getContent(commitHash: Hash | null): string | null {
    if (!commitHash) return null;
    const commit = this.db.get(commitHash) as Commit;
    if (!commit) return null;
    const tree = this.db.get(commit.tree) as Tree;
    if (!tree) return null;
    const blobHash = tree[this.filename];
    if (!blobHash) return null;
    return this.db.get(blobHash) as GitBlob;
  }

  public getCurrentContent(): string | null {
    return this.getContent(this.HEAD);
  }

  public getDiff(commitHash1: Hash, commitHash2: Hash): DiffResult[] | null {
    const content1 = this.getContent(commitHash1);
    const content2 = this.getContent(commitHash2);

    if (content1 === null || content2 === null) {
      console.error('Could not find content for one or both commits.');
      return null;
    }

    return diff(content1, content2);
  }

  public log() {
    console.log('--- Commit History ---');
    let currentHash = this.HEAD;
    while (currentHash) {
      const commit = this.db.get(currentHash) as Commit;
      if (!commit) break;
      const headMarker = currentHash === this.HEAD ? ' (HEAD)' : '';
      console.log(
        `- ${currentHash.substring(0, 12)}${headMarker}: ${commit.message}`
      );
      currentHash = commit.parent;
    }
    console.log('--------------------');
  }
}

// --- Step 3: Run the Demo Simulation ---

/**
 * Helper function to render the diff results to the console with highlighting.
 */
function renderDiff(changes: DiffResult[]) {
  changes.forEach((change) => {
    switch (change.type) {
      case 'added':
        console.log(`\x1b[32m+ ${change.line}\x1b[0m`); // Green text for additions
        break;
      case 'removed':
        console.log(`\x1b[31m- ${change.line}\x1b[0m`); // Red text for removals
        break;
      case 'unchanged':
        console.log(`  ${change.line}`);
        break;
      case 'modified':
        // Build the string for the old line view with removed characters highlighted
        const oldLine = change
          .charDiffs!.filter((cd) => cd.type !== 'added')
          .map((cd) =>
            cd.type === 'removed'
              ? `\x1b[41m\x1b[37m${cd.char}\x1b[0m` // Red background, white text
              : cd.char
          )
          .join('');

        // Build the string for the new line view with added characters highlighted
        const newLine = change
          .charDiffs!.filter((cd) => cd.type !== 'removed')
          .map((cd) =>
            cd.type === 'added'
              ? `\x1b[42m\x1b[37m${cd.char}\x1b[0m` // Green background, white text
              : cd.char
          )
          .join('');

        console.log(`- ${oldLine}`);
        console.log(`+ ${newLine}`);
        break;
    }
  });
}

/**
 * Renders a character-level diff in a "unified diff" style, showing
 * chunks of changes inline with the context of unchanged text.
 */
function renderUnifiedStyleDiff(changes: DiffResult[]) {
  console.log('--- Unified Diff Renderer ---');
  changes.forEach((change) => {
    if (change.type === 'modified' && change.charDiffs) {
      let unchangedChunk = '';
      let removedChunk = '';
      let addedChunk = '';

      const flushChanges = () => {
        if (unchangedChunk) {
          console.log(`  ${unchangedChunk}`);
          unchangedChunk = '';
        }
        if (removedChunk) {
          console.log(`\x1b[31m- ${removedChunk}\x1b[0m`);
          removedChunk = '';
        }
        if (addedChunk) {
          console.log(`\x1b[32m+ ${addedChunk}\x1b[0m`);
          addedChunk = '';
        }
      };

      for (const diff of change.charDiffs) {
        if (diff.type === 'unchanged') {
          // If we were in a change block, flush it first
          if (removedChunk || addedChunk) {
            flushChanges();
          }
          unchangedChunk += diff.char;
        } else if (diff.type === 'removed') {
          // If we were in an unchanged block, flush it
          if (unchangedChunk) {
            flushChanges();
          }
          removedChunk += diff.char;
        } else if (diff.type === 'added') {
          if (unchangedChunk) {
            flushChanges();
          }
          addedChunk += diff.char;
        }
      }
      // Flush any remaining chunks
      flushChanges();
    } else if (change.type !== 'unchanged') {
      console.log(`  Line ${change.type}: "${change.line}"`);
    }
  });
  console.log('--------------------------');
}

function runGitStyleDemo() {
  console.log('--- Git-like Version History Simulation: Typo Correction ---\n');
  const history = new VersionHistory('note.txt');

  // 1. Commit the text with typos
  const text1 = 'hwoa abut this?';
  console.log('Step 1: Committing initial text with typos');
  const commit1_hash = history.commit(text1, 'Initial commit');
  console.log(`Current Text: "${history.getCurrentContent()}"\n`);

  // 2. Commit the corrected text
  const text2 = 'how about this?';
  console.log('Step 2: Committing corrected text');
  const commit2_hash = history.commit(text2, 'Second commit with corrections');
  console.log(`Current Text: "${history.getCurrentContent()}"\n`);

  // 3. Show the diff as inline text
  console.log('Step 3: Diff Report (Inline View)');
  let changes = history.getDiff(commit1_hash, commit2_hash);
  if (changes) {
    renderDiff(changes);
  }
  console.log('-------------------\n');

  // 4. Show the diff as a tree
  console.log('Step 4: Diff Report (Unified Style)');
  if (changes) {
    renderUnifiedStyleDiff(changes);
  }
  console.log();

  // 5. Log the final history
  console.log('Final commit history:');
  history.log();
}

runGitStyleDemo();
