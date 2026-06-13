# claude-trace

This is a drop-in replacement for claude, except it writes a log of all json requests+responses to the LLM into ~/claude-trace

Use it e.g. `claude-trace.ts --print "why is the sky blue?"` or just run it interactively `claude-trace.ts`

This requires bun to be installed on your machine.

Each session gets its own logfile. The logs are dual-use: they're interactive HTML pages so you can open them in a browser to explore, but inside they're really plain jsonl files so AIs can parse them. The logs are stored in an efficient "delta" format to save space -- most agents send a huge request containing the entire content of the previous request, plus a tiny extra query.

Credit to https://github.com/badlogic/lemmy/tree/main/apps/claude-trace who came up with the idea of intercepting 'fetch'.
