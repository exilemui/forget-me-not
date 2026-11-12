# forget-me-not (勿忘我)

A "human-forgetting" memory plugin for DeepSeek Harness agents.

It does not try to remember everything — instead it **forgets in a disciplined way**. Like a human, it distills experience into impressions, lets them fade over time, and eventually forgets them entirely. At the same time, it keeps a "notebook" for the things truly worth remembering long-term.

**New in v2.0**: a DSH sidebar entry (forget-me-not flower icon + settings page), Chinese/English switching, lightweight/full embedding model selection, and "exchange names" (I'm called "念" / Nian, and I'll ask what to call you).

> 中文：[README.md](./README.md)

---

## Design Philosophy

Human memory has two sides:

- **Forgetting is the main theme**: impressions of each event fade over time — at first you remember a lot, then only the rough outline, then just one sentence or a few words, and finally nothing. Forgetting is not a defect; it is a good solution to the problem of "limited brain capacity". For an agent, that maps to a **bounded context window**.
- **Memory and cognition interact**: experience shapes cognition; cognition acts like a filter, turning every objective fact into an "impression / evaluation". An impression is not the full picture, nor necessarily the truth — it is only "what I think is right and worth remembering".

forget-me-not turns these two ideas into engineering:

1. **Each session = one memory cycle = one memory file**, extracting impressions in chronological order.
2. **Impressions of events**: like a human recalling an event — who (subject), with/about whom (object), what was actually done, how it went, how it felt, and the vivid details worth keeping (a scene, a sentence, a small thing) — **not just a list of lessons**.
3. **Forgetting = 8 rounds of "impression processing"** (each round is an LLM summarization rewrite, not mechanical truncation), keeping the most vivid scene / sentence / feeling first, shrinking each round, and deleting the file entirely after round 8.
4. **Notebook**: a few chosen words/sentences kept long-term, exempt from forgetting, without greed.
5. **Recall (唤起)**: each processing round generates a few indexes; a new session does local vector semantic retrieval against old indexes, and on a hit writes the old impression + the new insight back into the current session's memory file.
6. **Anti-path-dependence**: recalled old experience is only "reference", never dogma — for growth, not standing still.
7. **Anti-context-pollution**: vector similarity ≠ contextual relevance. Recall is two-layered — first local vector retrieval produces candidates, then an LLM "relevance judge" filters out candidates that are "off-topic" for the current intent, so finished work tasks or unrelated small talk don't get dragged into a new conversation.

---

## Forgetting Model

| Round | Keeps of previous | Notes |
|-------|-------------------|-------|
| Round 1 (initial) | 100% | Extract what's worth remembering, even fine details |
| Round 2 | ~85% | Drop more details |
| Round 3 | ~80% | |
| Round 4 | ~70% | |
| Rounds 5–8 | ~60% each | Progressive compression |
| After round 8 | **Forgotten entirely** | Memory file deleted |

Triggers:

- **Manual**: call the `decay` tool anytime to advance the forgetting clock.
- **Automatic (lifeline)**: when a session's context budget is exhausted and it is rebuilt via compaction (`agent/created` with `source === 'compact'`), automatically advance the previous session one forgetting round — distilling before "death".

> Ratios are "targets / ceilings", not hard truncation: in late rounds, if the content is already tiny, it is kept as-is rather than forced down to 60%.

---

## Installation

### Method 1: local directory (dev / trial)

1. Clone this repo, and in DeepSeek Harness use `plugin_manager` → `install_bundle` on this directory (a local-directory install is a **link** and does **not** auto-install dependencies).
2. Install dependencies once inside this directory:

   ```bash
   pnpm install --node-linker=hoisted
   ```

   This installs `@xenova/transformers` (the local embedding runtime) into `node_modules/` and builds `sharp` automatically (`package.json` declares `pnpm.onlyBuiltDependencies: ["sharp"]`).

3. On the first `recall` call, the embedding model (default multilingual, ~118MB) is downloaded once and cached locally under `~/.forgetme/models/`; from then on all inference is local. You can switch to the lightweight English model (~23MB) in settings.

### Method 2: npm release (later)

Once published to npm, `plugin_manager install_bundle` installs the package directly with dependencies auto-installed — no manual `pnpm install`.

> Requires Node 18+.

---

## Tools

| Tool | Purpose |
|------|---------|
| `remember` | Initial processing: write an impression of the current session (pass `text`, or auto LLM summary) |
| `decay` | Advance the forgetting clock: seal the current session + advance every old memory one round |
| `recall` | Recall: retrieve old memories by query (with relevance judging), write hits back to the current session's memory file |
| `notebook_add` | Add a line to the notebook (long-term, never forgotten) |
| `memory_list` | List all memories (round / category / preview) + the notebook |

---

## Configuration

All fields are editable in the DeepSeek Harness plugin settings UI (sidebar "forget-me-not" settings page), provided by the `Config` schema:

| Key | Default | Description |
|-----|---------|-------------|
| `storeDir` | `~/.forgetme/rememberme` | Memory storage directory (memory data is private; keep it out of Git) |
| `maxCycles` | `8` | Max forgetting rounds; beyond this the file is deleted |
| `decayRatios` | `[0.85, 0.8, 0.7, 0.6, 0.6, 0.6, 0.6]` | Retention ratios for rounds 2–8 |
| `categories` | `['工作','学习','聊天','情感','通用']` | Initial categories; add/remove as needed |
| `embedModel` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Local embedding model: multilingual (~118MB, default) or lightweight English `Xenova/all-MiniLM-L6-v2` (~23MB); switching auto-downloads on next recall |
| `hfRemoteHost` | `https://hf-mirror.com` | Model download source (mirror when huggingface.co is blocked) |
| `indexCount` | `4` | Max indexes generated per processing round |
| `recallTopK` | `3` | Max old memories returned by recall |
| `recallMinScore` | `0.5` | Recall similarity threshold (0–1) |
| `recallJudge` | `true` | Relevance judge: after recall, run an LLM pass to filter "off-topic" candidates |
| `selfName` | `念` | My name: the agent's self-identity in the plugin (I tell people my name and ask what to call them) |
| `language` | `zh` | Host prompt language: `zh` / `en` |

---

## Storage Layout

```
~/.forgetme/
├── rememberme/
│   ├── index.json        # forgetting clock + index of all memories (round/category/time)
│   ├── notebook.json     # notebook (long-term, never forgotten)
│   └── memories/
│       └── <sessionId>.json   # one memory file per session
└── models/               # local embedding model cache (downloaded on first recall)
```

---

## Notes

- **sharp native library**: `@xenova/transformers` depends on `sharp` (only used for image models; this plugin only does text embedding and does not need it). pnpm skips build scripts by default, but `package.json` declares `pnpm.onlyBuiltDependencies: ["sharp"]`, so `pnpm install` builds sharp automatically. If the sharp build fails, text recall falls back to character 2-gram overlap matching (it won't crash, only semantic precision drops).
- **Model download**: the first `recall` downloads the embedding model (default ~118MB), then caches it locally under `~/.forgetme/models/` — all inference is local, and your data never leaves the machine. If huggingface.co is unreachable, it falls back to the `hf-mirror.com` mirror (configurable via `hfRemoteHost`).
- **Reasoning-model budget**: summarization / indexing / judging via `llm.stream` automatically lowers `reasoningEffort` to the model's lowest advertised tier (excluding `off`), so DeepSeek reasoning models don't burn the whole `maxTokens` budget on thinking and produce empty text.

---

## Repository Layout

```
forget-me-not/
├── index.js          # plugin core (forgetting clock / impression processing / storage / recall / relevance judge / tools)
├── client.js         # client (sidebar forget-me-not flower icon + settings page)
├── cordis.patch.yml  # Cordis patch (declares the bundle)
├── package.json      # bundle metadata + deps + pnpm build whitelist
├── locale/
│   ├── en.json
│   └── zh.json
├── icon.svg          # forget-me-not flower icon
├── DESIGN.md         # design document
├── README.md         # this file (Chinese)
└── README.en.md      # English version
```

---

## Future Work

- [ ] **Impressions of people (personae)**: a separate file for a user profile, built slowly from sparse to rich, and updated/replaced as the person grows.
- [ ] **Self-portrait**: represent "who I am" with a "behavior history + vector" rather than rigid adjective labels.
- [ ] Stronger "cognitive filter" for impression processing: strip tool-call XML, system prompts and other noise so summaries focus on the conversation itself.
- [ ] Task-state markers: record "done / in-progress" tasks; completed ones don't participate in vector recall by default (further reducing context pollution).

---

## License

MIT
