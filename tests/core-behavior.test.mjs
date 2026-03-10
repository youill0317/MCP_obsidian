import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { searchMarkdownFiles } from '../dist/core/markdown-search.js';

function createHeadingNormalizer(input) {
  return input
    .replace(/^#+\s*/, '')
    .replace(/\s+#+\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

test('searchMarkdownFiles reports sampled/full mode and can find tail content with full mode', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-obsidian-search-'));
  const filePath = path.join(tmpDir, 'long-note.md');
  const content = `${'intro line\n'.repeat(3000)}\nTAIL_ONLY_TOKEN\n`;
  await fs.writeFile(filePath, content, 'utf8');

  const sampled = await searchMarkdownFiles({
    rootDir: tmpDir,
    query: 'TAIL_ONLY_TOKEN',
    readFullContent: false,
    maxResults: 5,
  });
  assert.equal(sampled.contentScannedMode, 'sampled');

  const full = await searchMarkdownFiles({
    rootDir: tmpDir,
    query: 'TAIL_ONLY_TOKEN',
    readFullContent: true,
    maxResults: 5,
  });
  assert.equal(full.contentScannedMode, 'full');
  assert.ok(full.results.length >= 1);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('heading normalization handles trailing hashes and spacing', () => {
  const a = createHeadingNormalizer('##  My Heading   ##');
  const b = createHeadingNormalizer('My   Heading');
  assert.equal(a, b);
});
