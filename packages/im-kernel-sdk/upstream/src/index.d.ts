/** Canonical nonnegative signed-int64 decimal text; never convert through Number. */
export type DeliveryDecimal = string;
export interface DeliveryReaderInfo {
  version: 1 | 2; scopeKey: string; currentCursor: DeliveryDecimal; serverNow: number;
  maxPageItems: 32; maxChangeBytes: 65536; maxMessageBytes: 4194304; maxWindowPages: 100000;
}
export interface DeliveryChangesRequest {
  version: 1 | 2; scopeKey: string; after: DeliveryDecimal; limit: number; pageToken?: string;
}
export interface DeliveryProjectionRequest {
  version: 1 | 2; scopeKey: string; projectionKey: string; projectionRevision: DeliveryDecimal;
}
export interface DeliveryMessagesRequest extends DeliveryProjectionRequest {
  direction: "older" | "newer"; anchorDeliveryCursor?: DeliveryDecimal; limit: number;
}
export interface DeliveryMarkReadRequest extends DeliveryProjectionRequest { throughOrdinal: DeliveryDecimal; }
export type DeliveryConversationChange = {
  projectionKey: string; revision: DeliveryDecimal; cursor: DeliveryDecimal;
} & ({ visibility: "revoked" } | {
  visibility: "visible"; liveUnread: DeliveryDecimal; storedUnread: DeliveryDecimal;
  admittedOrdinal: DeliveryDecimal; readOrdinal: DeliveryDecimal; nextExpiryAt: number;
  latestMessageId: string; latestSequence: string; latestMessageTime: number; conversationType: 1 | 2; targetId: string;
});
export interface DeliveryChangesResult {
  version: 1 | 2; scopeKey: string; after: DeliveryDecimal; upper: DeliveryDecimal;
  scanCursor: DeliveryDecimal; scanProjectionKey: string; pageToken: string;
  windowComplete: boolean; caughtUp: boolean; serverNow: number; items: DeliveryConversationChange[];
}
export interface DeliveryReadMessage {
  effectKey: string; messageId: string; sequence: DeliveryDecimal; deliveryCursor: DeliveryDecimal;
  messageTime: number; expiresAt: number; senderId: string; targetId: string;
  conversationType: 1 | 2; content: string; isSend: boolean; isRead: boolean;
  /** Required only for media-aware reader-v2; absent from reader-v1. */
  messageType?: "jg:text" | "dac:media.v1";
}
export interface DeliveryMessagesResult {
  version: 1 | 2; scopeKey: string; projectionKey: string; projectionRevision: DeliveryDecimal;
  direction: "older" | "newer"; nextDeliveryCursor: string; finished: boolean; serverNow: number; items: DeliveryReadMessage[];
}
export interface DeliveryReadCutResult {
  version: 1 | 2; scopeKey: string; projectionKey: string; projectionRevision: DeliveryDecimal;
  throughOrdinal: DeliveryDecimal; targetAdmittedOrdinal: DeliveryDecimal; readOrdinal: DeliveryDecimal;
  liveUnread: DeliveryDecimal; storedUnread: DeliveryDecimal; serverNow: number; complete: boolean;
}
export interface DeliveryError {
  name: "DeliveryError"; operation: string; code: number; wireCode?: number; msg: string;
  kind: "denied" | "reader_required" | "unavailable" | "stale" | "unknown" | "capacity" |
    "invalid_request" | "invalid_response" | "disconnected" | "transport_timeout" | "legacy_api_disabled" |
    "unsupported_capability" | "upgrade_required" | "conflict" | "expired" | "not_found" | "cancelled";
}
interface DeliveryCapabilities {
  version: 1;
  profile: "mysql-receipt-v1";
  maxLifetimeMs: 259200000;
  maxContentBytes: number;
  eventualDelivery: false;
}
interface DeliveryReceiptRequest {
  version: 1;
  channelType: 1 | 2;
  targetId: string;
  clientUid: string;
  requestHash: string;
  expiresAt: number;
}
interface DeliveryReceiptResult {
  state: "confirmed_acceptance" | "unknown" | "not_found" | "conflict" | "expired" | "unavailable";
  version: 1;
  clientUid: string;
  requestHash: string;
  expiresAt: number;
  msgId: string;
  msgTime: number;
  /** Decimal int64, never converted through Number. */
  msgSeqNo: string;
}
interface ProtectedTextMessage {
  tid?: string;
  clientMsgId: string;
  name: "jg:text";
  conversationType: 1 | 2;
  conversationId: string;
  content: { content: string };
  /** Original absolute epoch milliseconds; exact retry preserves this value. */
  deliveryExpiresAt: number;
}
interface ProtectedTextAcceptance extends ProtectedTextMessage {
  messageId: string;
  sentTime: number;
  /** Omitted when sequence cannot be represented safely as a JS Number. */
  messageIndex?: number;
  delivery: {
    state: "confirmed_acceptance";
    version: 1;
    expiresAt: number;
    requestHash: string;
    sequence: string;
  };
}

export interface ProtectedMediaAttachment {
  attachmentID: string; contentRef: string; filename: string; mime: string;
  sizeBytes: number; sha256: string; createdAt: number; expiresAt: number;
}
export interface ProtectedMediaContent { v: 1; content: string; attachments: readonly ProtectedMediaAttachment[]; }
export interface ProtectedMediaMessage {
  tid?: string; clientMsgId: string; name: "dac:media.v1"; conversationType: 1 | 2; conversationId: string;
  content: ProtectedMediaContent; deliveryExpiresAt: number;
}
export interface ProtectedMediaAcceptance extends ProtectedMediaMessage {
  messageId: string; sentTime: number; messageIndex?: number;
  delivery: { state: "confirmed_acceptance"; version: 1; expiresAt: number; requestHash: string; sequence: string; };
}
export interface ProtectedMediaCapabilities {
  version: 1; profile: "mysql-protected-media-v1"; capability: "dac:media.v1"; readerVersion: 2;
  maxFileBytes: 52428800; maxAttachments: 4; chunkBytes: 262144; ttlMillis: 86400000; authenticatedContent: true;
}
export interface ProtectedMediaTransferCapabilities {
  version: 1; protocol: "dac-media-resumable-v1"; chunkBytes: 262144; maxChunks: 200; maxFileBytes: 52428800;
}
export interface ProtectedMediaUploadProgress {
  version: 1; protocol: "dac-media-resumable-v1"; object: ProtectedMediaMetadata;
  chunkBytes: 262144; checkpointRevision: number; committedIndices: readonly number[];
}
export interface ProtectedMediaBeginRequest {
  conversationType: 1 | 2; conversationID: string;
  upload: { uploadID: string; filename: string; sizeBytes: number; sha256: string; };
}
export interface ProtectedMediaMetadata {
  objectID: string; uploadID: string; filename: string; mime: string; sizeBytes: number; sha256: string;
  state: "uploading" | "uploaded_unbound" | "bound" | "cancelled" | "expired" | "unknown";
  receivedBytes: number; receivedChunks: number; createdAt: number; expiresAt: number;
}
export interface ProtectedMediaObjectRequest { objectID: string; signal?: AbortSignal; }
export interface ProtectedMediaChunkRequest extends ProtectedMediaObjectRequest { index: number; body: Uint8Array; }
export interface ProtectedMediaRangeRequest { attachment: ProtectedMediaAttachment; start: number; end: number; signal?: AbortSignal; }

interface EVENT {
  STATE_CHANGED: string;
  MESSAGE_RECEIVED: string;
  MESSAGE_RECALLED: string;
  MESSAGE_UPDATED: string;
  MESSAGE_READ: string;
  MESSAGE_REMOVED: string;
  MESSAGE_CLEAN: string;
  MESSAGE_CLEAN_SOMEONE: string;
  MESSAGE_REACTION_CHANGED: string;
  TAG_ADDED: string;
  TAG_REMOVED: string;
  TAG_CHANGED: string;
  TAG_CONVERSATION_ADDED: string;
  TAG_CONVERSATION_REMOVED: string;
  CONVERSATION_SYNC_FINISHED: string;
  CONVERSATION_UNDISTURBED: string;
  CONVERSATION_TOP: string;
  CONVERSATION_CLEARUNREAD: string;
  CLEAR_TOTAL_UNREADCOUNT: string;
  CONVERSATION_CHANGED: string;
  CONVERSATION_ADDED: string;
  CONVERSATION_REMOVED: string;
  CHATROOM_ATTRIBUTE_UPDATED: string;
  CHATROOM_ATTRIBUTE_DELETED: string;
  CHATROOM_DESTROYED: string;
  CHATROOM_USER_QUIT: string;
  CHATROOM_USER_KICKED: string;
}
interface CONNECT_STATE {
  CONNECTED: number;
  CONNECTING: number;
  DISCONNECTED: number;
  CONNECT_FAILED: number;
  DB_OPENED: number;
  DB_CLOSED: number;
  RECONNECTING: number;
}
interface CONVERATION_TYPE {
  PRIVATE: number;
  GROUP: number;
  CHATROOM: number;
  SYSTEM: number;
}
interface MESSAGE_ORDER {
  FORWARD: number;
  BACKWARD: number;
}
interface CONVERSATION_ORDER {
  BACKWARD: number;
  FORWARD: number;
}
interface MENTION_ORDER {
  BACKWARD: number;
  FORWARD: number;
}
interface UPLOAD_TYPE {
  NONE: number;
  QINIU: number;
  ALI: number;
}
interface UNDISTURB_TYPE {
  DISTURB: number;
  UNDISTURB: number;
}

interface MESSAGE_TYPE {
  TEXT: string;
  IMAGE: string;
  VOICE: string;
  VIDEO: string;
  FILE: string;
  MERGE: string;
  RECALL: string;
  RECALL_INFO: string;
  READ_MSG: string;
  READ_GROUP_MSG: string;
  MODIFY: string;
  CLEAR_MSG: string;
  CLEAR_UNREAD: string;
  COMMAND_DELETE_MSGS: string;
  COMMAND_UNDISTURB: string;
  COMMAND_TOPCONVERS: string;
  COMMAND_REMOVE_CONVERS: string;
  COMMAND_ADD_CONVER: string;
  COMMAND_CLEAR_TOTALUNREAD: string;
  COMMAND_MARK_UNREAD: string;
  COMMAND_LOG_REPORT: string;
  COMMAND_MSG_EXSET: string;
  COMMAND_ADD_CONVERSATION_TO_TAG: string;
  COMMAND_REMOVE_CONVERS_FROM_TAG: string;
  COMMAND_CONVERSATION_TAG_REMOVE: string;
  CLIENT_REMOVE_MSGS: string;
  CLIENT_REMOVE_CONVERS: string;
  CLIENT_RECALL_MSG: string;
  CLIENT_MARK_UNREAD: string;
}
interface MENTION_TYPE {
  ALL: string;
  SOMEONE: string;
  ALL_SOMEONE: string;
}
interface FILE_TYPE {
  IMAGE: number;
  AUDIO: number;
  VIDEO: number;
  FILE: number;
}
interface MESSAGE_SENT_STATE {
  NONE: number;
  SENDING: number;
  SUCCESS: number;
  FAILED: number;
  UPLOADING: number;
}
interface DISCONNECT_TYPE {
  DISCONNECT: number;
  CLOSE: number;
  ERROR: number;
  SERVER: number;
}
interface UNREAD_TAG {
  READ: number;
  UNREAD: number;
}
interface SET_SEARCH_CONTENT_TYPE {
  APPEND: number;
  REPLACE: number;
}
interface CONVERATION_TAG_TYPE {
  USER: number;
  SYSNTEM: number;
  GLOBAL: number;
}

interface Error {
  code: number;
  msg: string;
}
declare class IMUser {
  id?: string;
  name?: string;
  portrait?: string;
  token?: string;
  exts?: string;
}
declare class ERROR_TYPE {
  CONNECT_SUCCESS: Error;
  CONNECT_ERROR: Error;
  CONNECT_APPKEY_IS_REQUIRE: Error;
  CONNECT_TOKEN_NOT_EXISTS: Error;
  CONNECT_APPKEY_NOT_EXISTS: Error;
  CONNECT_TOKEN_ILLEGAL: Error;
  CONNECT_TOKEN_UNAUTHORIZED: Error;
  CONNECT_TOKEN_EXPIRE: Error;
  CONNECT_REDIRECT: Error;
  CONNECT_UNSUPPORT_PLATFORM: Error;
  CONNECT_APP_BLOCKED: Error;
  CONNECT_USER_BLOCKED: Error;
  CONNECT_USER_KICKED: Error;
  CONNECT_USER_LOGOUT: Error;
  CHATROOM_NOT_JOIN: Error;
  CHATROOM_ATTR_EXCEED_LIMIT: Error;
  CHATROOM_ATTR_EXISTS: Error;
  CHATROOM_NOT_EXISTS: Error;
  PB_ERROR: Error;
  GROUP_NOT_EXISTS: Error;
  ILLEGAL_PARAMS: Error;
  CONNECTION_EXISTS: Error;
  CONNECTION_NOT_READY: Error;
  ILLEGAL_TYPE_PARAMS: Error;
  COMMAND_FAILED: Error;
  UPLOAD_PLUGIN_ERROR: Error;
  UPLOAD_PLUGIN_NOTMATCH: Error;
  UPLOADING_FILE_ERROR: Error;
  TRANSFER_MESSAGE_COUNT_EXCEED: Error;
  DATABASE_NOT_OPENED: Error;
  SDK_FUNC_NOT_DEFINED: Error;
  SEND_REFER_MESSAGE_ERROR: Error;
  IM_SERVER_CONNECT_ERROR: Error;
  ILLEGAL_PARAMS_EMPTY: Error;
  REPREAT_CONNECTION: Error;
  MESSAGE_RECALL_SUCCESS: Error;
  COMMAND_SUCCESS: Error;
  CONNECT_SIGNAL_UNSUPPORT: Error;
  COMMAND_OVER_FREQUENCY: Error;
  CONNECT_USER_NOT_EXISTS: Error;
  PARAMS_TIMEZONE_ILLEGAL: Error;
  PARAMS_MESSAGE_ILLEGAL: Error;
  REJECTED_BY_BLACKLIST: Error;
  KV_DUPLICATION: Error;
  MESSAGE_SENSITIVE_WORDS: Error;
  GROUP_NOT_GROUP_MEMBER: Error;
  GROUP_BANNED: Error;
  GROUP_MEMBER_BANNED: Error;
  GROUP_MEMBER_OVERFLOW: Error;
  CHATROOM_KV_NOT_EXISTS: Error;
  CHATROOM_DESTROY: Error;
  CHATROOM_MEMBER_BANNED: Error;
  CHATROOM_MEMBER_BLOCKED: Error;
}
declare class Message {
  conversationId: string;
  conversationType: CONVERATION_TYPE;
  conversationTitle?: string;
  conversationPortrait?: string;
  conversationExts?: string;
  conversationAlias: string;
  tid?: string;
  messageId?: string;
  name: string;
  content: Object;
  sentState?: number;
  sentTime?: number;
  sender?: IMUser;
  attribute?: string;
  referMsg?: Message;
  isMass?: boolean;
  isUpdated?: boolean;
  isSender?: boolean;
  isRead?: boolean;
  readCount?: number;
  unreadCount?: number;
  reactions?: any;
}
declare class Conversation {
  conversationId: string;
  conversationType: number;
  conversationTitle?: string;
  conversationPortrait?: string;
  conversationExts?: string;
  latestMessage?: Message;
  draft?: string;
  isTop?: boolean;
  latestReadIndex?: number;
  latestUnreadIndex?: number;
  undisturbType?: number;
  sortTime?: number;
  unreadCount?: number;
  unreadTag?: number;
}
declare class ChatroomAttribute {
  key: string;
  value: string;
  isForce: boolean;
  isDel: boolean;
}

declare class Chatroom {
  id: string;
  attributes?: ChatroomAttribute[];
}

interface GetConversationOptions {
  order?: number;
  count?: number;
  time?: number;
  tag?: string;
  exceptTag?: string;
}
interface TotalUnreadResult {
  total: number;
}
interface GetTotalOptions {
  conversationTypes?: CONVERATION_TYPE[];
  ignoreConversations?: Conversation[];
}
declare class TimeZone {
  start: string;
  end: string;
}
declare class DisturbInfo {
  type: UNDISTURB_TYPE;
  timezone: string;
  times: TimeZone[];
}
declare class TagInfo {
  id: string;
  name?: string;
  conversations?: Conversation[]
}
interface SendMsgCbData { message: Message, percent?: number, count?: number, total?: number }
interface SendMsgCbCompleteData {
  messages: Message[]
}
interface SendMsgCallbacks {
  onbefore?(message: Message): void;
  onerror?(error: Error): void;
  onprogress?(data: SendMsgCbData): void;
  oncompleted?(data: SendMsgCbCompleteData): void;
}
interface GetMsgByIdOptions {
  conversationType: CONVERATION_TYPE,
  conversationId: string;
  messageIds: string[];
}
interface ClearMsgsOptions {
  conversationType: CONVERATION_TYPE,
  conversationId: string;
  time: number;
}
interface ReadMember {
  readTime: number;
  member: IMUser;
}
interface GetGroupMessageDetailResult {
  readCount: number;
  unreadCount: number;
  unreadMembers: ReadMember[];
  readMembers: ReadMember[];
}
interface GetMentionOptions {
  conversationType: CONVERATION_TYPE,
  conversationId: string;
  messageIndex: number;
  count?: number;
  order?: number;
}
interface SendMergeOptions {
  conversationType: CONVERATION_TYPE,
  conversationId: string;
  messageIdList: string[];
  previewList: any;
  title: string;
}
interface SearchOptions {
  conversationType?: CONVERATION_TYPE,
  conversationId?: string;
  keywords: string[];
  senderIds?: string[];
  messageNames?: string[];
  startTime?: number;
  endTime?: number;
  page?: number;
  pageSize?: number;
}
interface SearchMatchMsg {
  conversationType: CONVERATION_TYPE;
  conversationId: string;
  conversationExts: string;
  conversationPortrait: string;
  conversationTitle: string;
  conversationAlias: string;
  matchedCount: number;
  matchedList: Message[];
}
interface SearchResult {
  isFinished: boolean;
  total: number;
  list: SearchMatchMsg[];
}
interface ReactionOptions {
  conversationType: CONVERATION_TYPE;
  conversationId: string;
  messageId: string;
  reactionId: string;
}
interface CustomMsgOption {
  name: string;
  isCount?: boolean;
  isStorage?: boolean;
  isCommand?: boolean;
}

declare class IMProvider {
  getDeliveryCapabilities: () => Promise<DeliveryCapabilities>;
  getDeliveryReceipt: (request: DeliveryReceiptRequest) => Promise<DeliveryReceiptResult>;
  sendProtectedMessage: (message: ProtectedTextMessage) => Promise<ProtectedTextAcceptance>;
  sendProtectedMedia: (message: ProtectedMediaMessage) => Promise<ProtectedMediaAcceptance>;
  getProtectedMediaCapabilities: () => Promise<ProtectedMediaCapabilities>;
  getProtectedMediaTransferCapabilities: () => Promise<ProtectedMediaTransferCapabilities>;
  getProtectedMediaUploadProgress: (request: ProtectedMediaObjectRequest) => Promise<ProtectedMediaUploadProgress>;
  beginProtectedMedia: (request: ProtectedMediaBeginRequest) => Promise<ProtectedMediaMetadata>;
  putProtectedMediaChunk: (request: ProtectedMediaChunkRequest) => Promise<ProtectedMediaMetadata>;
  finalizeProtectedMedia: (request: ProtectedMediaObjectRequest) => Promise<ProtectedMediaMetadata>;
  getProtectedMedia: (request: ProtectedMediaObjectRequest) => Promise<ProtectedMediaMetadata>;
  cancelProtectedMedia: (request: ProtectedMediaObjectRequest) => Promise<ProtectedMediaMetadata>;
  readProtectedMediaRange: (request: ProtectedMediaRangeRequest) => Promise<Uint8Array>;
  getDeliveryReader: () => Promise<DeliveryReaderInfo>;
  getDeliveryChanges: (request: DeliveryChangesRequest) => Promise<DeliveryChangesResult>;
  getDeliveryMessages: (request: DeliveryMessagesRequest) => Promise<DeliveryMessagesResult>;
  getDeliveryReadCut: (request: DeliveryProjectionRequest) => Promise<DeliveryReadCutResult>;
  /** Explicit user read action only. Unknown outcomes never automatically resend or widen the cut. */
  markDeliveryRead: (request: DeliveryMarkReadRequest) => Promise<DeliveryReadCutResult>;

  connect: (user: IMUser) => Promise<any>;
  disconnect: () => Promise<any>;
  getDevice: () => Promise<any>;
  setConnectParams: (params: any) => Promise<any>;
  isConnected: () => boolean;
  isNeedConnect: () => boolean;
  getCurrentUser: () => IMUser;
  joinChatroom: (chatroom: Chatroom) => Promise<any>;
  quitChatroom: (chatroom: Chatroom) => Promise<any>;
  setChatroomAttributes: (chatroom: Chatroom) => Promise<any>;
  getChatroomAttributes: (chatroom: Chatroom) => Promise<Chatroom>;
  removeChatroomAttributes: (chatroom: Chatroom) => Promise<any>;
  getAllChatRoomAttributes: (chatroom: Chatroom) => Promise<Chatroom>;
  getConversations: (options?: GetConversationOptions) => Promise<{ conversations: Conversation[], isFinished: boolean }>;
  removeConversation: (conversations: Conversation[]) => Promise<any>;
  insertConversation: (conversation: Conversation) => Promise<any>;
  getConversation: (conversation: Conversation) => Promise<Conversation>;
  markUnread: (conversation: Conversation) => Promise<any>;
  disturbConversation: (conversation: Conversation | Conversation[]) => Promise<any>;
  setTopConversation: (conversation: Conversation | Conversation[]) => Promise<any>;
  getTopConversations: () => Promise<{ conversations: Conversation[] }>;
  clearUnreadcount: (conversation: Conversation | Conversation[]) => Promise<any>;
  getTotalUnreadcount: (options?: GetTotalOptions) => Promise<TotalUnreadResult>;
  clearTotalUnreadcount: () => Promise<any>;
  setDraft: (conversation: Conversation) => Promise<any>;
  getDraft: (conversation: Conversation) => Promise<string>;
  removeDraft: (conversation: Conversation) => Promise<any>;
  setAllDisturb: (options: DisturbInfo) => Promise<any>;
  getAllDisturb: () => Promise<DisturbInfo>;
  createConversationTag: (tag: TagInfo) => Promise<any>;
  destroyConversationTag: (tag: TagInfo) => Promise<any>;
  getConversationTags: () => Promise<{ tags: TagInfo[] }>;
  addConversationsToTag: (tag: TagInfo) => Promise<any>;
  removeConversationsFromTag: (tag: TagInfo) => Promise<any>;
  sendMessage: (message: Message, callbacks?: SendMsgCallbacks) => Promise<Message>;
  sendMassMessage: (messages: Message[], callbacks?: SendMsgCallbacks) => Promise<any>;
  getMessages: (conversation: Conversation) => Promise<{ isFinished: boolean, messages: Message[] }>;
  removeMessages: (messages: Message[]) => Promise<any>;
  getMessagesByIds: (options: GetMsgByIdOptions) => Promise<{ messages: Message[] }>;
  clearMessage: (options: ClearMsgsOptions) => Promise<any>;
  recallMessage: (message: Message) => Promise<any>;
  readMessage: (messages: Message[]) => Promise<any>;
  getMessageReadDetails: (message: Message) => Promise<GetGroupMessageDetailResult>;
  updateMessage: (message: Message) => Promise<any>;
  insertMessage: (message: Message) => Promise<any>;
  updateMessageAttr: (message: Message) => Promise<any>;
  setSearchContent: (message: Message) => Promise<any>;
  getMentionMessages: (options: GetMentionOptions) => Promise<{ isFinished: boolean, messages: Message[] }>;
  getFileToken: (params: any) => Promise<any>;
  sendFileMessage: (message: Message, callbacks?: SendMsgCallbacks) => Promise<Message>;
  sendImageMessage: (message: Message, callbacks?: SendMsgCallbacks) => Promise<Message>;
  sendVoiceMessage: (message: Message, callbacks?: SendMsgCallbacks) => Promise<Message>;
  sendVideoMessage: (message: Message, callbacks?: SendMsgCallbacks) => Promise<Message>;
  sendMergeMessage: (options: SendMergeOptions, callbacks?: SendMsgCallbacks) => Promise<Message>;
  getMergeMessages: (message: Message) => Promise<{ isFinished: boolean, messages: Message[] }>;
  getFirstUnreadMessage: (conversation: Conversation) => Promise<{ message: Message }>;
  searchMessages: (options: SearchOptions) => Promise<SearchResult>;
  addMessageReaction: (message: ReactionOptions) => Promise<any>;
  removeMessageReaction: (message: ReactionOptions) => Promise<any>;
  registerMessage: (names: CustomMsgOption[]) => any;
  isDesktop: () => boolean;
  on: (name: string, event: any) => any;
  off: (name: string) => any;
  clear: () => any;
  once: (name: string, event: any) => any;
  Event: EVENT;
  ConnectionState: CONNECT_STATE;
  ConversationType: CONVERATION_TYPE;
  MessageType: MESSAGE_TYPE;
  ConversationOrder: CONVERSATION_ORDER;
  MentionType: MENTION_TYPE;
  MessageOrder: MESSAGE_ORDER;
  MentionOrder: MENTION_ORDER;
  FileType: FILE_TYPE;
  UndisturbType: UNDISTURB_TYPE;
  SentState: MESSAGE_SENT_STATE;
  UnreadTag: UNREAD_TAG;
  ConversationTagType: CONVERATION_TAG_TYPE;
  ErrorType: ERROR_TYPE;
  Message: Message;
  InitOptions: InitOptions;
  IMProvider: IMProvider;
}

interface InitOptions {
  appkey: string;
  navList?: string[];
  serverList?: string[];
  isSync?: boolean;
  /** Immutable per-instance deny-only mode. Disables legacy APIs, desktop bridges,
   * automatic sync and body events before provider invocation; only connection
   * state, protected send/receipt/capabilities and five delivery readers remain. */
  protectedDeliveryReader?: boolean;
  /** Independent default-off typed media profile. Requires protected reader mode;
   * opts into reader-v2 and authenticated Navigator requests. No legacy fallback. */
  protectedMedia?: boolean;
  upload?: Object;
}

export interface ProtectedLiveMessage {
  readonly version: 1;
  readonly generation: number;
  readonly receiverID: string;
  readonly conversationType: 1 | 2;
  readonly conversationID: string;
  readonly messageID: string;
  readonly sequence: string;
  readonly senderID: string;
  readonly messageTime: number;
  readonly wireContent: string;
  readonly messageType: "jg:text";
  readonly isSend: boolean;
  readonly hasReference: boolean;
  readonly originalDestroyTime?: number;
}
declare const protectedLiveObservation: unique symbol;
export type ProtectedLiveObservation = Readonly<{ [protectedLiveObservation]: true }>;
declare const protectedCurrentLink: unique symbol;
export type ProtectedCurrentLink = Readonly<{ [protectedCurrentLink]: true }>;
export interface ProtectedCurrentLinkFacts {
  readonly version: 1;
  readonly generation: number;
  readonly receiverID: string;
}

/** Protected clients expose only connection state and explicit delivery operations.
 * The original live observation is readable only in its original active WS generation;
 * copied handles and history responses cannot create an observation or task permission.
 * Runtime legacy methods also reject with DeliveryError.legacy_api_disabled. */
export type ProtectedDeliveryProvider = Readonly<Pick<IMProvider,
  "connect" | "disconnect" | "isConnected" | "isNeedConnect" | "isDesktop" |
  "getDeliveryCapabilities" | "getDeliveryReceipt" | "sendProtectedMessage" |
  "getDeliveryReader" | "getDeliveryChanges" | "getDeliveryMessages" |
  "getDeliveryReadCut" | "markDeliveryRead" | "sendProtectedMedia" | "getProtectedMediaCapabilities" |
  "getProtectedMediaTransferCapabilities" | "getProtectedMediaUploadProgress" |
  "beginProtectedMedia" | "putProtectedMediaChunk" | "finalizeProtectedMedia" | "getProtectedMedia" |
  "cancelProtectedMedia" | "readProtectedMediaRange" | "on" | "once" | "off" | "clear" |
  "Event" | "ConnectionState" | "ConversationType" | "MessageType" | "ConversationOrder" |
  "MentionType" | "MessageOrder" | "MentionOrder" | "FileType" | "UndisturbType" |
  "SentState" | "UnreadTag" | "ConversationTagType" | "ErrorType"
>> & {
  isProtectedLiveReadAvailable: () => boolean;
  isProtectedReceiverBaselineAvailable: () => boolean;
  getDeliveryReceiverBaseline: (request: { subscriberID: string; scopeKey: string }) => Promise<object>;
  readProtectedReceiverBaseline: (original: object) => Readonly<{ version: 1; baselineID: string; subscriberID: string; scopeKey: string;
    receiverID: string; acceptanceSendboxID: string; serverNow: number; expiresAt: number }> | undefined;
  getDeliveryLiveCut: (request: DeliveryProjectionRequest & { subscriberID: string }, baseline?: object) => Promise<object>;
  readProtectedLiveCut: (cut: object) => Readonly<{ version: 1; cutID: string; subscriberID: string; scopeKey: string; projectionKey: string;
    conversationScopeKey: string; acceptanceRevision: string; receiverID: string; serverNow: number; expiresAt: number;
    receiverBaselineID?: string; acceptanceSendboxID?: string }> | undefined;
  getDeliveryLiveMessages: (request: DeliveryMessagesRequest, cut: object) => Promise<object>;
  readProtectedLivePage: (original: object) => Readonly<{ page: DeliveryMessagesResult;
    observations: readonly ProtectedLiveObservation[]; receivedAt: number; deadline: number }> | undefined;
  onProtectedLiveMessage: (callback: (observation: ProtectedLiveObservation) => void) => () => void;
  readProtectedLiveMessage: (observation: object) => ProtectedLiveMessage | undefined;
  captureProtectedCurrentLink: () => ProtectedCurrentLink | undefined;
  readProtectedCurrentLink: (original: object) => ProtectedCurrentLinkFacts | undefined;
};

declare namespace IMCore {
  export function init(options: InitOptions & { protectedDeliveryReader: true }): ProtectedDeliveryProvider;
  export function init(options: InitOptions): IMProvider;
  export let Event: EVENT;
  export let ConnectionState: CONNECT_STATE;
  export let ConversationType: CONVERATION_TYPE;
  export let MessageType: MESSAGE_TYPE;
  export let ConversationOrder: CONVERSATION_ORDER;
  export let MentionType: MENTION_TYPE;
  export let MessageOrder: MESSAGE_ORDER;
  export let MentionOrder: MENTION_ORDER;
  export let FileType: FILE_TYPE;
  export let UndisturbType: UNDISTURB_TYPE;
  export let SentState: MESSAGE_SENT_STATE;
  export let UnreadTag: UNREAD_TAG;
  export let ConversationTagType: CONVERATION_TAG_TYPE;
  export let ErrorType: ERROR_TYPE;
  export let Message: Message;
  export let InitOptions: InitOptions;
  export let IMProvider: IMProvider;
}

export default IMCore;
