# LawyerCord code review

Read [AGENTS.md](../AGENTS.md) for the repository's coding, plugin, lifecycle, and release rules. Apply those rules to the changed code and its callers.

Review correctness, security, cleanup, and compatibility first. Prefer deleting unnecessary code, then simplifying what remains. Leave sound code alone.

- Report concrete failures with the trigger, affected behavior, and relevant source location.
- Trace types, callers, and existing utilities before recommending a change.
- Check that tests exercise the claimed behavior. Distinguish source checks from live verification.
- Assess severity by the effect on users. Style preferences are not security findings.
- Review all changes regardless of how they were written. Do not speculate about authorship.
- Use concise, natural language and avoid repeating findings.
