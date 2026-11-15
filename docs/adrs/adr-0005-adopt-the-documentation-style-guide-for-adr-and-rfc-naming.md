# Architectural decision record (ADR) 0005: Adopt the documentation style guide for ADR and RFC naming

## Status

Accepted on 2026-11-14: Apply the imported documentation style guide to ADR and
RFC naming; preserve accepted decisions when migrating their metadata.

## Date

2026-11-14.

## Context and problem statement

The repository's decision records predate the imported documentation style
guide. Their filenames, displayed identifiers and titles do not consistently
follow its naming convention. No RFC records existed in `docs/` at adoption.
Renaming ADRs without preserving their old metadata would make historical
references harder to interpret and could make a formatting migration look like
a change to an accepted decision.

## Decision drivers

- Use one current naming convention for new ADRs and RFCs.
- Keep ADR and RFC serial numbers independent and stable after publication.
- Preserve each accepted decision's original title, identifier and path in its
  history when normalizing metadata.

## Decision outcome

Adopt the naming conventions in
[`docs/documentation-style-guide.md`](../documentation-style-guide.md) for all
ADRs and RFCs in this repository. Keep the serial numbers already allocated to
the four accepted ADRs; render them as four-digit identifiers and use the
guide's title-derived filenames. RFCs use their own four-digit sequence.

Treat the existing ADR filename, identifier and title changes as metadata
amendments. Preserve their decision text, record each old and new identifier,
title and path in the record's `## Amendments` section, and add this ADR to the
record's Status section. Future targeted corrections to accepted ADRs follow
the amendment process in the style guide.

## Consequences

- Existing ADR links use the canonical `docs/adrs/adr-nnnn-title-slug.md`
  paths.
- Future ADR and RFC records follow the guide's independent numbering schemes.
- Renaming or correcting an accepted decision's metadata does not change its
  decision outcome; the old metadata remains recorded in `## Amendments`.

## References

- [Documentation style guide](../documentation-style-guide.md)
