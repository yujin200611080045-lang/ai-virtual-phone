// 重置角色：清除某一个角色「建卡以来生成的所有痕迹」，
// 保留角色卡本身、聊天/世界书/预设/API 等设置与其他角色的数据。
//
// 设计原则（与产品约定一致）：
// - 只清这个角色「单人」产生的内容；凡是与其他角色共享的多人内容一律保留：
//   · 群聊会话、剧情群组（StoryGroup）、共享朋友圈圈子都不动。
// - 地图冒险（AiPhoneMapDB）是按「世界」而非角色存储的，一个世界可能有多名角色，
//   无法干净地只抽走一个角色，故不在此处清除（避免误伤其他角色）。
//
// 所有删除都走各模块自己的公开接口，避免直接操作 Dexie 造成缓存与库不同步。

import { loadChatContacts, loadChatSessions, deleteChatSession, removeChatContact } from "./chat-storage";
import { deleteCharacterMemories } from "./memory-storage";
import { getAllPosts, deleteMomentPost, loadAllMomentComments, deleteMomentComment } from "./moments-storage";
import { clearDwellingData } from "./dwelling-storage";
import { clearPhoneManifest, clearPhoneSnapshot, clearCheckPhoneProjectionEntries } from "./checkphone-storage";
import { CHECKPHONE_APP_SPECS, type CheckPhoneAppId } from "./checkphone-config";
import { loadDiaryEntries, deleteDiaryEntry } from "./diary-entry-storage";
import { deleteStorySessionsByCharacter } from "./story-storage";
import { deleteVnSessionsByCharacter } from "./vn-storage";
import { kvKeysWithPrefix, kvRemove } from "./kv-db";

export type ResetCharacterReport = {
  characterId: string;
  chatSessions: number;
  moments: number;
  momentComments: number;
  story: number;
  vn: number;
  diary: number;
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
 * 清除某个角色建卡以来生成的所有痕迹（聊天、记忆、朋友圈、故事、漫卷、日记、
 * 住宅、查手机、相关计数/事件）。角色卡、设置与其他角色数据保持不变。
 *
 * 调用方应在调用前自行完成「导出备份 + 用户确认」。
 */
export async function resetCharacterTraces(characterId: string): Promise<ResetCharacterReport> {
  const report: ResetCharacterReport = {
    characterId,
    chatSessions: 0,
    moments: 0,
    momentComments: 0,
    story: 0,
    vn: 0,
    diary: 0,
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

  // 1) 私聊：顺着 角色→联系人→会话→消息 删干净；群聊（contactId 为群组）不受影响。
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
    report.errors.push(`聊天: ${String(err)}`);
  }

  // 2) 记忆
  try {
    await deleteCharacterMemories(characterId);
    report.memoriesCleared = true;
  } catch (err) {
    report.errors.push(`记忆: ${String(err)}`);
  }

  // 3) 朋友圈：删除该角色发布的动态，以及该角色发表的评论、被删动态下的评论。
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

  // 4) 故事（单人剧情线，群像不动）
  try {
    report.story = deleteStorySessionsByCharacter(characterId).sessions;
  } catch (err) {
    report.errors.push(`故事: ${String(err)}`);
  }

  // 5) 漫卷（视觉小说）
  try {
    report.vn = deleteVnSessionsByCharacter(characterId).sessions;
  } catch (err) {
    report.errors.push(`漫卷: ${String(err)}`);
  }

  // 6) 日记
  try {
    for (const entry of loadDiaryEntries().filter((e) => e.characterId === characterId)) {
      deleteDiaryEntry(entry.id);
      report.diary += 1;
    }
  } catch (err) {
    report.errors.push(`日记: ${String(err)}`);
  }

  // 7) 住宅
  try {
    await clearDwellingData(characterId);
    report.dwellingCleared = true;
  } catch (err) {
    report.errors.push(`住宅: ${String(err)}`);
  }

  // 8) 查手机快照（含各 app 快照、清单与事件投影）
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

  // 9) 该角色相关的 kv 计数与事件投影
  try {
    report.kvKeysRemoved = removePerCharacterKv(characterId);
  } catch (err) {
    report.errors.push(`计数/事件: ${String(err)}`);
  }

  return report;
}
