// 智慧思政 token 桥。
//
// 为什么需要这一层：智慧思政（nxg.zwu.edu.cn）和我的万里（ehallapp.zwu.edu.cn）是
// **两个不同的域**。主面板跑在 ehallapp 上，读不到 nxg 的 localStorage；而智慧思政的
// 鉴权恰恰只认 `Authorization: Bearer <localStorage.token>`，一个 cookie 都不带。
//
// 所以做法是：脚本在 nxg 页面里也注入一份（只加 @match，不加 UI），它干的事只有一件 ——
// 把当前页面的 localStorage.token 抄进宿主的 KV（油猴的 GM_setValue 是跨域共享的）。
// 主面板从 KV 里读，用 GM_xmlhttpRequest 发请求，不受 CORS 限制。
//
// 安全边界：
//   - token 只存在宿主 KV 里，不打印、不进日志、不回显给模型；
//   - 过期（接口回 code:401）时清掉，并让用户回智慧思政页面刷新一次；
//   - 不采集 openid、身份证、手机号等 teaInfo 里的其它字段 —— 那些用不到。
import {getHost} from '../host';

const KEY = 'xhsz.token';
const AT_KEY = 'xhsz.token.at';
const SID_KEY = 'xhsz.studentId';

/** nxg 的域（用来判断当前页面在不在智慧思政里）。 */
export const NXG_ORIGIN = 'https://nxg.zwu.edu.cn';
export const NXG_HOST = `${NXG_ORIGIN}/api`;
export const NXG_FILE_HOST = `${NXG_ORIGIN}/fileServer`;

/** 当前页面是不是智慧思政。 */
export const onNxgPage = (): boolean => {
  try {
    return location.origin === NXG_ORIGIN;
  } catch {
    return false;
  }
};

/**
 * 在智慧思政页面里调用：把页面上的 token 同步到宿主 KV。
 * 返回是否拿到了新 token。**不要把返回值里的任何内容打日志。**
 */
export function syncTokenFromPage(): boolean {
  if (!onNxgPage()) return false;
  try {
    const token = localStorage.getItem('token');
    if (!token || token.length < 32) return false;
    const host = getHost();
    if (host.getValue<string>(KEY, '') === token) {
      syncStudentId(host);
      return true;
    }
    host.setValue(KEY, token);
    host.setValue(AT_KEY, Date.now());
    syncStudentId(host);
    return true;
  } catch {
    return false;
  }
}

/**
 * 顺便抄一个 studentId 过来 —— 智慧思政所有业务接口都拿它当主键，
 * 而且它**不是学号**（学号 2025xxxxxx 对应的内部 id 是另一串数字）。
 *
 * 只抄这一个数字。teaInfo 里还有身份证、手机号、家庭住址，那些本 DLC 用不到，
 * 一个都不往 KV 里放。
 */
function syncStudentId(host: ReturnType<typeof getHost>): void {
  try {
    const raw = localStorage.getItem('teaInfo');
    if (!raw) return;
    const info = JSON.parse(raw);
    const id = info?.id;
    if (id !== undefined && id !== null && String(id) !== '') host.setValue(SID_KEY, String(id));
  } catch {}
}

/** 主面板用：拿 studentId。 */
export function requireStudentId(): string {
  const id = getHost().getValue<string>(SID_KEY, '');
  if (id) return id;
  throw new Error(
    '还没拿到智慧思政的 studentId。打开一次 https://nxg.zwu.edu.cn/zhxg/#/s/stunav ' +
      '（登录后首页），脚本会把 token 和 studentId 一起同步过来，然后回来重试。'
  );
}

/** 主面板用：拿 token。没有就抛一条能指向下一步的错。 */
export function requireToken(): string {
  const token = getHost().getValue<string>(KEY, '');
  if (token) return token;
  throw new Error(
    '还没有智慧思政的登录态。请先打开一次 https://nxg.zwu.edu.cn/zhxg/#/certificateLogin ' +
      '（会自动换票登录），然后回来重试 —— 脚本会在那个页面里自动把 token 同步过来。'
  );
}

/** 401 时调用：清掉过期 token，别让下一次请求继续拿着死票。 */
export function dropToken(): void {
  getHost().setValue(KEY, '');
  getHost().setValue(AT_KEY, 0);
  getHost().setValue(SID_KEY, '');
}

/** token 是什么时候同步过来的（毫秒时间戳，0 = 没有）。只用于展示，不参与鉴权判断。 */
export function tokenAge(): number {
  const at = getHost().getValue<number>(AT_KEY, 0);
  return at > 0 ? Date.now() - at : 0;
}
