// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";
import { formatSurfacedMemories } from "./memory-ombre";
import { getInternalCapability, OMBRE_MEMORY_CAPABILITY_ID } from "./internal-capability-storage";

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles token-budget filtering,
 * so this just formats the selected entries.
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";
    // 记忆库工具开着时带上 id，角色才能直接 trace / anchor 某一条
    let withIds = false;
    try {
        const cap = getInternalCapability(OMBRE_MEMORY_CAPABILITY_ID);
        withIds = Boolean(cap && cap.enabled && cap.mode !== "off");
    } catch { /* ignore */ }
    return formatSurfacedMemories(memories, { withIds });
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}
