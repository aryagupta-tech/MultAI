# MultAI: submission kit

Copy from here into the Cerebral Valley form and the X post. The video files are in `~/Movies/MultAI-demo/`:
`MultAI-demo.mp4` (2:13, the submission) and `MultAI-teaser.mp4` (1:01, for X).

## Form

- **Project name:** MultAI
- **Track:** Indie Developer
- **Problem statement:** Build for Your World
- **Tagline:** One AI coding agent, shared by your whole team, in real time.
- **Demo video:** <YouTube link to MultAI-demo.mp4>
- **Repository:** https://github.com/aryagupta-tech/MultAI
- **Try it:** https://app.multai.si (browser companion) · Android APK: https://api.multai.si/app/android · macOS app: GitHub release

### Description

Every AI coding agent today is single-player. When you get stuck, bringing in a teammate means screenshots, copy-paste and explaining everything again. MultAI makes the agent itself shared: your teammate joins the live session from a browser (no install, no API key), gets a Muse Wonder catch-up brief, and directs the same agent you're using. The agent and the code stay on the host's computer, in a private git worktree of the real project, and every file change and command waits for the host's approval. Teammates' directions wait for the host too.

What's in the demo, all live, nothing mocked:

- **SAM 3.1, point at the problem:** click the broken element on a screenshot and SAM outlines its exact edges for the agent.
- **look_at_app:** the agent opens the app in a hidden browser, and SAM 3.1 marks the element it's checking with pixel boxes, so it verifies its own UI fix.
- **Team control:** Alex joins from a browser and asks for "integer cents, not floats". That request waits until the host runs it; Muse Spark fixes the totals and the tests pass.
- **/split:** parallel agents, each in its own git worktree, merged with git.
- **Model handoff:** switch models mid-chat and the new model inherits the conversation, the earlier steps and the changed files.
- **Android companion:** pair a phone with a one-time code and six matching digits, then send a prompt, start it and approve each step from the phone. Every phone request is signed and checked again by the desktop.
- **Muse Wonder pull request draft:** it credits who directed the agent ("Directed by: Arya Gupta and Alex").
- **Watch link:** a read-only, expiring replay of the whole session, viewable in any browser.

### How it uses Meta's models

| Model | Role in MultAI |
|---|---|
| Muse Spark 1.3 | The shared coding agent: tool calls, plans, file changes and commands, all approval-gated, plus parallel agents |
| Muse Wonder 1.0 | Catch-up briefs for newcomers and pull request drafts that credit who directed the agent |
| SAM 3.1 | Point at the problem on a screenshot; look_at_app outlines and numbers what the agent checks |
| Muse Spark (vision) | Reads the screenshots teammates paste and the pages the agent looks at |
| Muse Voice Transcribe | Spoken instructions in the composer |
| Muse Glimmer (open weights) | Runs locally through Ollama or LM Studio, so neither code nor model leaves the machine |

### Built with

Electron and React desktop app (macOS); a Fastify and PostgreSQL collaboration service on AWS Lightsail with Supabase; a Capacitor Android app and a browser companion. The whole repository was built during the hackathon, and its history is public.

## X post (for the Most Viral prize; attach MultAI-teaser.mp4)

> AI coding agents are single-player. So I built MultAI for the @Meta AI hackathon 🧑‍💻🤝🧑‍💻
>
> One coding agent your whole team shares, live:
> • a teammate joins from a browser, no install
> • SAM 3.1 sees the bug you point at, then checks the fix itself
> • parallel agents, model handoff
> • approve every step from your phone
>
> Built on Muse Spark, Muse Wonder and SAM 3.1.
> https://github.com/aryagupta-tech/MultAI

Then paste the X post link into the form's viral-prize field.

## Before you submit

- [ ] Upload `MultAI-demo.mp4` to YouTube (Unlisted or Public) and check the link plays while logged out.
- [ ] The repository is public.
- [ ] Everyone who contributed is listed.
- [ ] Submit before Wed Nov 4, 9:00 PM ET (Thu Nov 5, 7:30 AM IST).

## Credits

Narration: the author's own HeyGen voice. Music: "Digital Technology" by AtlasAudio (Pixabay Content License). The video was edited in code with Remotion; source in `demo/video/`.
