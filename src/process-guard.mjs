/**
 * 全局异常兜底
 *
 * 防止浮空 Promise 拒绝或未捕获异常杀死常驻进程。
 *
 * 为什么需要：Node.js ≥ 15 对未处理的 Promise 拒绝默认 throw（即崩溃进程）。
 * 长时间运行下，任何一条 fire-and-forget 异步链（如消息处理 handler 内部
 * 某个 await 分支未 catch）都会变成 unhandledRejection，杀死整个进程。
 * 常驻服务必须显式兜底。
 *
 * 策略：两类异常都记日志、不退出（尽力保活）。
 *  - unhandledRejection：异步链某分支未 catch，不影响主轮询循环。
 *  - uncaughtException：同步代码未 catch，理论上有状态损坏风险；
 *    但本项目几乎全异步，同步异常极罕见。若频繁出现说明有代码 bug，应排查根因。
 */
import { log } from "./util.mjs";

let installed = false;

/**
 * 安装全局异常处理器。幂等，多次调用安全。
 * 应在进程启动早期（main() 入口）调用一次。
 */
export function installProcessGuards() {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ""}`
      : String(reason);
    log.error(`unhandledRejection（已兜底，进程继续运行）`, { reason: detail });
  });

  process.on("uncaughtException", (err) => {
    log.error(`uncaughtException（已兜底，进程继续运行；若频繁出现请排查代码 bug）`, {
      err: String(err),
      stack: err?.stack,
    });
  });
}
