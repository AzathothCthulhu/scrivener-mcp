# A Field of Crows: safe baseline

Inspected upstream 0.12.0, commit 598288bab4a83022e2680cbd5fa622d7aa23e2a3.
Fork: https://github.com/AzathothCthulhu/scrivener-mcp
Branch: field-of-crows/safe-baseline. Keep main unchanged; retain upstream remote,
package identity, parser and handler APIs, and AGPL-3.0-only license.

## Existing tool surface

The authoritative registry is src/handlers/skill-registry.ts. Two meta-tools
(list_skills, use_skill) progressively expose eight groups: project, documents,
search, analysis, compilation, memory, relationships, advanced. Eager exposure is
optional. Seven internal tools are hidden. TOOL_SURFACE.md records declarations
from the inspected source, including hidden tools; it is not a count of advertised tools.

Existing capabilities cover get_structure (nested Binder or flat tree, folderId,
maxDepth, trash), read_document, get_document_info (synopsis/notes/custom metadata),
search, find_mentions, read_annotations, snapshots, compilation settings and
statistics. Chapter/scene roles depend on the author's Binder arrangement; do not
infer them from titles alone. Analysis, generation, enhancement, memory, graph and
async tools exist upstream but are outside the initial allowed surface.

## Project format and write risks

The loader resolves a .scriv directory or its .scrivx XML file; document storage
uses Files/Data/<UUID>/content.rtf, synopsis.txt and notes.rtf. Binder hierarchy and
metadata live in XML; docs.checksum and native snapshots also matter. Upstream
targets Scrivener 3, including Windows; older layouts and all format variants are
not established as compatible by this inspection. RTF parsing and reserialization
can affect formatting; native fidelity-preserving splicing has fallback paths.

Opening upstream creates support directories, databases, indexes and context
files and may alter .gitignore. Close/refresh may flush state. RTF backups use a
per-document filename and can overwrite prior backups; XML backups are separate,
have retention cleanup, and failures can be logged rather than aborting. These are
not a whole-project transaction. Open-Scrivener detection permits writes when
detection is unavailable/ambiguous. Concurrent saves and cloud sync remain risks.

## Initial implementation plan

1. Default to an explicit read-tool allowlist at registry discovery and dispatch.
   Unknown/new tools fail closed. Keep mutations, exports, enhancement and jobs
   unavailable. An explicit environment opt-in restores upstream behavior for
   development; it is NOT a safe write mode.
2. Open a fresh isolated copy, rejecting symbolic links/junctions. All upstream
   support-file writes stay in the copy. Reopen the original path for a fresh saved
   view; refresh only rereads the copy. Retain copies for inspection (no cleanup).
3. Prepare author-entered scene records keyed by Binder UUID with evidence and
   uncertainty. Do not treat algorithmic pacing/style scores as editorial facts.
4. Before enabling explicit AI Notes tools: use a configured Research root UUID
   and dedicated AI Notes descendant UUID, verify ancestry outside Draft/Trash,
   reject aliases/links, serialize writes, detect external changes, require a
   closed project, and make a verified immutable full-project backup outside the
   project before each transaction. Backup failure must abort. Restore all changed
   files on failure, reload caches, retain recovery evidence, and test injected
   failures and denied targets. Do not expose generic create/move/delete/write tools.
5. Validate on synthetic projects and then a disposable copy of the user's actual
   Windows project before any live connection. No live project path is supplied.

## Scope and limitations

This baseline protects the original through copy isolation and tool gating, not
through a new parser or filesystem-wide sandbox. It does not provide live updates,
AI Notes writes, transactional backup/rollback, automatic story extraction, or
production certification. Copying a project while Scrivener or sync is modifying
it can yield an inconsistent read: use a closed, fully saved project. Copies may
contain private manuscript text and must be managed by the user. Upstream AI key
discovery/startup behavior remains; review that before configuring a client.

## Validation and next steps

TypeScript build and the tool-registry schema check passed. Focused Node tests
exercise denied mutations/unknown tools, discovery and direct-dispatch gating,
copy write isolation, external XML rejection and junction rejection. These do not
constitute a full Scrivener application round-trip or transactional-write test.
Dependencies were installed with lifecycle scripts disabled, so no client setup
was performed. npm reported 25 dependency vulnerabilities (7 moderate, 16 high,
2 critical); security triage remains before deployment. No dependency versions
were changed. The example client configuration is a template, not installed.

Remaining order: dependency/startup audit; read-only application round-trip on a
disposable Windows project; implement and fault-test backup/rollback; add only
explicit Research/AI Notes tools; then connect the user's saved project path and
confirmed Binder UUIDs. Tracking types are preparation, not a persistence API.
