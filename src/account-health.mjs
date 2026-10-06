import { getConfig, WeixinApiError, WeixinHttpError, WeixinTimeoutError } from "./http.mjs";
import { SESSION_EXPIRED_ERRCODE } from "./constants.mjs";

/** Probe without consuming messages. Typing/config service failures cannot prove auth failure. */
export async function checkAccountHealth({ baseUrl, token, userId, timeoutMs = 3000 }, getConfigFn = getConfig) {
  if (!token) return { result: "invalid", detail: "no token stored" };
  try {
    await getConfigFn({ baseUrl, token, ilinkUserId: userId, timeoutMs });
    return { result: "valid", detail: "token 有效（getConfig 查询成功）" };
  } catch (err) {
    if (err instanceof WeixinTimeoutError) return { result: "unknown", detail: "查询超时，未能确认 token 状态" };
    if (err instanceof WeixinApiError) {
      const errcode = err.errcode;
      if (errcode === SESSION_EXPIRED_ERRCODE || err.ret === SESSION_EXPIRED_ERRCODE) return { result: "expired", detail: "session 已过期，需重新 --login", errcode };
      return { result: "unknown", detail: `微信配置服务暂未提供状态（ret=${err.ret} errcode=${errcode}），登录有效性未确认`, errcode };
    }
    if (err instanceof WeixinHttpError) return { result: err.status === 401 || err.status === 403 ? "invalid" : "unknown", detail: `HTTP ${err.status}` };
    return { result: "network_error", detail: String(err?.message ?? err) };
  }
}
