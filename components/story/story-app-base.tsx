"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpenIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  StopIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";

/* 三条粗横条的实心菜单图标，与实心图标集的笔画粗细一致 */
function SolidMenuIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="4.6" width="18" height="2.8" />
      <rect x="3" y="10.6" width="18" height="2.8" />
      <rect x="3" y="16.6" width="18" height="2.8" />
    </svg>
  );
}

/* 粗笔画「‹」返回图标，笔画粗细与菜单横条一致 */
function SolidBackIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 5 L8 12 L15 19"
        stroke="currentColor"
        strokeWidth={2.8}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Avatar } from "@/components/ui/primitives";
import { StoryDialLauncher } from "./story-dial-launcher";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { incrementEventCounter } from "@/lib/memory-storage";
import { resolveUserIdentity, loadPresets } from "@/lib/settings-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  createOrGetStorySession,
  hydrateStoryStorage,
  loadStoryMessages,
  loadStorySessions,
  pushStoryMessage,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  editStoryMessage,
  type StoryMessage,
  type StorySession,
  updateStorySession,
  loadStoryGroups,
  getStoryGroup,
  createStoryGroup,
  updateStoryGroup,
  deleteStoryGroup,
  type StoryGroup,
} from "@/lib/story-storage";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";

type StoryAppProps = {
  onClose: () => void;
};

type StoryGenerationRun = {
  runId: string;
  controller: AbortController;
};

const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();

function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController(),
  };
  activeStoryGenerationRuns.set(sessionId, run);
  return run;
}

function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted);
}

function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run || run.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  return true;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;
const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "纸白" },
  { id: "warm", color: "#b89870", name: "手账" },
  { id: "night", color: "#3a4560", name: "夜读" },
  { id: "ink", color: "#1a1a1a", name: "水墨" },
  { id: "rose", color: "#d4889a", name: "玫瑰" },
  { id: "sage", color: "#7a9a6a", name: "青苔" },
] as const;

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "从这里开始新的剧情。";
  const source = last.renderedContent || last.rawContent || "";
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "继续上次的场景。";
}

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["整理场景", "续写剧情", "打磨对白", "写入故事"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

function StoryGeneratingIndicator({
  characterName,
  avatar,
}: {
  characterName: string;
  avatar?: string;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="story-row" data-role="assistant">
      <div className="story-msg-head">
        <div className="story-avatar-wrap">
          <Avatar src={avatar || undefined} name={characterName} size="md" />
        </div>
        <div className="story-msg-meta">
          <span className="story-msg-name">{characterName}</span>
          <span className="story-msg-time story-generating-head">{status}</span>
        </div>
      </div>
      <div className="story-bubble-wrap">
        <div className="story-bubble story-generating-bubble" aria-label="正在生成剧情">
          <span className="story-generating-copy">{status}</span>
          <span className="story-generating-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  characterName,
  isGenerating,
  appendRequest,
  onSend,
  onStop,
}: {
  characterName: string;
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    onSend(text);
  };

  return (
    <div className="story-composer">
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => resizeStoryComposerTextarea(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={`以你和“${characterName}”为主角继续这一段剧情……`}
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        title={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? <StopIcon width={17} height={17} /> : <PaperAirplaneIcon width={17} height={17} className="story-send-icon" />}
      </button>
    </div>
  );
});

export function StoryApp({ onClose }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  const [, setStorageVersion] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  // 进入 APP 先出选择页（选角色或群组），不直接进入某个会话
  const [showLauncher, setShowLauncher] = useState(true);
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("");
  // 生成状态按会话记录：避免在 A 会话生成时切到 B 会话也显示"正在生成"
  const [generatingSessionIds, setGeneratingSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  // 抽屉滑动手势用 ref 而不是 state：手指按住时 touchmove 每帧都在触发，
  // 逐帧 setState 会让整个剧情页以事件频率重渲染（iOS 上拉到顶/底按住不动时
  // 表现为持续的重排/闪烁）
  const dragStartXRef = useRef<number | null>(null);
  const dragDeltaXRef = useRef(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  // 剧情群组新建/编辑弹窗
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string>("");
  const [groupDraftName, setGroupDraftName] = useState("");
  const [groupDraftMembers, setGroupDraftMembers] = useState<string[]>([]);
  const [groupDraftPreset, setGroupDraftPreset] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const groups = loadStoryGroups();
  const activeGroup = activeGroupId ? groups.find((g) => g.id === activeGroupId) || null : null;
  const currentSession = useMemo(
    () => (activeGroupId ? null : sessions.find((session) => session.id === activeSessionId) || null),
    [sessions, activeSessionId, activeGroupId]
  );
  // 统一线程：普通角色会话或剧情群组，二选一。承载 foldTags/排除标签/自定义 CSS/主题等。
  const currentThread = activeGroup
    ? { id: activeGroup.id, foldTags: activeGroup.foldTags, contextExcludedTags: activeGroup.contextExcludedTags, customCSS: activeGroup.customCSS, uiPrefs: activeGroup.uiPrefs || {}, isGroup: true as const }
    : currentSession
      ? { id: currentSession.id, foldTags: currentSession.foldTags, contextExcludedTags: currentSession.contextExcludedTags, customCSS: currentSession.customCSS, uiPrefs: currentSession.uiPrefs || {}, isGroup: false as const }
      : null;
  // 群像同场角色（群组成员里除主导外的其余角色）；普通角色会话为空。
  const participantIds = activeGroup ? activeGroup.memberIds.filter((id) => id !== activeGroup.leadCharacterId) : [];
  const uiPrefs = currentThread?.uiPrefs || {};
  const isGenerating = Boolean(activeSessionId) && generatingSessionIds.has(activeSessionId);

  const markGenerating = useCallback((sessionId: string, on: boolean) => {
    setGeneratingSessionIds((prev) => {
      if (on === prev.has(sessionId)) return prev;
      const next = new Set(prev);
      if (on) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
  }, []);

  // 群像：参与的每个角色都要记忆——逐个记账 + 触发总结（群像里人人平等，无配角）
  const runStoryMemoryForIds = useCallback((ids: string[]) => {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    void (async () => {
      for (const id of uniq) {
        const c = loadCharacters().find((x) => x.id === id);
        if (!c) continue;
        try {
          incrementEventCounter(id);
          incrementEventCounter(id);
          await maybeRunSummarization(id, c.name);
        } catch (err) {
          console.warn("[StoryApp] Memory counter/summarization failed:", err);
        }
      }
    })();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeSessionIdRef.current) {
        cancelStoryGenerationRun(activeSessionIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // 进 APP 只做水合，不自动进入任何会话——停在选择页
    hydrateStoryStorage().then(() => {
      setReady(true);
      setStorageVersion((value) => value + 1);
    });
  }, []);

  const loadThreadInto = useCallback((thread: { id: string; customCSS?: string; foldTags?: string; contextExcludedTags?: string }) => {
    setActiveSessionId(thread.id);
    activeSessionIdRef.current = thread.id; // 同步更新，堵住生成完成回调的守卫空窗
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(thread.id));
    setCustomCssDraft(thread.customCSS || "");
    setFoldTagsDraft(thread.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(thread.contextExcludedTags ?? "think,thinking");
    setStorageVersion((value) => value + 1);
  }, []);

  const openCharacter = useCallback((charId: string) => {
    if (!charId) return;
    const session = createOrGetStorySession(charId);
    setActiveGroupId("");
    setActiveCharacterId(charId);
    loadThreadInto(session);
    setShowLauncher(false);
    setDrawerOpen(false);
  }, [loadThreadInto]);

  const openGroup = useCallback((groupId: string) => {
    const group = getStoryGroup(groupId);
    if (!group || group.memberIds.length === 0) return;
    setActiveGroupId(group.id);
    setActiveCharacterId(group.leadCharacterId || group.memberIds[0]);
    loadThreadInto(group);
    setShowLauncher(false);
    setDrawerOpen(false);
  }, [loadThreadInto]);

  const saveGroupStay = useCallback((name: string, memberIds: string[], presetId: string, avatar: string) => {
    const members = Array.from(new Set(memberIds.filter(Boolean)));
    if (members.length < 2) return;
    createStoryGroup({ name: name.trim() || "剧情群组", memberIds: members, presetId: presetId || undefined, avatar: avatar || undefined });
    setStorageVersion((value) => value + 1);
  }, []);

  const backToLauncher = useCallback(() => {
    setShowLauncher(true);
    setDrawerOpen(false);
    setActiveGroupId("");
    setActiveSessionId("");
    activeSessionIdRef.current = "";
    setMessages([]);
    setStorageVersion((value) => value + 1);
  }, []);

  const openGroupModal = useCallback((groupId?: string) => {
    if (groupId) {
      const g = getStoryGroup(groupId);
      if (!g) return;
      setEditingGroupId(g.id);
      setGroupDraftName(g.name);
      setGroupDraftMembers(g.memberIds);
      setGroupDraftPreset(g.presetId || "");
    } else {
      setEditingGroupId("");
      setGroupDraftName("");
      setGroupDraftMembers([]);
      setGroupDraftPreset("");
    }
    setGroupModalOpen(true);
  }, []);

  const saveGroupDraft = useCallback(() => {
    const members = groupDraftMembers.filter(Boolean);
    if (members.length < 2) { alert("剧情群组至少需要 2 个角色。"); return; }
    const name = groupDraftName.trim() || "剧情群组";
    if (editingGroupId) {
      updateStoryGroup(editingGroupId, { name, memberIds: members, presetId: groupDraftPreset || undefined, leadCharacterId: members[0] });
    } else {
      createStoryGroup({ name, memberIds: members, presetId: groupDraftPreset || undefined });
    }
    setGroupModalOpen(false);
    setStorageVersion((value) => value + 1);
  }, [editingGroupId, groupDraftName, groupDraftMembers, groupDraftPreset]);

  const removeEditingGroup = useCallback(() => {
    if (!editingGroupId) return;
    if (!confirm("删除这个剧情群组？群组的剧情记录会一并删除，角色本身不受影响。")) return;
    deleteStoryGroup(editingGroupId);
    setGroupModalOpen(false);
    if (activeGroupId === editingGroupId) backToLauncher();
    setStorageVersion((value) => value + 1);
  }, [editingGroupId, activeGroupId, backToLauncher]);

  function renderGroupModal() {
    const toggleMember = (id: string) => {
      setGroupDraftMembers((prev) => (
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      ));
    };
    return (
      <div className="story-modal-overlay" onClick={() => setGroupModalOpen(false)}>
        <div className="story-group-modal" onClick={(e) => e.stopPropagation()}>
          <div className="story-group-modal-title">{editingGroupId ? "编辑剧情群组" : "新建剧情群组"}</div>

          <label className="story-group-modal-label">群组名称</label>
          <input
            className="story-group-modal-input"
            value={groupDraftName}
            onChange={(e) => setGroupDraftName(e.target.value)}
            placeholder="例如：茶会四人组"
          />

          <label className="story-group-modal-label">成员（至少 2 位，全部平等同场）</label>
          <div className="story-group-modal-members">
            {characters.map((c) => {
              const selected = groupDraftMembers.includes(c.id);
              return (
                <button
                  key={c.id}
                  className="story-group-modal-member"
                  data-active={selected ? "true" : undefined}
                  onClick={() => toggleMember(c.id)}
                >
                  <Avatar src={c.avatar || undefined} name={c.name} size="md" />
                  <span>{c.name}{selected ? " ✓" : ""}</span>
                </button>
              );
            })}
          </div>

          <label className="story-group-modal-label">预设（从设置里已加好的预设直接选，全员共用这一套）</label>
          <div className="story-group-modal-lead">
            <button
              className="story-group-modal-lead-chip"
              data-active={!groupDraftPreset ? "true" : undefined}
              onClick={() => setGroupDraftPreset("")}
            >跟随默认</button>
            {loadPresets().map((p) => (
              <button
                key={p.id}
                className="story-group-modal-lead-chip"
                data-active={groupDraftPreset === p.id ? "true" : undefined}
                onClick={() => setGroupDraftPreset(p.id)}
              >{p.name}</button>
            ))}
          </div>

          <div className="story-group-modal-actions">
            {editingGroupId ? (
              <button className="story-group-modal-btn story-group-modal-danger" onClick={removeEditingGroup}>删除</button>
            ) : <span />}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="story-group-modal-btn" onClick={() => setGroupModalOpen(false)}>取消</button>
              <button className="story-group-modal-btn story-group-modal-primary" onClick={saveGroupDraft}>保存</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Listen for live CSS updates from 小卷
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === activeSessionId) {
        setCustomCssDraft(detail.css || "");
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, [activeSessionId]);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // 段落编辑期间：贴底锁必须关掉，否则编辑框自适应高度每次变化都会被
  // ResizeObserver 拽到底部（表现为"一打字就滚到底"）
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // 编辑草稿放 ref、textarea 非受控：逐键 setState 会让 React 回写 value，
  // 中文输入法下 iOS 会光标错位；逐键改 style.height 又会触发 iOS 自动滚动。
  // 高度自适应改由纯 CSS 镜像（.story-grow-wrap::after）完成，打字零 JS 干预。
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // 段落编辑期间任何路径都不允许自动贴底
    const node = scrollRef.current;
    if (!node) return;
    // 已经贴底（或 iOS 橡皮筋回弹超出底部）时不再强写 scrollTop：
    // 否则 ResizeObserver → 贴底 → scroll 事件 → 再贴底会形成每帧循环，
    // 并和 iOS 的回弹动画互相打架
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 1) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // 编辑中不自动贴底
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  // Close context menu when clicking outside (delay to avoid the opening tap closing it)
  useEffect(() => {
    if (!activeMessageId) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".story-ctx-menu")) {
        setActiveMessageId(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [activeMessageId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentThread || isGenerating) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    // 配置解析可能抛错（如绑定的 API 配置已被删除）；这里在渲染 effect 里，
    // 抛出去会让整个剧情页白屏，所以失败时跳过缓存刷新，错误留到发送时提示
    let signature: { regexSignature: string; parserVersion: number };
    try {
      signature = getStoryRenderSignature(activeCharacterId);
    } catch {
      return;
    }
    const { regexSignature, parserVersion } = signature;
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentThread.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      let rebuilt: StoryMessage[];
      try {
        rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentThread.id, { sessionFoldTags: currentThread.foldTags });
      } catch {
        if (cacheRefreshKeyRef.current === refreshKey) cacheRefreshKeyRef.current = null;
        return;
      }
      if (cancelled) return;
      if (activeSessionIdRef.current === currentThread.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
    // 依赖用 id/foldTags 原始值而不是 session 对象：会话缓存归一化会更换对象
    // 引用，按对象依赖会让本 effect 在无关渲染中反复重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeCharacterId, currentThread?.id, currentThread?.foldTags, messages, isGenerating]);

  function applySessionUpdates(updates: Partial<StorySession> & Partial<StoryGroup>) {
    if (!currentThread) return;
    // 群组走群组存储，普通会话走会话存储
    const next = activeGroupId
      ? updateStoryGroup(currentThread.id, updates)
      : updateStorySession(currentThread.id, updates);
    if (!next) return;
    setCustomCssDraft(next.customCSS || "");
    setFoldTagsDraft(next.foldTags ?? "think,thinking");
    setContextExcludedTagsDraft(next.contextExcludedTags ?? "think,thinking");
    setStorageVersion((value) => value + 1);
  }

  async function handleSend(userTextInput: string) {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;

    const userMessage = pushStoryMessage({
      sessionId,
      role: "user",
      rawContent: userText,
      renderedContent: userText,
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const historyForGeneration = loadStoryMessages(sessionId);
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: currentThread?.foldTags,
        sessionContextExcludedTags: currentThread?.contextExcludedTags,
        signal: generationRun.controller.signal,
        participantIds,
        presetId: activeGroup?.presetId,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId)); // 按会话从存储重读，杜绝跨会话串消息
      }
      setStorageVersion((value) => value + 1);

      runStoryMemoryForIds([characterId, ...participantIds]);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
      const systemMessage = pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      if (activeSessionIdRef.current === sessionId) {
        setMessages(loadStoryMessages(sessionId));
      }
      setStorageVersion((value) => value + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    markGenerating(activeSessionId, false);
  }

  function handleTouchStart(clientX: number) {
    dragStartXRef.current = clientX;
    dragDeltaXRef.current = 0;
  }

  function handleTouchMove(clientX: number) {
    if (dragStartXRef.current == null) return;
    dragDeltaXRef.current = clientX - dragStartXRef.current;
  }

  function handleTouchEnd() {
    const dragStartX = dragStartXRef.current;
    const dragDeltaX = dragDeltaXRef.current;
    if (dragStartX == null) return;
    // 从右边缘向左滑打开
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (!drawerOpen && dragStartX > screenW - 32 && dragDeltaX < -54) {
      setDrawerOpen(true);
    }
    // 向右滑关闭
    if (drawerOpen && dragDeltaX > 54) {
      setDrawerOpen(false);
    }
    dragStartXRef.current = null;
    dragDeltaXRef.current = 0;
  }

  // ── Long-press & context menu handlers ──
  function getClampedContextMenuPoint(clientX: number, clientY: number) {
    if (typeof window === "undefined") return { x: clientX, y: clientY };
    const menuHalfWidth = 112;
    const menuHeight = 96;
    return {
      x: Math.min(Math.max(clientX, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(clientY + 12, 16), window.innerHeight - menuHeight),
    };
  }

  function handleMsgPointerDown(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Don't preventDefault — it blocks clicks on <details>, <summary>, <input> etc. inside messages
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      const point = startPosRef.current ?? { x: e.clientX, y: e.clientY };
      setContextMenuPoint(getClampedContextMenuPoint(point.x, point.y));
      setActiveMessageId(msgId);
      longPressTimerRef.current = null;
    }, 500);
  }
  function handleMsgPointerMove(e: React.PointerEvent) {
    if (!startPosRef.current) return;
    if (Math.abs(e.clientX - startPosRef.current.x) > 10 || Math.abs(e.clientY - startPosRef.current.y) > 10) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
  }
  function handleMsgPointerUp(e: React.PointerEvent) {
    startPosRef.current = null;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressTriggeredRef.current) { e.stopPropagation(); e.preventDefault(); longPressTriggeredRef.current = false; }
  }
  function handleMsgPointerCancel() {
    startPosRef.current = null; longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function handleStoryDelete(msgId: string) {
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // 仅作为非受控 textarea 的初始值
    editingDraftRef.current = msg.rawContent;
    setActiveMessageId(null);
  }
  function handleStoryEditSave() {
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId);
      if (regexes.length > 0) {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "用户");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
    setActiveMessageId(null);
  }
  async function handleStoryRetry(msgId: string) {
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = retryMessage.role === "user"
      ? messages.slice(0, msgIndex + 1)
      : messages.slice(0, msgIndex);
    const firstDiscardedMessage = messages[contextMessages.length];
    if (firstDiscardedMessage) {
      deleteStoryMessagesFrom(activeSessionId, firstDiscardedMessage.id);
    }
    setMessages(contextMessages);
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
    // 重试会截掉一条长消息，内容变矮时浏览器把滚动位置钳回新底部，
    // 看起来像"页面跳到上面"；这里主动贴底，让视线落在生成指示器上
    autoBottomLockRef.current = true;
    requestAnimationFrame(() => scrollStoryToBottom());
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => mountedRef.current && isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, contextMessages, {
        sessionFoldTags: currentThread?.foldTags,
        sessionContextExcludedTags: currentThread?.contextExcludedTags,
        signal: generationRun.controller.signal,
        participantIds,
        presetId: activeGroup?.presetId,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
      });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
      runStoryMemoryForIds([characterId, ...participantIds]);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "重试失败，请稍后再试。";
      const systemMessage = pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
      setStorageVersion(v => v + 1);
    } finally {
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  if (!ready) return null;

  if (characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <SolidBackIcon size={16} />
                </button>
              </div>
              <div className="story-header-center">Story</div>
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <BookOpenIcon width={30} height={30} opacity={0.45} />
                <div>
                  <div className="story-empty-title">还没有角色卡</div>
                  <div className="story-empty-desc">请先创建或导入角色卡，再进入剧情 APP 开始故事。</div>
                </div>
                <button className="story-empty-action" onClick={onClose}>
                  返回
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 选择页：进 APP 先选角色或群组，不直接进会话
  if (showLauncher || !currentThread || !currentCharacter) {
    return (
      <div className="story-app-shell story-launcher" data-story-theme="mono">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <SolidBackIcon size={16} />
                </button>
              </div>
              <div className="story-header-center">Story</div>
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-launcher-body story-launcher-body-dial">
            <StoryDialLauncher
              characters={characters}
              groups={groups}
              presets={loadPresets().map((p) => ({ id: p.id, name: p.name }))}
              onOpenCharacter={openCharacter}
              onOpenGroup={openGroup}
              onEditGroup={(id) => openGroupModal(id)}
              onSaveGroup={saveGroupStay}
            />
          </div>
        </div>

        {groupModalOpen ? renderGroupModal() : null}
      </div>
    );
  }

  const sessionScope = `.story-session-${currentThread.id}`;

  // 群像：本群组同场角色（全体平等主角，含主导角色）。空=普通单人剧情。
  const ensembleCast = participantIds
    .map((id) => characters.find((c) => c.id === id))
    .filter(Boolean) as typeof characters;
  const isEnsemble = ensembleCast.length > 0;
  const rosterChars = isEnsemble ? [currentCharacter, ...ensembleCast] : [currentCharacter];

  return (
    <div
      className={`story-app-shell story-session-${currentThread.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartXRef.current != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {/* Styles moved to styles/story.css */}
      {currentThread.customCSS ? (
        <SessionCustomCSS css={currentThread.customCSS} scope={sessionScope} />
      ) : null}

      {drawerOpen ? <div className="story-drawer-overlay" onClick={() => setDrawerOpen(false)} /> : null}
      <aside className="story-drawer" style={{ transform: drawerOpen ? "translateX(0)" : "translateX(106%)", transition: "transform 220ms ease" }}>
        <div className="story-drawer-section">
          <button className="story-tool-btn" onClick={backToLauncher}>← 返回选择角色 / 群组</button>
          <div style={{ marginTop: 10, fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))" }}>
            {activeGroupId
              ? `当前群像：${rosterChars.map((c) => c.name).join("、")}`
              : `当前剧情：${currentCharacter.name}`}
          </div>
          {activeGroupId ? (
            <button
              className="story-tool-btn"
              style={{ marginTop: 8 }}
              onClick={() => openGroupModal(activeGroupId)}
            >编辑这个群组</button>
          ) : null}
        </div>

        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">显示选项</div>
          <div style={{ padding: "10px 0", borderBottom: "1px solid var(--c-story-drawer-border, rgba(124, 104, 68, 0.08))" }}>
            <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))", display: "block", marginBottom: 6 }}>
              折叠标签
            </label>
            <input
              type="text"
              value={foldTagsDraft}
              onChange={(e) => setFoldTagsDraft(e.target.value)}
              onBlur={() => applySessionUpdates({ foldTags: foldTagsDraft.trim() || undefined })}
              placeholder="think,thinking"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 12px", borderRadius: 0,
                border: "none", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.06)",
                background: "var(--c-story-css-box-bg, rgba(255, 251, 246, 0.88))",
                color: "var(--c-story-text, #4b4335)",
                fontSize: "calc(13px*var(--app-text-scale,1))", lineHeight: 1.6, fontFamily: "inherit",
              }}
            />
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", marginTop: 4, color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))" }}>
              逗号分隔标签名，如 think,thinking,reasoning
            </div>
          </div>
          <div style={{ padding: "10px 0", borderBottom: "1px solid var(--c-story-drawer-border, rgba(124, 104, 68, 0.08))" }}>
            <label style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))", display: "block", marginBottom: 6 }}>
              不进上下文标签
            </label>
            <input
              type="text"
              value={contextExcludedTagsDraft}
              onChange={(e) => setContextExcludedTagsDraft(e.target.value)}
              onBlur={() => applySessionUpdates({ contextExcludedTags: contextExcludedTagsDraft.trim() || undefined })}
              placeholder="think,thinking"
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "8px 12px", borderRadius: 0,
                border: "none", boxShadow: "inset 0 1px 3px rgba(0,0,0,0.06)",
                background: "var(--c-story-css-box-bg, rgba(255, 251, 246, 0.88))",
                color: "var(--c-story-text, #4b4335)",
                fontSize: "calc(13px*var(--app-text-scale,1))", lineHeight: 1.6, fontFamily: "inherit",
              }}
            />
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", marginTop: 4, color: "var(--c-story-sub, rgba(95, 82, 61, 0.72))" }}>
              默认 think,thinking；影响后续生成上下文，不影响显示与保存
            </div>
          </div>
        </div>

        <div className="story-drawer-section">
          <div className="story-drawer-eyebrow">工具</div>
          <button
            className="story-tool-btn"
            onClick={() => {
              try {
                const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentThread.id, { sessionFoldTags: currentThread.foldTags });
                setMessages(rebuilt);
                setStorageVersion((value) => value + 1);
                alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
              } catch (error) {
                alert(error instanceof Error ? error.message : "缓存重建失败，请检查 API 绑定配置");
              }
            }}
          >
            重建渲染缓存
          </button>
        </div>
      </aside>

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== 固定顶部标题栏 ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                <SolidBackIcon size={16} />
              </button>
            </div>
            <div className="story-header-center">Story</div>
            <div className="story-header-right" style={{ gap: 8 }}>
              <button className="story-top-btn" onClick={() => setCssModalOpen(true)} aria-label="页面样式">
                <PaintBrushIcon width={16} height={16} />
              </button>
              <button className="story-top-btn" onClick={() => setDrawerOpen(true)} aria-label="打开剧情侧栏">
                <SolidMenuIcon size={16} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">
            
            {/* ====== 顶部信息阅读卡片 ====== */}
            {isEnsemble ? (
              /* 群像：极简题头——叠放头像 + 一行小字，不列名字，避免多人名换行 */
              <div className="story-meta story-meta-ensemble">
                <div className="story-meta-ava-stack">
                  {rosterChars.slice(0, 6).map((c, i) => (
                    <div key={c.id} className="story-meta-ava" style={{ marginLeft: i === 0 ? 0 : -12, zIndex: 10 - i }}>
                      {c.avatar ? <img src={c.avatar} alt="" /> : <span>{c.name.trim().charAt(0) || "书"}</span>}
                    </div>
                  ))}
                  {rosterChars.length > 6 ? (
                    <div className="story-meta-ava story-meta-ava-more" style={{ marginLeft: -12, zIndex: 3 }}>+{rosterChars.length - 6}</div>
                  ) : null}
                </div>
                <div className="story-meta-ensemble-label">群像 · {rosterChars.length} 位角色同场</div>
              </div>
            ) : (
              <div className="story-meta">
                <div className="story-meta-layout">
                  <div className="story-meta-cover">
                    {currentCharacter.avatar ? (
                      <img src={currentCharacter.avatar} alt="cover" />
                    ) : (
                      <div className="story-meta-cover-fallback" aria-hidden="true">
                        <span className="story-meta-cover-char">{currentCharacter.name.trim().charAt(0) || "书"}</span>
                        <span className="story-meta-cover-line" />
                        <span className="story-meta-cover-sub">STORY</span>
                      </div>
                    )}
                  </div>
                  <div className="story-meta-body">
                    <div className="story-meta-title">本次阅读：《 {currentCharacter.name} 》</div>
                    <div className="story-meta-tags">{userIdentity?.name || "我"} x {currentCharacter.name}</div>
                    <div className="story-meta-desc">“有些故事，在开始之前就已经写好了结局。”</div>
                  </div>
                </div>
              </div>
            )}

            {messages.length === 0 ? (
              <div className="story-empty">
                <BookOpenIcon width={28} height={28} opacity={0.45} />
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading,#1e293b)] mb-1">{isEnsemble ? "群像故事从这里开始" : "故事从这里开始"}</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">{isEnsemble ? `${rosterChars.length} 位角色同场。从底部输入一段引导，故事会同时展开他们几个。` : "从底部输入一段引导，剧情会继续展开。"}</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>查看更多消息</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message) => {
                  const speakerName = message.role === "user"
                    ? (userIdentity?.name?.trim() || "我")
                    : message.role === "assistant"
                      ? currentCharacter.name
                      : "系统";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (currentCharacter.avatar || undefined)
                      : undefined;
                  return (
                    <article
                      key={message.id}
                      className="story-row"
                      data-role={message.role}
                      onPointerDown={(e) => handleMsgPointerDown(e, message.id)}
                      onPointerMove={handleMsgPointerMove}
                      onPointerUp={handleMsgPointerUp}
                      onPointerCancel={handleMsgPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenuPoint(getClampedContextMenuPoint(e.clientX, e.clientY));
                        setActiveMessageId(message.id);
                      }}
                    >
                      {message.role !== "system" ? (
                        <div className="story-msg-head">
                          <div className="story-avatar-wrap">
                            <Avatar src={avatarUrl} name={speakerName} size="md" />
                          </div>
                          <div className="story-msg-meta">
                            <span className="story-msg-name">{speakerName}</span>
                            <span className="story-msg-time">{formatStoryTime(message.createdAt)}</span>
                          </div>
                        </div>
                      ) : null}
                      <div className="story-bubble-wrap" style={{ position: "relative" }}>
                        <div className="story-bubble">
                          {editingMessageId === message.id ? (
                            <div className="story-inline-edit">
                              <div className="story-grow-wrap" data-value={editingContent}>
                                <textarea
                                  autoFocus
                                  defaultValue={editingContent}
                                  onInput={(e) => {
                                    const el = e.currentTarget;
                                    editingDraftRef.current = el.value;
                                    const wrap = el.parentElement;
                                    if (wrap) wrap.dataset.value = el.value;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                                    if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                                  }}
                                />
                              </div>
                              <div className="story-inline-edit-actions">
                                <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">取消</button>
                                <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">保存</button>
                              </div>
                            </div>
                          ) : (
                            <StoryHtmlRenderer
                              content={message.renderedContent || message.rawContent}
                              messageId={message.id}
                              onOptionSelect={handleOptionSelect}
                              serifIframeFallback
                            />
                          )}
                        </div>
                        {activeMessageId === message.id && (() => {
                          const menu = (
                            <div
                              className="story-ctx-menu"
                              style={contextMenuPoint ? { left: contextMenuPoint.x, top: contextMenuPoint.y } : undefined}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryCopy(message.rawContent)} className="story-ctx-btn">复制</button>
                                <button onClick={() => handleStoryEditStart(message)} className="story-ctx-btn">编辑</button>
                                {(message.role === "assistant" || message.role === "user") && (
                                  <button onClick={() => { void handleStoryRetry(message.id); }} className="story-ctx-btn story-ctx-btn-danger">重试</button>
                                )}
                              </div>
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryDelete(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除</button>
                                <button onClick={() => handleStoryDeleteFrom(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除以下</button>
                              </div>
                              <div className="story-ctx-triangle" />
                            </div>
                          );
                          return shellInnerRef.current ? createPortal(menu, shellInnerRef.current) : menu;
                        })()}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating ? (
              <StoryGeneratingIndicator
                characterName={currentCharacter.name}
                avatar={currentCharacter.avatar || undefined}
              />
            ) : null}
          </div>
        </div>
      </div>

      <StoryComposer
        characterName={currentCharacter.name}
        isGenerating={isGenerating}
        appendRequest={composerAppendRequest}
        onSend={(text) => { void handleSend(text); }}
        onStop={handleStopGeneration}
      />

      {/* CSS Style Modal */}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #fdfdfd)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #94a3b8)" }}>
              页面样式
            </span>
            <button className="story-top-btn" onClick={() => setCssModalOpen(false)}>
              <XMarkIcon width={17} height={17} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
                {STORY_THEMES.map(t => {
                  const active = (uiPrefs.theme || "paper") === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`切换到${t.name}主题`}
                      aria-pressed={active}
                      onClick={() => applySessionUpdates({ uiPrefs: { ...uiPrefs, theme: t.id } })}
                      style={{
                        minHeight: 54,
                        borderRadius: 0,
                        border: "none",
                        boxShadow: "none",
                        background: active ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))",
                        color: "var(--c-story-text, #3a3b3c)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        padding: "7px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: t.color,
                        border: "none",
                        boxShadow: active
                          ? "inset 0 0 0 2px var(--c-story-bg-top, #fdfdfd), 0 0 0 2px var(--c-story-text, #3a3b3c)"
                          : "none",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-sub, #94a3b8)", lineHeight: 1.1 }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 这里写剧情模式的 session CSS */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "none",
                borderRadius: 0,
                boxShadow: "none",
                background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))",
                color: "var(--c-story-text, #3a3b3c)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, #fdfdfd)",
                border: "var(--c-story-drawer-border, rgba(0,0,0,0.06))",
                text: "var(--c-story-text, #3a3b3c)",
                textDim: "var(--c-story-sub, #94a3b8)",
                input: "var(--c-story-css-box-bg, rgba(248,250,252,0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(0,0,0,0.06))",
                accent: "var(--c-story-send-bg-active, #0f172a)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={() => { applySessionUpdates({ customCSS: customCssDraft }); setCssModalOpen(false); }}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0, border: "none", boxShadow: "none",
                  background: "var(--c-story-send-bg-active, #dbe3ea)", color: "var(--c-story-send-color-active, #475569)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}

      {groupModalOpen ? renderGroupModal() : null}
    </div>
  );
}
