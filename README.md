# Markdown Explorer MCP Server

마크다운 파일 탐색 및 분석을 위한 MCP (Model Context Protocol) 서버입니다.

**버전**: 4.0.0

## 설치

```bash
npm install
```

## 빌드

```bash
npm run build
```

## 실행

```bash
npm start
```

## 클라이언트 설정

### Claude Desktop

`claude_desktop_config.json`에 추가:

```json
{
  "mcpServers": {
    "markdown-explorer": {
      "command": "node",
      "args": ["c:\\Users\\user\\Documents\\Projects_src\\My_mcp\\dist\\index.js"]
    }
  }
}
```

## 제공 도구 (8개)

### 탐색 및 검색

| 도구명 | 설명 | 주요 파라미터 |
|--------|------|---------------|
| `list_directory` | 디렉토리 내용 조회 | `path` |
| `get_directory_tree` | 트리 구조로 표시 | `path`, `markdownOnly`, `depth` |
| `search_markdown_files` | 마크다운 파일 검색 (태그/속성 필터) | `directory`, `pattern`, `tag`, `property`, `value` |
| `search_text_in_markdown` | 마크다운 내 텍스트 검색 | `directory`, `query`, `contextBefore`, `contextAfter` |

### 내용 이해

| 도구명 | 설명 | 주요 파라미터 |
|--------|------|---------------|
| `read_markdown_toc` | 목차(TOC) 추출 | `path`, `maxLevel` |
| `read_markdown_section` | 특정 섹션만 읽기 | `path`, `header`, `includeSubsections` |
| `read_markdown_full` | 전체 읽기 (메타데이터 포함) | `path` 또는 `paths[]` |
| `get_linked_files` | 링크 추출 및 존재 확인 | `path`, `type`, `checkExists` |

## 사용 예시

### 마크다운 파일만 트리로 보기
```
get_directory_tree로 노트 폴더를 마크다운 파일만 보여줘
```

### 태그로 파일 검색
```
search_markdown_files로 tags에 "project"가 있는 파일 찾아줘
```

### 목차 확인 후 섹션 읽기
```
read_markdown_toc로 README.md 구조를 보여줘
read_markdown_section으로 "설치" 섹션만 읽어줘
```

### 여러 파일 한 번에 읽기
```
read_markdown_full로 note1.md, note2.md, note3.md를 읽어줘
```

### 링크된 파일 존재 확인
```
get_linked_files로 이 문서의 링크들이 실제로 존재하는지 확인해줘
```

## 주요 기능

- **프론트매터 지원**: YAML 메타데이터 파싱 및 태그 검색
- **목차 추출**: 헤더 기반 문서 구조 파악
- **섹션별 읽기**: 토큰 절약을 위한 부분 읽기
- **링크 분석**: 위키 링크, 이미지, 임베드 추출 및 존재 확인
- **복수 파일 읽기**: 연관 문서 일괄 조회
- **gitignore 존중**: 불필요한 파일 자동 제외

## 지원 마크다운 확장자

- `.md`
- `.mdx`
- `.markdown`

## 개발

```bash
# 개발 모드 (파일 변경 시 자동 빌드)
npm run dev
```
