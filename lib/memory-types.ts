// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
    // —— Ombre 式结构化字段（第一批：情绪坐标 + 标签 + 一句话概括，全部可选、向后兼容）——
    title?: string;             // 一句话概括
    tags?: string[];            // 关键词标签
    valence?: number;           // 情绪效价 -1(负面) ~ 1(正面)
    arousal?: number;           // 情绪唤醒度/强度 0(平静) ~ 1(激烈)
    // —— Ombre-Brain 复刻：记忆桶类型与状态标记（全部可选、向后兼容；缺省 = 普通动态记忆）——
    kind?: MemoryKind;
    domain?: string[];          // 主题域（饮食 / 恋爱 / 学习 …）
    pinned?: boolean;           // 核心准则：每次必浮现、不衰减、importance 锁 10（上限 20）
    protected?: boolean;        // 只防衰减、不主动浮现（上限 20，与 pinned 互斥）
    resolved?: boolean;         // 已结案：衰减 ×0.05，检索排名 ×0.3
    digested?: boolean;         // 已被 feel 消化过：不再主动浮现
    anchored?: boolean;         // 锚点：冷参照，不浮现、不衰减（上限 24）
    dontSurface?: boolean;      // 不主动浮现（仍可检索）
    activationCount?: number;   // 被真正激活（强化 / 合并）的次数，新建为 0
    lastActive?: string;        // 最后一次真实激活时间（衰减以它为起点）
    whyRemembered?: string;     // 第一人称：为什么值得留下
    meaning?: string;           // 第一人称：这件事对我意味着什么
    sourceBucketId?: string;    // feel 桶：由哪条记忆引发
    planStatus?: "active" | "done" | "dropped";
    resolutionSuggestion?: { byId: string; confidence: number; reason?: string; at: string };
    letterLock?: { type: "none" | "timed" | "permanent"; unlockAt?: string };
    selfAspect?: string;        // I 桶：nature / values / patterns / limits / becoming / uncertainty / stance
    selfStatus?: "candidate" | "promoted" | "superseded";
    selfWitnessDates?: string[];// I 候选被 dream 见证过的日期（≥3 个不同日期 → 升格）
    supersedes?: string;        // I 桶：取代了哪一条旧认识
};

/** Ombre 记忆桶类型：dynamic 普通 / permanent 固化 / feel 感受 / plan 计划 / letter 信 / i 自我认识 */
export type MemoryKind = "dynamic" | "permanent" | "feel" | "plan" | "letter" | "i";

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    emotionTaggingEnabled?: boolean;        // 记忆情绪打标（valence/arousal/tags/title），折进同一次总结调用、不额外花额度
    autoArchiveEnabled?: boolean;           // 遗忘落地：保持率极低且不重要的长期记忆自动归档（不再主动召回，仍可搜/恢复）
    archiveRetentionThreshold?: number;     // （旧）保持率阈值，已由 decayArchiveThreshold 取代
    decayArchiveThreshold?: number;         // Ombre 衰减分低于此值自动归档（默认 0.3）
    autoResolveEnabled?: boolean;           // Ombre 自动结案：importance≤4 且 30 天未激活 → resolved
    ombreExtractionEnabled?: boolean;       // Ombre 拆条：每段对话提取 0~5 条独立记忆并与相似旧记忆合并（关掉则回到一段一总结）
    breathMaxResults?: number;              // 每次浮现的记忆条数上限（不含核心准则，默认 20）
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记

总结：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    emotionTaggingEnabled: true,
    autoArchiveEnabled: true,
    archiveRetentionThreshold: 0.12,
    decayArchiveThreshold: 0.3,
    autoResolveEnabled: true,
    ombreExtractionEnabled: true,
    breathMaxResults: 20,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};
