/** Python 提供的本轮物品资料；图片地址只用于卡片，不进入检索正文。 */
export interface InventoryItem {
  id: number;
  name: string;
  location_text: string;
  record_text: string;
  image_url: string;
}

export interface RunTurnRequest {
  user_id: number;
  family_id: number;
  text: string;
  items: InventoryItem[];
}

export type ItemCardData = Omit<InventoryItem, "record_text">;

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "item_cards"; items: ItemCardData[] }
  | { type: "error"; message: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  created_at: string;
  blocks: MessageBlock[];
}

export interface HistoryResult {
  messages: ChatMessage[];
  next_before: string | null;
}

export interface TurnResult {
  messages: ChatMessage[];
}

/** 完整消息复用 Pi 原始编号；生成中的助手文字仅保存在当前任务内存中。 */
export interface ChatProgress {
  messages: ChatMessage[];
  draft: ChatMessage | null;
}
