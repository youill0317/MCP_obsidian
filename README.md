# Markdown Explorer MCP Server

MCP (Model Context Protocol) server for markdown discovery, navigation, reading, and link analysis.

**Version**: 5.0.0

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Run

```bash
npm start
```

## Client Configuration (Claude Desktop)

Add this server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "markdown-explorer": {
      "command": "node",
      "args": [
        "C:\\Users\\user\\Documents\\Projects_src\\MCP\\MCP_Obsidian\\dist\\index.js"
      ]
    }
  }
}
```

## Canonical Workflow (Use This Order)

1. Discover candidate files with `search_markdown`.
2. Read known files with `read_markdown_full` or `read_markdown_section`.
3. Analyze relationships with `get_linked_files` or `get_backlinks`.
4. Use `get_directory_tree` / `list_directory` only for structural navigation.

## Tool Selection Matrix

| If your question is... | Use this tool | Avoid |
|---|---|---|
| "What files mention X?" | `search_markdown` | `read_markdown_full` as a search substitute |
| "Show folder structure" | `get_directory_tree` | `search_markdown` |
| "Show one folder level" | `list_directory` | `get_directory_tree` for shallow single-level checks |
| "Give me the whole file content" | `read_markdown_full` | `search_markdown` |
| "Give me only section H2/H3..." | `read_markdown_section` | `read_markdown_full` |
| "What links does this note contain?" | `get_linked_files` | `get_backlinks` |
| "Which notes link to this note?" | `get_backlinks` | `get_linked_files` |
| "Show document header outline" | `read_markdown_toc` | `read_markdown_full` for structure-only checks |

## Tools (8)

### Discovery and Navigation

| Tool | Purpose | Main Parameters |
|---|---|---|
| `search_markdown` | Unified discovery across filename, frontmatter tags, and content | `query`, `tag`, `filenamePattern`, `directory`, `maxResults`, `useRegex`, `fuzzy`, `frontmatterFilter`, `modifiedAfter`, `modifiedBefore` |
| `get_directory_tree` | Recursive tree overview (structure only) | `path`, `depth`, `markdownOnly`, `showHidden`, `respectGitignore` |
| `list_directory` | One-level listing with file sizes | `path`, `markdownOnly`, `showHidden`, `respectGitignore` |

### Reading and Link Analysis

| Tool | Purpose | Main Parameters |
|---|---|---|
| `read_markdown_full` | Read frontmatter + full body for known file path(s) | `path` or `paths[]` |
| `read_markdown_section` | Read one header section from a known file | `path`, `header`, `includeSubsections` |
| `read_markdown_toc` | Read document structure (headers only) | `path`, `maxLevel` |
| `get_linked_files` | Outgoing links from one note | `path`, `type`, `checkExists` |
| `get_backlinks` | Incoming links to one target note | `path`, `directory`, `maxResults`, `respectGitignore` |

## Resources (2)

| Resource | URI | Purpose |
|---|---|---|
| `vault-context` | `mcp://markdown-explorer-mcp/vault-context` | Base-dir summary, recent files, top tags, stats, workflow tips |
| `server-info` | `mcp://markdown-explorer-mcp/info` | Server metadata: version, tool list, resource list, usage model |

## Parameter Safety Rules (LLM-Safe)

0. All tool calls (JSON envelope)
- Send exactly one JSON object per tool call.
- Do not concatenate objects in one payload (`{...}{...}` is invalid JSON).
- Do not add prose, markdown fences, or trailing characters outside JSON.
- If parsing fails with `Unexpected non-whitespace character after JSON`, retry with only one JSON object.

1. `search_markdown`
- Always provide a non-empty `query`.
- Do not set `useRegex=true` and `fuzzy=true` together.
- Date filters must be ISO-like strings (`YYYY-MM-DD` recommended).
- Keep one search intent per call.

2. `read_markdown_full`
- Provide either `path` or `paths`, never both.
- `paths` cannot be empty and has a maximum length.
- This tool is for known paths only (not search).

3. `read_markdown_section`
- `path` is required.
- `header` must be non-empty.
- Use `includeSubsections=false` for strict single-section extraction.

4. `get_linked_files`
- `type` must be one of: `all`, `markdown`, `image`, `external`, `embed`.
- `checkExists=true` is slower (extra filesystem checks).

5. `get_backlinks`
- `path` should be a target file path (not directory).
- Limit scan scope with `directory` for performance.

## Good vs Bad Query Cookbook

### search_markdown

Good:
```json
{"query":"project roadmap","directory":"notes","maxResults":10}
```

Good:
```json
{"query":"release.*notes","useRegex":true,"directory":"docs"}
```

Good:
```json
{"query":"보험 시뮬레이션 노력 점수 할인 모델","directory":"Projects/DB 보험금융공모전","maxResults":10}
```

Bad:
```json
{"query":"release.*","useRegex":true,"fuzzy":true}
```
Reason: invalid combination (`useRegex` and `fuzzy` are mutually exclusive).

Bad:
```json
{"query":"보험 시뮬레이션 노력 점수 할인 모델","directory":"Projects/DB 보험금융공모전","maxResults":10}{"query":"보험 시뮬레이션 노력 점수 할인 모델","directory":"Projects/DB 보험금융공모전","maxResults":10}
```
Reason: two JSON objects are concatenated; one call must contain exactly one JSON object.

Bad:
```json
{"query":"project roadmap"}}
```
Reason: trailing non-whitespace character after the JSON object causes parser failure.

### read_markdown_full

Good:
```json
{"path":"README.md"}
```

Good:
```json
{"paths":["notes/todo.md","notes/plan.md"]}
```

Bad:
```json
{"path":"README.md","paths":["notes/a.md"]}
```
Reason: must provide either `path` or `paths`, not both.

### read_markdown_section

Good:
```json
{"path":"docs/guide.md","header":"Install","includeSubsections":false}
```

Bad:
```json
{"header":"Install"}
```
Reason: `path` is required.

### read_markdown_toc

Good:
```json
{"path":"README.md","maxLevel":3}
```

Bad:
```json
{"path":"README.md","maxLevel":10}
```
Reason: `maxLevel` must be 1..6.

### get_linked_files / get_backlinks

Good (outgoing links):
```json
{"path":"notes/project.md","type":"markdown","checkExists":true}
```

Good (incoming links):
```json
{"path":"notes/project.md","directory":"notes","maxResults":25}
```

Bad:
```json
{"query":"project"}
```
Reason: link tools do not support semantic query discovery.

### get_directory_tree / list_directory

Good:
```json
{"path":"docs","depth":2}
```

Bad:
```json
{"path":"README.md","depth":2}
```
Reason: `get_directory_tree` expects a directory path, not a file path.

## Error-Handling Playbook

1. `Error: Access denied ... outside BASE_DIRS`
- Fix: use a path under configured base directories.

2. `Error: Path not found`
- Fix: run `list_directory` or `get_directory_tree` to verify path spelling and location.

3. `Error: Not a markdown file`
- Fix: pass `.md`, `.mdx`, or `.markdown` files only to read/link tools.

4. `No results for "<query>"`
- Fix: broaden query, remove strict filters, or inspect structure first.

5. Too much output / token pressure
- Fix: lower `depth`, lower `maxResults`, use section-level reads, split into multiple calls.

6. `Unexpected non-whitespace character after JSON ...`
- Fix: resend exactly one valid JSON object, with no second object and no trailing text.

## Supported Markdown Extensions

- `.md`
- `.mdx`
- `.markdown`

## Development

```bash
# Watch mode
npm run dev
```
