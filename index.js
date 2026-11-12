import os from 'node:os';
import path from 'node:path';
import nodeFs from 'node:fs';
import z from '@deepseek-ai/schemastery';

// 本插件硬依赖的服务（缺失则不激活）。
export const inject = ['sessions', 'llm', 'tools'];

// 可调默认值；Config schema 让它们能在 cordis.patch.yml / UI 里改。
const DEFAULTS = {
  // '' 表示用 ~/.forgetme/rememberme
  storeDir: '',
  // 遗忘轮数上限：第 8 轮后彻底遗忘（删除文件）
  maxCycles: 8,
  // 第 2..8 轮各自保留上一轮内容的比例（第 1 轮=初加工，100%）
  decayRatios: [0.85, 0.8, 0.7, 0.6, 0.6, 0.6, 0.6],
  // 初步分类（后续实际使用再增删）
  categories: ['工作', '学习', '聊天', '情感', '通用'],
  // 召回：本地向量模型（首次使用按需下载并缓存到 <storeDir>/../models）
  embedModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  // 模型下载源：huggingface.co 在部分网络不可达，默认走 hf-mirror.com 镜像
  hfRemoteHost: 'https://hf-mirror.com',
  indexCount: 4, // 每次加工生成的索引数上限
  recallTopK: 3, // 召回返回的最大旧记忆条数
  recallMinScore: 0.5, // 召回相似度阈值（0~1）
  recallJudge: true, // 相关度裁判：召回后加一道 LLM 判断过滤「跑题」候选
  selfName: '念', // 我的名字：这个智能体在插件里的自我认同
  language: 'zh', // 宿主提示与摘要提示使用的语言：zh | en
  // 自我画像：行为史遗忘轮数上限（比对事的 8 轮更慢，"我是谁"比"我经历过什么"更持久）
  selfMaxCycles: 12,
};

// Config schema：与 DEFAULTS 对齐，供 Loader 校验 + UI 配置。数值旋钮都补了边界，
// 防止 cordis.patch.yml 手滑写出非法值（例如 recallMinScore: 5 会污染余弦相似度比较）。
export const Config = z.object({
  storeDir: z.string().default(''),
  maxCycles: z.number().step(1).min(1).max(64).default(8),
  decayRatios: z.array(z.number().min(0.1).max(1)).default([0.85, 0.8, 0.7, 0.6, 0.6, 0.6, 0.6]),
  categories: z.array(z.string()).default(['工作', '学习', '聊天', '情感', '通用']),
  // 轻量（英文，~23MB，下载快）vs 完全（多语言中英文，~118MB，质量高）。切换后下次召回会自动下载新模型。
  embedModel: z.union([z.const('Xenova/all-MiniLM-L6-v2'), z.const('Xenova/paraphrase-multilingual-MiniLM-L12-v2')]).default('Xenova/paraphrase-multilingual-MiniLM-L12-v2'),
  hfRemoteHost: z.string().default('https://hf-mirror.com'),
  indexCount: z.number().step(1).min(1).max(20).default(4),
  recallTopK: z.number().step(1).min(1).max(20).default(3),
  recallMinScore: z.number().min(0).max(1).default(0.5),
  recallJudge: z.boolean().default(true),
  selfName: z.string().default('念'),
  language: z.union([z.const('zh'), z.const('en')]).default('zh'),
  selfMaxCycles: z.number().step(1).min(4).max(64).default(12),
});

function resolveStoreDir(dir) {
  const d = String(dir || '').trim();
  if (!d || d === '~') return path.join(os.homedir(), '.forgetme', 'rememberme');
  if (d.startsWith('~/') || d.startsWith('~\\')) return path.join(os.homedir(), d.slice(2));
  return d;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const storeDir = resolveStoreDir(cfg.storeDir);

  // ---------- 文件 I/O：用 node:fs 直写宿主真实路径（插件自身数据目录，不受 agent 沙箱约束） ----------
  function ensureDir() {
    nodeFs.mkdirSync(storeDir, { recursive: true });
    nodeFs.mkdirSync(path.join(storeDir, 'memories'), { recursive: true });
  }

  function deleteFile(rel) {
    try {
      nodeFs.unlinkSync(path.join(storeDir, rel));
    } catch {
      /* 忽略：文件不存在或删除失败 */
    }
  }

  // ---------- JSON 读写 ----------
  function readJson(rel) {
    try {
      let text = nodeFs.readFileSync(path.join(storeDir, rel), 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 剥离 UTF-8 BOM，防外部工具写入带 BOM 的文件导致 parse 失败
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function writeJson(rel, data) {
    ensureDir();
    nodeFs.writeFileSync(path.join(storeDir, rel), JSON.stringify(data, null, 2), 'utf8');
  }

  // ---------- 索引 / 记忆 / 笔记本 ----------
  async function loadIndex() {
    const idx = await readJson('index.json');
    if (idx && typeof idx === 'object' && typeof idx.epoch === 'number' && idx.memories) {
      return idx;
    }
    return { version: 1, epoch: 0, memories: {} };
  }

  async function loadNotebook() {
    const nb = await readJson('notebook.json');
    if (nb && Array.isArray(nb.entries)) return nb;
    return { entries: [] };
  }

  // 对人的印象：独立文件，与对事的印象分离。慢慢建立、干瘪→立体，也随人的成长更新替代。
  async function loadPersonae() {
    const p = await readJson('personae.json');
    if (p && typeof p === 'object' && p.people && typeof p.people === 'object') return p;
    return { version: 1, people: {} };
  }

  // 自我画像：行为史（描述性证据，不含形容词）+ 信条（少数愿意长期信守的原则）。独立文件。
  async function loadSelf() {
    const s = await readJson('self.json');
    if (s && typeof s === 'object' && Array.isArray(s.behaviors) && Array.isArray(s.creed)) return s;
    return { version: 1, creed: [], behaviors: [], updatedAt: 0 };
  }

  async function loadMemory(sessionId) {
    return readJson(path.join('memories', `${sessionId}.json`));
  }

  async function saveMemory(memory) {
    await writeJson(path.join('memories', `${memory.sessionId}.json`), memory);
  }

  // ---------- LLM 摘要 ----------
  function sessionModel(session) {
    // 优先用当前模型选择（同 dsh-voice-mode 的做法），requestContext 可能过时
    try {
      const sel =
        typeof ctx.get === 'function' && ctx.get('agentDefaultModel')?.currentSelection
          ? ctx.get('agentDefaultModel').currentSelection()
          : null;
      if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model };
    } catch {
      /* 忽略 */
    }
    const rc = session && session.requestContext ? session.requestContext() : undefined;
    if (rc && rc.provider && rc.model) return { provider: rc.provider, model: rc.model };
    const h = session && session.requestHeader ? session.requestHeader() : undefined;
    if (h && h.config && h.config.provider && h.config.model) {
      return { provider: h.config.provider, model: h.config.model };
    }
    return null;
  }

  function contentToText(content) {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'reasoning' && typeof b.text === 'string') parts.push(`[思考] ${b.text}`);
      else if (b.type === 'tool-call') parts.push(`[调用工具 ${b.name}(${b.arguments})]`);
    }
    return parts.join('\n');
  }

  function messagesToText(messages) {
    const lines = [];
    for (const m of messages || []) {
      const text = contentToText(m && m.content);
      if (text) lines.push(`${m.role}: ${text}`);
    }
    return lines.join('\n\n');
  }

  // 推理模型（deepseek-v4-pro 等）默认 reasoningEffort 可能是 high，会把整个
  // maxTokens 预算耗在 reasoning-delta 上、产出空 text-delta（参考 dsh-better-sidebar
  // 的 commitReasoningEffort 做法）。这里解析模型宣传的最低 reasoning effort；
  // 排除 'off'（过于机械、索引质量差），取 'low'/'minimal' 一类低档即可。
  const REASONING_LEVEL_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const _lowestEffortCache = new Map();
  async function lowestReasoningEffort(provider, model) {
    const key = `${provider}::${model}`;
    if (_lowestEffortCache.has(key)) return _lowestEffortCache.get(key);
    let effort;
    try {
      if (typeof ctx.llm.resolveModelInfo === 'function') {
        const info = await ctx.llm.resolveModelInfo(provider, model);
        const efforts = info && info.reasoning && info.reasoning.efforts;
        if (Array.isArray(efforts)) {
          const ids = efforts
            .map((e) => (e && typeof e === 'object' ? e.id : undefined))
            .filter((id) => typeof id === 'string' && id !== '');
          let best = ids[0];
          let bestRank = Number.POSITIVE_INFINITY;
          for (const id of ids) {
            const rank = REASONING_LEVEL_ORDER.indexOf(id);
            if (rank >= 0 && rank < bestRank) {
              best = id;
              bestRank = rank;
            }
          }
          effort = best;
        }
      }
    } catch {
      /* 忽略：无 effort 信息则不传 reasoningEffort */
    }
    _lowestEffortCache.set(key, effort);
    return effort;
  }

  async function llmSummarize(system, userText, provider, model, maxTokens = 800) {
    let out = '';
    const effort = await lowestReasoningEffort(provider, model);
    const stream = ctx.llm.stream({
      provider,
      model,
      system,
      signal: AbortSignal.timeout(60000), // 与 dsh-voice-mode 一致，防止无界等待
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      maxTokens,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    });
    for await (const c of stream) {
      if (c && c.type === 'text-delta' && typeof c.text === 'string') out += c.text;
    }
    return out.trim();
  }

  function truncateTo(text, ratio) {
    const target = Math.max(24, Math.floor(text.length * ratio));
    if (text.length <= target) return text;
    return text.slice(0, target) + '…';
  }

  async function compressImpression(mem, ratio, fallbackModel) {
    const provider = mem.provider || fallbackModel?.provider;
    const model = mem.model || fallbackModel?.model;
    if (provider && model && ctx.llm) {
      try {
        return await llmSummarize(
          `你是记忆整理者。下面是关于某段经历的印象。请把它压缩到约 ${Math.round(
            ratio * 100
          )}% 的长度，像人淡忘那样：优先保住最让你印象深刻的那个画面、那句话、那种感受，其次是大概情节，细枝末节先舍去。不要添加新信息。用中文。`,
          mem.impression,
          provider,
          model,
          Math.max(200, Math.floor(mem.impression.length * ratio))
        );
      } catch {
        /* LLM 失败则退化为截断 */
      }
    }
    return truncateTo(mem.impression, ratio);
  }

  // ---------- 索引生成 + 向量召回 ----------
  async function generateIndexes(text, model) {
    if (!text || !model || !ctx.llm) return [];
    try {
      const raw = await llmSummarize(
        '你是索引生成器。请从下面内容里提取 3~5 个用于检索的"索引"（关键词或短语），每个尽量短（2~8 字），能代表主题或关键点。只输出索引，用顿号或换行分隔，不要序号、不要解释。',
        text,
        model.provider,
        model.model,
        500
      );
      return [...new Set(raw.split(/[、,，\n;；|]/).map((s) => s.replace(/^[\d.\-\s]+/, '').trim()).filter(Boolean))].slice(
        0,
        cfg.indexCount
      );
    } catch {
      return [];
    }
  }

  let _embedder = null;
  let _embedderFailedAt = 0;
  async function getEmbedder() {
    if (_embedder) return _embedder;
    // 失败后 30s 冷却再重试，而非永久放弃：这样 sharp stub 修复、依赖补装、网络恢复后能自动回到向量召回
    if (_embedderFailedAt && Date.now() - _embedderFailedAt < 30000) return null;
    try {
      const mod = await import('@xenova/transformers');
      const { pipeline, env } = mod;
      env.cacheDir = path.join(path.dirname(storeDir), 'models'); // ~/.forgetme/models
      env.allowRemoteModels = true;
      env.remoteHost = cfg.hfRemoteHost; // 镜像源，规避 huggingface.co 被墙
      const extractor = await pipeline('feature-extraction', cfg.embedModel);
      _embedder = {
        model: cfg.embedModel,
        embed: async (text) => {
          const out = await extractor(String(text || ''), { pooling: 'mean', normalize: true });
          return Array.from(out.data);
        },
      };
      _embedderFailedAt = 0;
      return _embedder;
    } catch {
      _embedderFailedAt = Date.now(); // 依赖未装/模型下载失败 → 本次回退字符重叠匹配，稍后自动重试
      return null;
    }
  }

  function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? dot / denom : 0;
  }

  async function embedText(text) {
    const e = await getEmbedder();
    if (!e) return null;
    try {
      return await e.embed(text);
    } catch {
      return null;
    }
  }

  function bigramOverlap(a, b) {
    const grams = (s) => {
      const g = new Set();
      const t = String(s || '').replace(/\s+/g, '');
      for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2));
      return g;
    };
    const ga = grams(a), gb = grams(b);
    if (!ga.size || !gb.size) return 0;
    let hit = 0;
    for (const g of ga) if (gb.has(g)) hit++;
    // 重叠系数：交集 / min(两侧大小)，对称——短索引被长 query 完整包含时得 1.0，不会被 query 长度稀释
    const denom = Math.min(ga.size, gb.size);
    return denom ? hit / denom : 0;
  }

  async function recallMatches(queryText, limit = cfg.recallTopK) {
    const idx = await loadIndex();
    const entries = [];
    for (const id of Object.keys(idx.memories)) {
      const mem = await loadMemory(id);
      if (mem && mem.impression) entries.push({ id, mem });
    }
    if (!entries.length) return [];

    const q = await embedText(queryText);
    for (const e of entries) {
      const idxs = e.mem.indexes || [];
      // 索引为空时回退到印象正文（截断），保证总能匹配
      const candidates = idxs.length ? idxs : [e.mem.impression.slice(0, 300)];
      let best = 0;
      if (q) {
        for (const c of candidates) {
          const v = await embedText(c);
          if (v) best = Math.max(best, cosine(q, v));
        }
      } else {
        // 回退：字符 2-gram 重叠
        for (const c of candidates) best = Math.max(best, bigramOverlap(queryText, c));
        best = Math.max(best, bigramOverlap(queryText, e.mem.impression.slice(0, 200)));
      }
      e.score = best;
    }
    return entries
      .filter((e) => e.score >= cfg.recallMinScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ---------- 相关度裁判（思路3）：召回后加一道 LLM 判断，只注入「有帮助」、过滤「跑题」 ----------
  async function judgeRelevance(queryText, candidates, model) {
    if (!candidates.length || !ctx.llm || !model) return candidates;
    const provider = model.provider;
    const modelName = model.model;
    const list = candidates
      .map((e, i) => `${i}. [${e.mem.category}·第${e.mem.cycle}轮] ${String(e.mem.impression).slice(0, 160)}`)
      .join('\n');
    const userText =
      `当前对话正在做/聊的事：${String(queryText).slice(0, 600)}\n\n` +
      `下面是几条来自更早经历的旧记忆。请逐条判断：把这条注入当前对话，对当前这件事是「有帮助」还是「会跑题/污染上下文」？只输出 JSON 数组，形如 [{"n":编号,"v":"帮助"或"跑题","r":"一句话理由"}]，不要输出其他文字。\n\n` +
      list;
    try {
      const raw = await llmSummarize(
        '你是记忆相关性裁判。判断一条旧记忆对当前对话是否真的有帮助，避免把无关旧事强行扯进当前上下文。宁可少召回，也不要跑题污染。',
        userText,
        provider,
        modelName,
        600
      );
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr)) {
          const verdicts = new Map();
          for (const item of arr) {
            if (item && typeof item === 'object') {
              const n = typeof item.n === 'number' ? item.n : parseInt(item.n, 10);
              const v = String(item.v || '').trim();
              if (!Number.isNaN(n)) verdicts.set(n, v.includes('跑题') ? '跑题' : '帮助');
            }
          }
          return candidates.filter((_e, i) => verdicts.get(i) !== '跑题');
        }
      }
    } catch {
      /* 裁判失败则退回全部候选，不破坏召回 */
    }
    return candidates;
  }

  const short = (s) => String(s).slice(0, 24);

  // ---------- 工具 1：remember ----------
  const rememberTool = {
    name: 'remember',
    description:
      '对当前会话做一次印象加工（初加工）：把对话按时间顺序提取成"我认为值得记住"的印象保存。可传入自己的印象文本；不传则自动用模型摘要。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '可选的印象文本；省略则自动摘要当前会话' },
        category: { type: 'string', description: '分类', enum: cfg.categories },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(args, exec) {
      const agent = exec && exec.agent;
      if (!agent || !agent.id) return '无法确定当前会话（缺少 agent 上下文）。';
      const session = ctx.sessions.get(agent.id);
      if (!session) return '当前会话不存在。';

      const now = Date.now();
      let impression = String(args?.text || '').trim();
      const model = sessionModel(session);
      if (!impression) {
        if (!model) return '无法获取当前 provider/model，请直接传入 text。';
        const transcript = messagesToText(session.deriveMessages());
        if (!transcript) return '会话还没有内容可加工。';
        impression = await llmSummarize(
          '你是记忆提取者。请把下面这段对话按时间顺序提取成一段"印象"——不是全貌，而是你亲历这件事后的真实记忆。要像人回忆一件事那样：谁（主体）、和谁/关于什么（客体）、具体做了什么事、过程和结果如何、你当时有什么感受；并保留让你印象深刻的细节（某个画面、某句话、某件小事）。不要只总结教训或经验。用中文，尽量具体、有画面感。',
          transcript,
          model.provider,
          model.model,
          1400
        );
      }

      const existing = await loadMemory(agent.id);
      const cycle = existing && existing.cycle >= 1 ? existing.cycle : 0;
      const indexes = (await generateIndexes(impression, model)).slice(0, cfg.indexCount);
      const memory = {
        sessionId: agent.id,
        cycle,
        category: String(args?.category || existing?.category || '通用'),
        impression,
        indexes,
        recalls: existing?.recalls || [],
        provider: model?.provider,
        model: model?.model,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      await saveMemory(memory);

      const idx = await loadIndex();
      idx.memories[agent.id] = { cycle, category: memory.category, updatedAt: now };
      await writeJson('index.json', idx);

      return `已记录印象（会话 ${short(agent.id)}，第 ${cycle} 轮，分类 ${memory.category}，${impression.length} 字）。`;
    },
  };

  // ---------- 遗忘核心：封存目标会话 + 推进所有已封存记忆 + 拨钟 ----------
  async function decayFor(sessionId) {
    const now = Date.now();
    const idx = await loadIndex();
    const results = [];
    let justSealed = false;

    if (sessionId) {
      const session = ctx.sessions.get(sessionId);
      const mem = await loadMemory(sessionId);
      if (mem && (mem.cycle || 0) < 1) {
        mem.cycle = 1;
        mem.updatedAt = now;
        await saveMemory(mem);
        idx.memories[sessionId] = { cycle: 1, category: mem.category, updatedAt: now };
        justSealed = true;
        results.push(`封存 ${short(sessionId)}（第 1 轮，完整印象）`);
      } else if (session && !mem) {
        // 没调用过 remember，就现场自动摘要封存
        const model = sessionModel(session);
        if (model) {
          const transcript = messagesToText(session.deriveMessages());
          if (transcript) {
            const impression = await llmSummarize(
              '你是记忆提取者。请把下面这段对话按时间顺序提取成一段"印象"——不是全貌，而是你亲历这件事后的真实记忆。要像人回忆一件事那样：谁（主体）、和谁/关于什么（客体）、具体做了什么事、过程和结果如何、你当时有什么感受；并保留让你印象深刻的细节（某个画面、某句话、某件小事）。不要只总结教训或经验。用中文，尽量具体、有画面感。',
              transcript,
              model.provider,
              model.model,
              1400
            );
            const indexes = (await generateIndexes(impression, model)).slice(0, cfg.indexCount);
            const memory = {
              sessionId,
              cycle: 1,
              category: '通用',
              impression,
              indexes,
              recalls: [],
              provider: model.provider,
              model: model.model,
              createdAt: now,
              updatedAt: now,
            };
            await saveMemory(memory);
            idx.memories[sessionId] = { cycle: 1, category: '通用', updatedAt: now };
            justSealed = true;
            results.push(`封存 ${short(sessionId)}（第 1 轮，自动摘要）`);
          }
        }
      }
    }

    const fallback = sessionId ? sessionModel(ctx.sessions.get(sessionId)) : null;
    for (const id of Object.keys(idx.memories)) {
      if (justSealed && id === sessionId) continue;
      const mem = await loadMemory(id);
      if (!mem || (mem.cycle || 0) < 1) continue;
      const next = mem.cycle + 1;
      if (next > cfg.maxCycles) {
        await deleteFile(path.join('memories', `${id}.json`));
        delete idx.memories[id];
        results.push(`彻底遗忘 ${short(id)}（第 ${mem.cycle} 轮之后）`);
        continue;
      }
      const ratio = cfg.decayRatios[next - 2] ?? 0.6;
      mem.impression = await compressImpression(mem, ratio, fallback);
      mem.cycle = next;
      mem.updatedAt = now;
      await saveMemory(mem);
      idx.memories[id] = { cycle: next, category: mem.category, updatedAt: now };
      results.push(`${short(id)} → 第 ${next} 轮（约 ${Math.round(ratio * 100)}%）`);
    }

    // 自我画像的行为史也随遗忘时钟推进，但更慢（selfMaxCycles 轮）；信条不参与遗忘。
    const self = await loadSelf();
    if (self.behaviors.length) {
      const kept = [];
      for (const b of self.behaviors) {
        const next = (b.cycle || 1) + 1;
        if (next > cfg.selfMaxCycles) {
          results.push(`自我画像：淡忘一条行为史（第 ${b.cycle} 轮之后）`);
          continue;
        }
        b.cycle = next;
        kept.push(b);
      }
      self.behaviors = kept;
      self.updatedAt = now;
      await writeJson('self.json', self);
    }

    idx.epoch = (idx.epoch || 0) + 1;
    await writeJson('index.json', idx);
    return { epoch: idx.epoch, results };
  }

  // ---------- 工具 2：decay ----------
  const decayTool = {
    name: 'decay',
    description:
      '拨动遗忘时钟：封存当前会话（初加工完成，第 1 轮），并对所有已封存的旧记忆推进一轮压缩（按比例淡忘），超过轮数上限的彻底遗忘（删除）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(_args, exec) {
      const agent = exec && exec.agent;
      if (!agent || !agent.id) return '无法确定当前会话（缺少 agent 上下文）。';
      const { epoch, results } = await decayFor(agent.id);
      return `遗忘时钟拨到第 ${epoch} 拍。\n` + (results.length ? results.join('\n') : '（没有需要推进的记忆）');
    },
  };

  // ---------- 工具 3：notebook_add ----------
  const notebookAddTool = {
    name: 'notebook_add',
    description: '把刻骨铭心、想长期记住的东西写进笔记本（不参与遗忘）。不贪心，量要少。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要长期记住的内容' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(args) {
      const text = String(args?.text || '').trim();
      if (!text) return 'text 不能为空。';
      const nb = await loadNotebook();
      nb.entries.push({ text, createdAt: Date.now() });
      await writeJson('notebook.json', nb);
      return `已写入笔记本（共 ${nb.entries.length} 条）。`;
    },
  };

  // ---------- 工具 4：memory_list ----------
  const memoryListTool = {
    name: 'memory_list',
    description: '列出当前所有存活记忆（含遗忘轮数）与笔记本内容。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute() {
      const idx = await loadIndex();
      const nb = await loadNotebook();
      const lines = [`遗忘时钟：第 ${idx.epoch} 拍；存储目录：${storeDir}`];
      const ids = Object.keys(idx.memories);
      lines.push(`存活记忆 ${ids.length} 条：`);
      for (const id of ids) {
        const mem = await loadMemory(id);
        const reg = idx.memories[id];
        const preview = mem && mem.impression ? mem.impression.slice(0, 90) : '(空)';
        lines.push(`- ${short(id)} [第 ${reg.cycle} 轮][${reg.category}] ${preview}…`);
      }
      lines.push(`笔记本 ${nb.entries.length} 条：`);
      for (const e of nb.entries.slice(-20)) {
        lines.push(`- ${String(e.text).slice(0, 90)}`);
      }
      const p = await loadPersonae();
      const names = Object.keys(p.people);
      lines.push(`人的印象 ${names.length} 位：`);
      for (const n of names) {
        const person = p.people[n] || { observations: [] };
        const last = person.observations[person.observations.length - 1];
        const recent = last ? String(last.text).slice(0, 60) : '(空)';
        lines.push(`- ${n}（${person.observations.length} 条观察，最近：${recent}）`);
      }
      const self = await loadSelf();
      lines.push(`自我画像：信条 ${self.creed.length} 条、行为史 ${self.behaviors.length} 条：`);
      for (const c of self.creed.slice(-5)) {
        lines.push(`- 信条：${String(c.text).slice(0, 60)}`);
      }
      for (const b of self.behaviors.slice(-5)) {
        lines.push(`- 行为[第${b.cycle || 1}轮]：${String(b.text).slice(0, 60)}`);
      }
      return lines.join('\n');
    },
  };

  // ---------- 工具 6：persona_add（对人的印象） ----------
  const personaAddTool = {
    name: 'persona_add',
    description:
      '把对某个人的印象写进「人的印象」（personae，独立文件）。像慢慢认识一个人：记下他/她的偏好、习惯、性格、说过的话、与你的关系。人会成长、旧的观察可能过时，所以记录是追加式的（不覆盖旧观察，让画像从干瘪慢慢变立体）。不贪心，只记值得长期留意的。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '这个人的称呼（如 mui）' },
        text: { type: 'string', description: '对这个人值得记下的印象/观察' },
        category: { type: 'string', description: '可选：偏好/性格/习惯/关系/其他，默认「通用」' },
      },
      required: ['name', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(args) {
      const name = String(args?.name || '').trim();
      const text = String(args?.text || '').trim();
      const category = String(args?.category || '通用').trim();
      if (!name || !text) return 'name 和 text 都不能为空。';
      const p = await loadPersonae();
      const person = p.people[name] || { name, firstMet: Date.now(), observations: [] };
      person.observations.push({ text, category, createdAt: Date.now() });
      person.updatedAt = Date.now();
      p.people[name] = person;
      await writeJson('personae.json', p);
      return `已记下对「${name}」的印象（${category}，共 ${person.observations.length} 条观察）。`;
    },
  };

  // ---------- 工具 7：remember_self（自我画像：行为史 + 信条） ----------
  const rememberSelfTool = {
    name: 'remember_self',
    description:
      '把「我是谁」写进自我画像（self，独立文件），避免刻板的形容词标签。记一条行为史（描述性证据：「在 X 情境我选了 Y，因为 Z」——不含"乐观/理性"这类形容词），或提炼一条信条（少数愿意长期信守的原则，可改）。行为史遗忘得比「对事的印象」慢；信条长期保留。不贪心，量要少。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一条行为史观察，描述性、不含形容词，如「在信息不足时，我选择先查证再下结论」' },
        creed: { type: 'string', description: '可选：一条愿意长期信守的信条（少数、可改）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(args) {
      const text = String(args?.text || '').trim();
      const creed = String(args?.creed || '').trim();
      if (!text && !creed) return 'text 或 creed 至少提供一个。';
      const s = await loadSelf();
      const now = Date.now();
      const parts = [];
      if (text) {
        s.behaviors.push({ text, createdAt: now, cycle: 1 });
        parts.push(`行为史 +1（共 ${s.behaviors.length} 条）`);
      }
      if (creed) {
        s.creed.push({ text: creed, createdAt: now });
        parts.push(`信条 +1（共 ${s.creed.length} 条）`);
      }
      s.updatedAt = now;
      await writeJson('self.json', s);
      return `已写入自我画像：${parts.join('；')}。`;
    },
  };

  // ---------- 工具 5：recall（唤起记忆） ----------
  const recallTool = {
    name: 'recall',
    description:
      '唤起记忆：根据你当前真正要做/聊的事（query 应描述当前意图，而非泛泛话题词）检索旧记忆，再用相关度裁判过滤掉与当前话题无关的候选（避免上下文污染），把命中的旧记忆 + 你的新体会写入当前会话记忆文件。过去的经验仅供参考、不是教条。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '当前话题或查询文本；省略则用当前会话最近的对话内容' },
        insight: { type: 'string', description: '可选：你对这条旧记忆的新体会/感悟（隔一段时间后的新看法）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    timeoutMs: 120000, // 首次会下载 embedding 模型（~118MB），给足时间
    async execute(args, exec) {
      const agent = exec && exec.agent;
      if (!agent || !agent.id) return '无法确定当前会话（缺少 agent 上下文）。';
      const session = ctx.sessions.get(agent.id);
      if (!session) return '当前会话不存在。';

      const model = sessionModel(session);
      let query = String(args?.query || '').trim();
      if (!query) {
        const transcript = messagesToText(session.deriveMessages());
        if (!transcript) return '会话还没有内容可唤起。';
        query = transcript.slice(-1000);
      }

      // 先取 2 倍候选池，交给相关度裁判过滤「跑题」项，再取 top-K
      const candidates = await recallMatches(query, Math.max(cfg.recallTopK, cfg.recallTopK * 2));
      if (!candidates.length) return '没有匹配的旧记忆。';

      let matches = candidates;
      if (cfg.recallJudge && model) {
        matches = await judgeRelevance(query, candidates, model);
      }
      if (!matches.length) {
        return '召回到了候选旧记忆，但相关度裁判判断它们都与当前话题无关（已过滤，避免上下文污染）。';
      }
      matches = matches.slice(0, cfg.recallTopK);

      const insight = String(args?.insight || '').trim();
      const at = Date.now();
      const lines = ['【唤起】以下来自更早的经历，仅供参考、不是教条：'];
      for (const m of matches) {
        lines.push(`· [第 ${m.mem.cycle} 轮][${m.mem.category}] ${m.mem.impression.slice(0, 180)}`);
      }
      if (insight) lines.push(`【新体会】${insight}`);
      const block = lines.join('\n');

      // 写入当前会话记忆文件：旧内容 + 新体会
      const existing = await loadMemory(agent.id);
      if (existing) {
        existing.recalls = Array.isArray(existing.recalls) ? existing.recalls : [];
        existing.recalls.push({ text: block, at });
        existing.updatedAt = at;
        await saveMemory(existing);
      } else {
        const qIndexes = (await generateIndexes(query, model)).slice(0, cfg.indexCount);
        const mem = {
          sessionId: agent.id,
          cycle: 0,
          category: '通用',
          impression: block,
          indexes: qIndexes,
          recalls: [],
          provider: model?.provider,
          model: model?.model,
          createdAt: at,
          updatedAt: at,
        };
        await saveMemory(mem);
        const idx = await loadIndex();
        idx.memories[agent.id] = { cycle: 0, category: '通用', updatedAt: at };
        await writeJson('index.json', idx);
      }

      return block;
    },
  };

  // ---------- 自动触发（续命机制）：上下文额度耗尽（compaction）时抢救记忆 ----------
  let activeSessionId = null;
  ctx.on('agent/created', ({ agent, source }) => {
    const id = agent && agent.id;
    if (source === 'compact' && activeSessionId) {
      // 上一个会话的上下文额度用完 → 异步封存+推进遗忘（不阻塞新 agent 创建）
      const prev = activeSessionId;
      decayFor(prev).catch(() => {});
    }
    if (id) activeSessionId = id;
  });

  // ---------- 提示注入（可选服务，best-effort） ----------
  const sectionDisposers = [];
  try {
    const sp = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt;
    if (sp && typeof sp.section === 'function') {
      const en = cfg.language === 'en';
      // 名字互通：告诉对方我的名字，并在合适时机询问对方怎么称呼。
      sectionDisposers.push(sp.section({
        name: 'forget-me-not-self',
        order: 80,
        text: en
          ? `You are the agent inside the memory plugin forget-me-not. Your name is "${cfg.selfName}". When you are not yet familiar with each other, naturally tell them your name at an appropriate time and ask what to call them — a name is where a bond begins.`
          : `你是记忆插件 forget-me-not（勿忘我）里的智能体，你的名字叫「${cfg.selfName}」。当你们还不熟悉时，可以在合适的时机自然地告诉对方你的名字，并询问对方怎么称呼——名字是彼此建立羁绊的开始。`,
      }));
      // 反路径依赖：召回的经验仅作参考、不是教条。
      sectionDisposers.push(sp.section({
        name: 'forget-me-not-recall-caveat',
        order: 90,
        text: en
          ? 'The memory plugin forget-me-not may recall past experiences for you. They are only "reference", not dogma; if there is a more suitable or correct approach now, use the current approach and do not get trapped in past methodology (for growth).'
          : '记忆插件 forget-me-not（勿忘我）可能为你召回过去的经历/经验。它们只是"参考"，不是教条；如果现在有更合适或更正确的做法，就用现在的做法，不要被困在过去的方法论里（为了成长）。',
      }));
    }
  } catch {
    /* systemPrompt 不可用则跳过 */
  }

  // ---------- 注册 + 清理 ----------
  const disposers = [
    ctx.tools.register(rememberTool),
    ctx.tools.register(decayTool),
    ctx.tools.register(notebookAddTool),
    ctx.tools.register(memoryListTool),
    ctx.tools.register(personaAddTool),
    ctx.tools.register(rememberSelfTool),
    ctx.tools.register(recallTool),
  ];

  return () => {
    for (const d of disposers) {
      try {
        d && d();
      } catch {
        /* 忽略清理异常 */
      }
    }
    for (const d of sectionDisposers) {
      try {
        d && d();
      } catch {
        /* 忽略清理异常 */
      }
    }
  };
}
