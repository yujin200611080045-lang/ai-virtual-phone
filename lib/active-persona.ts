// lib/active-persona.ts
// 「当前用户人设」视图：聊天 App 的四个页面（消息/联系人/动态/主页）按角色所绑定的
// 用户身份进行过滤——相当于在同一台手机里切换两套"分身"。点消息页顶部的头像切换。
//
// 归属判定走绑定级联（resolveBinding）：角色显式绑定的用户身份优先，未绑定则回落到全局默认。
// 当前人设为 null 表示「全部」——不过滤，显示所有会话/联系人/动态。

import { kvGet, kvSet } from "./kv-db";
import { loadBindingConfig, resolveBinding } from "./settings-storage";

const KEY = "ai_phone_active_persona_v1";
export const ACTIVE_PERSONA_EVENT = "active-persona-changed";

/** 当前人设 id；null = 全部（不过滤）。 */
export function getActivePersonaId(): string | null {
    if (typeof window === "undefined") return null;
    const v = kvGet(KEY);
    return v && v.trim() ? v : null;
}

export function setActivePersonaId(id: string | null): void {
    if (typeof window === "undefined") return;
    kvSet(KEY, id || "");
    window.dispatchEvent(new CustomEvent(ACTIVE_PERSONA_EVENT, { detail: id || null }));
}

/** 订阅当前人设变化，返回取消订阅函数。 */
export function subscribeActivePersona(cb: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    const handler = () => cb();
    window.addEventListener(ACTIVE_PERSONA_EVENT, handler);
    return () => window.removeEventListener(ACTIVE_PERSONA_EVENT, handler);
}

/** 某角色归属的用户身份 id（走绑定级联，未绑定→全局默认）。 */
export function personaOfCharacter(characterId?: string): string | undefined {
    if (!characterId) return undefined;
    try {
        return resolveBinding(loadBindingConfig(), characterId).userIdentityId;
    } catch {
        return undefined;
    }
}

/**
 * 该角色是否落在「当前人设」视图内。
 * - 当前人设为 null（全部）→ 恒真。
 * - 否则：角色绑定的用户身份 === 当前人设。
 */
export function characterInActivePersona(characterId?: string): boolean {
    const active = getActivePersonaId();
    if (!active) return true;
    if (!characterId) return false;
    return personaOfCharacter(characterId) === active;
}
