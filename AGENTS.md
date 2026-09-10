# Forge/foundry tests

- When running tests they should be run from the contracts/ subfolder.
- See package.json for the test commands.
- When testing for event emission, always check logs properly. Use either `vm.recordLogs` with explicit log assertions, or `vm.expectEmit` paired with an `emit Event(...)` expectation before the call under test.
- Do not use --via-ir when compiling contracts and tests. If there are Solidity stack too deep errors then fix them through code refactoring.
- When doing vm.prank and vm.expectRevert together for a call, always place the vm.expectRevert call before the vm.prank call.

### Test commands:

These are all to be run from within the contracts/ folder:

* `forge test` - run forge solidity tests
* `bun run test:hardhat` - run hardhat tests
* `bun run test:e2e` - run end-to-end tests

# Lint command:

Run this in the contracts/ folder:

* `bun run lint`

# Comment Guidelines

When writing comments in code:
- Comments should describe what the code does, not what changed
- Avoid hardcoded values in comments - describe the behavior conceptually
- Don't refer to specific variables or constants by name unless necessary
- Write comments as descriptors of functionality, not as a changelog

# Inline Documentation

All Solidity contracts, libraries, and interfaces must have NatSpec inline documentation. When making any code changes, inline docs MUST be kept updated alongside the code — adding, modifying, or removing documentation as needed to accurately reflect the current behavior.

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- when writing tests that involve constants already defined in the source (e.g contracts/src/registry/libraries/RegistryRolesLib.sol) use those defined constants directly instead of hardcoding their values in the tests.

# Upstream submodules

`contracts/lib/` holds submodules that track upstream repositories we do not own, such as
`ensdomains/ens-contracts`. **Never fix a migration-script or testnet-deployment problem by editing
one of them**, and never commit or push into one. That includes edits meant only to unblock a run:
they are invisible to everyone else, make the result irreproducible, and put a change into a shared
dependency that was never reviewed there.

When a deployment or migration fails inside upstream deploy scripts, the fix belongs on our side of
the boundary — in `contracts/script/`, in the tags and configuration we pass to the deploy, or in a
follow-up step our own driver performs. If no such fix exists, say so and report the upstream defect
rather than patching around it locally.

# Documentation

The `contracts/docs/` folder contains operational documentation for scripts and tools. When making changes to code that is covered by documentation in `contracts/docs/`, the corresponding documentation MUST be kept up-to-date alongside the code changes.
