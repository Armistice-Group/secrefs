# secrefs (Python)

Python SDK/CLI parity with `@secrefs/node`. See the repo root README for the
full `sec://` reference spec and provider list.

## Install

```bash
pip install secrefs
# or, in this monorepo:
poetry install
```

## Library usage

```python
import asyncio
import os
from secrefs import sec_refs

async def main():
    await sec_refs.init()  # expands sec:// values in os.environ, in place
    print(os.environ["DB_PASSWORD"])

asyncio.run(main())
```

## CLI usage

```bash
secrefs-py run -- python app.py
secrefs-py check
```
