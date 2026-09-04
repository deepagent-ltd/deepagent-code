import { dict as en } from "./en"

type Keys = keyof typeof en

export const dict = {
  "tui.reviews.title": "執行評審",
  "tui.reviews.empty": "還沒有執行評審",
  "tui.reviews.readonly": "唯讀清單 — promote/reject 在完整評審流中開啟",
  "tui.reviews.statusUnknown": "狀態未知",
  "tui.reviews.next": "下一步",
  "tui.reviews.candidates": "候選",
  "tui.wiki.title": "Wiki（唯讀）",
  "tui.wiki.editableGuiOnly": "可編輯（僅 GUI）",
  "tui.wiki.emptyPage": "（空頁面）",
  "tui.archive.title": "已封存工作階段",
  "tui.archive.restore": "還原",
  "tui.archive.delete": "刪除",
  "tui.archive.restored": "工作階段已還原",
  "tui.archive.deleted": "工作階段已刪除",
  "tui.archive.restoreFailed": "還原工作階段失敗",
  "tui.archive.deleteFailed": "刪除工作階段失敗",
  "tui.archive.confirmDelete": "再按一次刪除鍵確認",
  "tui.archive.empty": "沒有已封存工作階段",
  "tui.queue.title": "佇列輸入",
  "tui.queue.empty": "沒有佇列輸入 — 明確 queue 模式輸入會在目前活動結束後開啟下一個",
  "tui.queue.promotesInOrder": "按提交順序提升",
  "tui.suggest.none": "暫無下一步建議",
  "tui.suggest.label": "下一步建議",
  "tui.archive.archived": "工作階段已封存",
  "tui.archive.archiveFailed": "封存工作階段失敗",
} satisfies Record<Keys, string>
