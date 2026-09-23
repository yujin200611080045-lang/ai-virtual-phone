// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
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

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);
    // 遗忘落地：把忘透了的旧记忆归档（纯本地，不发请求）
    try { const { runMemoryDecayArchival } = await import("./memory-service"); await runMemoryDecayArchival(characterId, config); } catch { /* ignore */ }

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
        // 各自裁剪上限
        const all = await loadMemoryEntries(characterId);
        if (all.length > config.maxLongTermEntries) {
            await deleteMemoryEntries(all.slice(0, all.length - config.maxLongTermEntries).map(e => e.id));
        }
    }

    return { success: true, summary, memberCount: memberIds.length };
}
