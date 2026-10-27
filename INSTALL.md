# Install stale-config (steps for an agent)

You are installing a Claude Code plugin for the user. Run each step in a shell, check
its result, and stop and tell the user if a check fails. Do not edit any settings file
by hand.

1. Check the tools:
   - `claude --version` prints 2.1.292 or newer. If it is older, use step 2b.
   - `python3 --version` prints Python 3. The hook is stdlib Python and needs nothing else.
2. Install the plugin:
   - a. Claude Code 2.1.292 or newer:
     `claude plugin install stale-config --marketplace darrentmorgan/claude-stale-config`
   - b. Older versions:
     `claude plugin marketplace add darrentmorgan/claude-stale-config`, then
     `claude plugin install stale-config@stale-config`
   The install prints `Successfully installed plugin: stale-config@stale-config`.
3. Check it: `claude plugin list` shows `stale-config@stale-config` with status enabled.
4. Tell the user, in one or two lines:
   - It works in sessions started from now on. A session that was open before the
     install never runs the hook, so restart those once.
   - There is nothing to configure. When config that a running session can't reload
     changes on disk, a "Stale session" bar comes up above the prompt with the fix,
     and the next prompt shows one "Stale config" line too.

To remove it: `claude plugin uninstall stale-config@stale-config`.
