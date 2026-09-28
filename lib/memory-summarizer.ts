// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    saveMemoryEntry,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import { enforceActiveMemoryCap, extractFromEvents, isLegacySummary, logMemoryOp, runOmbreDecayCycle } from "./memory-ombre";
import { loadMemoryEntries } from "./memory-storage";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

// —— 情绪打标：折进同一次总结调用，不额外发请求 ——
const EMOTION_TAG_INSTRUCTION = `

————
在总结正文之后，另起一行，仅输出一行紧凑 JSON（不要任何额外解释或代码块围栏），描述这段记忆的情绪与标签：
{"title":"一句话概括(≤14字)","tags":["2-5个关键词"],"valence":情绪效价从-1(负面)到1(正面)的小数,"arousal":情绪强度从0(平静)到1(激烈)的小数}`;

function appendEmotionTagInstruction(prompt: string): string {
    return loadMemoryConfig().emotionTaggingEnabled === false ? prompt : prompt + EMOTION_TAG_INSTRUCTION;
}

type EmotionTag = { title?: string; tags?: string[]; valence?: number; arousal?: number };

/** 从总结原文里剥出末尾那行标签 JSON，返回干净正文 + 情绪字段。解析失败则原样返回。 */
function parseTaggedSummary(raw: string): { content: string; tag: EmotionTag } {
    const text = raw.trim();
    // 找最后一个 { ... } 块
    const match = text.match(/\{[\s\S]*\}\s*$/);
    if (!match) return { content: text, tag: {} };
    try {
        const parsed = JSON.parse(match[0]);
        const clamp = (n: unknown, lo: number, hi: number): number | undefined => {
            const v = typeof n === "number" ? n : Number(n);
            return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined;
        };
        const tag: EmotionTag = {
            title: typeof parsed.title === "string" ? parsed.title.trim().slice(0, 40) || undefined : undefined,
            tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 6) : undefined,
            valence: clamp(parsed.valence, -1, 1),
            arousal: clamp(parsed.arousal, 0, 1),
        };
        const content = text.slice(0, match.index).trim() || text;
        return { content, tag };
    } catch {
        return { content: text, tag: {} };
    }
}

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    const sourceSessionIdsForWindow = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    // Ombre 拆条：一段对话 → 0~5 条第一人称独立记忆，和相似旧记忆合并（不再一段一大坨）
    if (config.ombreExtractionEnabled !== false) {
        const sourceCountsX = new Map<string, number>();
        for (const e of allEntries) sourceCountsX.set(e.sourceApp, (sourceCountsX.get(e.sourceApp) || 0) + 1);
        const dominant = [...sourceCountsX.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "chat";
        const extracted = await extractFromEvents(characterId, eventsText, {
            earliest,
            latest,
            sourceApp: dominant as MemoryEntry["sourceApp"],
            metadata: { summarizedEvents: allEntries.length, sourceSessionIds: sourceSessionIdsForWindow },
        });
        if ("error" in extracted) return { success: false, error: extracted.error };
        setLastSummarizedTimestamp(characterId, latest);
        resetEventCounter(characterId);
        await enforceActiveMemoryCap(characterId, config.maxLongTermEntries);
        if (extracted.created + extracted.merged + extracted.plans > 0) {
            incrementCoreMemoryCounter(characterId);
            await maybeRunCoreMemoryPipeline(characterId, characterName);
        }
        try { await runOmbreDecayCycle(characterId, config); } catch { /* ignore */ }
        console.log(`[MemorySummarizer] Ombre extract ${allEntries.length} events → new ${extracted.created} / merged ${extracted.merged} / plans ${extracted.plans}`);
        return { success: true };
    }

    // Use user-editable prompt template from config, with placeholder substitution
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — compatible with all providers（情绪打标折进本次调用）
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: appendEmotionTagInstruction(summaryPrompt) }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const { content: summary, tag: emotionTag } = parseTaggedSummary(result.content);

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summary, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    // Save as long-term memory
    const now = new Date().toISOString();
    void sourceSessionIdsForWindow;
    const longTermEntry: MemoryEntry = {
        id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource as MemoryEntry["sourceApp"],
        type: "long_term",
        content: summary,
        embedding,
        importance: 0.8,
        createdAt: now,
        updatedAt: now,
        title: emotionTag.title,
        tags: emotionTag.tags,
        valence: emotionTag.valence,
        arousal: emotionTag.arousal,
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(longTermEntry);

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // 数量上限：超出的按衰减分归档（遗忘是淡出，不删除）
    await enforceActiveMemoryCap(characterId, config.maxLongTermEntries);

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);
    // 遗忘落地：把忘透了的旧记忆归档（纯本地，不发请求）
    try { await runOmbreDecayCycle(characterId, config); } catch { /* ignore */ }

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 long-term memory`);
    return { success: true };
}

/**
 * 手动总结一段共享内容（如一场剧情），生成【一份】总结，原样写进所有参与角色的长期记忆库。
 * 与自动总结不同：内容对全体一致（不是各人各总结一份），且不动各角色的自动总结水位线/计数。
 */
export async function summarizeSharedForMembers(params: {
    memberIds: string[];
    rosterName: string;      // 用于 {{char}} 占位
    eventsText: string;
    earliest: string;
    latest: string;
    eventCount: number;
    sourceApp?: MemoryEntry["sourceApp"];
    sourceThreadId?: string;
}): Promise<{ success: boolean; error?: string; summary?: string; memberCount?: number }> {
    const memberIds = Array.from(new Set(params.memberIds.filter(Boolean)));
    if (memberIds.length === 0) return { success: false, error: "没有参与角色" };
    if (!params.eventsText.trim()) return { success: false, error: "这段剧情还没有可总结的内容" };

    const config = loadMemoryConfig();
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };

    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, params.rosterName)
        .replace(/\{\{earliest\}\}/gi, params.earliest)
        .replace(/\{\{latest\}\}/gi, params.latest)
        .replace(/\{\{events\}\}/gi, params.eventsText);

    const result = await simpleLLMCall(apiConfig, [{ role: "user", content: appendEmotionTagInstruction(summaryPrompt) }], { temperature: 0.3 });
    if (!result.content) return { success: false, error: result.error || "LLM 返回了空内容" };
    if (result.wasTruncated) return { success: false, error: "总结结果疑似被截断，请稍后重试或提高模型输出上限" };
    const { content: summary, tag: emotionTag } = parseTaggedSummary(result.content);

    // 只算一次向量，全体复用
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try { const emb = await generateEmbedding(summary, embeddingApiConfig); if (emb) embedding = emb; } catch { /* ignore */ }
    }

    const now = new Date().toISOString();
    for (const characterId of memberIds) {
        const entry: MemoryEntry = {
            id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: (params.sourceApp || "story") as MemoryEntry["sourceApp"],
            type: "long_term",
            content: summary,
            embedding,
            importance: 0.8,
            createdAt: now,
            updatedAt: now,
            title: emotionTag.title,
            tags: emotionTag.tags,
            valence: emotionTag.valence,
            arousal: emotionTag.arousal,
            metadata: {
                summarizedEvents: params.eventCount,
                timeSpan: `${params.earliest} ~ ${params.latest}`,
                ...(params.sourceThreadId ? { sourceSessionIds: [params.sourceThreadId] } : {}),
            },
        };
        await saveMemoryEntry(entry);
        // 各自的数量上限：超出的按衰减分归档
        await enforceActiveMemoryCap(characterId, config.maxLongTermEntries);
    }

    return { success: true, summary, memberCount: memberIds.length };
}

/**
 * 把旧版「一段一总结」的成段记忆拆成细节：
 * 优先回到它当初总结的那段原始聊天（按时间跨度取回），逐块重新提取；原始记录已经没了就拆总结原文。
 * 新记忆按事件实际发生的时间入库；原来那一大段归档（不删除，可恢复），并记下拆成了哪几条。
 */
export async function resplitLegacyMemories(
    characterId: string,
    options: {
        ids?: string[];
        onProgress?: (done: number, total: number, label: string) => void;
        signal?: { cancelled: boolean };
    } = {},
): Promise<{ split: number; created: number; merged: number; failed: number; fromRaw: number; error?: string }> {
    const all = await loadMemoryEntries(characterId);
    const targets = all
        .filter(e => (options.ids ? options.ids.includes(e.id) : isLegacySummary(e)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const res = { split: 0, created: 0, merged: 0, failed: 0, fromRaw: 0 };
    if (!resolveAuxiliaryApiConfig("memorySummaryApiConfigId")) {
        return { ...res, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }
    const config = loadMemoryConfig();

    for (let i = 0; i < targets.length; i++) {
        if (options.signal?.cancelled) break;
        const t = targets[i];
        options.onProgress?.(i, targets.length, t.title || t.content.slice(0, 16));

        // 1. 取回原始聊天
        const span = typeof t.metadata?.timeSpan === "string" ? t.metadata.timeSpan.split(/\s*~\s*/) : [];
        const from = span[0] && Number.isFinite(new Date(span[0]).getTime()) ? new Date(span[0]) : null;
        const to = span[1] && Number.isFinite(new Date(span[1]).getTime()) ? new Date(span[1]) : null;
        let sourceText = "";
        let earliest = from ? from.toISOString() : t.createdAt;
        let latest = to ? to.toISOString() : t.createdAt;
        if (from && to) {
            const raw = filterTimelineByAllowedSources(
                loadNativeTimeline(characterId, { afterTimestamp: new Date(from.getTime() - 1000).toISOString() }),
                config.shortTermAllowedSources,
            ).filter(e => new Date(e.timestamp).getTime() <= to.getTime() + 1000);
            const formatted = raw.length >= 2 ? formatTimelineForSummarization(raw) : null;
            if (formatted && formatted.eventsText.trim()) {
                sourceText = formatted.eventsText;
                earliest = formatted.earliest;
                latest = formatted.latest;
            }
        }
        const fromRaw = Boolean(sourceText);
        if (!fromRaw) sourceText = t.content;

        // 2. 先把原来那段归档，免得新细节又被合并回它身上
        const archivedOriginal: MemoryEntry = {
            ...t,
            updatedAt: new Date().toISOString(),
            metadata: { ...(t.metadata || {}), archived: true, archivedAt: new Date().toISOString(), archivedReason: "resplit" },
        };
        await saveMemoryEntry(archivedOriginal);

        // 3. 逐块重新提取（更细：每块最多 8 条；旧待办不开成计划）
        const r = await extractFromEvents(characterId, sourceText, {
            earliest, latest,
            sourceApp: t.sourceApp,
            origin: "auto_extract",
            maxPerChunk: 8,
            at: latest,
            noPlans: true,
            signal: options.signal,
            metadata: { splitFrom: t.id, ...(typeof t.metadata?.summarizedEvents === "number" ? { summarizedEvents: t.metadata.summarizedEvents } : {}) },
        });

        if ("error" in r || r.created + r.merged === 0) {
            // 失败就原样放回
            await saveMemoryEntry({ ...t, updatedAt: new Date().toISOString() });
            res.failed++;
            continue;
        }
        await saveMemoryEntry({
            ...archivedOriginal,
            metadata: { ...(archivedOriginal.metadata || {}), splitInto: r.entries.map(e => e.id), splitFromRaw: fromRaw },
        });
        logMemoryOp(characterId, {
            op: "拆成细节",
            by: "你",
            id: t.id,
            title: t.title || t.content.slice(0, 20),
            detail: `${fromRaw ? "回到原始聊天" : "按原文"}拆成 ${r.created} 条，合并 ${r.merged} 条`,
        });
        res.split++;
        res.created += r.created;
        res.merged += r.merged;
        if (fromRaw) res.fromRaw++;
    }
    options.onProgress?.(targets.length, targets.length, "");
    return res;
}
