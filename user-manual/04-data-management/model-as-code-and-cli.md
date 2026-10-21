# Model as code and the `d4` command line

The model can be written, reviewed and stored as a YAML (or JSON) document, then imported. This suits version control and bulk changes.

## The document

```yaml
apiVersion: d4/v1
kind: Model
elements:
  - { key: dp-client, type: DataProduct, name: Client Master, lifecycle: LIVE,
      attrs: { productType: SOURCE_ALIGNED, classification: RESTRICTED } }
relationships:
  - { type: HOLDS, from: store-mdm, to: dp-client, attrs: { role: MASTER } }
```

- Each element has a `key`; relationships refer to keys.
- An import is **idempotent** (matched by id, then external key, then type + name), **validated as a whole before anything is written**, and **never deletes**.
- A full example is [samples/ubs-banking.yaml](../../samples/ubs-banking.yaml).

## Command line

With the local stack, run via `deploy/dev.sh cli …` (paths relative to the repository root):

| Command | Purpose |
|---|---|
| `d4 validate <file> [--metamodel <file>]` | Check a document offline against the starter (or a given) metamodel |
| `d4 workspaces` | List the workspaces you can see |
| `d4 import <file> -w <workspace> [--dry-run]` | Import into a workspace by slug or id |
| `d4 export -w <workspace> [-o file] [--format …] [--as-of date] [--scenario id] [--scope ids --depth n]` | Export a workspace or neighbourhood |

Export formats: `yaml`, `json`, `elements-csv`, `relationships-csv`, `xlsx` (web/API only), `mermaid`, `archimate`, `cypher`.

```bash
deploy/dev.sh sample                                   # import the UBS sample into "default"
deploy/dev.sh cli validate samples/ubs-banking.yaml
deploy/dev.sh cli import my-model.yaml -w default --dry-run
deploy/dev.sh cli export -w default --format mermaid --as-of 2027-08-01 -o exports/default.mmd
```

For Git-hosted model files kept in sync automatically, use a Git [connector](connectors.md).
