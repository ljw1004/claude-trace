# Goal: claude-trace, to log the raw JSON requests+responses to the LLM

This app runs claude with a "BUN_OPTIONS=preload" which installs a 'fetch' interceptor. The interceptor logs all LLM requests and responses to a transcript in ~/claude-trace/. The logs are in an efficient "delta" format since most subsequent requests are made from the previous request plus a tiny number of additions. The logs are in jsonl format, but with an html preamble to make them interactively viewable in a browser.

## Working in this codebase

- `bun install` to fetch packages
- Static checks: `bun run typecheck` and `bun run lint`
- No dynamic checks. Just run it with `./claude-trace.ts`
- Rendered DOM: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --dump-dom file://$PWD/example.html`
- Screenshot: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --window-size=1400,2200 --screenshot=/tmp/claude-trace.png file://$PWD/example.html`
- In VSCode install the `eslint` extension

## Running claude

You will often need to test claude or the SDK. There are two ways to run Claude

**Corporate**. Here, `/usr/local/bin/claude` is a corporate wrapper that gets automatically provisioned onto the machine, once every few hours. You run it and it sets some environment variables. Then it launches a blessed version of the underlying native binary /usr/local/bin/claude_code/claude (although this one prints a custom banner so maybe it's not the vanilla native binary?). The combination of the wrapper and `/Library/Application Support/ClaudeCode/managed-settings.json` is enough to fetch appropriate credentials to send LLM requests to a corporate proxy.

You can also do `CLAUDE_CODE_VERSION_OVERRIDE=latest /usr/local/bin/claude "$@"`. On some machines (although maybe not this one?) the launcher respects this by fetching the latest native binary.

**Personal**. If you download the native binary, and remove the managed-settings.json, the you can run normal native binary. The user has to `/login` to provide it with personal credentials. I've heard it stores them in the MacOS keychain. Just watch out because managed-settings.json gets reprovisioned every few hours. If present, you'll see an error because managed-settings.json makes it obtain a key that it can't without the launcher.

We will use the personal form for this project. If it's not working (e.g. if managed-settings.json has been re-provisioned), then stop and ask the user to sort things out.

If `which claude` points to `/Users/ljw/.local/bin/claude` then it's picking up the native binary, not the corporate wrapper.


## Code style

This project is a Bun-first TypeScript script. Prefer the simplest readable Bun idiom when it is good enough for the current phase:

- Keep early phase code script-like and top-to-bottom. A single visible `main()` flow is preferred over many small helper functions unless a helper removes real repetition or isolates tricky behavior.
- Use Bun conveniences where they make the code shorter and clearer, such as `Bun.file(path).arrayBuffer()`, `Bun.file(path).exists()`, `Bun.hash(...)`, `Bun.spawn(...)`, and top-level `await`.
- Do not prematurely turn local values into formal result objects or interfaces. Add types where they clarify contracts that are shared or non-obvious.
- Add robustness where it supports an actual validation gate, not just because a more general utility would be possible. For example, checking whether a directory exists should handle the first-run missing-directory case, but a full reusable filesystem abstraction is unnecessary.
- Prefer small inline control flow over functional contortions for async work. For example, use a `for...of` loop to find the first item matching an async predicate.
- Keep output human-readable while the project is still a proof of concept. Structured JSON output is useful only when another tool is expected to consume it.
- When a Bun convenience has an important semantic boundary, write the direct code plus the smallest needed guard. Examples: `Bun.file(path).exists()` is for files, not directories; `Bun.hash(...)` is a compact non-cryptographic hash, not SHA-256.
