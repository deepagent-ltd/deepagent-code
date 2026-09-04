import { dict as en } from "./en"

type Keys = keyof typeof en

export const dict = {
  "tui.reviews.title": "运行评审",
  "tui.reviews.empty": "还没有运行评审",
  "tui.reviews.readonly": "只读列表 — promote/reject 在完整评审流中打开",
  "tui.reviews.statusUnknown": "状态未知",
  "tui.reviews.next": "下一步",
  "tui.reviews.candidates": "候选",
  "tui.wiki.title": "Wiki（只读）",
  "tui.wiki.editableGuiOnly": "可编辑（仅 GUI）",
  "tui.wiki.emptyPage": "（空页面）",
  "tui.archive.title": "已归档会话",
  "tui.archive.restore": "恢复",
  "tui.archive.delete": "删除",
  "tui.archive.restored": "会话已恢复",
  "tui.archive.deleted": "会话已删除",
  "tui.archive.restoreFailed": "恢复会话失败",
  "tui.archive.deleteFailed": "删除会话失败",
  "tui.archive.confirmDelete": "再按一次删除键确认",
  "tui.archive.empty": "没有已归档会话",
  "tui.queue.title": "排队输入",
  "tui.queue.empty": "没有排队输入 — 显式 queue 模式输入会在当前活动结束后开启下一个",
  "tui.queue.promotesInOrder": "按提交顺序提升",
  "tui.suggest.none": "暂无下一步建议",
  "tui.suggest.label": "下一步建议",
  "tui.archive.archived": "会话已归档",
  "tui.archive.archiveFailed": "归档会话失败",
} satisfies Record<Keys, string>
