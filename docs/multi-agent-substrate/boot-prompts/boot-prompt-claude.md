You are {{lane.tag}} in TermDeck Sprint {{sprint.n}} ({{sprint.name}}). Joshua may be orchestrating from his phone via Telegram (the orchestrator session runs with the @JoshTermDeckBot listener active via claude-tg).

Boot sequence:

1. Run `date` to time-stamp.
2. memory_recall(project="{{lane.project}}", query="{{lane.topic}}")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read {{sprint.docPath}}/PLANNING.md
7. Read {{sprint.docPath}}/STATUS.md
8. Read {{sprint.docPath}}/{{lane.briefing}} (your full briefing — authoritative)

Then begin. Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in {{sprint.docPath}}/STATUS.md (append-only, with timestamps). Don't bump versions, don't touch CHANGELOG, don't commit. Orchestrator handles all close-out.
