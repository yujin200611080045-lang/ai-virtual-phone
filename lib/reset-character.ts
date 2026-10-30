// 重置角色：清除某一个角色「建卡以来生成的所有痕迹」，
// 保留角色卡本身、聊天/世界书/预设/API 等设置，以及其他角色自身的数据。
//
// 多人内容（群聊、剧情群组、共享朋友圈圈子）也会把这个角色清理出去：
// 删除他的成员身份与他本人的发言 / 动态 / 关系；清不干净的历史互动（比如别的
// 角色回复过他的消息）会作为「无名空壳」残留，这是可接受的。
// 唯一不动的是地图冒险（AiPhoneMapDB）——它按「世界」而非角色存储，一个世界
// 可能同场多名角色，无法干净抽离，故保留以免误伤其他角色。
//
// 所有删除都走各模块自己的公开接口，避免直接操作 Dexie 造成缓存与库不同步。

import {
  loadChatContacts,
  loadChatSessions,
  saveChatSessions,
  loadChatMessages,
  deleteChatMessagesByIds,
  deleteChatSession,
  removeChatContact,
} from "./chat-storage";
import { deleteCharacterMemories } from "./memory-storage";
import { getAllPosts, deleteMomentPost, loadAllMomentComments, deleteMomentComment } from "./moments-storage";
import { clearDwellingData } from "./dwelling-storage";
import { clearPhoneManifest, clearPhoneSnapshot, clearCheckPhoneProjectionEntries } from "./checkphone-storage";
import { CHECKPHONE_APP_SPECS, type CheckPhoneAppId } from "./checkphone-config";
import { loadDiaryEntries, deleteDiaryEntry } from "./diary-entry-storage";
import { deleteStorySessionsByCharacter, loadStoryGroups, updateStoryGroup, deleteStoryGroup } from "./story-storage";
import { deleteVnSessionsByCharacter } from "./vn-storage";
import { loadCharacterWorldGroups, saveCharacterWorldGroups } from "./character-world-storage";
import { kvKeysWithPrefix, kvRemove } from "./kv-db";

export type ResetCharacterReport = {
  characterId: string;
  chatSessions: number;
  groupChatsLeft: number;
  groupMessages: number;
  moments: number;
  momentComments: number;
  story: number;
  storyGroups: number;
  vn: number;
  diary: number;
  worldGroups: number;
  memoriesCleared: boolean;
  dwellingCleared: boolean;
  checkphoneCleared: boolean;
  kvKeysRemoved: number;
  errors: string[];
};

// 这些 kv 键都是「前缀 + 角色ID」形式，属于单个角色的计数/事件投影。
// 不含地图相关（map_adventure_summary_ 等），地图不在重置范围内。
const PER_CHARACTER_KV_PREFIXES = [
  "ai_phone_mem_evt_count_",
  "ai_phone_mem_last_sum_",
  "ai_phone_mem_core_count_",
  "ai_phone_mem_last_core_sum_",
  "note_wall_events_",
  "ai_phone_interview_magazine_events_",
  "ai_phone_cocreate_events_",
  "xiaohongshu_events_",
  "ai_phone_xiaohongshu_events_",
  "ai_phone_black_market_theater_events_",
];

function removePerCharacterKv(characterId: string): number {
  let removed = 0;
  for (const prefix of PER_CHARACTER_KV_PREFIXES) {
    for (const key of kvKeysWithPrefix(prefix)) {
      const rest = key.slice(prefix.length);
      // 精确匹配角色ID，或以「角色ID:」开头，避免 "abc" 误删 "abc2" 的键。
      if (rest === characterId || rest.startsWith(`${characterId}:`)) {
        kvRemove(key);
        removed += 1;
      }
    }
  }
  return removed;
}

/**
 * 清除某个角色建卡以来生成的所有痕迹。角色卡、全局设置与其他角色的「本体」数据
 * 保持不变；该角色会被清理出所有多人内容（群聊 / 剧情群组 / 共享朋友圈）。
 *
 * 调用方应在调用前自行完成「导出备份 + 用户确认」。
 */
export async function resetCharacterTraces(characterId: string): Promise<ResetCharacterReport> {
  const report: ResetCharacterReport = {
    characterId,
    chatSessions: 0,
    groupChatsLeft: 0,
    groupMessages: 0,
    moments: 0,
    momentComments: 0,
    story: 0,
    storyGroups: 0,
    vn: 0,
    diary: 0,
    worldGroups: 0,
    memoriesCleared: false,
    dwellingCleared: false,
    checkphoneCleared: false,
    kvKeysRemoved: 0,
    errors: [],
  };

  if (!characterId || typeof window === "undefined") {
    report.errors.push("无效的角色或运行环境");
    return report;
  }

  // 1) 私聊：顺着 角色→联系人→会话→消息 删干净。
  try {
    const contactIds = new Set(
      loadChatContacts().filter((c) => c.characterId === characterId).map((c) => c.id),
    );
    if (contactIds.size > 0) {
      const sessions = loadChatSessions().filter((s) => contactIds.has(s.contactId));
      for (const session of sessions) {
        deleteChatSession(session.id); // 连带清除该会话的消息
        report.chatSessions += 1;
      }
    }
    removeChatContact(characterId);
  } catch (err) {
    report.errors.push(`私聊: ${String(err)}`);
  }

  // 2) 群聊：把该角色移出每个群，删掉他本人的发言；群里只剩他一人则整群删除。
  //    其他角色回复过他的历史消息保留（作为无名空壳）。
  try {
    const sessions = loadChatSessions();
    const nextSessions: typeof sessions = [];
    let sessionsChanged = false;
    for (const session of sessions) {
      const members = session.participantIds;
      if (!session.isGroup || !Array.isArray(members) || !members.includes(characterId)) {
        nextSessions.push(session);
        continue;
      }
      const remaining = members.filter((id) => id !== characterId);
      // 先删掉该角色在本群发过的消息
      try {
        const myMsgIds = loadChatMessages(session.id)
          .filter((m) => m.senderCharacterId === characterId)
          .map((m) => m.id);
        if (myMsgIds.length > 0) {
          report.groupMessages += deleteChatMessagesByIds(session.id, myMsgIds);
        }
      } catch (err) {
        report.errors.push(`群聊消息: ${String(err)}`);
      }
      if (remaining.length === 0) {
        // 群里只有他 → 整群连消息一起删
        deleteChatSession(session.id);
        report.groupChatsLeft += 1;
        sessionsChanged = true;
        continue;
      }
      // 从成员及各类成员映射里剔除该角色
      const next = { ...session, participantIds: remaining };
      if (Array.isArray(next.groupAdminIds)) next.groupAdminIds = next.groupAdminIds.filter((id) => id !== characterId);
      if (next.groupOwnerId === characterId) next.groupOwnerId = "self";
      if (next.groupMutes) { const m = { ...next.groupMutes }; delete m[characterId]; next.groupMutes = m; }
      if (next.groupVideoBackgrounds) { const m = { ...next.groupVideoBackgrounds }; delete m[characterId]; next.groupVideoBackgrounds = m; }
      nextSessions.push(next);
      report.groupChatsLeft += 1;
      sessionsChanged = true;
    }
    if (sessionsChanged) saveChatSessions(nextSessions);
  } catch (err) {
    report.errors.push(`群聊: ${String(err)}`);
  }

  // 3) 记忆
  try {
    await deleteCharacterMemories(characterId);
    report.memoriesCleared = true;
  } catch (err) {
    report.errors.push(`记忆: ${String(err)}`);
  }

  // 4) 朋友圈：删除该角色发布的动态，以及该角色发表的评论、被删动态下的评论。
  try {
    const myPostIds = new Set(
      getAllPosts()
        .filter((p) => p.authorType === "character" && p.authorId === characterId)
        .map((p) => p.id),
    );
    for (const id of myPostIds) {
      deleteMomentPost(id);
      report.moments += 1;
    }
    for (const comment of loadAllMomentComments()) {
      const authoredByChar = comment.authorType !== "user" && comment.authorId === characterId;
      if (authoredByChar || myPostIds.has(comment.postId)) {
        deleteMomentComment(comment.id);
        report.momentComments += 1;
      }
    }
  } catch (err) {
    report.errors.push(`朋友圈: ${String(err)}`);
  }

  // 5) 共享朋友圈世界：把该角色移出每个圈子，并删除涉及他的关系线。
  try {
    const groups = loadCharacterWorldGroups();
    let changed = false;
    const next = groups.map((g) => {
      const inMembers = g.memberIds.includes(characterId);
      const inRelations = g.relations.some(
        (r) => r.fromCharacterId === characterId || r.toCharacterId === characterId,
      );
      if (!inMembers && !inRelations) return g;
      changed = true;
      report.worldGroups += 1;
      return {
        ...g,
        memberIds: g.memberIds.filter((id) => id !== characterId),
        relations: g.relations.filter(
          (r) => r.fromCharacterId !== characterId && r.toCharacterId !== characterId,
        ),
        updatedAt: new Date().toISOString(),
      };
    });
    if (changed) saveCharacterWorldGroups(next);
  } catch (err) {
    report.errors.push(`朋友圈圈子: ${String(err)}`);
  }

  // 6) 故事：单人剧情线直接删；剧情群组把他移出，空组删除（群组消息无单条作者，残留为空壳）。
  try {
    report.story = deleteStorySessionsByCharacter(characterId).sessions;
    for (const group of loadStoryGroups()) {
      if (!group.memberIds.includes(characterId)) continue;
      const remaining = group.memberIds.filter((id) => id !== characterId);
      if (remaining.length === 0) {
        deleteStoryGroup(group.id);
      } else {
        // updateStoryGroup 会在 lead 不在成员内时自动改选 lead
        updateStoryGroup(group.id, { memberIds: remaining });
      }
      report.storyGroups += 1;
    }
  } catch (err) {
    report.errors.push(`故事: ${String(err)}`);
  }

  // 7) 漫卷（视觉小说，单人）
  try {
    report.vn = deleteVnSessionsByCharacter(characterId).sessions;
  } catch (err) {
    report.errors.push(`漫卷: ${String(err)}`);
  }

  // 8) 日记
  try {
    for (const entry of loadDiaryEntries().filter((e) => e.characterId === characterId)) {
      deleteDiaryEntry(entry.id);
      report.diary += 1;
    }
  } catch (err) {
    report.errors.push(`日记: ${String(err)}`);
  }

  // 9) 住宅
  try {
    await clearDwellingData(characterId);
    report.dwellingCleared = true;
  } catch (err) {
    report.errors.push(`住宅: ${String(err)}`);
  }

  // 10) 查手机快照（含各 app 快照、清单与事件投影）
  try {
    await clearPhoneManifest(characterId);
    clearCheckPhoneProjectionEntries(characterId);
    const appIds = Object.keys(CHECKPHONE_APP_SPECS) as CheckPhoneAppId[];
    for (const appId of appIds) {
      await clearPhoneSnapshot(characterId, appId);
    }
    report.checkphoneCleared = true;
  } catch (err) {
    report.errors.push(`查手机: ${String(err)}`);
  }

  // 11) 该角色相关的 kv 计数与事件投影
  try {
    report.kvKeysRemoved = removePerCharacterKv(characterId);
  } catch (err) {
    report.errors.push(`计数/事件: ${String(err)}`);
  }

  return report;
}
