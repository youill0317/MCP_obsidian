# Markdown Explorer MCP Server

MCP (Model Context Protocol) server for exploring and analyzing markdown files.

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

## Client Configuration

### Claude Desktop

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

## Tools (8)

### Discovery and Navigation

| Tool | Description | Main Parameters |
|------|-------------|-----------------|
| `get_directory_tree` | Show folder structure as a tree | `path`, `depth`, `markdownOnly`, `showHidden`, `respectGitignore` |
| `list_directory` | List one directory level | `path`, `markdownOnly`, `showHidden`, `respectGitignore` |
| `search_markdown` | Unified search across filename, tags, and content | `query`, `tag`, `filenamePattern`, `directory`, `useRegex`, `fuzzy`, `frontmatterFilter` |

### Reading and Link Analysis

| Tool | Description | Main Parameters |
|------|-------------|-----------------|
| `read_markdown_toc` | Extract markdown table of contents from headers | `path`, `maxLevel` |
| `read_markdown_section` | Read one section under a header | `path`, `header`, `includeSubsections` |
| `read_markdown_full` | Read full markdown (frontmatter + body) | `path` or `paths[]` |
| `get_linked_files` | Extract markdown/image/external/embed links | `path`, `type`, `checkExists` |
| `get_backlinks` | Find files that link to a target file | `path`, `directory`, `maxResults`, `respectGitignore` |

## Resources (2)

| Resource | URI | Description |
|----------|-----|-------------|
| `vault-context` | `mcp://markdown-explorer-mcp/vault-context` | Vault summary (structure, recent files, tags, stats, tips) |
| `server-info` | `mcp://markdown-explorer-mcp/info` | Server metadata (version, tools, resources, capabilities) |

## Usage Examples

### Explore vault structure

```text
get_directory_tree with {"path": ".", "depth": 2}
```

### Find notes with one query

```text
search_markdown with {"query": "project", "tag": "work"}
```

### Read section by header

```text
read_markdown_section with {"path": "README.md", "header": "Install"}
```

### Read multiple files in one call

```text
read_markdown_full with {"paths": ["note1.md", "note2.md"]}
```

### Inspect links in a note

```text
get_linked_files with {"path": "README.md", "checkExists": true}
```

### Recommended workflow

```text
1) search_markdown -> discover file paths
2) read_markdown_full/read_markdown_section -> read specific files by path
```

## Supported Markdown Extensions

- `.md`
- `.mdx`
- `.markdown`

## Development

```bash
# Watch mode
npm run dev
```
