/**
 * iLink Bot 协议常量
 *
 * 这些值与官方插件的协议类型定义保持一致，
 * 是对微信 iLink Bot HTTP API 的协议级映射。
 */

/** iLink Bot API 基础地址 */
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** CDN 基础地址（媒体上传/下载） */
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** 默认 bot_type，用于 get_bot_qrcode / get_qrcode_status */
export const DEFAULT_BOT_TYPE = "3";

/** 接入层版本号，用于 base_info.channel_version */
export const CHANNEL_VERSION = "1.0.2";

/** 长轮询默认超时（服务器最多 hold 35s） */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

/** 普通业务请求默认超时（sendMessage / getUploadUrl） */
export const DEFAULT_API_TIMEOUT_MS = 15_000;

/** 轻量请求默认超时（getConfig / sendTyping） */
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/** Session 过期错误码（服务器返回 errcode=-14 表示需要重新登录） */
export const SESSION_EXPIRED_ERRCODE = -14;

/** Session 过期后默认暂停时长（1 小时） */
export const SESSION_PAUSE_DURATION_MS = 60 * 60 * 1000;

/** 长轮询连续失败上限，超过则触发退避 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** 连续失败后的退避时长 */
export const BACKOFF_DELAY_MS = 30_000;

/** 普通失败的重试间隔 */
export const RETRY_DELAY_MS = 2_000;

/** 单条消息文本上限（与官方插件 textChunkLimit 对齐） */
export const TEXT_CHUNK_LIMIT = 4000;

/** 入站媒体最大字节数 */
export const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** 微信语音默认采样率（SILK） */
export const SILK_SAMPLE_RATE = 24_000;

/**
 * message_type：消息方向
 * 1 = USER（用户发来），2 = BOT（机器人发出）
 */
export const MessageType = Object.freeze({
  NONE: 0,
  USER: 1,
  BOT: 2,
});

/**
 * item_list[].type：消息内容类型
 */
export const MessageItemType = Object.freeze({
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
});

/**
 * message_state：消息状态
 * 0 = NEW，1 = GENERATING（流式生成中），2 = FINISH（完整消息）
 */
export const MessageState = Object.freeze({
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
});

/**
 * getUploadUrl 请求中的 media_type
 */
export const UploadMediaType = Object.freeze({
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
});

/**
 * sendTyping 请求中的 status
 * 1 = 正在输入，2 = 取消输入
 */
export const TypingStatus = Object.freeze({
  TYPING: 1,
  CANCEL: 2,
});

/**
 * get_qrcode_status 返回的状态
 */
export const QrCodeStatus = Object.freeze({
  WAIT: "wait",
  SCANED: "scaned",
  CONFIRMED: "confirmed",
  EXPIRED: "expired",
});

/**
 * 二维码最多刷新次数
 */
export const MAX_QR_REFRESH_COUNT = 3;

/** 活跃登录会话的 TTL（5 分钟） */
export const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;

/** 等待扫码确认的默认超时（8 分钟） */
export const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;

/** 单次 QR 状态长轮询超时 */
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;
