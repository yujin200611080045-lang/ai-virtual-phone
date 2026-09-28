// lib/ombre-tool-executor.ts
// 记忆库（Ombre）内部工具执行：breath / breath_search / hold / grow / trace / plan / anchor / release /
// feel / dream / pulse / letter_write / letter_read / letter_lock_update / I

import type { ToolCall, ToolExecutionContext, ToolResult } from "./tool-executor";
import { getInternalCapability, OMBRE_MEMORY_CAPABILITY_ID, OMBRE_MEMORY_TOOL_NAMES } from "./internal-capability-storage";
import { loadMemoryConfig, loadMemoryEntries } from "./memory-storage";
import {
    anchorMemory,
    dreamReport,
    feelSearch,
    formatSurfacedMemories,
    growMemories,
    holdMemory,
    isArchivedMemory,
    letterIsReadable,
    memKind,
    pulseReport,
    releaseAnchor,
    renderEntryForTool,
    searchMemoriesOmbre,
    selectBreathSurface,
    traceMemory,
    updateLetterLock,
    writeLetter,
    writePlan,
    writeSelfCandidate,
    type TracePatch,
} from "./memory-ombre";

export function isOmbreMemoryToolName(name: string): boolean {
    if (!OMBRE_MEMORY_TOOL_NAMES.has(name)) return false;
    const cap = getInternalCapability(OMBRE_MEMORY_CAPABILITY_ID);
    return Boolean(cap && cap.enabled && cap.mode !== "off");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
const arr = (v: unknown): string[] | undefined => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === "string" && v.trim()) return v.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
    return undefined;
};

function readResult(name: string, data: string, notice: string): ToolResult {
    return { name, success: true, data, continueConversation: true, persistToHistory: true, userNotice: notice };
}

function writeResult(name: string, data: string, notice: string): ToolResult {
    return { name, success: true, data, continueConversation: false, persistToHistory: true, userNotice: notice };
}

function fail(name: string, message: string): ToolResult {
    return { name, success: false, error: message, continueConversation: false, persistToHistory: false, userNotice: `${name} 失败：${message}` };
}

export async function executeOmbreMemoryTool(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
    const name = call.name;
    const characterId = context?.characterId;
    if (!characterId) return fail(name, "当前场景没有角色，无法使用记忆库");
    const a = call.args || {};
    const writeOpts = { sourceApp: (context?.appId === "group_chat" ? "group_chat" : "chat") as "chat", origin: "ai_tool", metadata: context?.sessionId ? { sessionId: context.sessionId } : undefined };

    try {
        switch (name) {
            case "breath": {
                const all = await loadMemoryEntries(characterId);
                const cfg = loadMemoryConfig();
                const surfaced = selectBreathSurface(all.filter((e) => e.type === "long_term"), { maxResults: cfg.breathMaxResults ?? 20, tokenBudget: 20000 });
                const text = formatSurfacedMemories(surfaced, { withIds: true });
                return readResult(name, text || "我的记忆池现在很安静，没什么需要主动浮现的。可以用 breath_search 找具体的事，或者 dream 翻翻最近。", "翻了翻记忆");
            }
            case "breath_search": {
                const query = str(a.query) ?? "";
                const limit = num(a.limit) ?? 8;
                const hits = await searchMemoriesOmbre(characterId, query, {
                    includeArchive: bool(a.include_archive),
                    domain: str(a.domain),
                    tags: arr(a.tags),
                    importanceMin: num(a.importance_min),
                    valence: num(a.valence),
                    arousal: num(a.arousal),
                    limit,
                });
                if (hits.length === 0) return readResult(name, `没有找到和「${query}」相关的记忆。`, `搜索记忆：${query}`);
                const catalog = bool(a.catalog);
                const lines = hits.map((h) => catalog
                    ? `[id:${h.entry.id}] ${h.entry.title || h.entry.content.slice(0, 24)}${isArchivedMemory(h.entry) ? "（已归档，可 trace(restore=true)）" : ""}`
                    : `${renderEntryForTool(h.entry)}${isArchivedMemory(h.entry) ? "\n（已归档，可 trace(restore=true) 恢复）" : ""}`);
                return readResult(name, lines.join(catalog ? "\n" : "\n---\n"), `搜索记忆：${query}`);
            }
            case "hold": {
                const content = str(a.content);
                if (!content) return fail(name, "缺少 content");
                const r = await holdMemory(characterId, {
                    content,
                    title: str(a.title),
                    tags: arr(a.tags),
                    importance: num(a.importance),
                    pinned: bool(a.pinned),
                    feel: bool(a.feel),
                    sourceBucket: str(a.source_bucket),
                    valence: num(a.valence),
                    arousal: num(a.arousal),
                    whyRemembered: str(a.why_remembered),
                    meaning: str(a.meaning),
                }, writeOpts);
                if (r.note === "feel") return writeResult(name, `感受已沉淀 [id:${r.entry.id}]`, "记下了一份感受");
                return writeResult(
                    name,
                    r.merged ? `和旧记忆合并了 [id:${r.entry.id}] ${r.entry.title || ""}` : `新记忆 [id:${r.entry.id}] ${r.entry.title || ""}`,
                    r.merged ? `记忆加深：${r.entry.title || content.slice(0, 16)}` : `记住了：${r.entry.title || content.slice(0, 16)}`,
                );
            }
            case "grow": {
                const content = str(a.content);
                if (!content) return fail(name, "缺少 content");
                const r = await growMemories(characterId, content, writeOpts);
                const total = r.created + r.merged + r.plans;
                const summary = `${total}条|新${r.created}合${r.merged}${r.plans ? `|计划${r.plans}` : ""}`;
                return writeResult(name, `${summary}\n${r.entries.map((e) => `[id:${e.id}] ${e.title || e.content.slice(0, 20)}`).join("\n")}`, `整理进记忆：${summary}`);
            }
            case "trace": {
                const id = str(a.bucket_id) ?? str(a.id);
                if (!id) return fail(name, "缺少 bucket_id");
                const status = str(a.status);
                const patch: TracePatch = {
                    title: typeof a.title === "string" ? a.title : undefined,
                    tags: arr(a.tags),
                    domain: arr(a.domain),
                    importance: num(a.importance),
                    valence: num(a.valence),
                    arousal: num(a.arousal),
                    resolved: bool(a.resolved),
                    pinned: bool(a.pinned),
                    protected: bool(a.protected),
                    dontSurface: bool(a.dont_surface),
                    digested: bool(a.digested),
                    content: str(a.content),
                    oldStr: typeof a.old_str === "string" ? a.old_str : undefined,
                    newStr: typeof a.new_str === "string" ? a.new_str : undefined,
                    status: status === "active" || status === "done" || status === "dropped" ? status : undefined,
                    whyRemembered: typeof a.why_remembered === "string" ? a.why_remembered : undefined,
                    meaning: typeof a.meaning === "string" ? a.meaning : undefined,
                    reinforce: bool(a.reinforce),
                    delete: bool(a.delete),
                    restore: bool(a.restore),
                };
                const r = await traceMemory(characterId, id, patch);
                const label = r.entry.title || r.entry.content.slice(0, 16);
                return writeResult(name, `[id:${r.entry.id}] ${r.changes.join("、") || "没有改动"}`, `${label}：${r.changes.join("、") || "没有改动"}`);
            }
            case "plan": {
                const content = str(a.content);
                if (!content) return fail(name, "缺少 content");
                const r = await writePlan(characterId, { content, title: str(a.title), importance: num(a.importance) }, writeOpts);
                return writeResult(name, r.created ? `计划已记下 [id:${r.entry.id}]` : `这个计划已经在了 [id:${r.entry.id}]`, r.created ? `记下计划：${content.slice(0, 20)}` : "这个计划已经记着了");
            }
            case "anchor": {
                const id = str(a.bucket_id) ?? str(a.id);
                if (!id) return fail(name, "缺少 bucket_id");
                const e = await anchorMemory(characterId, id, str(a.reason));
                return writeResult(name, `⚓ 已设为锚点 [id:${e.id}]`, `⚓ 锚点：${e.title || e.content.slice(0, 16)}`);
            }
            case "release": {
                const id = str(a.bucket_id) ?? str(a.id);
                if (!id) return fail(name, "缺少 bucket_id");
                const e = await releaseAnchor(characterId, id);
                return writeResult(name, `已取消锚点 [id:${e.id}]`, `取消锚点：${e.title || e.content.slice(0, 16)}`);
            }
            case "feel": {
                const list = await feelSearch(characterId, str(a.query) ?? "");
                if (list.length === 0) return readResult(name, "没有找到对应的感受。", "翻了翻感受");
                return readResult(name, list.map((e) => `[${e.createdAt.slice(0, 10)} · id:${e.id}] ${e.content}`).join("\n"), "翻了翻感受");
            }
            case "dream": {
                return readResult(name, await dreamReport(characterId), "🌙 做了个梦");
            }
            case "pulse": {
                return readResult(name, await pulseReport(characterId), "看了看记忆库");
            }
            case "letter_write": {
                const content = str(a.content);
                if (!content) return fail(name, "缺少 content");
                const lock = str(a.lock);
                const e = await writeLetter(characterId, {
                    content,
                    title: str(a.title),
                    to: str(a.to),
                    lock: lock === "timed" || lock === "permanent" ? lock : "none",
                    unlockDate: str(a.unlock_date),
                }, writeOpts);
                return writeResult(name, `信已收好 [id:${e.id}] ${e.title}`, `✉️ 写了一封信：${e.title}`);
            }
            case "letter_read": {
                const all = await loadMemoryEntries(characterId);
                const letters = all.filter((e) => memKind(e) === "letter").sort((x, y) => y.createdAt.localeCompare(x.createdAt));
                const id = str(a.id) ?? str(a.bucket_id);
                if (!id) {
                    if (letters.length === 0) return readResult(name, "还没有写过信。", "翻了翻信");
                    return readResult(name, letters.map((e) => {
                        const lock = e.letterLock?.type ?? "none";
                        const state = lock === "permanent" ? "🔒永久封存" : lock === "timed" && !letterIsReadable(e) ? `⏳${(e.letterLock?.unlockAt || "").slice(0, 10)} 才能拆` : "可读";
                        return `[${e.createdAt.slice(0, 10)} · id:${e.id}] ${e.title}（${state}）`;
                    }).join("\n"), "翻了翻信");
                }
                const letter = letters.find((e) => e.id === id || e.id.endsWith(id));
                if (!letter) return fail(name, `找不到这封信：${id}`);
                if (!letterIsReadable(letter)) {
                    const lock = letter.letterLock?.type;
                    return readResult(name, lock === "permanent" ? `「${letter.title}」永久封存着，不拆。` : `「${letter.title}」要到 ${(letter.letterLock?.unlockAt || "").slice(0, 10)} 才能拆。`, "这封信还没到拆的时候");
                }
                return readResult(name, `「${letter.title}」 ${letter.createdAt.slice(0, 10)}\n\n${letter.content}`, `读信：${letter.title}`);
            }
            case "letter_lock_update": {
                const id = str(a.id) ?? str(a.bucket_id);
                const lock = str(a.lock);
                if (!id || !(lock === "none" || lock === "timed" || lock === "permanent")) return fail(name, "需要 id 和 lock（none / timed / permanent）");
                const e = await updateLetterLock(characterId, id, lock, str(a.unlock_date));
                return writeResult(name, `信的锁已改为 ${lock} [id:${e.id}]`, `改了信的锁：${e.title}`);
            }
            case "I": {
                const content = str(a.content);
                if (!content) return fail(name, "缺少 content");
                const e = await writeSelfCandidate(characterId, { content, aspect: str(a.aspect), supersedes: str(a.supersedes) }, writeOpts);
                return writeResult(name, `自我认识候选 [id:${e.id}]：之后在 3 个不同日子的 dream 里仍认同，就会确认下来。`, "写下了一条对自己的认识");
            }
        }
    } catch (err) {
        return fail(name, err instanceof Error ? err.message : String(err));
    }
    return fail(name, "未知记忆库动作");
}
