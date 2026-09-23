// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { rankMemoriesHybrid, retentionFactor } from "./memory-hybrid";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const allEntries = await loadMemoryEntriesByType(characterId, "long_term");
    // 归档的记忆可搜但不主动召回
    const longTermEntries = allEntries.filter((m) => !(m.metadata && m.metadata.archived === true));
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all（数量不多时不排序、不发向量请求，省额度）
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: 混合检索（关键词 BM25 + 可选向量）+ 遗忘曲线，按分填预算
    // 向量分：仅当开启向量召回且配了 embedding API 时才发请求
    let vectorScores: (number | null)[] | null = null;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            vectorScores = longTermEntries.map((m) =>
                m.embedding && m.embedding.length > 0 ? cosineSimilarity(queryEmbedding, m.embedding) : null,
            );
        }
    }

    const ranked = rankMemoriesHybrid({ entries: longTermEntries, query: currentContext, vectorScores });
    return fillByBudget(ranked, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/**
 * 遗忘落地：把「保持率极低 + 不重要 + 非手动」的长期记忆标记为归档。
 * 归档后不再主动召回（retrieve 已过滤），但仍可搜索、可在记忆库里恢复。核心记忆不受影响。
 * 纯本地计算，不发任何请求。返回本次新归档的条数。
 */
export async function runMemoryDecayArchival(characterId: string, config: MemoryConfig): Promise<number> {
    if (config.autoArchiveEnabled === false) return 0;
    const threshold = typeof config.archiveRetentionThreshold === "number" ? config.archiveRetentionThreshold : 0.12;
    const entries = await loadMemoryEntriesByType(characterId, "long_term");
    const now = Date.now();
    let archived = 0;
    for (const e of entries) {
        if (e.metadata?.archived === true) continue;
        if ((e.importance ?? 0.5) >= 0.6) continue;             // 重要的不归档
        if (e.metadata?.origin === "user_manual") continue;      // 用户手动加的不自动归档
        if (retentionFactor(e, now) > threshold) continue;       // 还没忘到那份上
        await saveMemoryEntry({
            ...e,
            metadata: { ...(e.metadata || {}), archived: true, archivedAt: new Date().toISOString(), archivedReason: "decay" },
            updatedAt: new Date().toISOString(),
        });
        archived++;
    }
    return archived;
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
