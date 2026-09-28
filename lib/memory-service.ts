// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntries, loadMemoryEntriesByType } from "./memory-storage";
import { canSurface, relatedForContext, runOmbreDecayCycle, selectBreathSurface } from "./memory-ombre";
import { estimateTokens } from "./token-counter";

/**
 * Ombre breath 式浮现：注入 prompt 的长期记忆。
 *   核心准则（pinned / permanent）始终在场
 *   → 与此刻对话相关的记忆（多维检索）
 *   → 按衰减分浮现（冷启动 + Top-1 固定 + 洗牌 + 近 7 天保底位）
 *   → 久未浮现 / 偶遇
 *   → 我对自己的认识 + 还惦记着的计划
 * feel / letter / 锚点 / 受保护 / 不浮现 / 归档 都不进普通浮现。
 * 活跃记忆少、预算装得下时不做检索（不发向量请求，省额度），直接全部按分区排好。
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const all = await loadMemoryEntries(characterId);
    const longTerm = all.filter((m) => m.type === "long_term");
    if (longTerm.length === 0) return [];

    const budget = config.longTermTokenBudget;
    const maxResults = config.breathMaxResults ?? 20;
    const eligible = longTerm.filter(canSurface);
    let eligibleTokens = 0;
    for (const entry of eligible) eligibleTokens += estimateTokens(entry.content) + 8;

    const smallEnough = eligible.length <= maxResults && eligibleTokens <= budget;
    const related = !smallEnough && currentContext.trim()
        ? await relatedForContext(characterId, currentContext, longTerm, Math.max(3, Math.ceil(maxResults / 2))).catch(() => [])
        : null;

    return selectBreathSurface(longTerm, {
        related,
        maxResults: smallEnough ? Math.max(maxResults, eligible.length) : maxResults,
        tokenBudget: budget,
    });
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
 * 遗忘落地（Ombre 衰减循环）：importance≤4 且 30 天未激活 → 自动结案；衰减分 < 阈值 → 归档。
 * 归档后不再主动浮现，但仍可搜索、可在记忆库里恢复。核心记忆 / 钉选 / 锚点 / 受保护 / 感受 / 计划 / 信 不受影响。
 * 纯本地计算，不发任何请求。返回本次新归档的条数。
 */
export async function runMemoryDecayArchival(characterId: string, config: MemoryConfig): Promise<number> {
    const result = await runOmbreDecayCycle(characterId, config);
    return result.archived;
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
