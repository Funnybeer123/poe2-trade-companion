# Item Intelligence Provenance

## Authorized source

The item-intelligence and scanner integration uses the following repository as
a behavioral and implementation reference:

- Repository: `Funnybeer123/Poe2StashRegexWeb`
- Revision: `f64652366c3377a1d26f2b09da4c56b1734ec1a2`
- Revision date: 2026-06-04
- Authorization: the repository owner explicitly authorized direct reuse for
  this project on 2026-08-26.

The source repository did not contain a license file at the pinned revision.
This authorization applies to repository-owned code only. It must not be
represented as an MIT or other open-source grant unless the source repository
later publishes that license.

## Reuse policy

The Electron application ports useful behavior into typed TypeScript modules.
It does not embed or distribute the ASP.NET Razor application, WinForms control
panel, AutoHotkey scripts, or Python utilities.

Ported or conformance-tested concepts include:

- clipboard item parsing and ordered modifier sections;
- compact stash-search query generation;
- AND/OR scan rules, range terms, and resistance helpers;
- normal, quad, and inventory grid geometry;
- scan-session and legacy JSONL contracts;
- deterministic left-pack planning.

Known defects in the pinned source are intentionally not preserved. Regression
fixtures document corrected behavior for header blocks, OR-group boundaries,
numeric ranges, query-length handling, stale clipboard reads, and session
lifecycle recovery.

## Third-party data

`Data/poe2wiki_mod_corpus.txt` and captured wiki HTML in the source repository
were derived from community wiki content with separate attribution and
share-alike considerations. They are not implicitly covered by the owner's
code authorization.

Do not copy or package that corpus until its exact source pages, revisions, and
license obligations have been recorded. Runtime collision checks must use
project-owned fixtures or an approved, versioned corpus with a provenance
manifest and generation timestamp.

## External-service boundary

The pinned source fetched Mobalytics pages and undocumented Path of Exile
Trade2 endpoints. This integration does not carry those fetches forward.
User-supplied links, inline query data, exported JSON, and local history files
may be parsed without network access. Automated providers require a documented
public API or explicit authorization from the service owner.
