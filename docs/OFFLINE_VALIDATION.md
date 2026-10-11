# Offline Windows project validation

The first real-project check used an isolated copy and no server startup, AI calls,
database initialization or project writes. A full external backup and SHA-256
manifest were created locally; manuscript paths and content are not committed.
All 269 source file hashes matched the isolated copy and backup and remained
unchanged after validation. The loader traversed 157 non-trash Binder documents;
91 text bodies parsed successfully. A local literal search found Morrigan variants
in 12 readable bodies. This is not validation of the MCP intelligent search path.

36 Text entries failed body reads because their content.rtf files were absent.
An inspected example had notes.rtf only. Missing bodies may represent intentional
undrafted documents; do not diagnose corruption or materialize empty files without
further evidence. The existing reader throws for these entries. Synopsis/notes are
read during Binder construction, but application-level correctness is not yet
verified. Scrivener's XML Version 2.0 field is not the application's major version.

Next: explicitly represent body absence in read responses; test synopsis/notes and
search with synthetic fixtures; audit server startup/key discovery and optional
service initialization; run full MCP checks offline. Verified backup creation is
not automatic pre-write backup or transactional rollback. Writes remain disabled.

Reproduce after build with:

    node scripts/validate-read-copy.mjs "<project.scriv>" "<external backup folder>"

Use a saved, closed project. The command retains private copies and reports and
fails on source changes, links, backup mismatches or body-read failures. It does
not restore or delete anything. The caller must manage retained copies.
