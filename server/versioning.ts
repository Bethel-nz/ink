// An implementation of a Git-like version control system for a single document.

type Hash = string;

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
export interface DiffResult {
  type: 'added' | 'removed' | 'unchanged' | 'modified';
  line: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  charDiffs?: CharDiff[];
  oldLine?: string;
  newLine?: string;
}

/**
 * Generates a character-by-character diff between two strings (lines).
 */
function generateCharacterDiff(line1: string, line2: string): CharDiff[] {
  const chars1 = line1.split('');
  const chars2 = line2.split('');
  const n = chars1.length;
  const m = chars2.length;
  const dp = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (chars1[i - 1] === chars2[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const result: CharDiff[] = [];
  let i = n,
    j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && chars1[i - 1] === chars2[j - 1]) {
      result.unshift({ char: chars1[i - 1]!, type: 'unchanged' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.unshift({ char: chars2[j - 1]!, type: 'added' });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      result.unshift({ char: chars1[i - 1]!, type: 'removed' });
      i--;
    } else {
      break; // End of diff.
    }
  }
  return result;
}

/**
 * A diffing function that provides detailed character diffs for OT.
 */
export function diff(text1: string, text2: string): DiffResult[] {
  if (text1 === text2) {
    return [];
  }

  const charDiffs = generateCharacterDiff(text1, text2);
  const results: DiffResult[] = [];

  // Convert character diffs to individual operations
  for (const charDiff of charDiffs) {
    switch (charDiff.type) {
      case 'unchanged':
        results.push({
          type: 'unchanged',
          line: charDiff.char,
        });
        break;
      case 'added':
        results.push({
          type: 'added',
          line: charDiff.char,
        });
        break;
      case 'removed':
        results.push({
          type: 'removed',
          line: charDiff.char,
        });
        break;
    }
  }

  return results;
}

export class VersionHistory {
  private db: Map<Hash, GitObject> = new Map();
  private HEAD: Hash | null = null;
  public readonly filename: string;

  constructor(filename: string = 'note.txt') {
    this.filename = filename;
  }

  public getHeadHash(): Hash | null {
    return this.HEAD;
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
    return commitHash;
  }

  public getContent(commitHash: Hash | null): string | null {
    if (!commitHash) return null;
    if (!this.db.has(commitHash)) return null;
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
