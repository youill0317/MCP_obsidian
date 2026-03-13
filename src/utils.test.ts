import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { validatePathAgainstBaseDirs } from "./utils.js";

async function createTempDir(t: TestContext): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-obsidian-utils-"));
    t.after(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });
    return tempDir;
}

async function createDirectoryAlias(targetDir: string, aliasPath: string): Promise<void> {
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(targetDir, aliasPath, symlinkType);
}

test("rejects a dot-prefixed base directory itself", async (t) => {
    const tempDir = await createTempDir(t);
    const hiddenBaseDir = path.join(tempDir, ".obsidian");

    await fs.mkdir(hiddenBaseDir, { recursive: true });

    assert.equal(
        validatePathAgainstBaseDirs(".", [hiddenBaseDir], hiddenBaseDir),
        null
    );
});

test("rejects a visible alias that resolves into a dot-prefixed directory", async (t) => {
    const tempDir = await createTempDir(t);
    const hiddenDir = path.join(tempDir, ".git");
    const visibleAlias = path.join(tempDir, "visible");

    await fs.mkdir(hiddenDir, { recursive: true });
    await createDirectoryAlias(hiddenDir, visibleAlias);

    assert.equal(
        validatePathAgainstBaseDirs(visibleAlias, [tempDir], tempDir),
        null
    );
});

test("rejects a visible alias that escapes the configured base directory", async (t) => {
    const tempDir = await createTempDir(t);
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-obsidian-outside-"));
    const visibleAlias = path.join(tempDir, "escape");

    t.after(async () => {
        await fs.rm(outsideDir, { recursive: true, force: true });
    });

    await createDirectoryAlias(outsideDir, visibleAlias);

    assert.equal(
        validatePathAgainstBaseDirs(path.join(visibleAlias, "note.md"), [tempDir], tempDir),
        null
    );
});

test("allows regular directories inside the configured base directory", async (t) => {
    const tempDir = await createTempDir(t);
    const notesDir = path.join(tempDir, "notes");

    await fs.mkdir(notesDir, { recursive: true });

    assert.equal(
        validatePathAgainstBaseDirs(notesDir, [tempDir], tempDir),
        path.resolve(notesDir)
    );
});

test("keeps dot-prefixed markdown files accessible", async (t) => {
    const tempDir = await createTempDir(t);
    const hiddenMarkdownFile = path.join(tempDir, ".note.md");

    await fs.writeFile(hiddenMarkdownFile, "# hidden note\n");

    assert.equal(
        validatePathAgainstBaseDirs(hiddenMarkdownFile, [tempDir], tempDir),
        path.resolve(hiddenMarkdownFile)
    );
});
