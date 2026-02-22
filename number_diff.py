from pathlib import Path
for i,line in enumerate(Path('diff_index.txt').read_text(encoding='utf-8-sig').splitlines(),1):
    print(f'{i}:{line}')
