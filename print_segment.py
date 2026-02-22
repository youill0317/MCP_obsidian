from pathlib import Path
lines = Path('src/tools/linked-files.ts').read_text(encoding='utf-8').splitlines()
for i in range(190, 211):
    print(f'{i+1}:{lines[i]}')
