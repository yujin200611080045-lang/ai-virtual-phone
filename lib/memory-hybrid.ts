// lib/memory-hybrid.ts
// Ombre 式混合检索 + 遗忘曲线（纯客户端，无服务器）。
// - 关键词：CJK 友好的 BM25（拉丁词 + 汉字二元组）
// - 向量：由调用方传入余弦分
// - 遗忘：Ebbinghaus 保持率，按重要度/情绪唤醒度减缓衰减

import type { MemoryEntry } from "./memory-types";

/** CJK 友好分词：拉丁单词 + 汉字二元组（相邻两字）+ 单字兜底。 */
export function tokenizeForSearch(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const tokens: string[] = [];
    // 拉丁 / 数字词
    const latin = lower.match(/[a-z0-9]+/g);
    if (latin) tokens.push(...latin);
    // 汉字
    const han = lower.match(/[一-鿿]/g) || [];
    for (let i = 0; i < han.length; i++) {
        tokens.push(han[i]);
        if (i + 1 < han.length) tokens.push(han[i] + han[i + 1]); // 二元组
    }
    return tokens;
}

/** 对候选集算 BM25 原始分。docsTokens 顺序与返回分数一一对应。 */
export function bm25Scores(queryTokens: string[], docsTokens: string[][], k1 = 1.5, b = 0.75): number[] {
    const N = docsTokens.length;
    if (N === 0) return [];
    const dl = docsTokens.map((d) => d.length);
    const avgdl = dl.reduce((a, c) => a + c, 0) / N || 1;
    // 文档频率
    const df = new Map<string, number>();
    const docSets = docsTokens.map((d) => new Set(d));
    for (const s of docSets) for (const t of s) df.set(t, (df.get(t) || 0) + 1);
    // 查询词去重
    const qTerms = Array.from(new Set(queryTokens));
    // 每个文档的词频表
    const tfMaps = docsTokens.map((d) => {
        const m = new Map<string, number>();
        for (const t of d) m.set(t, (m.get(t) || 0) + 1);
        return m;
    });
    const scores = new Array(N).fill(0);
    for (const term of qTerms) {
        const n = df.get(term);
        if (!n) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        for (let i = 0; i < N; i++) {
            const tf = tfMaps[i].get(term);
            if (!tf) continue;
            const denom = tf + k1 * (1 - b + b * (dl[i] / avgdl));
            scores[i] += idf * ((tf * (k1 + 1)) / denom);
        }
    }
    return scores;
}

/** 记忆强度（天）：重要度、情绪唤醒度越高，忘得越慢。 */
export function memoryStrengthDays(entry: MemoryEntry): number {
    const importance = typeof entry.importance === "number" ? entry.importance : 0.5;
    const arousal = typeof entry.arousal === "number" ? entry.arousal : 0.4;
    return 14 * (1 + 2 * importance) * (1 + 1.5 * arousal); // ~14 天(弱) → ~112 天(强)
}

/** Ebbinghaus 保持率 0.05~1，越老越低，但不清零（重要记忆仍可被召回）。 */
export function retentionFactor(entry: MemoryEntry, now = Date.now()): number {
    const created = new Date(entry.createdAt).getTime();
    if (!Number.isFinite(created)) return 1;
    const ageDays = Math.max(0, (now - created) / 86400000);
    const strength = memoryStrengthDays(entry);
    return Math.max(0.05, Math.min(1, Math.exp(-ageDays / strength)));
}

function minMaxNormalize(arr: number[]): number[] {
    if (arr.length === 0) return arr;
    let lo = Infinity, hi = -Infinity;
    for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi <= lo) return arr.map(() => (hi > 0 ? 1 : 0));
    return arr.map((v) => (v - lo) / (hi - lo));
}

export type HybridInput = {
    entries: MemoryEntry[];
    query: string;
    /** 与 entries 一一对应的向量余弦分；无向量时传 null。 */
    vectorScores: (number | null)[] | null;
    now?: number;
};

/** 混合分 = (0.6·向量 + 0.4·关键词) · (0.5 + 0.5·保持率)；无向量时纯关键词。返回按分降序的条目。 */
export function rankMemoriesHybrid(input: HybridInput): MemoryEntry[] {
    const { entries, query } = input;
    if (entries.length === 0) return [];
    const now = input.now ?? Date.now();

    const docsTokens = entries.map((e) => tokenizeForSearch(`${e.title || ""} ${(e.tags || []).join(" ")} ${e.content}`));
    const bm = minMaxNormalize(bm25Scores(tokenizeForSearch(query), docsTokens));

    const hasVec = Boolean(input.vectorScores && input.vectorScores.some((v) => typeof v === "number"));
    const vec = hasVec ? minMaxNormalize((input.vectorScores as (number | null)[]).map((v) => (typeof v === "number" ? v : 0))) : null;

    const wVec = hasVec ? 0.6 : 0;
    const wBm = hasVec ? 0.4 : 1;

    const scored = entries.map((entry, i) => {
        const relevance = wVec * (vec ? vec[i] : 0) + wBm * bm[i];
        const final = relevance * (0.5 + 0.5 * retentionFactor(entry, now));
        return { entry, final };
    });
    scored.sort((a, b) => b.final - a.final);
    return scored.map((s) => s.entry);
}
