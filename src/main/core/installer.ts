import { spawn } from 'node:child_process'

/**
 * 静默安装器的参数与启动方式（M3）。
 *
 * 单独一个模块、不 import electron：这一段的风险几乎全在「命令行怎么拼」上，
 * 拆出来就能用裸 node 单测钉住（Updater.ts 要 import electron，跑不了单测）。
 *
 * 三个参数都是实测出来的（见 docs/升级模块方案.md §12），没有一个是可选的：
 *  - `/S`：静默。会弹界面的安装器等于把升级又交回给用户点。
 *  - `--force-run`：装完自动拉起新版本。electron-builder 生成的安装器在静默模式下
 *    默认**什么都不拉起**（实测 `/S` 与 `/S --updated` 都不拉起），用户看到的会是
 *    「点了升级，窗口没了，然后再也没有出现」。
 *  - `/D=<安装目录>`：必须显式给，而且必须是**最后一个、且不加引号**。NSIS 的 `/D`
 *    把「它后面剩下的整行」直接当目录，任何引号都会变成目录名的一部分；而不传 `/D`
 *    的纯 `/S` 安装实测是彻底的空操作 —— 退出码 0、一个文件都不写、注册表里没有条目，
 *    属于最难查的一类失败（看起来像成功）。
 */
export const DEFAULT_INSTALLER_ARGS: readonly string[] = ['/S', '--force-run']

/**
 * 拼安装器参数。`/D` 一定在最后，理由见上面的注释。
 *
 * `installDir` 缺省（开发态）时只给 `/S --force-run`：那时跑的是 electron.exe，
 * 「安装目录」指向哪里都没有意义，而少了 `/D` 的安装器实测会安静地什么都不做 ——
 * 对开发态来说这正好是想要的「别真装」。
 */
export function installerArgsFor(installDir: string | undefined): string[] {
  const args = [...DEFAULT_INSTALLER_ARGS]
  if (installDir) args.push(`/D=${installDir}`)
  return args
}

/**
 * 解析 `TM_INSTALLER_ARGS`（测试专用，和 `TM_UPDATE_FEED` / `TM_USER_DATA` 一个思路）。
 *
 * 只为隔离验收存在：探针要「装完别自动拉起」，否则 `--force-run` 拉起的那个新实例不继承
 * 探针的环境变量（实测：安装器环境里的变量传不到它拉起的进程），会打到真实 userData 上去。
 * 按空白切分，所以传不了含空格的安装目录 —— 那个由 `installerArgsFor` 自己拼。
 */
export function parseInstallerArgsOverride(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const parts = raw.split(/\s+/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}

/**
 * 起安装器，并立刻让它与本进程脱钩。
 *
 * `detached: true` + `unref()` 是必须的：紧接着本进程就 `app.exit(0)`，安装器若还挂在
 * 同一个进程组里会跟着一起被杀掉 —— 那种失败的样子是「点了升级，应用关了，什么也没发生」。
 * `stdio: 'ignore'` 同理：安装器没有控制台可写，留着管道反而可能让它阻塞。
 *
 * `windowsVerbatimArguments: true` 是上面 `/D=` 的直接后果：Node 默认会给含空格的参数
 * 加引号，而 NSIS 会把引号当成目录名的一部分（含空格的安装目录就这么装不上）。开了它
 * 参数原样落进命令行，代价是调用方必须自己保证「该拼的都拼好、不要引号」。
 * 实测这条路径下安装包自身的路径含空格也没问题。
 */
export function launchInstaller(filePath: string, args: readonly string[]): void {
  const child = spawn(filePath, [...args], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  })
  child.unref()
}
